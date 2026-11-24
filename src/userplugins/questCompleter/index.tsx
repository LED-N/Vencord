/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";
import { migratePluginSettings } from "@api/Settings";
import { Button } from "@components/Button";
import ErrorBoundary from "@components/ErrorBoundary";
import definePlugin from "@utils/types";
import { createRoot, RestAPI, UserStore } from "@webpack/common";

import { getQuestTask, HARDWARE_TASKS, isClaimable, normalizeQuest, primaryTask, QuestJob, questOrbs, rewardSummary, waitFor } from "./catalog";
import { cancelDialogs, confirmActivityRisk, suspendMenu } from "./dialogs";
import { BOOST_KEY, checkOrbsNitro, fetchBalance, resetBalance, updateBoostEvidence } from "./orbs";
import { claimWithDiscord, hasDiscordDialog } from "./rewards";
import {
    abortError, announce, cancelLater, CaptchaRequired, clearTimers, currentAccountId, isAbort, later, logger, nameOf, questsStore, toast
} from "./runtime";
import { bulkReason, getCatalog, isCompleted, orbBoost, unavailableReason } from "./selectors";
import { PLUGIN_NAME, settings } from "./settings";
import { actions, emit, state } from "./state";
import managedStyle from "./styles.css?managed";
import {
    AchievementCompletionError, completeActivityAchievement, EngineContext, enroll, restoreFakeGame, runDesktop, runSession, runVideo, setProgress
} from "./tasks";
import { Launcher } from "./ui/Launcher";
import { QcRoot } from "./ui/Root";

migratePluginSettings(PLUGIN_NAME, "Quest Auto Completer");

const ROOT_ID = "qc-root";
const QUEUE_KEY = `${PLUGIN_NAME}-queue`;
const STATS_KEY = `${PLUGIN_NAME}-stats`;
/** Catalog fetches are reused for this long unless forced */
const CATALOG_TTL = 60_000;

// ── Lifecycle state ──────────────────────────────────────────────────────────

let lifecycle: AbortController | null = null;
let accountGeneration = 0;
let engineController: AbortController | null = null;
let fetchPending: Promise<void> | null = null;
let rewardTail: Promise<unknown> = Promise.resolve();
let rewardController = new AbortController();
let cleanup: (() => void) | null = null;
/** Activity-achievement quests the user accepted the risk for, this session */
const consented = new Set<string>();
/** Quests automatic starts already tried this session, so a failing one is not retried forever */
const autoTried = new Set<string>();

// ── Persistence ──────────────────────────────────────────────────────────────

function saveQueue() {
    if (!settings.store.resumeQueue) return;
    const { current } = state.queue;
    const ids = [...(current?.status === "running" ? [current.id] : []), ...state.queue.waiting().map(job => job.id)];
    DataStore.set(QUEUE_KEY, ids).catch(() => { });
}

function saveStats() {
    DataStore.set(STATS_KEY, state.stats).catch(() => { });
}

// ── Catalog ──────────────────────────────────────────────────────────────────

function mergeStore() {
    for (const quest of questsStore()?.quests?.values?.() ?? []) {
        if (!quest?.id || !quest.config) continue;
        const normalized = normalizeQuest(quest);
        const previous = state.catalog.get(quest.id)?.userStatus;
        // A gateway snapshot can lag behind our successful REST response
        normalized.userStatus = {
            ...normalized.userStatus,
            ...(previous?.completedAt ? { completedAt: previous.completedAt } : {}),
            ...(previous?.claimedAt ? { claimedAt: previous.claimedAt } : {})
        };
        state.catalog.set(quest.id, normalized);
    }
}

function sameSession(session: AbortController | null, generation: number, accountId: string | undefined) {
    return !!session && session === lifecycle && !session.signal.aborted && generation === accountGeneration && currentAccountId() === accountId;
}

