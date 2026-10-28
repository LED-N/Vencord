/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { SettingsStore } from "@api/Settings";
import { Logger } from "@utils/Logger";
import definePlugin, { PluginNative, ReporterTestable } from "@utils/types";
import type { Channel } from "@vencord/discord-types";
import { findByCodeLazy, waitFor } from "@webpack";
import {
    ApplicationStreamingStore, AuthenticationStore, ChannelStore, FluxDispatcher, GuildMemberStore, GuildStore, NavigationRouter,
    PresenceStore, ReadStateStore, RelationshipStore, RestAPI, SelectedChannelStore, showToast, SnowflakeUtils, StreamerModeStore,
    UserGuildSettingsStore, UserStore, WindowStore
} from "@webpack/common";

import { collectButtons, convertButton, convertEmbed, FormatOptions, imageAttachments, plainText, RawAuthor, RawComponent, RawMessage, toRich } from "./format";
import { contextMenus } from "./menus";
import { Level, matchesKeyword, MentionKind, migrateRules, pruneExpired, resolve, Rule, RuleKind, scopeChain, SoundLevel, sourceOf, withRule } from "./rules";
import { settings, sourceDefaults } from "./settings";
import managedStyle from "./styles.css?managed";
import type { HoverBehavior, OverlayAction, OverlayDisplay, OverlayLayout, OverlayMenuItem, OverlayNotification, OverlayPosition, TypingBehavior, TypingTrigger } from "./types";
import { bridge } from "./ui/bridge";
import { openSettings } from "./ui/SettingsModal";

const Native = VencordNative.pluginHelpers.BetterNotifications as PluginNative<typeof import("./native")>;
const logger = new Logger("BetterNotifications");

// Discord's own "should this message notify" check (mutes, notification settings, Do Not Disturb...)
// (message, channelId, includeSelectedChannel = true, ignoreStatus = false)
const discordShouldNotify = findByCodeLazy(".SUPPRESS_NOTIFICATIONS))return!1");

/** Message flag set by @silent */
const SUPPRESS_NOTIFICATIONS = 1 << 12;
const INTERACTION_TYPE_COMPONENT = 3;
const COMPONENT_BUTTON = 2;
/** Messages kept around to resolve clicks, follow edits and match Discord's notifications */
const MAX_TRACKED = 50;
/** How long a Discord notification waits for its MESSAGE_CREATE payload before falling back to the bare text */
const RAW_MESSAGE_WAIT = 250;
/** A notification Discord would not have made itself waits this long for Discord's, then plays the sound on its own */
const SOUND_WAIT = 300;
const DEFAULT_SOUND = "message1";
const SNOOZE = 60 * 60_000;

interface Decision {
    show: boolean;
    sound: boolean;
    priority: boolean;
    /** Discord would have notified on its own, and so plays the sound itself */
    discordWould: boolean;
    /** Discord's own desktop notification must be skipped */
    suppressNative: boolean;
}

interface Tracked {
    message: RawMessage;
    buttons: RawComponent[];
    decision: Decision;
    /** Messages of the conversation gathered in this card */
    count: number;
}

/** Every message received recently, by id */
const rawMessages = new Map<string, RawMessage>();
/** Messages displayed by the overlay, by id */
const tracked = new Map<string, Tracked>();
const decisions = new Map<string, Decision>();
/** Messages Discord made a desktop notification for (and so took care of the sound) */
const discordHandled = new Map<string, true>();
/** Discord notifications whose MESSAGE_CREATE payload has not been seen yet */
const awaitingRaw = new Map<string, ReturnType<typeof setTimeout>>();
const soundTimers = new Map<string, ReturnType<typeof setTimeout>>();
/** Ids of the cards on screen */
const displayed = new Set<string>();
/** Card currently showing each conversation, by channel id */
const channelCards = new Map<string, { id: string; count: number; }>();

let running = false;
let warnedShouldNotify = false;

