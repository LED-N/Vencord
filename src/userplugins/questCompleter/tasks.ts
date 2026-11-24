/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// How each kind of quest task is completed. The queue, the catalog and the rewards stay in index.tsx

import { ChannelStore, FluxDispatcher, GuildChannelStore, RestAPI, RunningGameStore } from "@webpack/common";

import { getQuestApplication, normalizeQuest, QuestJob } from "./catalog";
import { promptHumanCaptcha } from "./dialogs";
import { CaptchaRequired, currentAccountId, isAbort, logger, nameOf, Native, questsStore, toast } from "./runtime";
import { settings } from "./settings";
import { emit } from "./state";

/** Heartbeats without any confirmed progress before a quest is given up */
const MAX_STAGNANT = 6;

// Discord QuestContentType: "where the action was initiated" (analytics field
// required on enroll/claim). 1 = QUEST_BAR, the bar shown above the quest list.
const QUEST_LOCATION = 1;

export class AchievementCompletionError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "AchievementCompletionError";
    }
}

/** Puts Discord's game detection back as it was, see runDesktop */
let restoreGame: (() => void) | null = null;

export function restoreFakeGame() {
    restoreGame?.();
}

export interface EngineContext {
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

export function setProgress(job: QuestJob, detail: string, fraction: number | null) {
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

export async function enroll(ctx: EngineContext, quest: any) {
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

export async function runVideo(ctx: EngineContext, job: QuestJob, quest: any, taskName: string, target: number, done: number) {
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

export async function runDesktop(ctx: EngineContext, job: QuestJob, quest: any, taskName: string, taskConfig: any, target: number, done: number) {
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
        start: Date.now(),
        // BetterNotifications must not take it for a game being played
        vcQuestFake: true
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

export async function runSession(ctx: EngineContext, job: QuestJob, quest: any, taskName: string, taskConfig: any, target: number, done: number) {
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

export async function completeActivityAchievement(ctx: EngineContext, quest: any, taskName: string, taskConfig: any, target: number) {
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
