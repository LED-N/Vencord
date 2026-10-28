/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { Channel } from "@vencord/discord-types";
import { ChannelStore, GuildStore, UserStore } from "@webpack/common";

/**
 * What lets a message through, decided separately for the card and for the sound.
 * "discord": what Discord itself would notify (mutes, server notification settings, Do Not Disturb)
 * "all": every message, even in muted places
 * "mentions": only the mention kinds chosen, even in muted places
 * "friends": what Discord would notify, from friends only
 */
export type Level = "discord" | "all" | "mentions" | "friends" | "none";
/** The sound can also simply follow the notification */
export type SoundLevel = Level | "same";
/** "me" also covers replies that ping, "keywords" the keyword list */
export type MentionKind = "me" | "roles" | "everyone" | "keywords";
export type RuleKind = "guild" | "channel" | "user";
export type SourceKind = "servers" | "dms" | "groups";

export const MENTION_KINDS: MentionKind[] = ["me", "roles", "everyone", "keywords"];

/** Undefined fields inherit from the broader scope, and in the end from the source settings */
export interface Rule {
    kind: RuleKind;
    /** Shown in the list when the server, channel or user is not cached */
    name?: string;
    /** Server of a channel rule, to list it under its server even when the channel is not cached */
    guildId?: string;
    notify?: Level;
    sound?: SoundLevel;
    mentions?: MentionKind[];
    priority?: boolean;
    /** Temporary silence, timestamp in milliseconds */
    snoozedUntil?: number;
}

export type Rules = Record<string, Rule>;

export interface Defaults {
    notify: Level;
    sound: SoundLevel;
    mentions: MentionKind[];
}

export interface Resolved {
    notify: Level;
    sound: Level;
    mentions: MentionKind[];
    priority: boolean;
    snoozed: boolean;
}

export function sourceOf(channel: Channel): SourceKind {
    if (channel.isDM()) return "dms";
    if (channel.isGroupDM()) return "groups";
    return "servers";
}

/** From the most specific scope to the broadest: author, channel, parents (thread parent, category), server */
export function scopeChain(authorId: string | undefined, channel: Channel): string[] {
    const ids = authorId ? [authorId, channel.id] : [channel.id];
    let parentId = channel.parent_id;
    while (parentId && !ids.includes(parentId)) {
        ids.push(parentId);
        parentId = ChannelStore.getChannel(parentId)?.parent_id;
    }
    if (channel.guild_id) ids.push(channel.guild_id);
    return ids;
}

export function resolve(rules: Rules, chain: string[], defaults: Defaults, now = Date.now()): Resolved {
    let notify: Level | undefined;
    let sound: SoundLevel | undefined;
    let mentions: MentionKind[] | undefined;
    let priority: boolean | undefined;

    for (const id of chain) {
        const rule = rules[id];
        if (!rule) continue;

        // A silence anywhere in the chain wins, whatever the more specific rules say
        if (rule.snoozedUntil && rule.snoozedUntil > now)
            return { notify: "none", sound: "none", mentions: [], priority: false, snoozed: true };

        notify ??= rule.notify;
        sound ??= rule.sound;
        mentions ??= rule.mentions;
        priority ??= rule.priority;
    }

    notify ??= defaults.notify;
    sound ??= defaults.sound;
    return {
        notify,
        sound: sound === "same" ? notify : sound,
        mentions: mentions ?? defaults.mentions,
        priority: !!priority,
        snoozed: false
    };
}

/** A rule with nothing left to say is dropped instead of being kept around */
export function isEmpty(rule: Rule, now = Date.now()) {
    return rule.notify == null && rule.sound == null && rule.mentions == null && !rule.priority
        && !(rule.snoozedUntil && rule.snoozedUntil > now);
}

/**
 * A plain deep copy. Values read from settings.store are proxies, and a spread copy keeps the nested ones:
 * once stored, they cannot be sent to the main process to be saved, which threw before the change listeners ran
 * (the settings page then stopped refreshing after the first change, and the rules were not written to disk).
 */
function plainCopy(rules: Rules): Rules {
    return JSON.parse(JSON.stringify(rules ?? {}));
}