function remember<T>(map: Map<string, T>, id: string, value: T) {
    map.delete(id);
    map.set(id, value);
    while (map.size > MAX_TRACKED) map.delete(map.keys().next().value!);
}

function layout(): OverlayLayout {
    const s = settings.store;
    return {
        position: s.position as OverlayPosition,
        display: s.display as OverlayDisplay,
        offsetX: Math.round(s.offsetX),
        offsetY: Math.round(s.offsetY),
        maxWidth: s.maxWidth,
        scale: s.scale,
        opacity: s.opacity / 100,
        maxVisible: s.maxVisible,
        maxHeight: s.maxHeight / 100,
        collapseOlder: s.collapseOlder,
        autoCollapse: Math.round(s.autoCollapse * 1000),
        clickable: s.clickable,
        hover: s.hover as HoverBehavior,
        typing: s.typing as TypingBehavior,
        typingTrigger: s.typingTrigger as TypingTrigger,
        typingOpacity: s.typingOpacity / 100,
        shortcut: s.shortcut.trim()
    };
}

function avatarUrl(author: RawAuthor) {
    if (author.avatar)
        return `https://cdn.discordapp.com/avatars/${author.id}/${author.avatar}.png?size=64`;
    return `https://cdn.discordapp.com/embed/avatars/${Number((BigInt(author.id) >> 22n) % 6n)}.png`;
}

/**
 * The name Discord shows: server nickname, then the nickname you gave a friend, then the display name.
 * The payload alone is not enough: depending on the path, its author lacks global_name and only the username was left.
 */
function authorName(message: RawMessage, channel?: Channel) {
    const { id } = message.author;
    const guildId = channel?.guild_id ?? message.guild_id;
    return message.member?.nick
        || (guildId ? GuildMemberStore.getNick(guildId, id) : null)
        || RelationshipStore.getNickname(id)
        || (UserStore.getUser(id) as any)?.globalName
        || message.author.global_name
        || message.author.username;
}

function subtitleFor(channel: Channel) {
    if (channel.isDM()) return "Message privé";
    if (channel.isGroupDM()) return channel.name || "Groupe privé";
    const guild = GuildStore.getGuild(channel.guild_id);
    return guild ? `${guild.name} · #${channel.name}` : `#${channel.name}`;
}

