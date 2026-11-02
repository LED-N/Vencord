/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Set BROWSER_PATH to a Chromium/Edge executable, then run node --test on this file.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import puppeteer from "puppeteer-core";

const html = readFileSync(new URL("../overlay.html", import.meta.url), "utf8");
const notification = {
    id: "test", title: "Test", content: ["Test des interactions"], duration: 60_000,
    layout: {
        position: "bottom-center", clickable: true, opacity: 0.97, maxWidth: 440,
        typingOpacity: 0.2, maxVisible: 5, collapseOlder: true, autoCollapse: 0, typing: "off"
    }
};

test("overlay mouse interactions", { skip: !process.env.BROWSER_PATH }, async t => {
    const browser = await puppeteer.launch({
        executablePath: process.env.BROWSER_PATH,
        headless: true,
        pipe: true,
        args: ["--no-sandbox", "--disable-gpu"]
    });
    t.after(() => browser.close());

    async function setup(t, data = notification, scale = 1) {
        const page = await browser.newPage();
        t.after(() => page.close());
        const messages = [];
        const errors = [];
        page.on("console", event => {
            if (event.text().startsWith("__VC_BN__")) messages.push(JSON.parse(event.text().slice(9)));
        });
        page.on("pageerror", error => errors.push(error.message));
        await page.setViewport({ width: 700, height: 650 });
        await page.setContent(html);
        await page.evaluate(({ data, scale }) => window.pushNotification(data, 1, scale), { data, scale });
        // Wait for the entry animation before testing real hit targets.
        await page.waitForFunction(() => document.querySelector(".n")?.getAnimations().every(a => a.playState === "finished"));
        t.after(() => assert.deepEqual(errors, []));
        return { page, messages, actions: () => messages.filter(m => m.type === "action").map(m => m.action) };
    }

    for (const scale of [0.7, 1, 1.5]) {
        await t.test(`close button dismisses without opening Discord at scale ${scale}`, async t => {
            const { page, messages, actions } = await setup(t, notification, scale);
            await page.hover(".n");
            await page.click(".x");
            await page.waitForFunction(() => !document.querySelector(".n"));
            assert.deepEqual(actions(), [{ type: "closed", ids: ["test"] }]);
            assert.deepEqual(messages.filter(m => m.type === "pointer").map(m => m.active), [true, false]);
        });
    }

    await t.test("a message update between press and release does not lose the close button click", async t => {
        const { page, actions } = await setup(t);
        const button = await page.$(".x");
        const box = await button.boundingBox();
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down();
        await page.evaluate(data => window.pushNotification({ ...data, content: ["Message modifié"] }, 2, 1), notification);
        assert.equal(await page.evaluate(button => button === document.querySelector(".x"), button), true);
        await page.mouse.up();
        await page.waitForFunction(() => !document.querySelector(".n"));
        assert.deepEqual(actions(), [{ type: "closed", ids: ["test"] }]);
    });

    await t.test("layout reports use the actual viewport after a resize and a CSS zoom change", async t => {
        const { page, messages } = await setup(t);
        await page.setViewport({ width: 464, height: 835, deviceScaleFactor: 1.5 });
        await page.evaluate(data => window.pushNotification(data, 2, 1.25), notification);
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const report = messages.filter(m => m.type === "rects").at(-1);
        const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
        assert.deepEqual(report.viewport, viewport);
        const close = await (await page.$(".x")).boundingBox();
        const x = close.x + close.width / 2;
        const y = close.y + close.height / 2;
        assert.ok(report.rects.some(([left, top, right, bottom]) => x >= left && x <= right && y >= top && y <= bottom));
    });

    for (const direction of [-1, 1]) {
        await t.test(`swipe ${direction < 0 ? "left" : "right"} dismisses without opening Discord`, async t => {
            const { page, messages, actions } = await setup(t);
            const box = await (await page.$(".n")).boundingBox();
            const x = box.x + box.width / 2;
            const y = box.y + box.height / 2;
            await page.mouse.move(x, y);
            await page.mouse.down();
            await page.waitForFunction(() => [...document.querySelectorAll(".n, .n *")].some(el => el.hasPointerCapture(1)));
            assert.equal(messages.some(m => m.type === "pointer" && m.active), true);
            assert.equal(messages.some(m => m.type === "drag" && m.active), false);
            await page.mouse.move(x + direction * 150, y, { steps: 10 });
            await page.mouse.up();
            await page.waitForFunction(() => !document.querySelector(".n"));
            assert.deepEqual(actions(), [{ type: "closed", ids: ["test"] }]);
            assert.deepEqual(messages.filter(m => m.type === "drag").map(m => m.active), [true, false]);
        });
    }

    await t.test("cancelling a swipe restores the card instead of dismissing it", async t => {
        const { page, actions } = await setup(t);
        const box = await (await page.$(".n")).boundingBox();
        await page.mouse.move(box.x + 40, box.y + 30);
        await page.mouse.down();
        await page.mouse.move(box.x + 170, box.y + 30, { steps: 10 });
        await page.evaluate(() => document.querySelector(".n").dispatchEvent(new PointerEvent("pointercancel", { bubbles: true, pointerId: 1 })));
        assert.equal(await page.$eval(".n", card => !!card._gone), false);
        assert.equal(await page.$eval(".n", card => card.style.transform), "");
        assert.deepEqual(actions(), []);
    });

    await t.test("the card body still opens the message", async t => {
        const { page, actions } = await setup(t);
        await page.click(".title");
        await page.waitForFunction(() => !document.querySelector(".n"));
        assert.deepEqual(actions(), [{ type: "jump", id: "test" }, { type: "closed", ids: ["test"] }]);
    });

    await t.test("successive notifications stay clickable in the same page after pointer cleanup", async t => {
        const { page, actions } = await setup(t);
        const ids = ["test", "second", "third"];
        for (let i = 0; i < ids.length; i++) {
            if (i) {
                await page.evaluate(({ data, seq }) => {
                    window.pointerLeft();
                    window.pushNotification(data, seq, 1);
                }, { data: { ...notification, id: ids[i] }, seq: i + 1 });
                await page.waitForFunction(() => document.querySelector(".n")?.getAnimations().every(a => a.playState === "finished"));
            }
            await page.hover(".n");
            await page.click(".x");
            await page.waitForFunction(() => !document.querySelector(".n"));
        }
        assert.deepEqual(actions(), ids.map(id => ({ type: "closed", ids: [id] })));
    });

    await t.test("capturing a press preserves bot button targets", async t => {
        const { page, actions } = await setup(t, { ...notification, buttons: [{ label: "Action", style: 1 }] });
        await page.click(".btn");
        await page.waitForFunction(() => !document.querySelector(".n"));
        assert.deepEqual(actions(), [{ type: "button", id: "test", index: 0 }, { type: "closed", ids: ["test"] }]);
    });
});
