/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { React } from "@webpack/common";

import { outcome, SOURCES } from "../labels";
import type { SourceKind } from "../rules";
import { settings, SOURCE_KEYS } from "../settings";
import { bridge } from "./bridge";
import { Icon } from "./icons";
import { openSettings } from "./SettingsModal";

/** All that the Vencord settings page shows: a summary and the way into the BetterNotifications window */
export function SettingsCard() {
    const values = settings.use([...Object.values(SOURCE_KEYS).flat(), "rules"]);
    const exceptions = Object.keys(values.rules).length;

    return (
        <div className="vc-bn-launch">
            <div className="vc-bn-launch-head">
                <div className="vc-bn-launch-icon"><Icon name="bell" size={22} /></div>
                <div>
                    <div className="vc-bn-launch-title">Les réglages sont dans leur propre fenêtre</div>
                    <div className="vc-bn-launch-sub">Sources, exceptions, apparence et comportement en jeu.</div>
                </div>
            </div>
            <dl className="vc-bn-launch-summary">
                {(Object.keys(SOURCES) as SourceKind[]).map(source => {
                    const [notifyKey, soundKey] = SOURCE_KEYS[source];
                    const notify = values[notifyKey];
                    const sound = values[soundKey] === "same" ? notify : values[soundKey];
                    return (
                        <React.Fragment key={source}>
                            <dt>{SOURCES[source].title}</dt>
                            <dd>{outcome(notify, sound, source)}</dd>
                        </React.Fragment>
                    );
                })}
                <dt>Exceptions</dt>
                <dd>{exceptions || "Aucune"}</dd>
            </dl>
            <div className="vc-bn-launch-actions">
                <button type="button" className="vc-bn-btn vc-bn-btn-primary" onClick={() => openSettings()}>Ouvrir les paramètres</button>
                <button type="button" className="vc-bn-btn vc-bn-btn-secondary" onClick={() => bridge.sendTest()}>Envoyer une notification de test</button>
            </div>
        </div>
    );
}
