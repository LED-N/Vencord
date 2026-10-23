/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { filters, find, findByProps, wreq } from "@webpack";
import { createRoot, React, RestAPI } from "@webpack/common";

import { normalizeQuest, questRewards, REWARD_CODE } from "./catalog";

const DIALOGS = '[data-mana-component="modal"], [role="dialog"], [role="alertdialog"]';
export const hasDiscordDialog = () => [...document.querySelectorAll(DIALOGS)].some(element => !element.closest("#qc-root"));

/** Discord QuestContentType QUEST_BAR, and QuestRewardPlatform CROSS_PLATFORM */
const QUEST_LOCATION = 1;
const CROSS_PLATFORM = 0;

/**
 * Discord's claim-button hook, in the main bundle: it checks the account verification, then opens the reward modal
 * matching the reward type, which claims and lets Discord's request layer show the captcha.
 * The analytics name "quest_claim_reward" it used to be found by is gone since an October 2026 Discord update.
 */
const CLAIM_HOOK_FILTERS = [
    filters.byCode("hasVerifiedEmailOrPhone", "CLAIM_REWARD", "sourceQuestContent"),
    filters.byCode("quest_claim_reward", "sourceQuestContent")
];

/** Discord's own claim action (request, store updates, captcha), used when the hook cannot be found */
const claimActionFilter = filters.byCode("QUESTS_CLAIM_REWARD_BEGIN");

function findExport(filter: (module: any) => boolean): any {
    const loaded = find(filter, { isIndirect: true });
    if (loaded) return loaded;
    // The factory may be loaded but not executed yet
    const entry = Object.entries(wreq.m).find(([, factory]) => filter(factory));
    if (!entry) return;
    const exports = wreq(entry[0]);
    return filter(exports) ? exports : Object.values(exports).find(filter);
}

function findClaimHook(): any {
    for (const filter of CLAIM_HOOK_FILTERS) {
        try {
            const hook = findExport(filter);
            if (hook) return hook;
        } catch { }
    }
}

/**
 * Without Discord's window: the claim itself, through Discord's action when it can be found (it keeps the stores and the
 * captcha handling), else a plain request. The reward is granted either way; only the confirmation window is skipped.
 */
async function claimDirectly(quest: any) {
    let action: any;
    try { action = findExport(claimActionFilter); } catch { }

    try {
        const body = typeof action === "function"
            ? await action(quest.id, CROSS_PLATFORM, QUEST_LOCATION)
            : normalizeQuest((await RestAPI.post({
                url: `/quests/${quest.id}/claim-reward`,
                body: { platform: CROSS_PLATFORM, location: QUEST_LOCATION, metadata_sealed: null, traffic_metadata_sealed: null }
            }))?.body);
        if (body?.errors?.length) throw new Error(body.errors[0]?.message ?? "Discord a refusé la récupération");
    } catch (error: any) {
        const body = error?.body ?? error?.response?.body;
        throw new Error(body?.message ?? error?.message ?? "Récupération impossible. Réessaye depuis l’onglet Quêtes.");
    }
}

/**
 * Claims through Discord's own claim-button hook whenever possible: it selects the reward modal, checks account
 * verification and lets Discord own the human captcha and the confirmation.
 */
export async function claimWithDiscord(quest: any, store: any, signal: AbortSignal): Promise<{ codeInQuests: boolean; }> {
    if (hasDiscordDialog()) throw new Error("Ferme le dialogue Discord ouvert avant de récupérer une récompense.");

    const hook = findClaimHook();
    if (hook) {
        await openNativeReward(hook, quest, store, signal);
        return { codeInQuests: false };
    }

    await claimDirectly(quest);
    // A code is only shown by Discord's window: it stays readable in the Quests tab
    return { codeInQuests: questRewards(quest).some(reward => reward?.type === REWARD_CODE) };
}

function openNativeReward(useClaimReward: any, quest: any, store: any, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal.aborted) return reject(new DOMException("Arrêt demandé", "AbortError"));
        const host = document.createElement("div");
        host.hidden = true;
        document.body.append(host);
        const root = createRoot(host);
        const dispatcher = findByProps("flushWaitQueue");
        let claimedByDiscord = false;
        let seenDialog = false;
        let settled = false;
        let closeTimer: ReturnType<typeof setTimeout> | undefined;
        const finish = (error?: Error) => {
            if (settled) return;
            settled = true;
            clearTimeout(openTimer);
            clearTimeout(closeTimer);
            observer.disconnect();
            dispatcher?.unsubscribe?.("QUESTS_CLAIM_REWARD_SUCCESS", onClaimed);
            store?.removeChangeListener?.(inspect);
            signal.removeEventListener("abort", abort);
            // An error boundary/effect can call finish during a React commit.
            queueMicrotask(() => { root.unmount(); host.remove(); });
            if (error) reject(error); else resolve();
        };
        const inspect = () => {
            if (settled) return;
            clearTimeout(closeTimer);
            if (hasDiscordDialog()) {
                seenDialog = true;
                clearTimeout(openTimer);
            } else if (seenDialog) {
                // Allow Discord's transition from captcha to reward to settle.
                closeTimer = setTimeout(() => {
                    if (hasDiscordDialog()) return inspect();
                    const claimed = normalizeQuest(store?.getQuest?.(quest.id)?.userStatus)?.claimedAt;
                    finish(claimed || claimedByDiscord ? undefined : new Error("Récupération interrompue. La récompense reste à récupérer."));
                }, 250);
            }
        };
        const observer = new MutationObserver(inspect);
        const onClaimed = (event: any) => {
            if (event.questId === quest.id) claimedByDiscord = true;
        };
        dispatcher?.subscribe?.("QUESTS_CLAIM_REWARD_SUCCESS", onClaimed);
        observer.observe(document.getElementById("app-mount") ?? document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["role", "data-mana-component"] });
        store?.addChangeListener?.(inspect);
        const abort = () => finish(new DOMException("Arrêt demandé", "AbortError"));
        signal.addEventListener("abort", abort, { once: true });
        const openTimer = setTimeout(() => finish(new Error("Discord n’a pas ouvert la récupération. Réessaye depuis Quests.")), 15_000);
        function NativeClaim() {
            const claim = useClaimReward({ quest: store?.getQuest?.(quest.id) ?? quest, questContent: 1 });
            React.useEffect(() => {
                if (!signal.aborted && !settled) {
                    try { claim(); inspect(); } catch (error) { finish(error as Error); }
                }
            }, []);
            return null;
        }
        class ClaimBoundary extends React.Component<React.PropsWithChildren> {
            state = { failed: false };
            static getDerivedStateFromError() { return { failed: true }; }
            componentDidCatch(error: Error) { finish(error); }
            render() { return this.state.failed ? null : this.props.children; }
        }
        root.render(<ClaimBoundary><NativeClaim /></ClaimBoundary>);
    });
}