async function fetchQuests(force = false): Promise<void> {
    if (fetchPending) return fetchPending;
    if (!force && state.catalogUpdated && Date.now() - state.catalogUpdated < CATALOG_TTL) return;

    const session = lifecycle;
    const generation = accountGeneration;
    const accountId = currentAccountId();
    if (!session || session.signal.aborted || !accountId) return;

    state.catalogError = "";
    state.loading = true;
    emit();

    fetchPending = (async () => {
        try {
            const response = await RestAPI.get({ url: "/quests/@me" });
            if (!sameSession(session, generation, accountId)) return;
            const body = response?.body ?? response;
            const quests = Array.isArray(body) ? body : body?.quests;
            if (!Array.isArray(quests)) throw new Error("format du catalogue inconnu");

            state.catalog.clear();
            for (const raw of quests) {
                const quest = normalizeQuest(raw);
                if (quest?.id && quest.config) state.catalog.set(quest.id, quest);
            }
            state.catalogUpdated = Date.now();
            updateBoostEvidence();
        } catch (error: any) {
            if (sameSession(session, generation, accountId))
                state.catalogError = `Actualisation impossible : ${error?.body?.message ?? error?.message ?? "erreur réseau"}. Réessaye avec ↻.`;
        } finally {
            if (sameSession(session, generation, accountId)) {
                fetchPending = null;
                state.loading = false;
                emit();
                scheduleAutoStart();
            }
        }
    })();
    return fetchPending;
}

// ── Menu ─────────────────────────────────────────────────────────────────────

function openMenu() {
    if (state.menuOpen) return;
    state.menuOpen = true;
    state.ui.view = "quests";
    emit();
    void fetchQuests();
    void fetchBalance();
}

function closeMenu() {
    if (!state.menuOpen) return;
    state.menuOpen = false;
    emit();
}

// ── Queue ────────────────────────────────────────────────────────────────────

async function enqueueQuests(quests: any[], source: QuestJob["source"] = "manual") {
    const session = lifecycle;
    const generation = accountGeneration;
    if (!session || session.signal.aborted) return;
    if (engineController?.signal.aborted) {
        toast("Arrêt en cours, relance la quête dans un instant.", "info");
        return;
    }

    const filtered = source === "bulk" || source === "automatic";
    let added = 0;
    for (const selected of quests) {
        const quest = state.catalog.get(selected.id) ?? selected;
        if (isCompleted(quest) || unavailableReason(quest) || (filtered && bulkReason(quest))) continue;

        if (primaryTask(quest) === "ACHIEVEMENT_IN_ACTIVITY" && !settings.store.achievementBypass) {
            // Only a deliberate, confirmed choice runs one without the global setting, and only that quest
            if (source !== "manual") continue;
            if (!consented.has(quest.id)) {
                if (!await confirmActivityRisk(quest, session.signal)) continue;
                if (session !== lifecycle || session.signal.aborted || generation !== accountGeneration) return;
                consented.add(quest.id);
            }
        }

        if (state.queue.add(quest, source)) added++;
    }

    emit();
    saveQueue();
    if (added && !state.running) void runEngine();
}

let autoTimer: ReturnType<typeof setTimeout> | null = null;

/** Automatic starts follow the "Add all" filters, and try each quest once per session */
function scheduleAutoStart() {
    if (!settings.store.autoStart || autoTimer != null) return;
    autoTimer = later(() => {
        autoTimer = null;
        if (!lifecycle || !settings.store.autoStart) return;

        const quests = getCatalog().filter(quest => !isCompleted(quest)
            && !autoTried.has(quest.id)
            && !state.queue.jobs.has(quest.id)
            && (settings.store.autoAccept || quest.userStatus?.enrolledAt)
            && !unavailableReason(quest)
            && !bulkReason(quest));
        quests.forEach(quest => autoTried.add(quest.id));
        if (quests.length) void enqueueQuests(quests, "automatic");
    }, 1000);
}

async function resumeSavedQueue() {
    if (!settings.store.resumeQueue) return;
    const ids = await DataStore.get<string[]>(QUEUE_KEY).catch(() => undefined);
    if (!ids?.length || !lifecycle) return;
    await fetchQuests();
    const quests = ids.map(id => state.catalog.get(id)).filter(Boolean);
    if (quests.length) {
        toast(`Reprise de la file : ${quests.length} quête${quests.length > 1 ? "s" : ""}.`, "info");
        void enqueueQuests(quests, "resume");
    }
}

function stopEngine() {
    state.queue.cancel();
    engineController?.abort();
    restoreFakeGame();
    emit();
    saveQueue();
}

