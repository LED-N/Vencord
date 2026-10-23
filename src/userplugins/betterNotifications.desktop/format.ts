/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Logger } from "@utils/Logger";
import { ChannelStore, GuildMemberStore, GuildRoleStore, Parser, RelationshipStore, UserStore } from "@webpack/common";

import type { OverlayButton, OverlayEmbed, OverlayImage, RichNode } from "./types";

const logger = new Logger("BetterNotifications");

// Raw gateway payloads (snake_case), as received by MESSAGE_CREATE / MESSAGE_UPDATE

export interface RawAuthor {
    id: string;
    username: string;
    global_name?: string | null;
    avatar?: string | null;
}

export interface RawMedia {
    url?: string;
    proxy_url?: string;
    width?: number;
    height?: number;
    content_type?: string;
}

export interface RawEmbed {
    type?: string;
    title?: string;
    description?: string;
    url?: string;
    timestamp?: string;
    color?: number;
    author?: { name?: string; url?: string; icon_url?: string; proxy_icon_url?: string; };
    footer?: { text?: string; icon_url?: string; proxy_icon_url?: string; };
    thumbnail?: RawMedia;
    image?: RawMedia;
    fields?: { name: string; value: string; inline?: boolean; }[];
}

export interface RawComponent {
    type: number;
    style?: number;
    label?: string;
    emoji?: { id?: string | null; name?: string; animated?: boolean; };
    custom_id?: string;
    url?: string;
    disabled?: boolean;
    components?: RawComponent[];
    accessory?: RawComponent;
}

export interface RawAttachment extends RawMedia {
    filename: string;
}

export interface RawMessage {
    id: string;
    channel_id: string;
    guild_id?: string;
    application_id?: string;
    flags?: number;
    author: RawAuthor & { bot?: boolean; };
    member?: { nick?: string | null; };
    content: string;
    mentions?: { id: string; }[];
    mention_roles?: string[];
    mention_everyone?: boolean;
    attachments: RawAttachment[];
    embeds: RawEmbed[];
    components?: RawComponent[];
    sticker_items?: unknown[];
}

export interface FormatOptions {
    channelId: string;
    guildId?: string;
    /** Animated emojis and GIF images; when off, emojis are static and GIFs are left out */
    gifs: boolean;
    /** Large images: embed images, link previews and attachments */
    images: boolean;
}

const COMPONENT_BUTTON = 2;

const warnedTypes = new Set<string>();

function absoluteUrl(src: string) {
    try {
        return new URL(src, location.origin).href;
    } catch {
        return src;
    }
}

function emojiUrl(id: string, animated: boolean | undefined, opts: FormatOptions) {
    return `https://cdn.discordapp.com/emojis/${id}.${animated && opts.gifs ? "gif" : "webp"}?size=48`;
}

function isGif(m: RawMedia) {
    if (m.content_type === "image/gif") return true;
    try {
        return new URL(m.url ?? m.proxy_url ?? "").pathname.toLowerCase().endsWith(".gif");
    } catch {
        return false;
    }
}

function textOf(content: unknown): string {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) return content.map(textOf).join("");
    if (content && typeof content === "object" && "content" in content) return textOf((content as any).content);
    return "";
}

/** Same order as Discord: server nickname, friend nickname, display name, username */
function userName(id: string, guildId?: string) {
    const user = UserStore.getUser(id);
    return (guildId ? GuildMemberStore.getNick(guildId, id) : null)
        || RelationshipStore.getNickname(id)
        || (user as any)?.globalName
        || user?.username
        || "utilisateur";
}

function convertNodes(nodes: unknown, opts: FormatOptions): RichNode[] {
    if (nodes == null) return [];
    if (typeof nodes === "string") return [nodes];

    const out: RichNode[] = [];
    for (const node of Array.isArray(nodes) ? nodes : [nodes]) {
        const converted = convertNode(node, opts);
        if (Array.isArray(converted)) out.push(...converted);
        else if (converted != null) out.push(converted);
    }
    return out;
}

