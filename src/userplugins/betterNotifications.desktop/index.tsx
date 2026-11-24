/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { SettingsStore } from "@api/Settings";
import { Logger } from "@utils/Logger";
import definePlugin, { PluginNative, ReporterTestable } from "@utils/types";
import type { Channel } from "@vencord/discord-types";
import { waitFor } from "@webpack";
import {
    AuthenticationStore, ChannelStore, FluxDispatcher, NavigationRouter, NotificationSettingsStore, ReadStateStore, RestAPI, RunningGameStore,
    SelectedChannelStore, showToast, SnowflakeUtils, WindowStore
} from "@webpack/common";

import { authorName, buildNotification, NotificationContent, whereLabel } from "./card";
import { decide, Decision } from "./decision";
import { findMonitor, saveMonitor } from "./displays";
import { collectButtons, RawComponent, RawMessage } from "./format";
import { detectedGames } from "./games";
import { contextMenus } from "./menus";
import { Level, migrateRules, pruneExpired, Rule, RuleKind, SoundLevel, withRule } from "./rules";
import { settings } from "./settings";
import managedStyle from "./styles.css?managed";
import type { HoverBehavior, OverlayAction, OverlayDisplay, OverlayLayout, OverlayNotification, OverlayPosition, TypingBehavior, TypingTrigger } from "./types";
import { bridge } from "./ui/bridge";
import { openSettings } from "./ui/SettingsModal";

const Native = VencordNative.pluginHelpers.BetterNotifications as PluginNative<typeof import("./native")>;
const logger = new Logger("BetterNotifications");

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
        gameDisplay: s.gameDisplay,
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
        lockInGame: s.lockInGame,
        shortcut: s.shortcut.trim(),
        unlockShortcut: s.unlockShortcut.trim()
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

// ── Showing the card ───────────────────────────────────────────────────────────

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

/** With desktop notifications turned off, Discord plays the sound of what it notifies without making a notification */
function discordPlaysSoundAlone(decision: Decision) {
    return decision.discordWould
        && NotificationSettingsStore.getDesktopType() === "NEVER"
        && !NotificationSettingsStore.isSoundDisabled(DEFAULT_SOUND);
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
            if (decision) {
                // Discord plays the sound from inside showNotification, and passes none when its message sound is turned off:
                // the rules have the last word either way
                const discordPlays = !decision.suppressNative && options?.sound != null;
                if (decision.sound && !discordPlays)
                    utils.playNotificationSound(options?.sound ?? DEFAULT_SOUND, options?.volume ?? 1, options?.soundpack);
                if (decision.suppressNative) return Promise.resolve(undefined);
                if (!decision.sound && options?.sound != null) options = { ...options, sound: undefined };
            }
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
    const where = whereLabel(channel);

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

// ── Games ──────────────────────────────────────────────────────────────────────

let gameReported: string | null = null;

/** Send real game process ids so the main process can distinguish playing from Alt+Tab and the Start menu */
function syncGame() {
    let pids: number[];
    try {
        pids = [...new Set(detectedGames()
            .map(game => game.pid)
            .filter((pid): pid is number => typeof pid === "number" && Number.isInteger(pid) && pid > 0))].sort((a, b) => a - b);
    } catch (e) {
        logger.error("Failed to read the running games", e);
        return;
    }

    const key = pids.join(",");
    if (key === gameReported) return;
    gameReported = key;
    Native.setRunningGames(pids).catch(e => {
        gameReported = null;
        logger.error("Failed to report the running games", e);
    });
}

function syncGameDisplay() {
    Native.setGameDisplay(settings.store.gameDisplay).catch(e => logger.error("Failed to change the game display", e));
}

/**
 * Older versions saved the bare Electron display id, which stops matching when Windows restarts:
 * save the monitor itself while that id is still valid.
 */
async function migrateGameDisplay() {
    const saved = settings.store.gameDisplay;
    if (!saved || saved.startsWith("{")) return;

    try {
        const monitor = findMonitor(saved, await Native.getDisplays());
        if (monitor && settings.store.gameDisplay === saved) settings.store.gameDisplay = saveMonitor(monitor);
    } catch (e) {
        logger.error("Failed to migrate the game display", e);
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
bridge.getDisplays = () => Native.getDisplays();

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

            // Without a notification from Discord, nothing plays the sound: what it would not have notified, but also everything
            // while its own in-game overlay is focused. Play it ourselves, unless its notification shows up after all
            if (decision.sound && !viewing && !discordHandled.has(message.id) && !discordPlaysSoundAlone(decision)) {
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
        RunningGameStore.addChangeListener(syncGame);
        SettingsStore.addChangeListener("plugins.BetterNotifications.gameDisplay", syncGameDisplay);
        syncGame();
        migrateGameDisplay();
    },

    stop() {
        running = false;
        unhookNotifications();
        RunningGameStore.removeChangeListener(syncGame);
        SettingsStore.removeChangeListener("plugins.BetterNotifications.gameDisplay", syncGameDisplay);
        gameReported = null;
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
