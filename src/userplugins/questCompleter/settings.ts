/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { OptionType } from "@utils/types";

export const PLUGIN_NAME = "CompleteDiscordQuests";

export const settings = definePluginSettings({
    // ── Launcher ────────────────────────────────────────────────────────────
    launcher: {
        type: OptionType.SELECT,
        description: "Emplacement du bouton des quêtes",
        options: [
            { label: "Près des réglages du compte (en bas à gauche)", value: "account", default: true },
            { label: "Dans l'en-tête (barre de titre)", value: "header" },
            { label: "Les deux", value: "both" },
            { label: "Bouton flottant (en bas à droite)", value: "floating" }
        ]
    },
    nitroBoost: {
        type: OptionType.SELECT,
        description: "Bonus Nitro ×1,2 sur les Orbs. Le Nitro obtenu avec des Orbs ou des crédits Nitro n'y a pas droit : la détection automatique s'appuie sur tes récupérations passées",
        options: [
            { label: "Détection automatique", value: "auto", default: true },
            { label: "Toujours appliquer", value: "on" },
            { label: "Ne jamais appliquer", value: "off" }
        ]
    },
    showBadges: {
        type: OptionType.BOOLEAN,
        description: "Pastilles sur le bouton : rouge = quêtes disponibles, verte = récompenses prêtes à être récupérées",
        default: true
    },

    // ── Automation ──────────────────────────────────────────────────────────
    autoAccept: {
        type: OptionType.BOOLEAN,
        description: "Accepter automatiquement les quêtes pour le lancement automatique (un choix dans le menu accepte toujours la quête choisie)",
        default: false
    },
    autoClaim: {
        type: OptionType.BOOLEAN,
        description: "Récupérer la récompense dès que Discord confirme la fin d'une quête",
        default: true
    },
    captchaVerification: {
        type: OptionType.BOOLEAN,
        description: "Quand Discord demande un captcha, attendre que tu le résolves (aucun captcha n'est résolu automatiquement)",
        default: true
    },
    autoStart: {
        type: OptionType.BOOLEAN,
        description: "Lancer automatiquement les quêtes disponibles, au démarrage et à l'arrivée de nouvelles, selon les filtres de « Tout ajouter »",
        default: false
    },
    overlayNotify: {
        type: OptionType.BOOLEAN,
        description: "Annoncer les quêtes terminées dans l'overlay BetterNotifications (visible en jeu) quand ce plugin est activé",
        default: true
    },
    resumeQueue: {
        type: OptionType.BOOLEAN,
        description: "Reprendre la file d'attente après un redémarrage de Discord",
        default: false
    },

    // ── "Add all" filters: quest types ─────────────────────────────────────
    farmVideo: {
        type: OptionType.BOOLEAN,
        description: "« Tout ajouter » : inclure les vidéos",
        default: true
    },
    farmDesktop: {
        type: OptionType.BOOLEAN,
        description: "« Tout ajouter » : inclure les jeux sur ordinateur",
        default: true
    },
    farmStreaming: {
        type: OptionType.BOOLEAN,
        description: "« Tout ajouter » : inclure le streaming",
        default: true
    },
    farmActivities: {
        type: OptionType.BOOLEAN,
        description: "« Tout ajouter » : inclure les activités",
        default: true
    },
    achievementBypass: {
        type: OptionType.BOOLEAN,
        description: "Objectifs d'activité dans « Tout ajouter » et le lancement automatique : autorisation temporaire de l'application, déclaration de l'objectif puis révocation. Risque de sanction pour le compte",
        default: false
    },

    // ── "Add all" filters: rewards ──────────────────────────────────────────
    farmOrbs: {
        type: OptionType.BOOLEAN,
        description: "« Tout ajouter » : inclure les Orbs",
        default: true
    },
    farmDecorations: {
        type: OptionType.BOOLEAN,
        description: "« Tout ajouter » : inclure les décorations d'avatar / de profil",
        default: true
    },
    farmInGame: {
        type: OptionType.BOOLEAN,
        description: "« Tout ajouter » : inclure les récompenses en jeu",
        default: true
    },
    farmRewardCodes: {
        type: OptionType.BOOLEAN,
        description: "« Tout ajouter » : inclure les codes à échanger",
        default: true
    },
    farmFractionalPremium: {
        type: OptionType.BOOLEAN,
        description: "« Tout ajouter » : inclure Nitro",
        default: true
    },

    // ── Menu ────────────────────────────────────────────────────────────────
    menuFilter: {
        type: OptionType.SELECT,
        description: "Ordre des quêtes dans le menu et dans les ajouts groupés",
        options: [
            { label: "Suggérées", value: "suggested", default: true },
            { label: "Les plus récentes", value: "recent" },
            { label: "Expiration proche", value: "expiring" },
            { label: "Acceptées d'abord", value: "started" },
            { label: "Plus d'Orbs d'abord", value: "orbs" }
        ]
    }
});

export type SettingsKey = keyof typeof settings.store;