// ── Rewards ──────────────────────────────────────────────────────────────────

/** Manual, grouped and automatic claims share one worker: one captcha and one native confirmation at a time */
async function claimQuests(quests: any[], signal?: AbortSignal): Promise<void> {
    const session = lifecycle;
    const generation = accountGeneration;
    for (const quest of quests) {
        if (session !== lifecycle || generation !== accountGeneration || signal?.aborted || !await claimReward(quest, signal)) break;
    }
}

function claimReward(quest: any, signal?: AbortSignal): Promise<boolean> {
    if (state.claiming.has(quest.id)) return Promise.resolve(false);
    const session = lifecycle;
    const generation = accountGeneration;
    const accountId = currentAccountId();
    const rewards = rewardController;
    if (!session || session.signal.aborted || !accountId) return Promise.resolve(false);

    state.claiming.add(quest.id);
    emit();

    const work = rewardTail.then(async () => {
        const check = () => {
            if (signal?.aborted || rewards.signal.aborted || !sameSession(session, generation, accountId)) throw abortError();
        };
        const controller = new AbortController();
        const abort = () => controller.abort();
        let release: (() => void) | undefined;
        signal?.addEventListener("abort", abort, { once: true });
        rewards.signal.addEventListener("abort", abort, { once: true });

        try {
            check();
            const latest = state.catalog.get(quest.id) ?? quest;
            if (latest.userStatus?.claimedAt || normalizeQuest(questsStore()?.getQuest?.(quest.id)?.userStatus)?.claimedAt) {
                markClaimed(latest);
                return true;
            }
            if (!isClaimable(latest)) throw new Error("Cette récompense n’est pas disponible ou a expiré.");
            if (hasDiscordDialog()) throw new Error("Ferme le dialogue Discord ouvert avant de récupérer une récompense.");

            // Discord's own claim modal takes the screen; the menu comes back with its tab, search and scroll
            release = suspendMenu();
            const { codeInQuests } = await claimWithDiscord(latest, questsStore(), controller.signal);
            if (codeInQuests) toast("Code récupéré : il est affiché dans l’onglet Quêtes de Discord.", "info", 8000);
            check();
            markClaimed(latest);
            return true;
        } catch (error: any) {
            if (!isAbort(error)) {
                const job = state.queue.jobs.get(quest.id);
                if (job?.status === "completed") job.detail = "Récompense à récupérer";
                toast(error?.message ?? "Récupération impossible. Réessaye depuis le menu.", "warn", 6000);
            }
            return false;
        } finally {
            signal?.removeEventListener("abort", abort);
            rewards.signal.removeEventListener("abort", abort);
            release?.();
            if (session === lifecycle && generation === accountGeneration && !session.signal.aborted) {
                state.claiming.delete(quest.id);
                emit();
            }
        }
    });
    rewardTail = work.catch(() => false);
    return work;
}

function markClaimed(quest: any) {
    const cached = state.catalog.get(quest.id) ?? quest;
    const now = new Date().toISOString();
    cached.userStatus = { ...cached.userStatus, completedAt: cached.userStatus?.completedAt ?? now, claimedAt: now };
    state.catalog.set(quest.id, cached);

    const job = state.queue.jobs.get(quest.id);
    if (job) {
        job.claimed = true;
        job.detail = "";
    }

    const orbs = questOrbs(cached, orbBoost())?.value;
    if (orbs) {
        state.stats = { ...state.stats, orbs: state.stats.orbs + orbs };
        saveStats();
    }
    toast(`Récompense récupérée : ${rewardSummary(cached, orbBoost())}`, "success");
    emit();

    // Discord's status update says what was really paid: fixes the statistics, teaches the multiplier, refreshes the balance
    later(() => {
        const actual = Number(normalizeQuest(questsStore()?.getQuest?.(quest.id)?.userStatus)?.orbQuantityClaimed);
        if (orbs && Number.isFinite(actual) && actual > 0 && actual !== orbs) {
            state.stats = { ...state.stats, orbs: Math.max(0, state.stats.orbs - orbs + actual) };
            saveStats();
        }
        mergeStore();
        updateBoostEvidence();
        void fetchBalance(true);
        emit();
    }, 2500);
}