function convertNode(n: any, opts: FormatOptions): RichNode | RichNode[] | null {
    if (n == null) return null;
    if (typeof n === "string") return n;

    const children = () => convertNodes(n.content, opts);

    switch (n.type) {
        case "text":
            return typeof n.content === "string" ? n.content : children();
        case "paragraph":
            return children();
        case "strong":
            return { t: "b", c: children() };
        case "em":
            return { t: "i", c: children() };
        case "u":
            return { t: "u", c: children() };
        case "s":
            return { t: "s", c: children() };
        case "spoiler":
            return { t: "spoiler", c: children() };
        case "blockQuote":
            return { t: "quote", c: children() };
        case "subtext":
            return { t: "sub", c: children() };
        case "heading":
            return { t: "h", level: n.level ?? 1, c: children() };
        case "inlineCode":
            return { t: "code", text: textOf(n.content) };
        case "codeBlock":
            return { t: "pre", text: textOf(n.content) };
        case "br":
        case "newline":
            return { t: "br" };
        case "link":
        case "url":
        case "autolink": {
            const c = children();
            return { t: "link", href: n.target, c: c.length ? c : [n.target] };
        }
        case "emoji":
            return n.src
                ? { t: "emoji", src: absoluteUrl(n.src), name: n.surrogate ?? n.name ?? "" }
                : n.surrogate ?? n.name ?? null;
        case "customEmoji":
            return { t: "emoji", src: emojiUrl(n.emojiId, n.animated, opts), name: n.name ?? "" };
        case "timestamp":
            return typeof n.formatted === "string" ? n.formatted : textOf(n.content);
        case "list":
            return {
                t: "list",
                ordered: !!n.ordered,
                start: n.start,
                items: (n.items ?? []).map((item: unknown) => convertNodes(item, opts))
            };
        case "mention":
        case "roleMention":
        case "channelMention":
        case "channel":
            return convertMention(n, opts.guildId);
    }

    if (!warnedTypes.has(n.type)) {
        warnedTypes.add(n.type);
        logger.warn("Unhandled markdown node, falling back to its content", n);
    }
    if (n.content != null) return children();
    return typeof n.formatted === "string" ? n.formatted : null;
}

function convertMention(n: any, guildId?: string): RichNode {
    const text = textOf(n.content);

    const roleId = n.roleId ?? (n.type === "roleMention" ? n.id : undefined);
    if (roleId) {
        const role = guildId ? GuildRoleStore.getRole(guildId, roleId) : undefined;
        return { t: "mention", text: text || `@${role?.name ?? n.roleName ?? "rôle"}`, color: role?.colorString ?? n.roleColor ?? undefined };
    }

    if (n.channelId && n.type !== "mention")
        return { t: "mention", text: text || `#${ChannelStore.getChannel(n.channelId)?.name ?? "salon"}` };

    if (n.userId)
        return { t: "mention", text: text || `@${userName(n.userId, guildId)}` };

    return { t: "mention", text: text || "@mention" };
}

export function toRich(text: string | undefined, opts: FormatOptions, kind: "content" | "title" = "content"): RichNode[] {
    if (!text) return [];

    try {
        const state = { channelId: opts.channelId, allowLinks: true, allowHeading: true, allowList: true, previewLinkTarget: false };
        const ast = kind === "title" && Parser.parseEmbedTitleToAST
            ? Parser.parseEmbedTitleToAST(text, true, state)
            : Parser.parseToAST(text, true, state);
        return convertNodes(ast, opts);
    } catch (e) {
        logger.error("Failed to parse markdown, showing raw text", e);
        return [text];
    }
}

function formatTimestamp(iso?: string) {
    if (!iso) return undefined;

    const date = new Date(iso);
    if (isNaN(date.getTime())) return undefined;

    const time = date.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
    return date.toDateString() === new Date().toDateString()
        ? `Aujourd'hui à ${time}`
        : `${date.toLocaleDateString("fr-FR")} ${time}`;
}

/** Longest side requested from Discord's media proxy, in pixels: large images are at most 300px tall, thumbnails 80px (x2 for HiDPI) */
const LARGE_MAX = 720;
const SMALL_MAX = 160;

/** Discord's media proxies resize on the fly: never download more pixels than the card can show */
function resized(src: string, width: number | undefined, height: number | undefined, max: number) {
    if (!width || !height || (width <= max && height <= max)) return src;

    try {
        const url = new URL(src);
        if (!/(^|\.)discordapp\.net$/.test(url.hostname)) return src;

        const ratio = Math.min(max / width, max / height);
        url.searchParams.set("width", String(Math.round(width * ratio)));
        url.searchParams.set("height", String(Math.round(height * ratio)));
        return url.href;
    } catch {
        return src;
    }
}

