/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { settings, SettingsKey } from "../settings";
import { emit, state } from "../state";

type Row = [key: SettingsKey, title: string];

const SECTIONS: [string, Row[]][] = [
    ["Bouton", [["launcher", "Emplacement"], ["showBadges", "Pastilles"]]],
    ["Orbs", [["nitroBoost", "Bonus Nitro"]]],
    ["Automatisation", [
        ["autoClaim", "Récupérer automatiquement"],
        ["autoStart", "Lancement automatique"],
        ["autoAccept", "Accepter automatiquement"],
        ["captchaVerification", "Captcha"],
        ["overlayNotify", "Annonce en jeu"],
        ["resumeQueue", "Reprendre la file"]
    ]],
    ["« Tout ajouter » — types de quêtes", [
        ["farmVideo", "Vidéos"],
        ["farmDesktop", "Jeux sur ordinateur"],
        ["farmStreaming", "Streaming"],
        ["farmActivities", "Activités"],
        ["achievementBypass", "Objectifs d'activité"]
    ]],
    ["« Tout ajouter » — récompenses", [
        ["farmOrbs", "Orbs"],
        ["farmDecorations", "Décorations"],
        ["farmInGame", "Récompenses en jeu"],
        ["farmRewardCodes", "Codes"],
        ["farmFractionalPremium", "Nitro"]
    ]]
];

function SettingRow({ id, title }: { id: SettingsKey; title: string; }) {
    const values = settings.use([id]);
    const value = values[id];
    const def: any = settings.def[id];
    const danger = id === "achievementBypass";

    if (def.options) {
        return (
            <div className="qc-set-row qc-set-stack">
                <div className="qc-set-text">
                    <strong>{title}</strong>
                    <span>{def.description}</span>
                </div>
                <div className="qc-seg" role="radiogroup" aria-label={title}>
                    {def.options.map((option: { label: string; value: string; }) => (
                        <button
                            key={option.value}
                            type="button"
                            role="radio"
                            aria-checked={value === option.value}
                            className={value === option.value ? "qc-seg-on" : undefined}
                            onClick={() => (settings.store as any)[id] = option.value}
                        >
                            {option.label}
                        </button>
                    ))}
                </div>
            </div>
        );
    }

    return (
        <label className={"qc-set-row" + (danger ? " qc-set-danger" : "")}>
            <div className="qc-set-text">
                <strong>{title}</strong>
                <span>{def.description}</span>
            </div>
            <input
                type="checkbox"
                className="qc-switch"
                role="switch"
                checked={!!value}
                onChange={() => (settings.store as any)[id] = !value}
            />
        </label>
    );
}

export function SettingsView() {
    return (
        <div className="qc-settings">
            {SECTIONS.map(([label, rows]) => (
                <section key={label} className="qc-set-section">
                    <h2 className="qc-section-title">{label}</h2>
                    <div className="qc-set-card">
                        {rows.map(([id, title]) => <SettingRow key={id} id={id} title={title} />)}
                    </div>
                </section>
            ))}
            <div className="qc-settings-foot">
                <span className="qc-foot-note">Réglages enregistrés automatiquement.</span>
                <button type="button" className="qc-btn qc-btn-primary" onClick={() => { state.ui.view = "quests"; emit(); }}>Retour aux quêtes</button>
            </div>
        </div>
    );
}
