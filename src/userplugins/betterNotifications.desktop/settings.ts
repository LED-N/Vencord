/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { makeRange, OptionType } from "@utils/types";

import { Level, MENTION_KINDS, MentionKind, Rules, SoundLevel } from "./rules";
import { SettingsCard } from "./ui/SettingsCard";

// Everything is edited in the BetterNotifications window (ui/SettingsModal.tsx): the Vencord page only shows SettingsCard.
// The descriptions below are the hints shown there, the option labels are the choices of the segmented controls.

export const settings = definePluginSettings({
    launcher: {
        type: OptionType.COMPONENT,
        component: SettingsCard
    },

    // ── Sources ───────────────────────────────────────────────────────────────
    serversNotify: { type: OptionType.CUSTOM, default: "discord" as Level },
    serversSound: { type: OptionType.CUSTOM, default: "same" as SoundLevel },
    dmsNotify: { type: OptionType.CUSTOM, default: "discord" as Level },
    dmsSound: { type: OptionType.CUSTOM, default: "same" as SoundLevel },
    groupsNotify: { type: OptionType.CUSTOM, default: "discord" as Level },
    groupsSound: { type: OptionType.CUSTOM, default: "same" as SoundLevel },
    mentionKinds: { type: OptionType.CUSTOM, default: [...MENTION_KINDS] as MentionKind[] },
    keywords: {
        type: OptionType.STRING,
        description: "Mots-clés séparés par des virgules",
        default: "",
        hidden: true
    },
    rules: {
        type: OptionType.CUSTOM,
        default: {} as Rules
    },
    onlyWhenUnfocused: {
        type: OptionType.BOOLEAN,
        description: "Rien n'apparaît tant que la fenêtre Discord est au premier plan",
        default: false,
        hidden: true
    },
    hideNativeNotifications: {
        type: OptionType.BOOLEAN,
        description: "L'overlay remplace les notifications Windows de Discord. Le son reste géré par tes réglages",
        default: true,
        hidden: true
    },

    // ── Appearance ────────────────────────────────────────────────────────────
    position: {
        type: OptionType.SELECT,
        description: "Coin ou bord de l'écran où les notifications s'empilent",
        hidden: true,
        options: [
            { label: "En bas à droite", value: "bottom-right", default: true },
            { label: "En haut à droite", value: "top-right" },
            { label: "En bas à gauche", value: "bottom-left" },
            { label: "En haut à gauche", value: "top-left" },
            { label: "En haut au centre", value: "top-center" },
            { label: "En bas au centre", value: "bottom-center" }
        ]
    },
    display: {
        type: OptionType.SELECT,
        description: "« Souris » suit le jeu en cours sur une configuration à plusieurs écrans",
        hidden: true,
        options: [
            { label: "Celui de la souris", value: "cursor", default: true },
            { label: "Principal", value: "primary" },
            { label: "Celui de Discord", value: "discord" }
        ]
    },
    offsetX: {
        type: OptionType.SLIDER,
        description: "Distance depuis le bord gauche ou droit de l'écran",
        markers: [0, 50, 100, 200, 300, 400],
        default: 0,
        stickToMarkers: false,
        hidden: true
    },
    offsetY: {
        type: OptionType.SLIDER,
        description: "Distance depuis le haut ou le bas, par exemple pour laisser visible une zone de saisie",
        markers: [0, 50, 100, 200, 300, 400],
        default: 0,
        stickToMarkers: false,
        hidden: true
    },
    duration: {
        type: OptionType.SLIDER,
        description: "Le survol de la souris met le compte à rebours en pause",
        markers: [3, 5, 8, 10, 15, 20],
        default: 8,
        stickToMarkers: false,
        hidden: true
    },
    maxWidth: {
        type: OptionType.SLIDER,
        description: "Les messages courts restent plus étroits",
        markers: [300, 360, 420, 480, 540, 600, 700],
        default: 440,
        stickToMarkers: false,
        hidden: true
    },
    scale: {
        type: OptionType.SLIDER,
        description: "Taille du texte et des images",
        markers: [0.7, 0.8, 0.9, 1, 1.1, 1.25, 1.5],
        default: 1,
        stickToMarkers: false,
        hidden: true
    },
    opacity: {
        type: OptionType.SLIDER,
        description: "Opacité du fond des cartes",
        markers: [50, 60, 70, 80, 90, 100],
        default: 97,
        stickToMarkers: false,
        hidden: true
    },
    maxHeight: {
        type: OptionType.SLIDER,
        description: "Part de l'écran occupée au maximum. Au-delà, les plus anciennes sont regroupées en « +N »",
        markers: [30, 40, 50, 60, 70, 80, 100],
        default: 60,
        stickToMarkers: false,
        hidden: true
    },
    maxVisible: {
        type: OptionType.SLIDER,
        description: "Nombre de cartes affichées en même temps",
        markers: makeRange(1, 8),
        default: 5,
        stickToMarkers: true,
        hidden: true
    },
    collapseOlder: {
        type: OptionType.BOOLEAN,
        description: "Seule la plus récente, ou celle survolée, est affichée en entier",
        default: true,
        hidden: true
    },
    groupMessages: {
        type: OptionType.BOOLEAN,
        description: "Les messages successifs d'une même conversation partagent une seule carte",
        default: true,
        hidden: true
    },
    autoCollapse: {
        type: OptionType.SLIDER,
        description: "La plus récente se réduit aussi à une ligne après ce délai. Le survol l'affiche en entier",
        markers: [0, 2, 3, 5, 8, 10],
        default: 0,
        stickToMarkers: false,
        hidden: true
    },

    // ── Content ───────────────────────────────────────────────────────────────
    fullEmbeds: {
        type: OptionType.BOOLEAN,
        description: "Mise en forme, embeds et champs. Désactivé : une ligne de texte seulement",
        default: true,
        hidden: true
    },
    showImages: {
        type: OptionType.BOOLEAN,
        description: "Images d'embed, aperçus de liens et pièces jointes",
        default: true,
        hidden: true
    },
    showGifs: {
        type: OptionType.BOOLEAN,
        description: "Désactivé : les GIFs sont masqués et les emojis animés figés",
        default: true,
        hidden: true
    },
    showButtons: {
        type: OptionType.BOOLEAN,
        description: "Boutons des messages de bots, cliquables depuis la carte",
        default: true,
        hidden: true
    },

    // ── Staying out of the way ────────────────────────────────────────────────
    clickable: {
        type: OptionType.BOOLEAN,
        description: "Ouvrir le message, liens, boutons, clic droit. Désactivé : la souris les traverse toujours",
        default: true,
        hidden: true
    },
    hover: {
        type: OptionType.SELECT,
        description: "En mode fantôme, la carte devient transparente et laisse passer les clics, puis cliquable si la souris reste dessus",
        hidden: true,
        options: [
            { label: "Cliquable", value: "interact", default: true },
            { label: "Mode fantôme", value: "ghost" }
        ]
    },
    typing: {
        type: OptionType.SELECT,
        description: "Pendant que tu joues ou écris dans une autre application. Approcher la souris d'une carte l'affiche normalement",
        hidden: true,
        options: [
            { label: "Ne rien faire", value: "off" },
            { label: "Estomper", value: "fade", default: true },
            { label: "Masquer", value: "hide" }
        ]
    },
    typingTrigger: {
        type: OptionType.SELECT,
        description: "Ce qui compte comme de l'activité",
        hidden: true,
        options: [
            { label: "Clavier et souris (jeux)", value: "any", default: true },
            { label: "Frappe au clavier seulement", value: "keyboard" }
        ]
    },
    typingOpacity: {
        type: OptionType.SLIDER,
        description: "Opacité des cartes estompées",
        markers: [5, 10, 20, 30, 40, 50],
        default: 20,
        stickToMarkers: false,
        hidden: true
    },
    shortcut: {
        type: OptionType.STRING,
        description: "Raccourci global qui ferme toutes les cartes, actif seulement pendant qu'elles sont affichées",
        default: "Alt+Shift+N",
        hidden: true
    },

    // ── Privacy ───────────────────────────────────────────────────────────────
    privacy: {
        type: OptionType.SELECT,
        description: "Masque le contenu des messages privés et des groupes. Les messages de serveurs, mentions comprises, restent visibles",
        hidden: true,
        options: [
            { label: "Jamais", value: "off" },
            { label: "Mode streamer", value: "streamer", default: true },
            { label: "Mode streamer ou partage d'écran", value: "streaming" },
            { label: "Toujours", value: "always" }
        ]
    },
    privacyHideAuthor: {
        type: OptionType.BOOLEAN,
        description: "Pour les messages masqués, cache aussi l'auteur, son avatar et le nom du groupe",
        default: false,
        hidden: true
    }
});

export type SettingsKey = keyof typeof settings.store;

const SOURCE_KEYS = {
    servers: ["serversNotify", "serversSound"],
    dms: ["dmsNotify", "dmsSound"],
    groups: ["groupsNotify", "groupsSound"]
} as const;

export function sourceDefaults(source: keyof typeof SOURCE_KEYS) {
    const [notify, sound] = SOURCE_KEYS[source];
    return { notify: settings.store[notify], sound: settings.store[sound], mentions: settings.store.mentionKinds };
}

export function setSource(source: keyof typeof SOURCE_KEYS, notify: Level, sound: SoundLevel) {
    const [notifyKey, soundKey] = SOURCE_KEYS[source];
    settings.store[notifyKey] = notify;
    settings.store[soundKey] = sound;
}

export { SOURCE_KEYS };
