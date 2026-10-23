/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";
import { isPluginEnabled, plugins } from "@api/PluginManager";
import { migratePluginSettings } from "@api/Settings";
import { Button } from "@components/Button";
import ErrorBoundary from "@components/ErrorBoundary";
import { Logger } from "@utils/Logger";
import definePlugin, { PluginNative } from "@utils/types";
import { findByProps } from "@webpack";
import { ChannelStore, createRoot, Flux, FluxDispatcher, GuildChannelStore, RestAPI, RunningGameStore, UserStore } from "@webpack/common";

import {
    boostEvidence, getQuestApplication, getQuestTask, HARDWARE_TASKS, isClaimable, normalizeQuest, primaryTask, QuestJob, questOrbs,
    rewardSummary, waitFor
} from "./catalog";
import { claimWithDiscord, hasDiscordDialog } from "./rewards";
import { bulkReason, discordBoostEligibility, getCatalog, hasNitro, isCompleted, orbBoost, unavailableReason } from "./selectors";
import { PLUGIN_NAME, settings } from "./settings";
import { actions, Dialog, emit, state, ToastType } from "./state";
import managedStyle from "./styles.css?managed";
import { Launcher } from "./ui/Launcher";
import { QcRoot } from "./ui/Root";

migratePluginSettings(PLUGIN_NAME, "Quest Auto Completer");

const Native = VencordNative.pluginHelpers[PLUGIN_NAME] as PluginNative<typeof import("./native")>;
const logger = new Logger(PLUGIN_NAME, "#C084FC");

const ROOT_ID = "qc-root";
const QUEUE_KEY = `${PLUGIN_NAME}-queue`;
const STATS_KEY = `${PLUGIN_NAME}-stats`;
/** What past claims taught about the Nitro multiplier, by account id */
const BOOST_KEY = `${PLUGIN_NAME}-boost`;
const BALANCE_TTL = 60_000;
/** Discord EntitlementType: bought in the Shop with Orbs; PREMIUM_SUBSCRIPTION: a paid Nitro subscription */
const ENTITLEMENT_VIRTUAL_CURRENCY = 12;
const ENTITLEMENT_PREMIUM_SUBSCRIPTION = 2;
/** Catalog fetches are reused for this long unless forced */
const CATALOG_TTL = 60_000;
/** Heartbeats without any confirmed progress before a quest is given up */
const MAX_STAGNANT = 6;

// Discord QuestContentType: "where the action was initiated" (analytics field
// required on enroll/claim). 1 = QUEST_BAR, the bar shown above the quest list.
const QUEST_LOCATION = 1;

class CaptchaRequired extends Error {
    constructor() {
        super("Captcha requis");
    }
}

class AchievementCompletionError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "AchievementCompletionError";
    }
}

const abortError = () => new DOMException("Arrêt demandé", "AbortError");
const isAbort = (error: any) => error?.name === "AbortError";
const currentAccountId = (): string | undefined => UserStore.getCurrentUser()?.id;
const nameOf = (quest: any): string => quest?.config?.messages?.questName ?? quest?.config?.application?.name ?? "Quête";

// ── Lifecycle state ──────────────────────────────────────────────────────────

let lifecycle: AbortController | null = null;
let accountGeneration = 0;
let engineController: AbortController | null = null;
let restoreGame: (() => void) | null = null;
let fetchPending: Promise<void> | null = null;
let rewardTail: Promise<unknown> = Promise.resolve();
let rewardController = new AbortController();
let cleanup: (() => void) | null = null;
/** Activity-achievement quests the user accepted the risk for, this session */
const consented = new Set<string>();
/** Quests automatic starts already tried this session, so a failing one is not retried forever */
const autoTried = new Set<string>();
const cancelDialogs = new Set<() => void>();
const timers = new Set<ReturnType<typeof setTimeout>>();

function later(action: () => void, delay: number) {
    const timer = setTimeout(() => {
        timers.delete(timer);
        action();
    }, delay);
    timers.add(timer);
    return timer;
}