// ── Decision ───────────────────────────────────────────────────────────────────

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
function decide(message: RawMessage, channel: Channel): Decision | null {
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

/**
 * Our own decision about the timing, independent of Discord's desktop notifications: Discord skips them when its in-game
 * overlay handles the message, when desktop notifications are set to "never", or when it wrongly believes it is focused.
 * viewing: the conversation is open in a focused Discord, nothing at all is due; blocked: only the card is held back
 */
async function focusState(channel: Channel) {
    const open = SelectedChannelStore.getChannelId() === channel.id;
    if (!open && !settings.store.onlyWhenUnfocused) return { viewing: false, blocked: false };

    // Discord's own focus state can be stale after switching to a game, so the OS focus has the final say
    const osFocused = await Native.isDiscordFocused().catch(() => false);
    return {
        viewing: open && WindowStore.isFocused() && osFocused,
        blocked: settings.store.onlyWhenUnfocused && osFocused
    };
}

// ── Building the card ──────────────────────────────────────────────────────────

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

function menuFor(message: RawMessage, channel: Channel): OverlayMenuItem[] {
    const where = channel.isDM() ? "cette conversation" : channel.isGroupDM() ? "ce groupe" : `#${channel.name}`;
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

type NotificationContent = Omit<OverlayNotification, "duration" | "layout">;

function buildNotification(message: RawMessage, channel: Channel, buttons: RawComponent[], count: number): NotificationContent {
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

function show(data: NotificationContent & Partial<Pick<OverlayNotification, "update" | "replaces" | "priority">>) {
    Native.showNotification({ ...data, layout: layout(), duration: settings.store.duration * 1000 })
        .catch(e => logger.error("Failed to show notification", e));
}

function notify(message: RawMessage, decision: Decision, update = false) {
    const channel = ChannelStore.getChannel(message.channel_id);
    if (!channel) return;

    const buttons = collectButtons(message.components);
    let count = tracked.get(message.id)?.count ?? 1;
    let replaces: string | undefined;

    if (!update) {
        // A newer message of a conversation already on screen takes its card over
        const previous = settings.store.groupMessages ? channelCards.get(message.channel_id) : undefined;
        if (previous && previous.id !== message.id && displayed.has(previous.id)) {
            replaces = previous.id;
            count = previous.count + 1;
            displayed.delete(previous.id);
        }
        channelCards.set(message.channel_id, { id: message.id, count });
        displayed.add(message.id);
    }

    remember(tracked, message.id, { message, buttons, decision, count });
    show({ ...buildNotification(message, channel, buttons, count), update, replaces, priority: decision.priority });
}

function playSound() {
    NotificationUtils?.playNotificationSound(DEFAULT_SOUND, 1);
}

// ── Discord's notifications ────────────────────────────────────────────────────

interface NotificationOptions {
    messageRecord?: {
        id: string;
        channel_id: string;
        content?: string;
        flags?: number;
        mentions?: string[];
        mentionRoles?: string[];
        mentionEveryone?: boolean;
        author?: { id: string; username: string; globalName?: string | null; avatar?: string | null; };
    };
    sound?: string;
    volume?: number;
    soundpack?: string;
}

interface NotificationUtilsModule {
    showNotification(icon: string | null, title: string, body: string, trackingProps: unknown, options?: NotificationOptions): Promise<unknown>;
    playNotificationSound(sound: string, volume?: number, soundpack?: string): Promise<void>;
}

let NotificationUtils: NotificationUtilsModule | null = null;
let originalShowNotification: NotificationUtilsModule["showNotification"] | null = null;

/** The message record Discord passes along, in the gateway's shape */
function fromRecord(record: NonNullable<NotificationOptions["messageRecord"]>, body: string): RawMessage {
    const author = record.author ?? { id: "0", username: "?" };
    return {
        id: record.id,
        channel_id: record.channel_id,
        flags: record.flags,
        author: { id: author.id, username: author.username, global_name: author.globalName, avatar: author.avatar },
        content: record.content || body,
        mentions: record.mentions?.map(id => ({ id })),
        mention_roles: record.mentionRoles,
        mention_everyone: record.mentionEveryone,
        attachments: [],
        embeds: []
    };
}

/**
 * Called whenever Discord shows a desktop notification. Returns our decision for the message, which says whether the
 * native notification and its sound are kept, or null to leave Discord alone.
 */
function onDiscordNotification(body: string, options?: NotificationOptions): Decision | null {
    const record = options?.messageRecord;
    if (!record?.id || !record.channel_id) return null;

    const channel = ChannelStore.getChannel(record.channel_id);
    if (!channel) return null;

    remember(discordHandled, record.id, true);
    clearTimeout(soundTimers.get(record.id));
    soundTimers.delete(record.id);

    const raw = rawMessages.get(record.id);
    let decision = decisions.get(record.id) ?? null;
    if (!decision) {
        decision = decide(raw ?? fromRecord(record, body), channel);
        if (!decision) return null;
        remember(decisions, record.id, decision);
    }

    if (!decision.show || tracked.has(record.id)) return decision;

    if (raw) {
        notify(raw, decision);
    } else if (!awaitingRaw.has(record.id)) {
        // Our MESSAGE_CREATE handler may run after Discord's, give it a moment
        const final = decision;
        awaitingRaw.set(record.id, setTimeout(() => {
            awaitingRaw.delete(record.id);
            notify(rawMessages.get(record.id) ?? fromRecord(record, body), final);
        }, RAW_MESSAGE_WAIT));
    }

    return decision;
}

function hookNotifications() {
    // The module may not be loaded yet when the plugin starts: waitFor fires now or as soon as it is
    waitFor(["showNotification", "requestPermission", "playNotificationSound"], (mod: NotificationUtilsModule) => {
        // Also guards against a subscription left over from a previous start
        if (!running || NotificationUtils) return;

        try {
            installHook(mod);
        } catch (e) {
            logger.error("Failed to hook NotificationUtils, Windows notifications will not be hidden", e);
        }
    });
}

function installHook(utils: NotificationUtilsModule) {
    NotificationUtils = utils;
    const original = originalShowNotification = utils.showNotification;

    utils.showNotification = function (this: unknown, icon, title, body, trackingProps, options) {
        try {
            const decision = onDiscordNotification(body, options);
            if (decision?.suppressNative) {
                // Discord plays the sound from inside showNotification, keep it if the rules allow it
                if (decision.sound && options?.sound != null) utils.playNotificationSound(options.sound, options.volume ?? 1, options.soundpack);
                return Promise.resolve(undefined);
            }
            if (decision && !decision.sound && options?.sound != null) options = { ...options, sound: undefined };
        } catch (e) {
            logger.error("Failed to handle Discord notification", e);
        }
        return original.call(this, icon, title, body, trackingProps, options);
    };
}

function unhookNotifications() {
    if (NotificationUtils && originalShowNotification) NotificationUtils.showNotification = originalShowNotification;
    NotificationUtils = originalShowNotification = null;
}

// ── Click handling ─────────────────────────────────────────────────────────────

function jumpTo(message: RawMessage) {
    const guildId = message.guild_id ?? ChannelStore.getChannel(message.channel_id)?.guild_id;
    NavigationRouter.transitionTo(`/channels/${guildId ?? "@me"}/${message.channel_id}/${message.id}`);
}

async function clickButton(message: RawMessage, button: RawComponent) {
    try {
        await RestAPI.post({
            url: "/interactions",
            body: {
                type: INTERACTION_TYPE_COMPONENT,
                nonce: SnowflakeUtils.fromTimestamp(Date.now()),
                guild_id: message.guild_id ?? ChannelStore.getChannel(message.channel_id)?.guild_id,
                channel_id: message.channel_id,
                message_flags: message.flags ?? 0,
                message_id: message.id,
                application_id: message.application_id ?? message.author.id,
                session_id: AuthenticationStore.getSessionId(),
                data: {
                    component_type: COMPONENT_BUTTON,
                    custom_id: button.custom_id
                }
            }
        });
    } catch (e) {
        logger.error("Button interaction failed", e);
        showToast({ text: "BetterNotifications : le clic sur le bouton a échoué", variant: "critical" });
    }
}

function setRule(id: string, kind: RuleKind, patch: Partial<Rule>, toast: string) {
    settings.store.rules = withRule(settings.store.rules, id, kind, patch);
    showToast({ text: toast, variant: "success" });
}

function handleMenu(entry: Tracked, key: string) {
    const { message } = entry;
    const channel = ChannelStore.getChannel(message.channel_id);
    if (!channel) return;
    const where = channel.isDM() ? "cette conversation" : channel.isGroupDM() ? "ce groupe" : `#${channel.name}`;

    switch (key) {
        case "read":
            FluxDispatcher.dispatch({
                type: "BULK_ACK",
                context: "APP",
                channels: [{ channelId: channel.id, messageId: ReadStateStore.lastMessageId(channel.id) ?? message.id, readStateType: 0 }]
            });
            break;
        case "snooze-channel":
            setRule(channel.id, "channel", { snoozedUntil: Date.now() + SNOOZE }, `Silence d'une heure pour ${where}`);
            break;
        case "mentions-guild":
            setRule(channel.guild_id, "guild", { notify: "mentions" }, "Seules les mentions de ce serveur seront notifiées");
            break;
        case "sound-guild":
            setRule(channel.guild_id, "guild", { sound: "none" }, "Son coupé pour ce serveur");
            break;
        case "sound-channel":
            setRule(channel.id, "channel", { sound: "none" }, `Son coupé pour ${where}`);
            break;
        case "vip":
            setRule(message.author.id, "user", { notify: "all" }, `${authorName(message, channel)} sera toujours notifié`);
            break;
        case "hide-channel":
            setRule(channel.id, "channel", { notify: "none", sound: "none" }, `${where} ne sera plus notifié`);
            break;
        case "hide-guild":
            setRule(channel.guild_id, "guild", { notify: "none", sound: "none" }, "Ce serveur ne sera plus notifié");
            break;
        case "settings":
            openSettings("exceptions");
            break;
    }
}

function onClosed(ids: string[]) {
    for (const id of ids) {
        displayed.delete(id);
        for (const [channelId, card] of channelCards)
            if (card.id === id) channelCards.delete(channelId);
    }
}

function handleAction(action: OverlayAction) {
    if (action.type === "closed") {
        onClosed(action.ids);
        return;
    }

    const entry = tracked.get(action.id);
    if (!entry) return;

    if (action.type === "menu") {
        handleMenu(entry, action.key);
        return;
    }

    if (action.type === "button") {
        const button = entry.buttons[action.index];
        if (button?.custom_id && !button.disabled) clickButton(entry.message, button);
    }

    // Bot replies to button clicks are usually ephemeral, only visible in the channel itself
    jumpTo(entry.message);
}

async function actionLoop() {
    while (running) {
        const action = await Native.nextAction().catch(() => null);
        if (!action || !running) return;

        try {
            handleAction(action);
        } catch (e) {
            logger.error("Failed to handle overlay action", e);
        }
    }
}

// ── Settings migration ─────────────────────────────────────────────────────────

/**
 * Settings saved before notifications and sounds were set apart: "servers" all / mentions / chosen / none,
 * "dms" all / friends / chosen / none, "groupDms" and "sound" on / off. The "chosen" modes became a disabled source
 * whose exceptions still go through, which is what they did.
 */
function migrateSettings() {
    const raw = SettingsStore.plain.plugins.BetterNotifications as Record<string, any> | undefined;
    if (!raw) return;

    const old = ["servers", "dms", "groupDms", "sound"].filter(k => Object.hasOwn(raw, k));
    if (old.length) {
        const sound: SoundLevel = raw.sound === false ? "none" : "same";
        const level = (value: unknown): Level => value === "mentions" ? "mentions" : value === "friends" ? "friends" : value === "all" || value === undefined ? "discord" : "none";

        settings.store.serversNotify = level(raw.servers);
        settings.store.dmsNotify = level(raw.dms);
        settings.store.groupsNotify = raw.groupDms === false ? "none" : "discord";
        settings.store.serversSound = settings.store.dmsSound = settings.store.groupsSound = sound;

        for (const key of old) delete raw[key];
        SettingsStore.markAsChanged();
        logger.info("Migrated the notification filters to the new settings", old);
    }

    const rules = migrateRules(settings.store.rules);
    if (rules) settings.store.rules = rules;
}

function sendTest() {
    // A new id each time, to try the stacking with several clicks
    const id = `test-${Date.now()}`;
    displayed.add(id);
    show({
        id,
        title: "Notification de test",
        subtitle: "BetterNotifications",
        icon: "https://cdn.discordapp.com/embed/avatars/0.png",
        preview: "Si tu vois ceci par-dessus ton jeu, ça fonctionne !",
        content: ["Si tu vois ceci par-dessus ton jeu, ", { t: "b", c: ["ça fonctionne"] }, " !"],
        embeds: settings.store.fullEmbeds ? [{
            color: "#5865f2",
            title: ["Exemple d'embed"],
            url: "https://vencord.dev",
            description: ["Survole la carte pour mettre le compte à rebours en pause, ", { t: "code", text: "clique" }, " pour aller au message, clic droit pour les options."],
            fields: [
                { name: ["Prix"], value: [{ t: "code", text: "29,38€" }], inline: true },
                { name: ["Habituel"], value: [{ t: "code", text: "213,51€" }], inline: true },
                { name: ["Remise"], value: [{ t: "code", text: "-86%" }], inline: true }
            ],
            footer: { text: "Test", timestamp: "Aujourd'hui" }
        }] : undefined,
        buttons: settings.store.showButtons ? [{ label: "Lien de test", style: 5, disabled: false, url: "https://vencord.dev" }] : undefined
    });
}

bridge.sendTest = sendTest;

// ── Plugin ─────────────────────────────────────────────────────────────────────

export default definePlugin({
    name: "BetterNotifications",
    description: "Notifications Discord redessinées dans une fenêtre toujours au premier plan (visible par-dessus les jeux), avec règles par serveur, salon et personne",
    authors: [{ name: "LEDEN", id: 224552140117508096n }],
    reporterTestable: ReporterTestable.None,
    settings,
    managedStyle,
    contextMenus,

    flux: {
        async MESSAGE_CREATE({ message, optimistic }: { message: RawMessage; optimistic: boolean; }) {
            if (optimistic) return;
            remember(rawMessages, message.id, message);

            // Discord already notified about it before this handler ran
            const waiting = awaitingRaw.get(message.id);
            if (waiting) {
                clearTimeout(waiting);
                awaitingRaw.delete(message.id);
                const decision = decisions.get(message.id);
                if (decision) notify(message, decision);
                return;
            }

            const channel = ChannelStore.getChannel(message.channel_id);
            if (!channel) return;

            const decision = decisions.get(message.id) ?? decide(message, channel);
            if (!decision || (!decision.show && !decision.sound)) return;
            remember(decisions, message.id, decision);

            const { viewing, blocked } = await focusState(channel);
            // Discord's notification may have claimed it while we were checking the focus
            if (decision.show && !viewing && !blocked && !tracked.has(message.id)) notify(message, decision);

            // Discord stays silent about what it would not have notified: play the sound ourselves, unless it did after all
            if (decision.sound && !decision.discordWould && !viewing && !discordHandled.has(message.id)) {
                soundTimers.set(message.id, setTimeout(() => {
                    soundTimers.delete(message.id);
                    if (!discordHandled.has(message.id)) playSound();
                }, SOUND_WAIT));
            }
        },

        // Bots often post a message and edit it right after (embed image, buttons...)
        MESSAGE_UPDATE({ message }: { message: Partial<RawMessage> & { id: string; }; }) {
            const raw = rawMessages.get(message.id);
            if (raw) remember(rawMessages, message.id, { ...raw, ...message });

            const entry = tracked.get(message.id);
            if (entry && displayed.has(message.id)) notify({ ...entry.message, ...message }, entry.decision, true);
        }
    },

    start() {
        running = true;
        migrateSettings();
        const pruned = pruneExpired(settings.store.rules);
        if (pruned) settings.store.rules = pruned;
        actionLoop();
        hookNotifications();
    },

    stop() {
        running = false;
        unhookNotifications();
        awaitingRaw.forEach(clearTimeout);
        awaitingRaw.clear();
        soundTimers.forEach(clearTimeout);
        soundTimers.clear();
        rawMessages.clear();
        tracked.clear();
        decisions.clear();
        discordHandled.clear();
        displayed.clear();
        channelCards.clear();
        Native.destroy();
    },

    /** Lets other plugins (Quest Completer) show a card in the overlay. Clicking it brings Discord forward */
    showExternal(data: { id: string; title: string; subtitle?: string; icon?: string; text: string; priority?: boolean; }) {
        if (!running) return false;
        displayed.add(data.id);
        show({ id: data.id, title: data.title, subtitle: data.subtitle, icon: data.icon, preview: data.text, content: [data.text], priority: data.priority });
        return true;
    }
});
