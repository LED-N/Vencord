/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Pure quest helpers, without Discord imports, so they can be tested with node.

// REST uses snake_case; Discord's stores generally expose camelCase.
export function normalizeQuest(value: any): any {
    if (Array.isArray(value)) return value.map(normalizeQuest);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [
        key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()),
        normalizeQuest(child)
    ]));
}

// ── Tasks ──────────────────────────────────────────────────────────────────────

/** Playtime / time-gated tasks driven by progress heartbeats */
export const TIME_TASKS = ["WATCH_VIDEO", "WATCH_VIDEO_ON_MOBILE", "PLAY_ON_DESKTOP", "STREAM_ON_DESKTOP", "PLAY_ACTIVITY"];
export const ACHIEVEMENT_TASKS = ["ACHIEVEMENT_IN_ACTIVITY", "ACHIEVEMENT_IN_GAME"];
/** Tasks that require real hardware */
export const HARDWARE_TASKS = ["PLAY_ON_MOBILE", "PLAY_ON_XBOX", "PLAY_ON_PLAYSTATION"];
export const ALL_TASKS = [...TIME_TASKS, ...ACHIEVEMENT_TASKS, ...HARDWARE_TASKS];
export const VIDEO_TASKS = ["WATCH_VIDEO", "WATCH_VIDEO_ON_MOBILE"];

function taskConfig(quest: any): any {
    const v1 = quest?.config?.taskConfig;
    // Some transition-era quests include an empty legacy config alongside the
    // populated V2 one. Prefer whichever config actually contains tasks.
    return Object.keys(v1?.tasks ?? {}).length ? v1 : quest?.config?.taskConfigV2 ?? v1;
}

/** Older quests use taskConfig and newer ones taskConfigV2; a malformed quest yields undefined instead of throwing */
export function getQuestTask(quest: any): { name: string; config: any; } | undefined {
    const tasks = taskConfig(quest)?.tasks;
    if (!tasks) return;

    const name = ALL_TASKS.find(task => tasks[task] != null);
    return name ? { name, config: tasks[name] } : undefined;
}

export const primaryTask = (quest: any): string | undefined => getQuestTask(quest)?.name;

/** Newer configs keep the application id on the task itself and may omit the top-level name */
export function getQuestApplication(quest: any, config = getQuestTask(quest)?.config): { id?: string; name?: string; } {
    const app = quest?.config?.application ?? quest?.application;
    const taskApp = config?.applications?.[0] ?? config?.application;
    const messages = quest?.config?.messages ?? {};

    return {
        id: taskApp?.id ?? app?.id,
        name: app?.name ?? messages.gameTitle ?? config?.messages?.gameTitle
    };
}

export type TaskKind = "video" | "game" | "stream" | "activity" | "achievement" | "device";

export function taskKind(name: string | undefined): TaskKind {
    if (!name) return "game";
    if (name.includes("VIDEO")) return "video";
    if (name.includes("ACHIEVEMENT")) return "achievement";
    if (name === "STREAM_ON_DESKTOP") return "stream";
    if (name === "PLAY_ACTIVITY") return "activity";
    if (HARDWARE_TASKS.includes(name)) return "device";
    return "game";
}

export const TASK_LABELS: Record<TaskKind, string> = {
    video: "Vidéo", game: "Jeu", stream: "Streaming", activity: "Activité", achievement: "Objectif", device: "Console / mobile"
};

/** Target and current progress of the quest's task, in seconds for time tasks */
export function taskProgress(quest: any): { target: number; done: number; } {
    const task = getQuestTask(quest);
    const target = Number(task?.config?.target) || 0;
    const done = Number(task && quest?.userStatus?.progress?.[task.name]?.value) || 0;
    return { target, done: Math.min(done, target || done) };
}

/** Seconds of work left, undefined when it is not a time task */
export function remainingSeconds(quest: any, fraction?: number): number | undefined {
    const name = primaryTask(quest);
    if (!name || !TIME_TASKS.includes(name)) return;

    const { target, done } = taskProgress(quest);
    if (!target) return;
    const progress = fraction != null ? Math.max(done, fraction * target) : done;
    return Math.max(0, Math.ceil(target - progress));
}

