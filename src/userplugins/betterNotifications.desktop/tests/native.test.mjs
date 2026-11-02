/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Run with: node --test src/userplugins/betterNotifications.desktop/tests/native.test.mjs
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

import ts from "typescript";

const require = createRequire(import.meta.url);
const source = readFileSync(new URL("../native.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;

const baseLayout = {
    position: "bottom-right", display: "cursor", gameDisplay: "", offsetX: 0, offsetY: 0,
    maxWidth: 440, scale: 1, opacity: 0.97, maxVisible: 5, maxHeight: 0.6,
    collapseOlder: true, autoCollapse: 0, clickable: true, hover: "interact",
    typing: "fade", typingTrigger: "any", typingOpacity: 0.2, lockInGame: true,
    shortcut: "Alt+Shift+N", unlockShortcut: "Alt+Shift+U"
};

function harness(overrides = {}, environment = {}) {
    const app = new EventEmitter();
    const screen = new EventEmitter();
    let displays = environment.displays ?? [0, 1920].map((x, i) => ({
        id: i + 1, label: `Monitor ${i + 1}`, bounds: { x, y: 0, width: 1920, height: 1080 },
        workArea: { x, y: 0, width: 1920, height: 1040 }, size: { width: 1920, height: 1080 }, scaleFactor: 1
    }));
    let cursor = { x: 500, y: 500 };
    Object.assign(screen, {
        getAllDisplays: () => displays,
        getPrimaryDisplay: () => displays[0],
        getCursorScreenPoint: () => cursor,
        getDisplayNearestPoint: p => displays.find(d => p.x >= d.bounds.x && p.x < d.bounds.x + d.bounds.width) ?? displays[0],
        getDisplayMatching: r => screen.getDisplayNearestPoint({ x: r.x + r.width / 2, y: r.y + r.height / 2 }),
        screenToDipRect: (_, r) => r
    });
    let now = 10_000;
    let foregroundCallback;
    let stopCount = 0;
    let overlay;
    let discordFocused = false;
    const discord = {
        isDestroyed: () => false, isFocused: () => discordFocused,
        getBounds: () => ({ x: 2000, y: 0, width: 800, height: 600 })
    };
    const timers = new Map();
    const shortcuts = new Map();
    let timerId = 0;
    const effects = { typing: false, ghost: -1, unlocked: false };
    const page = {
        setTyping: value => effects.typing = value,
        setGhost: value => effects.ghost = value,
        setUnlocked: value => effects.unlocked = value,
        pushNotification() { }, pointerLeft() { }
    };
    class BrowserWindow extends EventEmitter {
        static fromWebContents() { return discord; }
        constructor(options) {
            super();
            overlay = this;
            this.webContents = new EventEmitter();
            Object.assign(this.webContents, {
                executeJavaScript: async code => runInNewContext(code, { window: page }),
                setWindowOpenHandler() { },
                ...(environment.cssZoom ? {} : { setZoomFactor() { } })
            });
            this.visible = false;
            this.destroyed = false;
            this.focusable = options.focusable;
        }
        isDestroyed() { return this.destroyed; }
        isVisible() { return this.visible; }
        setIgnoreMouseEvents(value) { this.ignoringMouse = value; }
        setFocusable(value) { this.focusable = value; }
        setAlwaysOnTop() { }
        moveTop() { this.reassertions = (this.reassertions ?? 0) + 1; }
        async loadURL() { }
        setBounds(value) { this.bounds = value; }
        getContentBounds() { return this.bounds; }
        showInactive() { this.visible = true; }
        hide() { this.visible = false; }
        destroy() { this.destroyed = true; this.emit("closed"); }
    }
    const modules = {
        electron: { app, BrowserWindow, screen, shell: {}, powerMonitor: { getSystemIdleTime: () => 0 }, globalShortcut: {
            register: (key, fn) => { shortcuts.set(key, fn); return true; },
            unregister: key => shortcuts.delete(key)
        } },
        "file://overlay.html": { default: "" },
        "./windowsForeground": { watchForeground: callback => {
            foregroundCallback = callback;
            return () => stopCount++;
        } }
    };
    const native = {};
    runInNewContext(compiled, {
        require: id => modules[id] ?? require(id), exports: native, console,
        process: { platform: "win32" }, Date: { now: () => now },
        setTimeout: (fn, ms) => { timers.set(++timerId, { fn, ms }); return timerId; },
        clearTimeout: id => timers.delete(id)
    });
    const event = { sender: {} };
    return {
        native, app, screen, effects, shortcuts,
        get overlay() { return overlay; },
        get stopCount() { return stopCount; },
        games: pids => native.setRunningGames(event, pids),
        foreground(pid, displayId = 1) {
            foregroundCallback({ pid, monitor: displays.find(d => d.id === displayId).bounds });
        },
        sampleLost: () => foregroundCallback(null),
        discordFocus: value => discordFocused = value,
        pageMessage(message) {
            overlay.webContents.emit("console-message", { message: "__VC_BN__" + JSON.stringify(message) });
        },
        async show(layout = {}) {
            await native.showNotification(event, { id: "card", title: "Test", layout: { ...baseLayout, ...overrides, ...layout } });
            overlay.webContents.emit("console-message", { message: '__VC_BN__{"type":"rects","rects":[[12,12,300,100]]}' });
        },
        hover() { cursor = { x: overlay.bounds.x + 30, y: overlay.bounds.y + 30 }; },
        cursorAt(x, y) { cursor = { x: overlay.bounds.x + x, y: overlay.bounds.y + y }; },
        away() { cursor = { x: 500, y: 500 }; },
        tick(ms = 50) {
            now += ms;
            const entry = [...timers].find(([, timer]) => timer.ms <= 150);
            assert.ok(entry, "overlay polling must be active");
            timers.delete(entry[0]);
            entry[1].fn();
        },
        disconnect() { displays = displays.slice(0, 1); screen.emit("display-removed"); }
    };
}

test("a selected secondary screen stays visible in both fade and hide modes, and remains clickable", async () => {
    for (const typing of ["fade", "hide"]) {
        const h = harness({ gameDisplay: "2", typing });
        h.games([42]);
        h.foreground(42);
        await h.show();
        h.tick();
        assert.ok(h.overlay.bounds.x >= 1920);
        assert.equal(h.effects.typing, false);
        h.hover();
        h.tick();
        assert.equal(h.overlay.ignoringMouse, false);
        h.native.destroy();
    }
});

test("a press keeps the native window interactive until release, before any swipe movement", async () => {
    const h = harness();
    h.discordFocus(true);
    await h.show();
    h.hover();
    h.tick();
    h.pageMessage({ type: "pointer", active: true });
    const restacks = h.overlay.reassertions;
    h.away();
    h.tick(1100);
    assert.equal(h.overlay.ignoringMouse, false);
    assert.equal(h.overlay.reassertions, restacks);
    h.pageMessage({ type: "pointer", active: false });
    h.tick();
    assert.equal(h.overlay.ignoringMouse, true);
    assert.ok(h.overlay.reassertions > restacks);
});

test("a pending press cannot bypass the protection when the user returns to the game", async () => {
    const h = harness();
    h.games([42]);
    h.foreground(90);
    await h.show();
    h.hover();
    h.tick();
    h.pageMessage({ type: "pointer", active: true });
    h.foreground(42);
    h.pageMessage({ type: "pointer", active: true });
    h.tick();
    assert.equal(h.overlay.ignoringMouse, true);
});

test("successive notifications reuse an activatable window outside games", async () => {
    const h = harness();
    h.discordFocus(false);
    let original;
    for (let i = 1; i <= 3; i++) {
        await h.show();
        original ??= h.overlay;
        assert.equal(h.overlay, original, "the hidden notification window is reused");
        assert.equal(h.overlay.focusable, true, "every permitted click must be activatable, not only the first notification");
        h.hover();
        h.tick();
        assert.equal(h.overlay.ignoringMouse, false);
        h.pageMessage({ type: "pointer", active: true });
        h.pageMessage({ type: "pointer", active: false });
        h.pageMessage({ type: "empty", seq: i });
        assert.equal(h.overlay.visible, false);
    }
});

test("activation follows the permission to interact with the cards during a game", async () => {
    const h = harness();
    h.games([42]);
    h.foreground(42);
    await h.show();
    assert.equal(h.overlay.focusable, false, "locked cards on the game monitor must never activate");
    h.foreground(90);
    assert.equal(h.overlay.focusable, true, "Alt+Tab permits normal clicks");
    h.foreground(42);
    assert.equal(h.overlay.focusable, false);
    h.native.setGameDisplay({}, "2");
    assert.equal(h.overlay.focusable, true, "clicks on the separate notification monitor are permitted");
    h.native.setGameDisplay({}, "1");
    assert.equal(h.overlay.focusable, false);
    h.shortcuts.get("Alt+Shift+U")();
    assert.equal(h.overlay.focusable, true, "explicit unlocking permits intentional clicks");
    h.shortcuts.get("Alt+Shift+U")();
    assert.equal(h.overlay.focusable, false);
});

test("disabled clickable cards remain non-activating outside games", async () => {
    const h = harness({ clickable: false });
    await h.show();
    h.hover();
    h.tick();
    assert.equal(h.overlay.focusable, false);
    assert.equal(h.overlay.ignoringMouse, true);
});

test("hit testing follows the actual page viewport on each monitor instead of assuming the requested zoom", async () => {
    const displays = [
        { id: 1, label: "Principal", bounds: { x: 0, y: 0, width: 2560, height: 1440 }, workArea: { x: 0, y: 0, width: 2560, height: 1392 }, size: { width: 2560, height: 1440 }, scaleFactor: 1 },
        { id: 2, label: "Secondaire", bounds: { x: -1920, y: 217, width: 1920, height: 1080 }, workArea: { x: -1920, y: 217, width: 1920, height: 1032 }, size: { width: 1920, height: 1080 }, scaleFactor: 1 }
    ];
    const h = harness({}, { displays, cssZoom: true });
    h.discordFocus(true);
    await h.show({ display: "primary" });
    for (const pageZoom of [1.25, 1.5, 1, 0.8]) {
        const { width, height } = h.overlay.bounds;
        const viewport = { width: width / pageZoom, height: height / pageZoom };
        const rect = [viewport.width - 160, viewport.height - 100, viewport.width - 12, viewport.height - 12];
        h.pageMessage({ type: "rects", rects: [rect], viewport });
        // Near the close button at the visible right edge of the card.
        h.cursorAt((rect[2] - 10) * pageZoom, (rect[1] + 20) * pageZoom);
        h.tick();
        assert.equal(h.overlay.ignoringMouse, false, `visible card at effective zoom ${pageZoom} must receive clicks`);
        h.cursorAt(1, 1);
        h.tick();
        assert.equal(h.overlay.ignoringMouse, true, "the rest of the transparent window must remain click-through");
    }
    h.cursorAt(-3000, 300);
    await h.show({ display: "cursor" });
    assert.ok(h.overlay.bounds.x < 0, "secondary screen has a negative origin and a vertical offset");
    const { width, height } = h.overlay.bounds;
    h.pageMessage({ type: "rects", rects: [[width - 160, height - 100, width - 12, height - 12]], viewport: { width, height } });
    h.cursorAt(width - 25, height - 75);
    h.tick();
    assert.equal(h.overlay.ignoringMouse, false);
});

test("changing the chosen screen moves existing cards immediately and restores their protection", async () => {
    const h = harness();
    h.games([42]);
    h.foreground(42);
    await h.show();
    h.tick();
    assert.equal(h.effects.typing, true);
    h.native.setGameDisplay({}, "2");
    assert.ok(h.overlay.bounds.x >= 1920);
    h.tick();
    assert.equal(h.effects.typing, false);
    h.native.setGameDisplay({}, "1");
    h.tick();
    assert.equal(h.effects.typing, true);
});

test("the native game's physical monitor bounds are converted to DIPs before matching", async () => {
    const h = harness({ gameDisplay: "2" });
    let conversions = 0;
    h.screen.screenToDipRect = (_, rect) => {
        conversions++;
        assert.equal(rect.x, 1920);
        return { x: 0, y: 0, width: 1920, height: 1080 };
    };
    h.games([42]);
    h.foreground(42, 2);
    await h.show();
    h.tick();
    assert.equal(conversions, 1);
    assert.equal(h.effects.typing, false);
});

test("the display picker receives stable monitor ids, names, resolution and the primary screen", () => {
    const h = harness();
    assert.deepEqual(JSON.parse(JSON.stringify(h.native.getDisplays())), [
        { id: "1", label: "Monitor 1", primary: true, width: 1920, height: 1080 },
        { id: "2", label: "Monitor 2", primary: false, width: 1920, height: 1080 }
    ]);
});

test("selecting the game's screen preserves fading and click-through; off preserves full visibility", async () => {
    for (const typing of ["fade", "hide", "off"]) {
        const h = harness({ gameDisplay: "1", typing });
        h.games([42]);
        h.foreground(42);
        await h.show();
        h.hover();
        h.tick();
        assert.equal(h.effects.typing, typing !== "off");
        assert.equal(h.overlay.ignoringMouse, true);
        h.native.destroy();
    }
});

test("Alt+Tab to another app and Start release the cards; returning to the game protects them again", async () => {
    const h = harness();
    h.games([42]);
    h.foreground(42);
    await h.show();
    for (const otherPid of [90, 100]) {
        h.hover();
        h.tick();
        assert.equal(h.overlay.ignoringMouse, true);
        assert.equal(h.effects.typing, true);
        h.foreground(otherPid);
        h.tick();
        assert.equal(h.overlay.ignoringMouse, false);
        assert.equal(h.effects.typing, false);
        h.foreground(42);
    }
    h.tick();
    assert.equal(h.overlay.ignoringMouse, true);
    assert.equal(h.effects.typing, true);
});

test("moving the mouse away from the game does not change the game's monitor", async () => {
    const h = harness();
    h.games([42]);
    h.foreground(42);
    await h.show({ gameDisplay: "2" });
    h.hover();
    await h.show();
    assert.ok(h.overlay.bounds.x < 1920);
    h.tick();
    assert.equal(h.effects.typing, true);
});

test("a disconnected chosen screen falls back immediately and applies the same-screen protection", async () => {
    const h = harness({ gameDisplay: "2" });
    h.games([42]);
    h.foreground(42);
    await h.show();
    h.tick();
    assert.equal(h.effects.typing, false);
    h.disconnect();
    assert.ok(h.overlay.bounds.x < 1920);
    h.hover();
    h.tick();
    assert.equal(h.effects.typing, true);
    assert.equal(h.overlay.ignoringMouse, true);
});

test("a missing saved display falls back and a background game does not keep cards locked", async () => {
    const h = harness({ gameDisplay: "999" });
    h.games([42]);
    h.foreground(42);
    await h.show();
    assert.ok(h.overlay.bounds.x < 1920);
    h.foreground(90);
    h.hover();
    h.tick();
    assert.equal(h.overlay.ignoringMouse, false);
});

test("moving the game onto the chosen notification screen enables protection there", async () => {
    const h = harness({ gameDisplay: "2" });
    h.games([42]);
    h.foreground(42);
    await h.show();
    h.tick();
    assert.equal(h.effects.typing, false);
    h.foreground(42, 2);
    h.hover();
    h.tick();
    assert.equal(h.effects.typing, true);
    assert.equal(h.overlay.ignoringMouse, true);
});

test("disabled locking and the existing unlock shortcut remain effective on the game's screen", async () => {
    const h = harness({ lockInGame: false });
    h.games([42]);
    h.foreground(42);
    await h.show();
    h.hover();
    h.tick();
    assert.equal(h.overlay.ignoringMouse, false);
    await h.show({ lockInGame: true });
    h.shortcuts.get("Alt+Shift+U")();
    assert.equal(h.effects.unlocked, true);
    assert.equal(h.overlay.ignoringMouse, false);
});

test("a lost or stale foreground sample cannot leave the notifications locked", async () => {
    const h = harness();
    h.games([42]);
    h.foreground(42);
    await h.show();
    h.hover();
    h.tick();
    assert.equal(h.overlay.ignoringMouse, true);
    h.tick(1600);
    assert.equal(h.overlay.ignoringMouse, false);
    h.foreground(42);
    h.tick();
    assert.equal(h.overlay.ignoringMouse, true);
    h.sampleLost();
    h.tick();
    assert.equal(h.overlay.ignoringMouse, false);
});

test("the game-only display is ignored outside games, and leaving the game restores the usual display", async () => {
    const h = harness({ gameDisplay: "2", display: "primary" });
    await h.show();
    assert.ok(h.overlay.bounds.x < 1920);
    h.games([42]);
    h.foreground(42);
    assert.ok(h.overlay.bounds.x >= 1920);
    h.games([]);
    assert.ok(h.overlay.bounds.x < 1920);
    assert.equal(h.stopCount, 1);
});

test("plugin shutdown removes the helper, screen listeners and shortcuts", async () => {
    const h = harness();
    h.games([42]);
    await h.show();
    h.native.destroy();
    assert.equal(h.stopCount, 1);
    assert.equal(h.screen.listenerCount("display-removed"), 0);
    assert.equal(h.app.listenerCount("will-quit"), 0);
    assert.equal(h.shortcuts.size, 0);
});

test("Discord shutdown stops the helper even while a game keeps running", () => {
    const h = harness();
    h.games([42]);
    h.app.emit("will-quit");
    assert.equal(h.stopCount, 1);
});
