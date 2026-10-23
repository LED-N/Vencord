/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { Channel } from "@vencord/discord-types";
import { ChannelStore, GuildStore, UserStore } from "@webpack/common";

/** "always" also overrides Discord's mutes, "mentions" only lets mentions through (also in muted places) */
export type ShowRule = "always" | "mentions" | "never";
export type SoundRule = "on" | "off";
export type RuleKind = "guild" | "channel" | "user";

/** Undefined fields inherit from the broader scope */
export interface Rule {
    kind: RuleKind;
    /** Shown in the rules list when the server, channel or user is not cached */
    name?: string;
    show?: ShowRule;
    sound?: SoundRule;
    priority?: boolean;
    /** Temporary silence, timestamp in milliseconds */
    snoozedUntil?: number;
}

export type Rules = Record<string, Rule>;

export interface Resolved {
    show?: ShowRule;
    sound?: SoundRule;
    priority: boolean;
    snoozed: boolean;
}

/** From the most specific scope to the broadest: author, channel, parents (thread parent, category), server */
export function scopeChain(authorId: string, channel: Channel): string[] {
    const ids = [authorId, channel.id];
    let parentId = channel.parent_id;
    while (parentId && !ids.includes(parentId)) {
        ids.push(parentId);
        parentId = ChannelStore.getChannel(parentId)?.parent_id;
    }
    if (channel.guild_id) ids.push(channel.guild_id);
    return ids;
}

export function resolve(rules: Rules, chain: string[], now = Date.now()): Resolved {
    const out: Resolved = { priority: false, snoozed: false };
    let priority: boolean | undefined;

    for (const id of chain) {
        const rule = rules[id];
        if (!rule) continue;

        // A silence anywhere in the chain wins, whatever the more specific rules say
        if (rule.snoozedUntil && rule.snoozedUntil > now)
            return { show: "never", sound: "off", priority: false, snoozed: true };

        out.show ??= rule.show;
        out.sound ??= rule.sound;
        priority ??= rule.priority;
    }

    out.priority = !!priority;
    return out;
}

/** A rule with nothing left to say is dropped instead of being kept around */
export function isEmpty(rule: Rule, now = Date.now()) {
    return rule.show == null && rule.sound == null && !rule.priority && !(rule.snoozedUntil && rule.snoozedUntil > now);
}

/**
 * A plain deep copy. Values read from settings.store are proxies, and a spread copy keeps the nested ones:
 * once stored, they cannot be sent to the main process to be saved, which threw before the change listeners ran
 * (the settings page then stopped refreshing after the first change, and the rules were not written to disk).
 */
function plainCopy(rules: Rules): Rules {
    return JSON.parse(JSON.stringify(rules ?? {}));
}

export function withRule(rules: Rules, id: string, kind: RuleKind, patch: Partial<Rule>): Rules {
    const copy = plainCopy(rules);
    const next: Rule = { ...copy[id], kind, name: describe(id, kind) ?? copy[id]?.name, ...patch };
    for (const key of Object.keys(next) as (keyof Rule)[])
        if (next[key] === undefined) delete next[key];

    if (isEmpty(next)) delete copy[id];
    else copy[id] = next;
    return copy;
}

export function withoutRule(rules: Rules, id: string): Rules {
    const copy = plainCopy(rules);
    delete copy[id];
    return copy;
}

/** Drops expired silences that were the only content of their rule */
export function pruneExpired(rules: Rules, now = Date.now()): Rules | null {
    let changed = false;
    const copy = plainCopy(rules);
    for (const [id, rule] of Object.entries(rules)) {
        if (!rule.snoozedUntil || rule.snoozedUntil > now) continue;
        changed = true;
        const { snoozedUntil, ...rest } = rule;
        if (isEmpty(rest)) delete copy[id];
        else copy[id] = rest;
    }
    return changed ? copy : null;
}

/** Human readable name of a scope, from Discord's caches */
export function describe(id: string, kind: RuleKind): string | undefined {
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
    if (channel.isGroupDM()) return channel.name || "Groupe privé";

    const guild = channel.guild_id ? GuildStore.getGuild(channel.guild_id) : undefined;
    // Categories have no "#"
    const label = channel.type === 4 ? channel.name : `#${channel.name}`;
    return guild ? `${guild.name} · ${label}` : label;
}

/** Comma separated keywords, lowercased; parsed once per distinct setting value */
let keywordSource = "";
let keywordList: string[] = [];

export function matchesKeyword(text: string, source: string) {
    if (source !== keywordSource) {
        keywordSource = source;
        keywordList = source.split(",").map(k => k.trim().toLocaleLowerCase()).filter(Boolean);
    }
    if (!keywordList.length || !text) return false;

    const lower = text.toLocaleLowerCase();
    return keywordList.some(k => lower.includes(k));
}
