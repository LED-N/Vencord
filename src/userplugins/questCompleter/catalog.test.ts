/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { assetUrl, boostEvidence, bulkExclusionReason, formatDuration, isAvailable, isClaimable, normalizeQuest, questOrbs, QuestQueue, remainingSeconds, rewardGroups, rewardSummary, timeLeft, waitFor } from "./catalog";

const quest = (id: string) => ({ id, config: { startsAt: "2026-01-01", expiresAt: "2027-01-01" } });

test("REST normalization preserves task names and supports V2 rewards/status", () => {
    const value = normalizeQuest({ id: "1", config: {
        task_config_v2: { tasks: { WATCH_VIDEO: { target: 30 } } },
        rewards_config: { rewards: [{ type: 4, orb_quantity: 700 }] }
    }, user_status: { enrolled_at: "2026-01-01" } });
    assert.equal(value.config.taskConfigV2.tasks.WATCH_VIDEO.target, 30);
    assert.equal(value.userStatus.enrolledAt, "2026-01-01");
    assert.equal(rewardSummary(value), "700 Orbs");
});

test("multiple and unknown reward types stay discoverable", () => {
    assert.deepEqual(rewardGroups({ config: { rewards: [{ type: 2 }, { type: 4 }, { type: 99 }] } }), ["orbs", "game", "other"]);
    assert.deepEqual(rewardGroups({ config: {} }), ["other"]);
});

test("future, expired, preview and malformed quests are unavailable", () => {
    const now = Date.parse("2026-06-01");
    assert.equal(isAvailable(quest("1"), now), true);
    assert.equal(isAvailable({ ...quest("1"), preview: true }, now), false);
    assert.equal(isAvailable({ id: "1", config: { startsAt: "2026-07-01", expiresAt: "2027-01-01" } }, now), false);
    assert.equal(isAvailable({ id: "1", config: { expiresAt: "2026-06-01" } }, now), false);
    assert.equal(isAvailable({ id: "1", config: {} }, now), false);
    assert.equal(isAvailable(null, now), false);
});

test("queue supports additions during an active job without duplicates", () => {
    const queue = new QuestQueue();
    assert.equal(queue.add(quest("1")), true);
    assert.equal(queue.add(quest("1")), false);
    assert.equal(queue.take()?.id, "1");
    assert.equal(queue.add(quest("1")), false);
    assert.equal(queue.add(quest("2")), true);
    assert.equal(queue.current?.id, "1");
    queue.current!.status = "completed";
    assert.equal(queue.add(quest("1")), false);
    assert.equal(queue.take()?.id, "2");
});

test("reordering/removal only affects pending jobs", () => {
    const queue = new QuestQueue();
    ["1", "2", "3", "4"].forEach(id => queue.add(quest(id)));
    queue.take();
    queue.moveUp("3");
    queue.remove("2");
    queue.remove("1");
    assert.deepEqual(queue.waiting().map(job => job.id), ["3", "4"]);
    assert.equal(queue.current?.id, "1");
    assert.equal(queue.take()?.id, "3");
    assert.equal(queue.take()?.id, "4");
    assert.equal(queue.take(), undefined);
});

test("cancellation clears pending work; failed/cancelled jobs can be retried", () => {
    const queue = new QuestQueue();
    ["1", "2", "3"].forEach(id => queue.add(quest(id)));
    queue.take()!.status = "completed";
    queue.take();
    queue.cancel();
    assert.equal(queue.jobs.get("1")?.status, "completed");
    assert.equal(queue.jobs.get("2")?.status, "cancelled");
    assert.equal(queue.jobs.get("3")?.status, "cancelled");
    assert.equal(queue.waiting().length, 0);
    assert.equal(queue.add(quest("2")), true);
    queue.take()!.status = "failed";
    assert.equal(queue.add(quest("2")), true);
    queue.clear();
    assert.equal(queue.jobs.size, 0);
    assert.equal(queue.current, null);
});

test("long waits reject immediately when stopped", async () => {
    const controller = new AbortController();
    const wait = waitFor(60_000, controller.signal);
    controller.abort();
    await assert.rejects(wait, { name: "AbortError" });
    await assert.rejects(waitFor(60_000, controller.signal), { name: "AbortError" });
});

test("history pruning preserves active and pending jobs", () => {
    const queue = new QuestQueue();
    for (let index = 0; index < 30; index++) {
        queue.add(quest(String(index)));
        queue.take()!.status = "completed";
    }
    queue.add(quest("active"));
    queue.take();
    queue.add(quest("pending"));
    queue.pruneHistory();
    assert.equal(queue.jobs.size, 22);
    assert.equal(queue.current?.id, "active");
    assert.equal(queue.waiting()[0]?.id, "pending");
    assert.equal(queue.jobs.has("0"), false);
    assert.equal(queue.jobs.has("29"), true);
});

test("completed waits do not react to later cancellation", async () => {
    const controller = new AbortController();
    await waitFor(1, controller.signal);
    controller.abort();
});