// ── Engine ───────────────────────────────────────────────────────────────────

async function runAchievement(ctx: EngineContext, job: QuestJob, quest: any, taskName: string, taskConfig: any, target: number, done: number) {
    setProgress(job, "Objectif d’activité en cours", done / target);
    await completeActivityAchievement(ctx, quest, taskName, taskConfig, target);

    // Only the catalog can tell whether Discord accepted it
    for (let attempt = 0; attempt < 5; attempt++) {
        await fetchQuests(true);
        ctx.check();
        const status = state.catalog.get(quest.id)?.userStatus;
        if (status?.completedAt || status?.progress?.[taskName]?.value >= target) return;
        await ctx.sleep(2000);
    }
    throw new AchievementCompletionError("Discord n’a pas confirmé l’objectif");
}

function completeJob(job: QuestJob, quest: any) {
    const cached = state.catalog.get(quest.id) ?? quest;
    cached.userStatus = { ...cached.userStatus, completedAt: new Date().toISOString() };
    state.catalog.set(quest.id, cached);

    job.quest = cached;
    job.status = "completed";
    job.progress = 1;
    job.detail = "Terminée · récompense à récupérer";
    state.stats = { ...state.stats, quests: state.stats.quests + 1 };
    saveStats();

    const reward = rewardSummary(cached, orbBoost());
    toast(`Quête terminée : ${nameOf(cached)} · ${reward}`, "success");
    announce(quest.id, "Quête terminée", `${nameOf(cached)} · ${reward}`);
    emit();
}

function reportError(job: QuestJob, error: any) {
    if (isAbort(error)) throw error;
    job.status = "failed";
    job.detail = error?.message ?? "Erreur inconnue";
    logger.error(`Failed: ${nameOf(job.quest)}`, error);

    const name = nameOf(job.quest);
    if (error instanceof CaptchaRequired) toast(`Captcha non résolu : ${name} ignorée.`, "warn");
    else if (String(error?.message).includes("404")) toast(`Quête expirée : ${name}`, "error");
    else toast(`${name} : ${job.detail}`, "error", 7000);
    emit();
}

function skip(job: QuestJob, detail: string, notify = false) {
    job.status = "skipped";
    job.detail = detail;
    if (notify) toast(`${nameOf(job.quest)} ignorée : ${detail}`, "warn", 6000);
    emit();
}

async function runJob(ctx: EngineContext, job: QuestJob) {
    const quest = state.catalog.get(job.id) ?? job.quest;
    job.quest = quest;

    if (isCompleted(quest)) {
        job.status = "completed";
        job.detail = "Déjà terminée";
        return;
    }

    const taskName = primaryTask(quest);
    const achievementAllowed = settings.store.achievementBypass || consented.has(quest.id);
    const reason = unavailableReason(quest)
        ?? (job.source === "bulk" || job.source === "automatic" ? bulkReason(quest) : undefined)
        ?? (taskName === "ACHIEVEMENT_IN_ACTIVITY" && !achievementAllowed ? "Objectifs d’activité non autorisés" : undefined);
    if (reason) return skip(job, reason);

    const { name, config } = getQuestTask(quest)!;
    const target = Number(config?.target);
    const done = quest.userStatus?.progress?.[name]?.value ?? 0;
    if (HARDWARE_TASKS.includes(name)) return skip(job, "Nécessite un appareil réel", true);

    try {
        setProgress(job, "Acceptation de la quête…", done / target);
        await enroll(ctx, quest);

        if (name === "WATCH_VIDEO" || name === "WATCH_VIDEO_ON_MOBILE") await runVideo(ctx, job, quest, name, target, done);
        else if (name === "PLAY_ON_DESKTOP") await runDesktop(ctx, job, quest, name, config, target, done);
        else if (name === "PLAY_ACTIVITY" || name === "STREAM_ON_DESKTOP") await runSession(ctx, job, quest, name, config, target, done);
        else if (name === "ACHIEVEMENT_IN_ACTIVITY") await runAchievement(ctx, job, quest, name, config, target, done);
        else return skip(job, "Type de quête non pris en charge", true);

        completeJob(job, quest);
        if (settings.store.autoClaim) {
            await claimReward(state.catalog.get(quest.id) ?? quest, ctx.signal);
            ctx.check();
        }
    } catch (error) {
        reportError(job, error);
    }
}