/** Small pictures (thumbnails, icons), only GIFs are filtered */
function media(m: RawMedia | undefined, opts: FormatOptions, max = SMALL_MAX): OverlayImage | undefined {
    const src = m?.proxy_url ?? m?.url;
    if (!src || (!opts.gifs && isGif(m!))) return undefined;
    return { src: resized(src, m!.width, m!.height, max), width: m!.width, height: m!.height };
}

/** Large pictures, also subject to the "images" setting */
function largeMedia(m: RawMedia | undefined, opts: FormatOptions) {
    return opts.images ? media(m, opts, LARGE_MAX) : undefined;
}

export function convertEmbed(e: RawEmbed, opts: FormatOptions): OverlayEmbed {
    // Link previews of pictures / videos only carry a thumbnail, which Discord shows as a large image
    const isMediaPreview = e.type === "image" || e.type === "gifv" || e.type === "video";
    const previewAllowed = opts.gifs || e.type !== "gifv";

    return {
        color: e.color != null ? `#${e.color.toString(16).padStart(6, "0")}` : undefined,
        author: e.author?.name
            ? { name: e.author.name, icon: e.author.proxy_icon_url ?? e.author.icon_url, url: e.author.url }
            : undefined,
        title: toRich(e.title, opts, "title"),
        url: e.url,
        description: toRich(e.description, opts),
        fields: (e.fields ?? []).map(f => ({
            name: toRich(f.name, opts, "title"),
            value: toRich(f.value, opts),
            inline: !!f.inline
        })),
        thumbnail: isMediaPreview ? undefined : media(e.thumbnail, opts)?.src,
        image: largeMedia(e.image, opts) ?? (isMediaPreview && previewAllowed ? largeMedia(e.thumbnail, opts) : undefined),
        footer: e.footer?.text || e.timestamp
            ? { text: e.footer?.text, icon: e.footer?.proxy_icon_url ?? e.footer?.icon_url, timestamp: formatTimestamp(e.timestamp) }
            : undefined
    };
}

/** Buttons in display order, including those nested in Components V2 containers and sections */
export function collectButtons(components: RawComponent[] | undefined, out: RawComponent[] = []) {
    for (const c of components ?? []) {
        if (c.type === COMPONENT_BUTTON) out.push(c);
        if (c.components) collectButtons(c.components, out);
        if (c.accessory) collectButtons([c.accessory], out);
    }
    return out;
}

export function convertButton(b: RawComponent, opts: FormatOptions): OverlayButton {
    return {
        label: b.label,
        emoji: b.emoji
            ? b.emoji.id
                ? { src: emojiUrl(b.emoji.id, b.emoji.animated, opts) }
                : { text: b.emoji.name }
            : undefined,
        style: b.style ?? 2,
        disabled: !!b.disabled,
        url: b.url
    };
}

export function imageAttachments(message: RawMessage, opts: FormatOptions): OverlayImage[] {
    const image = message.attachments.find(a => a.content_type?.startsWith("image/") && largeMedia(a, opts));
    return image ? [largeMedia(image, opts)!] : [];
}

/** Single line summary, used in compact mode */
export function plainText(message: RawMessage) {
    const text = message.content
        .replace(/<@!?(\d{17,20})>/g, (_, id) => `@${userName(id, message.guild_id ?? ChannelStore.getChannel(message.channel_id)?.guild_id)}`)
        .replace(/<#(\d{17,20})>/g, (_, id) => `#${ChannelStore.getChannel(id)?.name ?? "salon"}`)
        .replace(/<@&\d{17,20}>/g, "@rôle")
        .replace(/<a?:(\w+):\d{17,20}>/g, ":$1:")
        .trim();

    if (text) return text.slice(0, 300);
    if (message.embeds[0]?.title) return message.embeds[0].title;
    if (message.embeds[0]?.description) return message.embeds[0].description.slice(0, 300);
    if (message.attachments.length) return "📎 Pièce jointe";
    if (message.sticker_items?.length) return "Autocollant";
    if (message.embeds.length) return "Intégration";
    return "Nouveau message";
}
