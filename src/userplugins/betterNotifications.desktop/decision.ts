/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Logger } from "@utils/Logger";
import type { Channel } from "@vencord/discord-types";
import { findByCodeLazy } from "@webpack";
import { GuildMemberStore, PresenceStore, RelationshipStore, UserGuildSettingsStore, UserStore } from "@webpack/common";

import type { RawMessage } from "./format";
import { Level, matchesKeyword, MentionKind, resolve, scopeChain, sourceOf } from "./rules";
import { settings, sourceDefaults } from "./settings";

const logger = new Logger("BetterNotifications");

// Discord's own "should this message notify" check (mutes, notification settings, Do Not Disturb...)
// (message, channelId, includeSelectedChannel = true, ignoreStatus = false)
const discordShouldNotify = findByCodeLazy(".SUPPRESS_NOTIFICATIONS))return!1");

/** Message flag set by @silent */
const SUPPRESS_NOTIFICATIONS = 1 << 12;

let warnedShouldNotify = false;

export interface Decision {
    show: boolean;
    sound: boolean;
    priority: boolean;
    /** Discord would have notified on its own */
    discordWould: boolean;
    /** Discord's own desktop notification must be skipped */
    suppressNative: boolean;
}

function mentionMatches(message: RawMessage, channel: Channel, kinds: MentionKind[]) {
    const me = UserStore.getCurrentUser()?.id;
    // In a one-to-one conversation, every message is addressed to you
    if (kinds.includes("me") && (channel.isDM() || message.mentions?.some(u => u.id === me))) return true;
    if (kinds.includes("everyone") && message.mention_everyone) return true;
    if (kinds.includes("keywords") && matchesKeyword(message.content, settings.store.keywords)) return true;
    if (!kinds.includes("roles") || !channel.guild_id || !message.mention_roles?.length) return false;

    const roles = GuildMemberStore.getMember(channel.guild_id, me)?.roles ?? [];
    return message.mention_roles.some(r => roles.includes(r));
}

/** Discord's own verdict, with a simple mute check if its function cannot be found any more. ignoreStatus: as if not in Do Not Disturb */
function discordWouldNotify(message: RawMessage, channel: Channel, ignoreStatus = false) {
    try {
        return !!discordShouldNotify(message, message.channel_id, true, ignoreStatus);
    } catch (e) {
        if (!warnedShouldNotify) {
            warnedShouldNotify = true;
            logger.error("Discord's notification check is unavailable, falling back to mutes only", e);
        }
        if (!ignoreStatus && PresenceStore.getStatus(UserStore.getCurrentUser()?.id) === "dnd") return false;
        if (!channel.guild_id) return true;
        return mentionMatches(message, channel, ["me", "roles", "everyone"])
            || (!UserGuildSettingsStore.isMuted(channel.guild_id) && !UserGuildSettingsStore.isChannelMuted(channel.guild_id, channel.id));
    }
}

/** null: not a message to notify at all (own message, blocked user, @silent) */
export function decide(message: RawMessage, channel: Channel): Decision | null {
    const me = UserStore.getCurrentUser()?.id;
    if (!me || message.author.id === me) return null;
    if (RelationshipStore.isBlockedOrIgnored?.(message.author.id) ?? RelationshipStore.isBlocked(message.author.id)) return null;
    if ((message.flags ?? 0) & SUPPRESS_NOTIFICATIONS) return null;

    const rule = resolve(settings.store.rules, scopeChain(message.author.id, channel), sourceDefaults(sourceOf(channel)));
    const discordWould = discordWouldNotify(message, channel);
    // What Discord would notify outside Do Not Disturb, which priority rules go through
    const discordAllows = rule.priority && !discordWould ? discordWouldNotify(message, channel, true) : discordWould;
    // Priority rules also go through Do Not Disturb
    const quiet = !rule.priority && PresenceStore.getStatus(me) === "dnd";

    // Keywords count as mentions, which Discord would have notified even in a muted channel
    const keyword = () => rule.mentions.includes("keywords") && matchesKeyword(message.content, settings.store.keywords);
    const passes = (level: Level) => {
        if (quiet) return false;
        switch (level) {
            case "all": return true;
            case "discord": return discordAllows || keyword();
            case "friends": return discordAllows && RelationshipStore.isFriend(message.author.id);
            case "mentions": return mentionMatches(message, channel, rule.mentions);
            default: return false;
        }
    };

    const show = passes(rule.notify);
    return {
        show,
        sound: passes(rule.sound),
        priority: rule.priority,
        discordWould,
        // Whatever the overlay does not show, Discord must not show either
        suppressNative: settings.store.hideNativeNotifications || !show
    };
}