async function runEngine() {
    if (state.running || !state.queue.waiting().length || !lifecycle) return;
    const session = lifecycle;
    const generation = accountGeneration;
    const accountId = currentAccountId();
    const controller = new AbortController();
    engineController = controller;
    state.running = true;
    emit();

    const ctx: EngineContext = {
        signal: controller.signal,
        check() {
            if (controller.signal.aborted || !sameSession(session, generation, accountId)) throw abortError();
        },
        sleep: ms => waitFor(ms, controller.signal)
    };

    let finished = 0;
    try {
        for (let job = state.queue.take(); job; job = state.queue.take()) {
            saveQueue();
            ctx.check();
            await runJob(ctx, job);
            if (job.status === "running") skip(job, "Quête non prise en charge");
            if (job.status === "completed") finished++;
        }
        if (finished > 1) toast(`File terminée : ${finished} quêtes terminées.`, "success");
    } catch (error: any) {
        if (!isAbort(error)) {
            if (state.queue.current) reportError(state.queue.current, error);
            state.queue.cancel();
        }
    } finally {
        restoreFakeGame();
        if (engineController === controller) {
            engineController = null;
            state.running = false;
            state.queue.pruneHistory();
            saveQueue();
            emit();
        }
    }
}

// ── Plugin ───────────────────────────────────────────────────────────────────

/** Stops what is in flight and forgets everything tied to the account: on an account switch, and when the plugin stops */
function resetSession() {
    stopEngine();
    cancelDialogs();
    rewardController.abort();
    rewardController = new AbortController();
    state.claiming.clear();
    state.catalog.clear();
    state.queue.clear();
    state.catalogUpdated = 0;
    state.catalogError = "";
    state.menuOpen = false;
    state.suspended = 0;
    state.loading = false;
    fetchPending = null;
    consented.clear();
    autoTried.clear();
    state.balance = null;
    state.boost = {};
    resetBalance();
}

function onKeydown(event: KeyboardEvent) {
    if (event.key !== "Escape" || hasDiscordDialog()) return;

    if (state.dialog?.type === "risk") state.dialog.resolve(false);
    else if (state.menuOpen && !state.suspended) {
        if (state.ui.view === "settings") state.ui.view = "quests";
        else state.menuOpen = false;
        emit();
    } else return;

    event.preventDefault();
    event.stopPropagation();
}

const renderLauncher = (place: "header" | "account") => ErrorBoundary.wrap(() => <Launcher place={place} />, { noop: true });
const HeaderLauncher = renderLauncher("header");
const AccountLauncher = renderLauncher("account");