function cancelLater(timer: ReturnType<typeof setTimeout> | null) {
    if (timer == null) return;
    clearTimeout(timer);
    timers.delete(timer);
}

// ── Toasts and announcements ─────────────────────────────────────────────────

let toastId = 0;

function toast(text: string, type: ToastType = "info", ttl = 4500) {
    const id = ++toastId;
    state.toasts = [...state.toasts.slice(-3), { id, text, type }];
    emit();
    later(() => {
        state.toasts = state.toasts.map(t => t.id === id ? { ...t, leaving: true } : t);
        emit();
        later(() => {
            state.toasts = state.toasts.filter(t => t.id !== id);
            emit();
        }, 250);
    }, ttl);
}

/** A card in BetterNotifications' overlay, visible over games; false when that plugin is not running */
function announce(id: string, title: string, text: string) {
    if (!settings.store.overlayNotify || !isPluginEnabled("BetterNotifications")) return false;
    try {
        return !!(plugins.BetterNotifications as any).showExternal?.({ id: `qc-${id}-${Date.now()}`, title, subtitle: "Quêtes", text });
    } catch (e) {
        logger.error("BetterNotifications announcement failed", e);
        return false;
    }
}

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

let questsStoreCache: any = null;
function questsStore(): any {
    return questsStoreCache ??= findByProps("getQuest");
}

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

// ── Orbs: Nitro multiplier and balance ──────────────────────────────────────

/** Learns from what Discord really paid whether this account gets the Nitro multiplier, and remembers it per account */
function updateBoostEvidence() {
    const evidence = boostEvidence(state.catalog.values());
    if (evidence === undefined || evidence === state.boost.claimed) return;
    state.boost = { ...state.boost, claimed: evidence };
    const accountId = currentAccountId();
    if (accountId) DataStore.update<Record<string, boolean>>(BOOST_KEY, all => ({ ...all, [accountId]: evidence })).catch(() => { });
    emit();
}

/**
 * Until a claim tells, the entitlements do: Nitro bought in the Shop with Orbs is an entitlement redeemed with virtual
 * currency, and does not get the multiplier although the account shows as Nitro.
 */
async function checkOrbsNitro() {
    const accountId = currentAccountId();
    // Discord’s own eligibility check makes this guess unnecessary
    if (!hasNitro() || state.boost.claimed != null || !accountId || discordBoostEligibility() !== undefined) return;
    try {
        const response = await RestAPI.get({ url: "/users/@me/entitlements", query: { with_sku: true, exclude_ended: true } });
        const entitlements = response?.body ?? response;
        if (!Array.isArray(entitlements) || currentAccountId() !== accountId) return;

        const now = Date.now();
        const active = (e: any) => !e?.deleted && (!e?.ends_at || Date.parse(e.ends_at) > now);
        const premium = (e: any) => e?.subscription_plan != null || /nitro/i.test(e?.sku?.name ?? "");
        const boughtWithOrbs = entitlements.some(e => active(e) && e.type === ENTITLEMENT_VIRTUAL_CURRENCY && premium(e));
        const paid = entitlements.some(e => active(e) && e.type === ENTITLEMENT_PREMIUM_SUBSCRIPTION);
        state.boost = { ...state.boost, orbsNitro: boughtWithOrbs && !paid };
        emit();
    } catch (error) {
        logger.info("Entitlements unavailable, the Nitro multiplier will be confirmed by the next claim", error);
    }
}

let balanceFetchedAt = 0;
let balanceWarned = false;

/** Discord keeps the balance shown in Quest Home and the Shop in a store; its name is not documented */
function balanceFromStores(): number | undefined {
    try {
        for (const store of (Flux.Store as any).getAll?.() ?? []) {
            if (!/virtualcurrency|orb/i.test(store?.getName?.() ?? "")) continue;
            for (const key of ["getBalance", "getVirtualCurrencyBalance", "getOrbsBalance", "getOrbBalance"]) {
                if (typeof store[key] !== "function") continue;
                const value = store[key]();
                const amount = Number(typeof value === "object" ? value?.balance ?? value?.amount : value);
                if (value != null && Number.isFinite(amount)) return amount;
            }
            if (Number.isFinite(store.balance)) return store.balance;
        }
    } catch { }
}