/** keepEmpty: entries of the settings window stay listed until removed, even with everything back to the default */
export function withRule(rules: Rules, id: string, kind: RuleKind, patch: Partial<Rule>, keepEmpty = false): Rules {
    const copy = plainCopy(rules);
    const guildId = kind === "channel" ? ChannelStore.getChannel(id)?.guild_id ?? copy[id]?.guildId : undefined;
    const next: Rule = { ...copy[id], kind, name: describe(id, kind) ?? copy[id]?.name, guildId: guildId || undefined, ...patch };
    for (const key of Object.keys(next) as (keyof Rule)[])
        if (next[key] === undefined) delete next[key];

    if (isEmpty(next) && !keepEmpty) delete copy[id];
    else copy[id] = next;
    return copy;
}

export function withoutRules(rules: Rules, ids: string[]): Rules {
    const copy = plainCopy(rules);
    for (const id of ids) delete copy[id];
    return copy;
}

/** Drops expired silences that were the only content of their rule */
export function pruneExpired(rules: Rules, now = Date.now()): Rules | null {
    let changed = false;
    const copy = plainCopy(rules);
    for (const [id, rule] of Object.entries(rules)) {
        if (!rule.snoozedUntil || rule.snoozedUntil > now) continue;
        changed = true;
        const { snoozedUntil, ...rest } = copy[id];
        if (isEmpty(rest)) delete copy[id];
        else copy[id] = rest;
    }
    return changed ? copy : null;
}

/** Rules saved before notifications and sounds had their own levels: "show" always / mentions / never, sound on / off */
export function migrateRules(rules: Rules): Rules | null {
    let changed = false;
    const copy = plainCopy(rules);
    for (const [id, rule] of Object.entries(copy) as [string, Rule & { show?: string; }][]) {
        if (rule.show != null) {
            changed = true;
            const notify = ({ always: "all", mentions: "mentions", never: "none" } as const)[rule.show];
            delete rule.show;
            if (notify) rule.notify = notify;
        }
        if ((rule.sound as string) === "on" || (rule.sound as string) === "off") {
            changed = true;
            rule.sound = (rule.sound as string) === "on" ? "same" : "none";
        }
        if (isEmpty(rule)) delete copy[id];
    }
    return changed ? copy : null;
}

/** Human readable name of a scope, from Discord's caches */
export function describe(id: string, kind: RuleKind, withGuild = true): string | undefined {
    if (kind === "guild") return GuildStore.getGuild(id)?.name;

    if (kind === "user") {
        const user = UserStore.getUser(id);
        return user ? (user as any).globalName ?? user.username : undefined;
    }

    const channel = ChannelStore.getChannel(id);
    if (!channel) return undefined;
    if (channel.isDM()) {
        const recipient = UserStore.getUser(channel.recipients?.[0]);
        return recipient ? `MP · ${(recipient as any).globalName ?? recipient.username}` : "Message privé";
    }
    if (channel.isGroupDM()) return channel.name || groupName(channel);

    const guild = withGuild && channel.guild_id ? GuildStore.getGuild(channel.guild_id) : undefined;
    // Categories have no "#"
    const label = channel.type === 4 ? channel.name : `#${channel.name}`;
    return guild ? `${guild.name} · ${label}` : label;
}

/** Unnamed groups are named after their members, like Discord does */
export function groupName(channel: Channel) {
    const names = (channel.recipients ?? []).flatMap(id => {
        const user = UserStore.getUser(id);
        return user ? [(user as any).globalName ?? user.username] : [];
    });
    return names.length ? names.join(", ") : "Groupe privé";
}

/** Comma separated keywords, lowercased; parsed once per distinct setting value */
let keywordSource = "";
let keywordList: string[] = [];

export function parseKeywords(source: string) {
    return source.split(",").map(k => k.trim()).filter(Boolean);
}

export function matchesKeyword(text: string, source: string) {
    if (source !== keywordSource) {
        keywordSource = source;
        keywordList = parseKeywords(source).map(k => k.toLocaleLowerCase());
    }
    if (!keywordList.length || !text) return false;

    const lower = text.toLocaleLowerCase();
    return keywordList.some(k => lower.includes(k));
}
