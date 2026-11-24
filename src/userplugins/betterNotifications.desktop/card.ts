/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { Channel } from "@vencord/discord-types";
import { ApplicationStreamingStore, GuildMemberStore, GuildStore, RelationshipStore, StreamerModeStore, UserStore } from "@webpack/common";

import { convertButton, convertEmbed, FormatOptions, imageAttachments, plainText, RawAuthor, RawComponent, RawMessage, toRich } from "./format";
import { settings } from "./settings";
import type { OverlayMenuItem, OverlayNotification } from "./types";

// What a card shows for a message: who, where, and the content the privacy and content settings allow

export type NotificationContent = Omit<OverlayNotification, "duration" | "layout">;

function avatarUrl(author: RawAuthor) {
    if (author.avatar)
        return `https://cdn.discordapp.com/avatars/${author.id}/${author.avatar}.png?size=64`;
    return `https://cdn.discordapp.com/embed/avatars/${Number((BigInt(author.id) >> 22n) % 6n)}.png`;
}

/**
 * The name Discord shows: server nickname, then the nickname you gave a friend, then the display name.
 * The payload alone is not enough: depending on the path, its author lacks global_name and only the username was left.
 */
export function authorName(message: RawMessage, channel?: Channel) {
    const { id } = message.author;
    const guildId = channel?.guild_id ?? message.guild_id;
    return message.member?.nick
        || (guildId ? GuildMemberStore.getNick(guildId, id) : null)
        || RelationshipStore.getNickname(id)
        || UserStore.getUser(id)?.globalName
        || message.author.global_name
        || message.author.username;
}

function subtitleFor(channel: Channel) {
    if (channel.isDM()) return "Message privé";
    if (channel.isGroupDM()) return channel.name || "Groupe privé";
    const guild = GuildStore.getGuild(channel.guild_id);
    return guild ? `${guild.name} · #${channel.name}` : `#${channel.name}`;
}

/** How the menu entries and their confirmations name the conversation */
export function whereLabel(channel: Channel) {
    return channel.isDM() ? "cette conversation" : channel.isGroupDM() ? "ce groupe" : `#${channel.name}`;
}

/** Only private conversations are masked: server messages, mentions included, stay readable */
function privacyActive(channel: Channel) {
    if (!channel.isDM() && !channel.isGroupDM()) return false;

    switch (settings.store.privacy) {
        case "always": return true;
        case "streamer": return !!StreamerModeStore.enabled;
        case "streaming": return !!StreamerModeStore.enabled || !!ApplicationStreamingStore.getCurrentUserActiveStream?.();
        default: return false;
    }
}

/** The keys are handled by handleMenu (index.tsx) */
function menuFor(message: RawMessage, channel: Channel): OverlayMenuItem[] {
    const where = whereLabel(channel);
    const items: OverlayMenuItem[] = [
        { key: "read", label: "Marquer comme lu" },
        { key: "snooze-channel", label: `Silence 1 h pour ${where}` }
    ];

    if (channel.guild_id) {
        items.push({ key: "mentions-guild", label: "Mentions seulement pour ce serveur" });
        items.push({ key: "sound-guild", label: "Couper le son de ce serveur" });
    } else items.push({ key: "sound-channel", label: `Couper le son de ${where}` });

    if (!channel.isDM()) items.push({ key: "vip", label: `Toujours notifier ${authorName(message, channel)}` });

    items.push({ key: "hide-channel", label: `Ne plus notifier ${where}`, danger: true });
    if (channel.guild_id) items.push({ key: "hide-guild", label: "Ne plus notifier ce serveur", danger: true });
    items.push({ key: "settings", label: "Réglages de BetterNotifications…" });
    return items;
}

export function buildNotification(message: RawMessage, channel: Channel, buttons: RawComponent[], count: number): NotificationContent {
    const subtitle = subtitleFor(channel) + (count > 1 ? ` · ${count} messages` : "");
    const base = { id: message.id, menu: menuFor(message, channel) };
    const name = authorName(message, channel);

    if (privacyActive(channel)) {
        const text = "🔒 Contenu masqué";
        return settings.store.privacyHideAuthor
            ? { ...base, title: "Nouveau message privé", subtitle: count > 1 ? `${count} messages` : undefined, preview: text, content: [text] }
            : { ...base, title: name, subtitle, icon: avatarUrl(message.author), preview: text, content: [text] };
    }

    const opts: FormatOptions = {
        channelId: channel.id,
        guildId: channel.guild_id ?? undefined,
        gifs: settings.store.showGifs,
        images: settings.store.showImages
    };

    const card = {
        ...base,
        title: name,
        subtitle,
        icon: avatarUrl(message.author),
        preview: plainText(message),
        buttons: settings.store.showButtons ? buttons.map(b => convertButton(b, opts)) : undefined
    };

    if (!settings.store.fullEmbeds)
        return { ...card, content: [plainText(message)] };

    return {
        ...card,
        content: toRich(message.content, opts),
        embeds: message.embeds.map(e => convertEmbed(e, opts)),
        images: imageAttachments(message, opts)
    };
}