export function formatDuration(seconds: number): string {
    if (seconds < 60) return `${Math.max(1, Math.round(seconds))} s`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes} min`;
    const hours = Math.floor(minutes / 60);
    return minutes % 60 ? `${hours} h ${minutes % 60}` : `${hours} h`;
}

/** "dans 3 j", "dans 5 h"; `soon` below 48 hours */
export function timeLeft(iso: string | undefined, now = Date.now()): { text: string; soon: boolean; } | undefined {
    const at = Date.parse(iso ?? "");
    if (!Number.isFinite(at)) return;

    const ms = at - now;
    if (ms <= 0) return { text: "expirée", soon: true };
    const hours = ms / 3_600_000;
    const text = hours < 1 ? `${Math.max(1, Math.round(ms / 60_000))} min` : hours < 48 ? `${Math.round(hours)} h` : `${Math.round(hours / 24)} j`;
    return { text, soon: hours < 48 };
}

// ── Rewards ────────────────────────────────────────────────────────────────────

/** Discord QuestRewardType */
export const REWARD_CODE = 1;
export const REWARD_IN_GAME = 2;
export const REWARD_COLLECTIBLE = 3;
export const REWARD_ORBS = 4;
export const REWARD_NITRO = 5;

export const REWARD_GROUPS = [
    { key: "orbs", label: "Orbs", types: [REWARD_ORBS] },
    { key: "decorations", label: "Décorations", types: [REWARD_COLLECTIBLE] },
    { key: "game", label: "En jeu", types: [REWARD_IN_GAME] },
    { key: "codes", label: "Codes", types: [REWARD_CODE] },
    { key: "nitro", label: "Nitro", types: [REWARD_NITRO] },
    { key: "other", label: "Autres", types: [] }
] as const;

export function questRewards(quest: any): any[] {
    return quest?.config?.rewardsConfig?.rewards ?? quest?.config?.rewards ?? [];
}

export function rewardGroups(quest: any): string[] {
    const rewards = questRewards(quest);
    const groups = REWARD_GROUPS.filter(group => rewards.some(reward => (group.types as readonly number[]).includes(reward.type)))
        .map(group => group.key as string);
    if (!rewards.length || rewards.some(reward => !REWARD_GROUPS.some(group => (group.types as readonly number[]).includes(reward.type)))) {
        groups.push("other");
    }
    return groups;
}

export interface OrbAmount {
    /** What this account receives */
    value: number;
    base: number;
    /** Nitro multiplier, e.g. 1.2, when it applies */
    multiplier?: number;
}

/**
 * Orbs of a reward for this account. Discord sends the Nitro amount alongside the regular one (premiumOrbQuantity)
 * and shows it to Nitro subscribers with a "x1.2" badge.
 */
export function orbsOf(reward: any, nitro: boolean): OrbAmount | undefined {
    if (reward?.type !== REWARD_ORBS) return;
    const base = Number(reward.orbQuantity);
    if (!Number.isFinite(base) || base <= 0) return;

    const premium = Number(reward.premiumOrbQuantity);
    if (nitro && Number.isFinite(premium) && premium > base)
        return { value: premium, base, multiplier: Math.round(premium / base * 10) / 10 };
    return { value: base, base };
}

/** Discord QuestFeature: the quest opts out of the Nitro Orb multiplier */
export const NO_PREMIUM_ORBS_PERK = 38;

/** Whether the Nitro multiplier can apply to this quest at all */
export function questBoostable(quest: any): boolean {
    const features: unknown = quest?.config?.features;
    return !(Array.isArray(features) && features.includes(NO_PREMIUM_ORBS_PERK));
}

/** Orb rewards that would differ with the multiplier, and still could get it */
function boostableReward(quest: any) {
    if (!questBoostable(quest)) return;
    return questRewards(quest).find(reward => reward?.type === REWARD_ORBS
        && Number(reward.premiumOrbQuantity) > Number(reward.orbQuantity) && Number(reward.orbQuantity) > 0);
}

/**
 * What the last claimed quest with a Nitro amount tells about this account: true when Discord paid the boosted amount,
 * false when it paid the regular one (Nitro obtained with Orbs or Nitro credits does not get the multiplier),
 * undefined without such a claim.
 */
export function boostEvidence(quests: Iterable<any>): boolean | undefined {
    let latest: { at: number; boosted: boolean; } | undefined;
    for (const quest of quests) {
        const claimed = Number(quest?.userStatus?.orbQuantityClaimed);
        const at = Date.parse(quest?.userStatus?.claimedAt ?? "");
        const reward = boostableReward(quest);
        if (!reward || !Number.isFinite(claimed) || claimed <= 0 || !Number.isFinite(at)) continue;
        if (questRewards(quest).filter(r => r?.type === REWARD_ORBS).length !== 1) continue;

        const boosted = claimed >= Number(reward.premiumOrbQuantity) ? true : claimed <= Number(reward.orbQuantity) ? false : undefined;
        if (boosted !== undefined && (!latest || at > latest.at)) latest = { at, boosted };
    }
    return latest?.boosted;
}

export function questOrbs(quest: any, nitro: boolean): OrbAmount | undefined {
    // Once claimed, Discord says what was really paid
    const claimed = Number(quest?.userStatus?.orbQuantityClaimed);
    const boost = nitro && questBoostable(quest);
    let total: OrbAmount | undefined;
    for (const reward of questRewards(quest)) {
        const orbs = orbsOf(reward, boost);
        if (!orbs) continue;
        total = total
            ? { value: total.value + orbs.value, base: total.base + orbs.base, multiplier: total.multiplier ?? orbs.multiplier }
            : orbs;
    }
    if (total && quest?.userStatus?.claimedAt && Number.isFinite(claimed) && claimed > 0) {
        return claimed > total.base
            ? { value: claimed, base: total.base, multiplier: Math.round(claimed / total.base * 10) / 10 }
            : { value: claimed, base: total.base };
    }
    return total;
}

export function formatNumber(value: number) {
    return value.toLocaleString("fr-FR");
}

/** The reward as Discord words it ("Récupère 240 Orbs"), one entry per reward */
export function rewardLabels(quest: any, nitro: boolean): string[] {
    const rewards = questRewards(quest);
    const single = rewards.filter(reward => reward?.type === REWARD_ORBS).length === 1;
    return rewards.map(reward => {
        // With a single Orb reward, the quest total includes what Discord really paid once claimed
        const orbs = single && reward?.type === REWARD_ORBS ? questOrbs(quest, nitro) : orbsOf(reward, nitro && questBoostable(quest));
        if (orbs) return `${formatNumber(orbs.value)} Orbs`;
        if (reward.type === REWARD_NITRO && reward.quantity) return `${reward.quantity} jours de Nitro`;
        return reward.messages?.name ?? REWARD_GROUPS.find(group => (group.types as readonly number[]).includes(reward.type))?.label ?? "Récompense";
    });
}

export function rewardSummary(quest: any, nitro = false): string {
    return rewardLabels(quest, nitro).join(" · ") || "Récompense à découvrir";
}

// ── Assets ─────────────────────────────────────────────────────────────────────

const CDN = "https://cdn.discordapp.com";

/** Quest assets are names relative to the quest's CDN folder, full CDN paths or, rarely, absolute URLs */
export function assetUrl(questId: string, asset: string | undefined | null): string | undefined {
    if (!asset || typeof asset !== "string") return;
    if (/^https?:\/\//.test(asset)) return asset;
    if (asset.startsWith("quests/")) return `${CDN}/${asset}`;
    return `${CDN}/quests/${questId}/${asset}`;
}

const VIDEO = /\.(mp4|webm|mov)(\?|$)/i;
const image = (url: string | undefined) => url && !VIDEO.test(url) ? url : undefined;

export function questArt(quest: any): { hero?: string; logo?: string; tile?: string; reward?: string; colors?: [string, string]; } {
    const assets = quest?.config?.assets ?? {};
    const id = quest?.id;
    const colors = quest?.config?.colors;
    const rewardAsset = questRewards(quest).find(reward => reward.type !== REWARD_ORBS && reward.asset)?.asset;

    return {
        hero: image(assetUrl(id, assets.questBarHero ?? assets.hero)),
        logo: image(assetUrl(id, assets.logotypeDark ?? assets.logotype)),
        tile: image(assetUrl(id, assets.gameTileDark ?? assets.gameTile)),
        reward: image(assetUrl(id, rewardAsset)),
        colors: colors?.primary && colors?.secondary ? [colors.primary, colors.secondary] : undefined
    };
}

// ── Availability ───────────────────────────────────────────────────────────────

export function isAvailable(quest: any, now = Date.now()): boolean {
    if (!quest?.id || !quest.config || quest.preview) return false;
    const start = quest.config.startsAt ? Date.parse(quest.config.startsAt) : 0;
    return start <= now && Date.parse(quest.config.expiresAt) > now;
}

export function isClaimable(quest: any, now = Date.now()): boolean {
    if (!quest?.userStatus?.completedAt || quest.userStatus.claimedAt || quest.preview) return false;
    const deadline = quest.config?.rewardsConfig?.rewardsExpireAt ?? quest.config?.expiresAt;
    return Date.parse(deadline) > now;
}

const TASK_SETTINGS: Record<string, [string, string]> = {
    WATCH_VIDEO: ["farmVideo", "Vidéos"], WATCH_VIDEO_ON_MOBILE: ["farmVideo", "Vidéos"],
    PLAY_ON_DESKTOP: ["farmDesktop", "Jeux sur ordinateur"], STREAM_ON_DESKTOP: ["farmStreaming", "Streaming"],
    PLAY_ACTIVITY: ["farmActivities", "Activités"], ACHIEVEMENT_IN_ACTIVITY: ["achievementBypass", "Objectifs d’activité"]
};
const REWARD_SETTINGS: Record<number, [string, string]> = {
    [REWARD_CODE]: ["farmRewardCodes", "Codes à échanger"], [REWARD_IN_GAME]: ["farmInGame", "Récompenses en jeu"],
    [REWARD_COLLECTIBLE]: ["farmDecorations", "Décorations"], [REWARD_ORBS]: ["farmOrbs", "Orbs"], [REWARD_NITRO]: ["farmFractionalPremium", "Nitro"]
};

/** Why "Add all" (and automatic starts) leave this quest out, undefined when the filters allow it */
export function bulkExclusionReason(quest: any, task: string | undefined, settings: Record<string, unknown>): string | undefined {
    const excluded: string[] = [];
    const option = task ? TASK_SETTINGS[task] : undefined;
    if (option && !settings[option[0]]) excluded.push(option[1]);
    const rewards = questRewards(quest);
    if (rewards.length && !rewards.some(reward => !REWARD_SETTINGS[reward.type] || settings[REWARD_SETTINGS[reward.type][0]])) {
        excluded.push(...new Set(rewards.map(reward => REWARD_SETTINGS[reward.type][1])));
    }
    return excluded.length ? `Exclue de « Tout ajouter » : ${excluded.map(label => `« ${label} »`).join(", ")} désactivé dans les réglages. Ajout manuel possible.` : undefined;
}

// ── Queue ──────────────────────────────────────────────────────────────────────

export type JobStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "skipped";
export interface QuestJob {
    id: string;
    quest: any;
    status: JobStatus;
    progress: number;
    detail: string;
    claimed: boolean;
    /** "resume": restored after a restart, treated like a manual choice */
    source: "manual" | "bulk" | "automatic" | "resume";
}

// A single worker owns Discord's game/session overrides. Pending jobs can be
// added, removed or reordered while it is waiting for a heartbeat.
export class QuestQueue {
    readonly jobs = new Map<string, QuestJob>();
    private pending: string[] = [];
    current: QuestJob | null = null;

    add(quest: any, source: QuestJob["source"] = "manual"): boolean {
        const previous = this.jobs.get(quest.id);
        if (previous && ["queued", "running", "completed"].includes(previous.status)) return false;
        this.jobs.delete(quest.id);
        this.jobs.set(quest.id, { id: quest.id, quest, status: "queued", progress: 0, detail: "En attente", claimed: false, source });
        this.pending.push(quest.id);
        return true;
    }

    take(): QuestJob | undefined {
        const id = this.pending.shift();
        const job = id ? this.jobs.get(id) : undefined;
        this.current = job ?? null;
        if (job) job.status = "running";
        return job;
    }

    waiting(): QuestJob[] {
        return this.pending.map(id => this.jobs.get(id)!);
    }

    remove(id: string) {
        this.pending = this.pending.filter(value => value !== id);
        const job = this.jobs.get(id);
        if (job?.status === "queued") this.jobs.delete(id);
    }

    moveUp(id: string) {
        const index = this.pending.indexOf(id);
        if (index > 0) [this.pending[index - 1], this.pending[index]] = [this.pending[index], this.pending[index - 1]];
    }

    cancel() {
        for (const job of this.jobs.values()) {
            if (job.status === "queued" || job.status === "running") {
                job.status = "cancelled";
                job.detail = "Arrêtée";
            }
        }
        this.pending = [];
    }

    pruneHistory(limit = 20) {
        const history = [...this.jobs.values()].filter(job => job !== this.current && !["queued", "running"].includes(job.status));
        for (const job of history.slice(0, Math.max(0, history.length - limit))) this.jobs.delete(job.id);
    }

    clear() {
        this.cancel();
        this.jobs.clear();
        this.current = null;
    }
}

export function waitFor(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal.aborted) return reject(new DOMException("Arrêt demandé", "AbortError"));
        const abort = () => {
            clearTimeout(timer);
            signal.removeEventListener("abort", abort);
            reject(new DOMException("Arrêt demandé", "AbortError"));
        };
        const timer = setTimeout(() => {
            signal.removeEventListener("abort", abort);
            resolve();
        }, ms);
        signal.addEventListener("abort", abort, { once: true });
    });
}
