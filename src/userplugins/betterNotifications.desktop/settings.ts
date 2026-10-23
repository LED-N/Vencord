/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { makeRange, OptionType } from "@utils/types";

import type { Rules } from "./rules";
import { RulesEditor } from "./RulesEditor";

export const settings = definePluginSettings({
    // ── Filters ───────────────────────────────────────────────────────────────
    servers: {
        type: OptionType.SELECT,
        description: "Messages de serveurs",
        options: [
            { label: "Tous (selon les réglages de notification Discord)", value: "all", default: true },
            { label: "Mentions seulement", value: "mentions" },
            { label: "Seulement les serveurs / salons choisis (clic droit → BetterNotifications)", value: "chosen" },
            { label: "Aucun", value: "none" }
        ]
    },
    dms: {
        type: OptionType.SELECT,
        description: "Messages privés",
        options: [
            { label: "Tous", value: "all", default: true },
            { label: "Seulement mes amis", value: "friends" },
            { label: "Seulement les personnes choisies (clic droit → BetterNotifications)", value: "chosen" },
            { label: "Aucun", value: "none" }
        ]
    },
    groupDms: {
        type: OptionType.BOOLEAN,
        description: "Notifier les groupes privés",
        default: true
    },
    keywords: {
        type: OptionType.STRING,
        description: "Mots-clés séparés par des virgules : un message qui en contient un est toujours notifié, même dans un salon muté",
        default: ""
    },
    sound: {
        type: OptionType.BOOLEAN,
        description: "Jouer le son de notification (chaque serveur, salon ou personne peut avoir sa propre règle)",
        default: true
    },
    rules: {
        type: OptionType.CUSTOM,
        default: {} as Rules
    },
    rulesEditor: {
        type: OptionType.COMPONENT,
        component: RulesEditor
    },

    // ── Appearance ────────────────────────────────────────────────────────────
    position: {
        type: OptionType.SELECT,
        description: "Emplacement des notifications",
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
        description: "Écran sur lequel les notifications apparaissent",
        options: [
            { label: "Celui où se trouve la souris (le jeu en cours)", value: "cursor", default: true },
            { label: "L'écran principal", value: "primary" },
            { label: "Celui de la fenêtre Discord", value: "discord" }
        ]
    },
    offsetX: {
        type: OptionType.SLIDER,
        description: "Décalage horizontal depuis le bord de l'écran (pixels)",
        markers: [0, 50, 100, 200, 300, 400],
        default: 0,
        stickToMarkers: false
    },
    offsetY: {
        type: OptionType.SLIDER,
        description: "Décalage vertical depuis le bord de l'écran (pixels), par exemple pour laisser visible une zone de saisie",
        markers: [0, 50, 100, 200, 300, 400],
        default: 0,
        stickToMarkers: false
    },
    duration: {
        type: OptionType.SLIDER,
        description: "Durée d'affichage d'une notification (secondes). Le survol de la souris met le compte à rebours en pause",
        markers: [3, 5, 8, 10, 15, 20],
        default: 8,
        stickToMarkers: false
    },
    maxWidth: {
        type: OptionType.SLIDER,
        description: "Largeur maximale d'une notification (pixels). Les messages courts restent plus étroits",
        markers: [300, 360, 420, 480, 540, 600, 700],
        default: 440,
        stickToMarkers: false
    },
    scale: {
        type: OptionType.SLIDER,
        description: "Échelle (taille du texte et des images)",
        markers: [0.7, 0.8, 0.9, 1, 1.1, 1.25, 1.5],
        default: 1,
        stickToMarkers: false
    },
    opacity: {
        type: OptionType.SLIDER,
        description: "Opacité du fond des notifications (%)",
        markers: [50, 60, 70, 80, 90, 100],
        default: 97,
        stickToMarkers: false
    },
    maxHeight: {
        type: OptionType.SLIDER,
        description: "Hauteur maximale occupée par les notifications (% de l'écran). Au-delà, les plus anciennes sont regroupées en « +N »",
        markers: [30, 40, 50, 60, 70, 80, 100],
        default: 60,
        stickToMarkers: false
    },
    maxVisible: {
        type: OptionType.SLIDER,
        description: "Nombre maximum de notifications affichées en même temps",
        markers: makeRange(1, 8),
        default: 5,
        stickToMarkers: true
    },
    collapseOlder: {
        type: OptionType.BOOLEAN,
        description: "Réduire les anciennes notifications à une ligne (seule la plus récente, ou celle survolée, est affichée en entier)",
        default: true
    },
    groupMessages: {
        type: OptionType.BOOLEAN,
        description: "Regrouper les messages successifs d'une même conversation dans une seule notification",
        default: true
    },

    // ── Content ───────────────────────────────────────────────────────────────
    fullEmbeds: {
        type: OptionType.BOOLEAN,
        description: "Afficher le message complet (embeds). Désactivé : une ligne de texte seulement",
        default: true
    },
    showImages: {
        type: OptionType.BOOLEAN,
        description: "Afficher les grandes images (images d'embed, aperçus de liens, pièces jointes)",
        default: true
    },
    showGifs: {
        type: OptionType.BOOLEAN,
        description: "Afficher les GIFs et les emojis animés. Désactivé : les GIFs sont masqués et les emojis figés",
        default: true
    },
    showButtons: {
        type: OptionType.BOOLEAN,
        description: "Afficher les boutons des bots",
        default: true
    },

    // ── Staying out of the way ────────────────────────────────────────────────
    autoCollapse: {
        type: OptionType.SLIDER,
        description: "Réduire aussi la notification la plus récente à une ligne après ce délai (secondes, 0 = jamais). Le survol l'affiche en entier",
        markers: [0, 2, 3, 5, 8, 10],
        default: 0,
        stickToMarkers: false
    },
    hover: {
        type: OptionType.SELECT,
        description: "Au survol de la souris",
        options: [
            { label: "La notification devient cliquable", value: "interact", default: true },
            { label: "Mode fantôme : elle devient transparente et laisse passer les clics, puis cliquable si la souris reste dessus", value: "ghost" }
        ]
    },
    typing: {
        type: OptionType.SELECT,
        description: "Pendant que tu utilises une autre application ou un jeu (voir le déclencheur ci-dessous). Approcher la souris d'une notification l'affiche normalement",
        options: [
            { label: "Ne rien faire", value: "off" },
            { label: "Estomper les notifications", value: "fade", default: true },
            { label: "Masquer les notifications le temps de la frappe", value: "hide" }
        ]
    },
    typingTrigger: {
        type: OptionType.SELECT,
        description: "Ce qui déclenche l'estompage",
        options: [
            { label: "Toute activité clavier ou souris loin des notifications (jeux : touches maintenues, déplacements, clics)", value: "any", default: true },
            { label: "La frappe au clavier seulement, souris immobile", value: "keyboard" }
        ]
    },
    typingOpacity: {
        type: OptionType.SLIDER,
        description: "Opacité des notifications estompées pendant la frappe (%)",
        markers: [5, 10, 20, 30, 40, 50],
        default: 20,
        stickToMarkers: false
    },
    shortcut: {
        type: OptionType.STRING,
        description: "Raccourci clavier global pour fermer toutes les notifications, actif uniquement pendant qu'elles sont affichées (format Electron, ex. Alt+Shift+N ; vide = désactivé)",
        default: "Alt+Shift+N"
    },
    clickable: {
        type: OptionType.BOOLEAN,
        description: "Notifications cliquables (ouvrir le message, liens, boutons, clic droit). Désactivé : la souris les traverse toujours",
        default: true
    },
    onlyWhenUnfocused: {
        type: OptionType.BOOLEAN,
        description: "N'afficher les notifications que lorsque Discord n'est pas au premier plan",
        default: false
    },
    hideNativeNotifications: {
        type: OptionType.BOOLEAN,
        description: "Ne plus afficher les notifications Windows : l'overlay les remplace et applique aussi ses filtres (le son est conservé selon tes règles)",
        default: true
    },

    // ── Privacy ───────────────────────────────────────────────────────────────
    privacy: {
        type: OptionType.SELECT,
        description: "Masquer le contenu des messages privés et des groupes privés (les messages de serveurs, mentions comprises, restent visibles)",
        options: [
            { label: "Jamais", value: "off" },
            { label: "Quand le mode streamer de Discord est actif", value: "streamer", default: true },
            { label: "Quand le mode streamer est actif ou que tu partages ton écran / un jeu", value: "streaming" },
            { label: "Toujours", value: "always" }
        ]
    },
    privacyHideAuthor: {
        type: OptionType.BOOLEAN,
        description: "Pour les messages privés masqués, cacher aussi l'auteur, son avatar et le nom du groupe",
        default: false
    }
});
