/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Read-only views of the state, shared by the engine and the interface

import { findByPropsLazy } from "@webpack";
import { UserStore } from "@webpack/common";

import { bulkExclusionReason, getQuestTask, HARDWARE_TASKS, isAvailable, isClaimable, primaryTask, questOrbs, remainingSeconds, VIDEO_TASKS } from "./catalog";
import { settings } from "./settings";
import { state } from "./state";

/** Discord PremiumType.TIER_2: the Orb multiplier is not part of Nitro Basic */
const NITRO = 2;

export const hasNitro = () => (UserStore.getCurrentUser() as any)?.premiumType === NITRO;

export type BoostStatus = "none" | "boosted" | "ineligible";

const PremiumUtils = findByPropsLazy("canUseMoreQuestOrbs");

/**
 * Discord’s own check, the one its quest cards use to show the boosted amount: it reads the account’s perks, so it is
 * true for Nitro with the perk and for Xbox Game Pass, false for Nitro obtained with Orbs. Undefined if it moved.
 */
export function discordBoostEligibility(): boolean | undefined {
    try {
        const user = UserStore.getCurrentUser();
        const check = PremiumUtils.canUseMoreQuestOrbs;
        if (!user || typeof check !== "function") return;
        return !!check.call(PremiumUtils, user);
    } catch {
        return;
    }
}

/**
 * Whether Orb amounts get the multiplier: Discord’s own eligibility check when it can be found, else what Discord paid
 * on past claims, then how the Nitro was obtained, then the Nitro itself.
 */
export function boostStatus(): BoostStatus {
    const nitro = hasNitro();
    switch (settings.store.nitroBoost) {
        case "on": return "boosted";
        case "off": return nitro ? "ineligible" : "none";
    }
    const eligible = discordBoostEligibility();
    if (eligible !== undefined) return eligible ? "boosted" : nitro ? "ineligible" : "none";
    if (!nitro) return "none";
    const { claimed, orbsNitro } = state.boost;
    if (claimed != null) return claimed ? "boosted" : "ineligible";
    return orbsNitro ? "ineligible" : "boosted";
}

/** Whether Orb amounts are shown with the Nitro multiplier */
export const orbBoost = () => boostStatus() === "boosted";

export function unavailableReason(quest: any): string | undefined {
    if (!isAvailable(quest)) return "Quête expirée ou indisponible";
    const task = getQuestTask(quest);
    if (!task) return "Type de quête non pris en charge";
    if (HARDWARE_TASKS.includes(task.name)) return "Nécessite un appareil réel";
    if (task.name === "ACHIEVEMENT_IN_GAME") return "Nécessite un objectif dans le jeu";
    const target = Number(task.config?.target);
    if (!Number.isFinite(target) || target <= 0) return "Objectif de quête invalide";
    if (!VIDEO_TASKS.includes(task.name) && !(IS_DISCORD_DESKTOP || IS_VESKTOP)) return "Nécessite Discord sur ordinateur";
    return;
}

export const bulkReason = (quest: any) => bulkExclusionReason(quest, primaryTask(quest), settings.store);

export const isCompleted = (quest: any) => !!quest.userStatus?.completedAt;
export const isClaimed = (quest: any) => !!quest.userStatus?.claimedAt || !!state.queue.jobs.get(quest.id)?.claimed;

function sortQuests(quests: any[]): any[] {
    const expiry = (q: any) => Date.parse(q.config.expiresAt);
    const started = (q: any) => Date.parse(q.config.startsAt ?? q.config.startedAt ?? 0) || 0;
    switch (settings.store.menuFilter) {
        case "expiring":
            return quests.sort((a, b) => expiry(a) - expiry(b));
        case "recent":
            return quests.sort((a, b) => started(b) - started(a));
        case "started":
            return quests.sort((a, b) => Number(!!b.userStatus?.enrolledAt) - Number(!!a.userStatus?.enrolledAt));
        case "orbs": {
            const nitro = orbBoost();
            return quests.sort((a, b) => (questOrbs(b, nitro)?.value ?? 0) - (questOrbs(a, nitro)?.value ?? 0));
        }
        default:
            // "suggested": Discord's own order
            return quests;
    }
}

/** Quests worth showing: available ones, plus finished ones whose reward can still be claimed */
export function getCatalog(): any[] {
    const quests = [...state.catalog.values()]
        .filter(quest => (isAvailable(quest) || isClaimable(quest)) && !isClaimed(quest))
        .map(quest => {
            // Our REST confirmation can be ahead of the store
            const job = state.queue.jobs.get(quest.id);
            if (job?.status !== "completed" || quest.userStatus?.completedAt) return quest;
            return { ...quest, userStatus: { ...quest.userStatus, completedAt: job.quest.userStatus?.completedAt ?? new Date().toISOString() } };
        });
    return sortQuests(quests);
}

/** Red badge: quests QC can still run */
export function eligibleCount(quests = getCatalog()) {
    return quests.filter(quest => !isCompleted(quest) && !unavailableReason(quest)).length;
}

/** Green badge: rewards waiting to be claimed */
export function claimableCount(quests = getCatalog()) {
    return quests.filter(isCompleted).length;
}

/** Orbs that the runnable quests, then the unclaimed rewards, would bring */
export function orbTotals(quests = getCatalog()) {
    const nitro = orbBoost();
    let toEarn = 0;
    let toClaim = 0;
    for (const quest of quests) {
        const orbs = questOrbs(quest, nitro)?.value ?? 0;
        if (isCompleted(quest)) toClaim += orbs;
        else if (!unavailableReason(quest)) toEarn += orbs;
    }
    return { toEarn, toClaim };
}

/** Seconds left for the running quest and everything waiting behind it */
export function queueEta(): number {
    const { current } = state.queue;
    let total = current?.status === "running" ? remainingSeconds(current.quest, current.progress) ?? 0 : 0;
    for (const job of state.queue.waiting()) total += remainingSeconds(state.catalog.get(job.id) ?? job.quest) ?? 0;
    return total;
}
