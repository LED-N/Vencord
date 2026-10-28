/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { Level, MentionKind, SoundLevel, SourceKind } from "./rules";

// Wording shared by the settings window and the context menus

export const NOTIFY_LABELS: Record<Level, string> = {
    all: "Tous les messages",
    discord: "Selon Discord",
    mentions: "Mentions",
    friends: "Amis seulement",
    none: "Rien"
};

export const SOUND_LABELS: Record<SoundLevel, string> = {
    same: "Comme la notification",
    ...NOTIFY_LABELS,
    none: "Aucun son"
};

export const LEVEL_HINTS: Partial<Record<SoundLevel, string>> = {
    all: "Chaque message, même dans un salon muté",
    discord: "Respecte les mutes et les réglages de notification de Discord",
    mentions: "Seulement les mentions choisies, même dans un salon muté",
    none: "Jamais",
    same: "Le son suit la notification"
};

/** Choices of the exceptions; undefined inherits from the broader scope */
export const RULE_NOTIFY: (Level | undefined)[] = [undefined, "all", "discord", "mentions", "none"];
export const RULE_SOUND: (SoundLevel | undefined)[] = [undefined, "same", "all", "discord", "mentions", "none"];

export const MENTION_LABELS: Record<MentionKind, { label: string; hint: string; }> = {
    me: { label: "@toi", hint: "Mentions directes, et réponses qui te mentionnent" },
    roles: { label: "@rôles", hint: "Les rôles que tu possèdes sur le serveur" },
    everyone: { label: "@everyone · @here", hint: "Annonces adressées à tout le serveur ou au salon" },
    keywords: { label: "Mots-clés", hint: "Un message contenant l'un de tes mots-clés" }
};

interface SourceInfo {
    title: string;
    hint: string;
    notify: [Level, string][];
    sound: [SoundLevel, string][];
}

export const SOURCES: Record<SourceKind, SourceInfo> = {
    servers: {
        title: "Serveurs",
        hint: "Les salons et fils de tous tes serveurs",
        notify: [["discord", "Selon Discord"], ["mentions", "Mentions"], ["none", "Rien"]],
        sound: [["same", "Comme la notif"], ["discord", "Selon Discord"], ["mentions", "Mentions"], ["none", "Aucun"]]
    },
    dms: {
        title: "Messages privés",
        hint: "Tes conversations en tête-à-tête",
        notify: [["discord", "Tous"], ["friends", "Amis seulement"], ["none", "Rien"]],
        sound: [["same", "Comme la notif"], ["discord", "Tous"], ["friends", "Amis"], ["none", "Aucun"]]
    },
    groups: {
        title: "Groupes privés",
        hint: "Les conversations de groupe hors serveur",
        notify: [["discord", "Tous"], ["mentions", "Mentions"], ["none", "Rien"]],
        sound: [["same", "Comme la notif"], ["discord", "Tous"], ["mentions", "Mentions"], ["none", "Aucun"]]
    }
};

function phrase(level: Level, source?: SourceKind) {
    switch (level) {
        case "discord": return source === "servers" || !source ? "selon Discord" : "pour chaque message";
        case "all": return "pour chaque message";
        case "mentions": return "pour les mentions";
        case "friends": return "pour tes amis";
        default: return "";
    }
}

/** One sentence telling what actually happens, the sound already resolved */
export function outcome(notify: Level, sound: Level, source?: SourceKind) {
    if (notify === "none" && sound === "none") return source ? "Rien, sauf tes exceptions" : "Rien";
    if (notify === "none") return `Son seulement, ${phrase(sound, source)}`;
    if (sound === "none") return `Notification ${phrase(notify, source)}, sans son`;
    if (sound === notify) return `Notification et son ${phrase(notify, source)}`;
    return `Notification ${phrase(notify, source)}, son ${phrase(sound, source)}`;
}