test("bulk filters name the disabled options and permit mixed/unknown rewards", () => {
    const settings = { farmVideo: false, farmRewardCodes: false, farmInGame: true };
    const code = { config: { rewards: [{ type: 1 }] } };
    assert.match(bulkExclusionReason(code, "WATCH_VIDEO", settings)!, /Vidéos.*Codes à échanger.*Ajout manuel possible/);
    assert.equal(bulkExclusionReason({ config: { rewards: [{ type: 1 }, { type: 2 }] } }, undefined, settings), undefined);
    assert.equal(bulkExclusionReason({ config: { rewards: [{ type: 99 }] } }, undefined, settings), undefined);
    const queue = new QuestQueue();
    queue.add({ ...code, id: "manual" });
    queue.add({ ...code, id: "bulk" }, "bulk");
    assert.equal(queue.take()?.source, "manual");
    assert.equal(queue.take()?.source, "bulk");
});

test("completed rewards remain claimable after quest expiry until the reward deadline", () => {
    const completed = { ...quest("1"), config: { expiresAt: "2026-05-01", rewardsConfig: { rewardsExpireAt: "2026-07-01" } }, userStatus: { completedAt: "2026-04-30" } };
    const now = Date.parse("2026-06-01");
    assert.equal(isAvailable(completed, now), false);
    assert.equal(isClaimable(completed, now), true);
    assert.equal(isClaimable(completed, Date.parse("2026-07-01")), false);
    assert.equal(isClaimable({ ...completed, userStatus: { ...completed.userStatus, claimedAt: "2026-05-01" } }, now), false);
    assert.equal(isClaimable({ ...completed, userStatus: {} }, now), false);
});

test("Nitro subscribers see Discord's premium Orb amount and multiplier", () => {
    const value = normalizeQuest({ id: "1", config: { rewards_config: { rewards: [{ type: 4, orb_quantity: 200, premium_orb_quantity: 240 }] } } });
    assert.deepEqual(questOrbs(value, false), { value: 200, base: 200 });
    assert.deepEqual(questOrbs(value, true), { value: 240, base: 200, multiplier: 1.2 });
    assert.equal(rewardSummary(value, true), "240 Orbs");
    // Without a premium amount from Discord, nothing is made up
    assert.deepEqual(questOrbs({ config: { rewards: [{ type: 4, orbQuantity: 700 }] } }, true), { value: 700, base: 700 });
    assert.equal(questOrbs({ config: { rewards: [{ type: 3 }] } }, true), undefined);
});

test("the Nitro multiplier follows the quest flag and what Discord really paid", () => {
    const reward = { type: 4, orbQuantity: 200, premiumOrbQuantity: 240 };
    const optedOut = { config: { features: [38], rewards: [reward] } };
    assert.deepEqual(questOrbs(optedOut, true), { value: 200, base: 200 });

    // Nitro obtained with Orbs: Discord paid the regular amount, the account does not get the multiplier
    const paidBase = { config: { rewards: [reward] }, userStatus: { claimedAt: "2026-06-02", orbQuantityClaimed: 200 } };
    const paidBoosted = { config: { rewards: [reward] }, userStatus: { claimedAt: "2026-06-01", orbQuantityClaimed: 240 } };
    assert.equal(boostEvidence([paidBoosted, paidBase]), false);
    assert.equal(boostEvidence([{ ...paidBoosted, userStatus: { ...paidBoosted.userStatus, claimedAt: "2026-06-03" } }, paidBase]), true);
    assert.equal(boostEvidence([optedOut, { config: { rewards: [reward] } }]), undefined);
    assert.deepEqual(questOrbs(paidBase, true), { value: 200, base: 200 });
    assert.equal(rewardSummary(paidBase, true), "200 Orbs");
});

test("quest assets resolve to the quest CDN folder", () => {
    assert.equal(assetUrl("42", "hero.jpg"), "https://cdn.discordapp.com/quests/42/hero.jpg");
    assert.equal(assetUrl("42", "quests/42/abc.png"), "https://cdn.discordapp.com/quests/42/abc.png");
    assert.equal(assetUrl("42", "https://example.com/a.png"), "https://example.com/a.png");
    assert.equal(assetUrl("42", undefined), undefined);
});

test("remaining time and deadlines are readable", () => {
    const video = { config: { taskConfig: { tasks: { WATCH_VIDEO: { target: 900 } } } }, userStatus: { progress: { WATCH_VIDEO: { value: 300 } } } };
    assert.equal(remainingSeconds(video), 600);
    assert.equal(remainingSeconds(video, 0.5), 450);
    assert.equal(remainingSeconds({ config: { taskConfig: { tasks: { ACHIEVEMENT_IN_GAME: { target: 1 } } } } }), undefined);
    assert.equal(formatDuration(600), "10 min");
    assert.equal(formatDuration(5400), "1 h 30");
    const now = Date.parse("2026-06-01T00:00:00Z");
    assert.deepEqual(timeLeft("2026-06-02T00:00:00Z", now), { text: "24 h", soon: true });
    assert.deepEqual(timeLeft("2026-06-11T00:00:00Z", now), { text: "10 j", soon: false });
});