// The name must stay a literal right after "definePlugin({" (the build reads it to name the native helper), equal to PLUGIN_NAME
export default definePlugin({
    name: "CompleteDiscordQuests",
    description: "Catalogue de quêtes Discord classé par récompense : lance les quêtes choisies dans une file modifiable, et récupère les récompenses",
    authors: [{ name: "Aseoriy", id: 0n }, { name: "LEDEN", id: 224552140117508096n }],
    settings,
    managedStyle,

    patches: [
        {
            // Title bar, next to Vencord's toolbox when it is enabled (both patches tolerate each other)
            find: '?"BACK_FORWARD_NAVIGATION":',
            replacement: {
                match: /(trailing:.{0,50}?(?:\i\.Fragment|Vencord\.Plugins\.plugins\[[^\]]+\]\.TrailingWrapper),\{children:\[)/,
                replace: "$1$self.renderHeaderLauncher(),"
            }
        },
        {
            // Account panel, next to the mute / deafen / settings buttons (after GameActivityToggle's button if any)
            find: "#{intl::USER_PROFILE_ACCOUNT_POPOUT_BUTTON_A11Y_LABEL}",
            replacement: {
                match: /children:\[(?=(?:Vencord\.Plugins\.plugins\[[^\]]+\]\.\i\(arguments\[0\]\),)*.{0,25}?accountContainerRef)/,
                replace: "children:[$self.renderAccountLauncher(),"
            }
        }
    ],

    renderHeaderLauncher: () => <HeaderLauncher key="qc-header-launcher" />,
    renderAccountLauncher: () => <AccountLauncher key="qc-account-launcher" />,

    settingsAboutComponent: () => (
        <Button onClick={() => actions.openMenu()}>Ouvrir les quêtes</Button>
    ),

    start() {
        const session = lifecycle = new AbortController();
        Object.assign(actions, {
            openMenu,
            closeMenu,
            refresh: () => void fetchQuests(true),
            enqueue: (quests: any[], bulk?: boolean) => void enqueueQuests(quests, bulk ? "bulk" : "manual"),
            stop: stopEngine,
            remove: (id: string) => { state.queue.remove(id); emit(); saveQueue(); },
            moveUp: (id: string) => { state.queue.moveUp(id); emit(); saveQueue(); },
            claim: (quests: any[]) => void claimQuests(quests),
            blocked: unavailableReason,
            bulkExcluded: bulkReason
        });

        const host = document.createElement("div");
        host.id = ROOT_ID;
        document.body.append(host);
        const root = createRoot(host);
        root.render(<ErrorBoundary noop><QcRoot /></ErrorBoundary>);

        // One wakeup at the next start / expiry in the catalog, instead of polling
        let boundaryTimer: ReturnType<typeof setTimeout> | null = null;
        let nextBoundary = 0;
        const watchBoundaries = () => {
            const now = Date.now();
            const next = Math.min(...[...state.catalog.values()].flatMap(quest => [
                Date.parse(quest.config.startsAt), Date.parse(quest.config.expiresAt), Date.parse(quest.config.rewardsConfig?.rewardsExpireAt)
            ]).filter(time => time > now));
            if (next === nextBoundary) return;
            cancelLater(boundaryTimer);
            nextBoundary = next;
            boundaryTimer = Number.isFinite(next)
                ? later(() => { nextBoundary = 0; emit(); watchBoundaries(); }, Math.min(next - now + 50, 2_147_483_647))
                : null;
        };

        const store = questsStore();
        const onQuestsChange = () => {
            mergeStore();
            updateBoostEvidence();
            watchBoundaries();
            emit();
            scheduleAutoStart();
        };
        mergeStore();
        watchBoundaries();
        store?.addChangeListener?.(onQuestsChange);

        let currentAccount = currentAccountId();
        const onAccountChange = () => {
            const next = currentAccountId();
            if (next === currentAccount) return;
            currentAccount = next;
            accountGeneration++;
            resetSession();
            emit();
            if (next) {
                void fetchQuests(true);
                void loadBoost();
            }
        };
        UserStore.addChangeListener(onAccountChange);
        document.addEventListener("keydown", onKeydown, true);

        DataStore.get(STATS_KEY).then(stats => {
            if (stats && session === lifecycle) {
                state.stats = { orbs: Number(stats.orbs) || 0, quests: Number(stats.quests) || 0 };
                emit();
            }
        }).catch(() => { });

        const loadBoost = async () => {
            const accountId = currentAccountId();
            const saved = await DataStore.get<Record<string, boolean>>(BOOST_KEY).catch(() => undefined);
            if (session !== lifecycle || currentAccountId() !== accountId) return;
            if (accountId && typeof saved?.[accountId] === "boolean" && state.boost.claimed == null) {
                state.boost = { ...state.boost, claimed: saved[accountId] };
                emit();
            }
            updateBoostEvidence();
            void checkOrbsNitro();
        };
        void loadBoost();

        // The badges need the catalog; otherwise it loads when the menu opens
        if (settings.store.showBadges || settings.store.autoStart) void fetchQuests();
        void fetchBalance();
        void resumeSavedQueue();
        logger.info("started");

        cleanup = () => {
            session.abort();
            resetSession();
            store?.removeChangeListener?.(onQuestsChange);
            UserStore.removeChangeListener(onAccountChange);
            document.removeEventListener("keydown", onKeydown, true);
            clearTimers();
            autoTimer = null;
            root.unmount();
            host.remove();
            state.toasts = [];
            state.dialog = null;
            state.running = false;
            lifecycle = null;
            emit();
        };
    },

    stop() {
        cleanup?.();
        cleanup = null;
    }
});