async function fetchBalance(force = false) {
    if (!force && Date.now() - balanceFetchedAt < BALANCE_TTL) return;
    balanceFetchedAt = Date.now();
    const accountId = currentAccountId();

    let balance = balanceFromStores();
    if (balance == null) {
        try {
            const response = await RestAPI.get({ url: "/users/@me/virtual-currency/balance" });
            const body = response?.body ?? response;
            const amount = Number(body?.balance ?? body?.amount);
            if (Number.isFinite(amount)) balance = amount;
        } catch { }
    }

    if (currentAccountId() !== accountId) return;
    if (balance == null) {
        if (!balanceWarned) {
            balanceWarned = true;
            const names = ((Flux.Store as any).getAll?.() ?? []).map((store: any) => store?.getName?.()).filter((name: string) => /currency|orb|wallet|balance/i.test(name ?? ""));
            logger.info("Orb balance not found; stores that look related:", names);
        }
        return;
    }
    if (balance !== state.balance) {
        state.balance = balance;
        emit();
    }
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

/** Hides the menu until the returned function is called; overlapping reasons stack */
function suspendMenu() {
    state.suspended++;
    emit();
    let released = false;
    return () => {
        if (released) return;
        released = true;
        state.suspended = Math.max(0, state.suspended - 1);
        emit();
    };
}

function closeMenu() {
    if (!state.menuOpen) return;
    state.menuOpen = false;
    emit();
}

/** Shows a QC dialog; resolves false when dismissed, stopped or superseded by an account change */
function askDialog(make: (resolve: (value: boolean) => void) => Dialog, signal: AbortSignal): Promise<boolean> {
    return new Promise(resolve => {
        if (signal.aborted || state.dialog) {
            if (state.dialog) toast("Une confirmation est déjà ouverte.", "info");
            resolve(false);
            return;
        }

        let settled = false;
        const finish = (value: boolean) => {
            if (settled) return;
            settled = true;
            signal.removeEventListener("abort", abort);
            cancelDialogs.delete(abort);
            if (state.dialog === dialog) state.dialog = null;
            emit();
            resolve(value);
        };
        const abort = () => finish(false);
        const dialog = make(finish);

        signal.addEventListener("abort", abort, { once: true });
        cancelDialogs.add(abort);
        state.dialog = dialog;
        emit();
    });
}

function confirmActivityRisk(quest: any, signal: AbortSignal) {
    return askDialog(resolve => ({ type: "risk", quest, resolve }), signal);
}

/** Human-in-the-loop captcha: QC never solves it, it waits for the user to solve Discord's own */
async function promptHumanCaptcha(label: string, signal: AbortSignal) {
    const release = suspendMenu();
    try {
        const solved = await askDialog(resolve => ({ type: "captcha", label, resolve }), signal);
        if (signal.aborted) throw abortError();
        if (!solved) throw new CaptchaRequired();
    } finally {
        release();
    }
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
    restoreGame?.();
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

interface EngineContext {
    signal: AbortSignal;
    check(): void;
    sleep(ms: number): Promise<void>;
}

const isCaptchaBody = (body: any) => !!(body?.captcha_key || body?.captcha_sitekey || body?.captcha_service);

/** Discord's own HTTP client: same headers and fingerprint as the real client */
async function api(ctx: EngineContext, url: string, body: any) {
    ctx.check();
    try {
        const response = await RestAPI.post({ url, body });
        ctx.check();
        return normalizeQuest(response?.body ?? response);
    } catch (error: any) {
        ctx.check();
        const errorBody = error?.body ?? error?.response?.body;
        if (isCaptchaBody(errorBody)) throw new CaptchaRequired();
        throw new Error(errorBody?.message || error?.message || `La requête ${url} a échoué`);
    }
}

/** On a captcha, lets the user solve Discord's real one, then retries once */
async function withCaptcha<T>(ctx: EngineContext, label: string, action: () => Promise<T>): Promise<T> {
    try {
        return await action();
    } catch (error) {
        if (!(error instanceof CaptchaRequired)) throw error;
        if (!settings.store.captchaVerification) {
            toast(`Captcha demandé pour ${label} : active « Captcha » dans les réglages pour le résoudre.`, "warn", 6000);
            throw error;
        }
        await promptHumanCaptcha(label, ctx.signal);
        return await action();
    }
}

function setProgress(job: QuestJob, detail: string, fraction: number | null) {
    job.detail = detail;
    if (fraction != null) job.progress = Math.max(0, Math.min(1, fraction));
    emit();
}

/** Shared by every time task: send, report, give up after MAX_STAGNANT answers without progress, wait, repeat */
async function heartbeatLoop(ctx: EngineContext, job: QuestJob, options: {
    target: number;
    done: number;
    interval: number;
    detail: string;
    send(progress: number): Promise<number>;
}) {
    const { target, interval, detail, send } = options;
    let progress = options.done;
    let stagnant = 0;
    setProgress(job, detail, progress / target);

    while (progress < target) {
        ctx.check();
        const previous = progress;
        progress = await send(progress);
        setProgress(job, detail, progress / target);
        if (progress >= target) break;

        stagnant = progress > previous ? 0 : stagnant + 1;
        if (stagnant >= MAX_STAGNANT) throw new Error("Aucune progression confirmée par Discord");
        await ctx.sleep(interval);
    }
}

/** Discord encodes the current user as the stream owner; guild channels use a different prefix from private calls */
function activityStreamKey(): string | undefined {
    const ownerId = currentAccountId();
    if (!ownerId) return;

    const privateChannelId = (ChannelStore as any).getSortedPrivateChannels?.()?.[0]?.id;
    if (privateChannelId) return `call:${privateChannelId}:${ownerId}`;

    const guilds: any[] = Object.values((GuildChannelStore as any).getAllGuilds?.() ?? {});
    for (const guild of guilds) {
        const voiceChannel = guild?.VOCAL?.[0]?.channel;
        const guildId = voiceChannel?.guild_id ?? voiceChannel?.guildId ?? guild?.id;
        if (guildId && voiceChannel?.id) return `guild:${guildId}:${voiceChannel.id}:${ownerId}`;
    }
}

async function enroll(ctx: EngineContext, quest: any) {
    if (quest.userStatus?.enrolledAt) return;
    // A deliberate selection always enrolls, independently of autoAccept. Never report progress after a failed enrollment.
    const status = await withCaptcha(ctx, `l’acceptation de ${nameOf(quest)}`, () => {
        ctx.check();
        const enrolled = normalizeQuest(questsStore()?.getQuest?.(quest.id)?.userStatus);
        return enrolled?.enrolledAt ? Promise.resolve(enrolled) : api(ctx, `/quests/${quest.id}/enroll`, {
            location: QUEST_LOCATION,
            metadata_sealed: quest.metadataSealed ?? null,
            traffic_metadata_sealed: quest.trafficMetadataSealed ?? null
        });
    });
    quest.userStatus = { ...quest.userStatus, ...status, enrolledAt: status?.enrolledAt ?? new Date().toISOString() };
}

async function runVideo(ctx: EngineContext, job: QuestJob, quest: any, taskName: string, target: number, done: number) {
    await heartbeatLoop(ctx, job, {
        target, done, interval: 10_000, detail: "Vidéo en cours",
        async send(progress) {
            // Discord refuses timestamps ahead of the time elapsed since enrollment
            const enrolled = Date.parse(quest.userStatus?.enrolledAt ?? "") || Date.now();
            const ceiling = Math.floor((Date.now() - enrolled) / 1000) + 10;
            const timestamp = Math.min(progress + 10, target, ceiling);
            const response = await withCaptcha(ctx, nameOf(quest), () => api(ctx, `/quests/${quest.id}/video-progress`, { timestamp }));
            const reported = response?.progress?.[taskName]?.value;
            if (response?.completedAt || reported >= target) return target;
            if (timestamp >= target) throw new Error("Discord n’a pas confirmé la fin de la vidéo");
            return typeof reported === "number" ? reported : timestamp;
        }
    });
}

async function runDesktop(ctx: EngineContext, job: QuestJob, quest: any, taskName: string, taskConfig: any, target: number, done: number) {
    const store = RunningGameStore as any;
    const { id: applicationId, name: applicationName } = getQuestApplication(quest, taskConfig);
    if (!store?.getRunningGames || !FluxDispatcher) throw new Error("Module de détection des jeux de Discord indisponible");
    if (!applicationId || !applicationName) throw new Error("Discord n’a pas fourni les informations du jeu");

    // Objectives inside the game are validated by its own servers: only the playtime can be completed here
    if (taskConfig?.objectives?.length > 0)
        toast(`${nameOf(quest)} a aussi des objectifs en jeu : le temps de jeu sera validé, lance le jeu pour les objectifs.`, "warn", 7000);

    const exeName = applicationName.replace(/[/\\:*?"<>|]/g, "").replace(/\s/g, "") + ".exe";
    const pid = Math.floor(Math.random() * 30000) + 1000;
    const fakeGame = {
        cmdLine: `C:\\Program Files\\${applicationName}\\${exeName}`,
        exeName,
        exePath: `c:/program files/${applicationName.toLowerCase()}/${exeName}`,
        hidden: false,
        isLauncher: false,
        id: applicationId,
        name: applicationName,
        pid,
        pidPath: [pid],
        processName: applicationName,
        start: Date.now()
    };

    // Games Discord is already tracking, including those started during the quest, stay visible
    const realGetRunningGames = store.getRunningGames;
    const realGetGameForPID = store.getGameForPID;
    const fakeGetRunningGames = () => [...realGetRunningGames.call(store).filter((game: any) => game.pid !== pid), fakeGame];
    const fakeGetGameForPID = (p: any) => p === pid ? fakeGame : realGetGameForPID?.call(store, p);
    store.getRunningGames = fakeGetRunningGames;
    store.getGameForPID = fakeGetGameForPID;

    let restored = false;
    const restore = () => {
        if (restored) return;
        restored = true;
        if (store.getRunningGames === fakeGetRunningGames) store.getRunningGames = realGetRunningGames;
        if (store.getGameForPID === fakeGetGameForPID) store.getGameForPID = realGetGameForPID;
        FluxDispatcher.dispatch({ type: "RUNNING_GAMES_CHANGE", removed: [fakeGame], added: [], games: store.getRunningGames() } as any);
        if (restoreGame === restore) restoreGame = null;
    };
    restoreGame = restore;

    try {
        FluxDispatcher.dispatch({ type: "RUNNING_GAMES_CHANGE", removed: [], added: [fakeGame], games: fakeGetRunningGames() } as any);
        await heartbeatLoop(ctx, job, {
            target, done, interval: 30_000, detail: `Jeu : ${applicationName}`,
            async send() {
                const response = await withCaptcha(ctx, nameOf(quest), () => api(ctx, `/quests/${quest.id}/heartbeat`, { application_id: applicationId, terminal: false }));
                const reported = response?.progress?.[taskName]?.value;
                if (typeof reported === "number") return reported;
                if (response?.completedAt) return target;
                throw new Error("Discord n’a renvoyé aucune progression de jeu");
            }
        });
        await api(ctx, `/quests/${quest.id}/heartbeat`, { application_id: applicationId, terminal: true });
    } finally {
        restore();
    }
}

async function runSession(ctx: EngineContext, job: QuestJob, quest: any, taskName: string, taskConfig: any, target: number, done: number) {
    const applicationId = getQuestApplication(quest, taskConfig).id;
    if (!applicationId) throw new Error("Discord n’a pas fourni les informations de l’activité");
    const streamKey = activityStreamKey();
    if (!streamKey) throw new Error("Impossible de créer une session d’activité (aucun MP ni salon vocal)");

    const activity = taskName === "PLAY_ACTIVITY";
    await heartbeatLoop(ctx, job, {
        target, done, interval: activity ? 20_000 : 30_000, detail: activity ? "Activité en cours" : "Streaming en cours",
        async send() {
            const response = await withCaptcha(ctx, nameOf(quest), () => api(ctx, `/quests/${quest.id}/heartbeat`, { stream_key: streamKey, application_id: applicationId, terminal: false }));
            const reported = response?.progress?.[taskName]?.value;
            if (typeof reported === "number") return reported;
            if (response?.completedAt != null) return target;
            throw new Error("Discord n’a renvoyé aucune progression d’activité");
        }
    });
    await api(ctx, `/quests/${quest.id}/heartbeat`, { stream_key: streamKey, application_id: applicationId, terminal: true });
}

async function listOAuthGrants(): Promise<any[]> {
    const response = await RestAPI.get({ url: "/oauth2/tokens" });
    const grants = response?.body ?? response;
    if (!Array.isArray(grants)) throw new AchievementCompletionError("Discord a renvoyé une liste d’applications autorisées invalide");
    return grants;
}

/** Revokes the authorizations this quest created, only on the account they were created on */
async function cleanupAchievementGrants(accountId: string, applicationId: string, previousGrantIds: Set<string>) {
    const sameAccount = () => currentAccountId() === accountId;
    if (!sameAccount()) return "account-changed";

    const grants = await listOAuthGrants();
    if (!sameAccount()) return "account-changed";

    const created = grants.filter(grant => grant?.application?.id === applicationId
        && typeof grant?.id === "string" && /^\d+$/.test(grant.id) && !previousGrantIds.has(grant.id));
    for (const grant of created) {
        if (!sameAccount()) return "account-changed";
        await RestAPI.del({ url: `/oauth2/tokens/${grant.id}` });
    }
    return "cleaned";
}

async function completeActivityAchievement(ctx: EngineContext, quest: any, taskName: string, taskConfig: any, target: number) {
    const applicationId = String(getQuestApplication(quest, taskConfig).id ?? "");
    const questId = String(quest?.id ?? "");
    if (!/^\d+$/.test(applicationId) || !/^\d+$/.test(questId))
        throw new AchievementCompletionError("Discord n’a pas fourni d’informations valides sur l’activité");

    const accountId = currentAccountId();
    if (!accountId) throw new AchievementCompletionError("compte Discord introuvable");
    const ensureSameAccount = () => {
        ctx.check();
        if (currentAccountId() !== accountId) throw new AchievementCompletionError("le compte Discord a changé pendant la quête");
    };

    // Some activity achievements accept an ordinary quest heartbeat: try that harmless path first
    const streamKey = activityStreamKey();
    if (streamKey) {
        try {
            const response = await api(ctx, `/quests/${questId}/heartbeat`, { stream_key: streamKey, application_id: applicationId, terminal: false });
            ensureSameAccount();
            const progress = response?.progress?.[taskName]?.value;
            if ((typeof progress === "number" && progress >= target) || response?.completedAt != null) {
                await api(ctx, `/quests/${questId}/heartbeat`, { stream_key: streamKey, application_id: applicationId, terminal: true }).catch(() => { });
                ensureSameAccount();
                return;
            }
        } catch (error) {
            if (error instanceof AchievementCompletionError || isAbort(error)) throw error;
            // A rejected heartbeat is expected for app-tracked achievements: continue with the activity flow
        }
    }

    let previousGrantIds: Set<string> | undefined;
    try {
        ensureSameAccount();
        const grants = await listOAuthGrants();
        ensureSameAccount();
        previousGrantIds = new Set(grants.filter(grant => grant?.application?.id === applicationId && typeof grant?.id === "string").map(grant => grant.id));

        const authorizeResponse = await RestAPI.post({
            url: "/oauth2/authorize",
            query: { response_type: "code", client_id: applicationId, scope: "identify applications.commands applications.entitlements" },
            body: {
                permissions: "0",
                authorize: true,
                integration_type: 1,
                location_context: { guild_id: "10000", channel_id: "10000", channel_type: 10000 }
            }
        });
        ensureSameAccount();

        const location = authorizeResponse?.body?.location;
        const authCode = typeof location === "string" ? new URL(location, "https://discord.com").searchParams.get("code") : null;
        if (!authCode) throw new AchievementCompletionError("Discord n’a pas renvoyé de code d’autorisation");

        const ticketResponse = await RestAPI.post({ url: `/applications/${applicationId}/proxy-tickets`, body: {} });
        ensureSameAccount();
        const proxyTicket = ticketResponse?.body?.ticket;
        if (typeof proxyTicket !== "string" || !proxyTicket) throw new AchievementCompletionError("Discord n’a pas renvoyé de ticket d’activité");

        if (typeof Native?.authorizeActivityAchievement !== "function" || typeof Native?.reportActivityAchievement !== "function")
            throw new AchievementCompletionError("le module natif d’activité est indisponible");

        const referrer = `https://${applicationId}.discordsays.com/?instance_id=quest-completer&platform=desktop&discord_proxy_ticket=${encodeURIComponent(proxyTicket)}`;
        const authorization = await Native.authorizeActivityAchievement({ appId: applicationId, questId, authCode, referrer });
        ensureSameAccount();
        if (!authorization.ok) throw new AchievementCompletionError(`l’autorisation de l’activité a échoué (${authorization.status || "erreur réseau"})`);

        let token: string | undefined;
        try {
            const parsed = JSON.parse(authorization.body);
            if (typeof parsed?.token === "string" && parsed.token) token = parsed.token;
        } catch {
            throw new AchievementCompletionError("l’activité a renvoyé une réponse d’autorisation invalide");
        }
        if (!token) throw new AchievementCompletionError("l’activité n’a pas renvoyé de jeton");

        const progressResponse = await Native.reportActivityAchievement({ appId: applicationId, questId, token, target, referrer });
        ensureSameAccount();
        if (!progressResponse.ok) throw new AchievementCompletionError(`l’activité a refusé l’objectif (${progressResponse.status || "erreur réseau"})`);
    } catch (error: any) {
        if (error instanceof AchievementCompletionError || isAbort(error)) throw error;
        const code = error?.body?.code ?? error?.response?.body?.code;
        if (code === 50165) throw new AchievementCompletionError("l’activité est soumise à une limite d’âge ou indisponible pour ce compte");
        throw new AchievementCompletionError("Discord a refusé la demande d’objectif d’activité");
    } finally {
        if (previousGrantIds) {
            try {
                if (await cleanupAchievementGrants(accountId, applicationId, previousGrantIds) === "account-changed")
                    toast("Le compte a changé avant la vérification de l’autorisation temporaire. Vérifie Paramètres → Applications autorisées.", "warn", 10_000);
            } catch (error: any) {
                logger.error("Temporary activity authorization cleanup failed", error?.message ?? error);
                toast("Impossible de vérifier la révocation de l’autorisation temporaire. Vérifie Paramètres → Applications autorisées.", "warn", 10_000);
            }
        }
    }
}

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
        restoreGame?.();
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
            stopEngine();
            for (const cancel of cancelDialogs) cancel();
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
            balanceFetchedAt = 0;
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
            rewardController.abort();
            rewardController = new AbortController();
            stopEngine();
            restoreGame?.();
            for (const cancel of cancelDialogs) cancel();
            store?.removeChangeListener?.(onQuestsChange);
            UserStore.removeChangeListener(onAccountChange);
            document.removeEventListener("keydown", onKeydown, true);
            for (const timer of timers) clearTimeout(timer);
            timers.clear();
            autoTimer = null;
            root.unmount();
            host.remove();
            state.catalog.clear();
            state.queue.clear();
            state.claiming.clear();
            state.toasts = [];
            state.dialog = null;
            state.balance = null;
            state.boost = {};
            balanceFetchedAt = 0;
            state.catalogUpdated = 0;
            state.catalogError = "";
            state.loading = false;
            state.running = false;
            state.menuOpen = false;
            state.suspended = 0;
            fetchPending = null;
            lifecycle = null;
            consented.clear();
            autoTried.clear();
            emit();
        };
    },

    stop() {
        cleanup?.();
        cleanup = null;
    }
});

