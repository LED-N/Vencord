/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Dialog, state, useQcState } from "../state";
import { Launcher } from "./Launcher";
import { QuestMenu } from "./Menu";
import { questName } from "./QuestCard";

const TOAST_ICONS = { info: "✦", success: "✓", error: "✕", warn: "!" };

function DialogView({ dialog }: { dialog: Dialog; }) {
    if (dialog.type === "captcha") {
        // Not modal: Discord's own captcha must stay usable
        return (
            <div className="qc-float-card" role="dialog" aria-label="Vérification Discord">
                <strong className="qc-float-title">Vérification Discord</strong>
                <p>Discord demande un captcha pour {dialog.label}. Résous-le dans Discord, puis continue.</p>
                <div className="qc-dialog-row">
                    <button type="button" className="qc-btn qc-btn-ghost" data-qc-cancel onClick={() => dialog.resolve(false)}>Ignorer</button>
                    <button type="button" className="qc-btn qc-btn-primary" autoFocus onClick={() => dialog.resolve(true)}>Continuer</button>
                </div>
            </div>
        );
    }

    return (
        <div className="qc-backdrop qc-backdrop-top" onMouseDown={e => { if (e.target === e.currentTarget) dialog.resolve(false); }}>
            <div className="qc-dialog" role="alertdialog" aria-modal="true" aria-labelledby="qc-risk-title">
                <h2 id="qc-risk-title">Objectif d'activité : risque pour ton compte</h2>
                <strong className="qc-dialog-quest">{questName(dialog.quest)}</strong>
                <p>
                    Le plugin autorisera temporairement l'application de la quête, déclarera son objectif, puis révoquera l'autorisation ajoutée.
                    Discord peut détecter cette automatisation et sanctionner ton compte ; la révocation ne supprime pas ce risque.
                </p>
                <p>Ton accord ne vaut que pour cette quête. Les ajouts groupés et automatiques restent soumis au réglage « Objectifs d'activité ».</p>
                <div className="qc-dialog-row">
                    <button type="button" className="qc-btn qc-btn-ghost" data-qc-cancel autoFocus onClick={() => dialog.resolve(false)}>Annuler</button>
                    <button type="button" className="qc-btn qc-btn-danger" onClick={() => dialog.resolve(true)}>Lancer malgré le risque</button>
                </div>
            </div>
        </div>
    );
}

function Toasts() {
    return (
        <div className="qc-toasts" role="status">
            {state.toasts.map(toast => (
                <div key={toast.id} className={`qc-toast qc-toast-${toast.type}` + (toast.leaving ? " qc-toast-out" : "")}>
                    <span className="qc-toast-icon">{TOAST_ICONS[toast.type]}</span>
                    <span>{toast.text}</span>
                </div>
            ))}
        </div>
    );
}

/** Everything QC draws outside of Discord's own components */
export function QcRoot() {
    useQcState();
    return (
        <>
            <Launcher place="floating" />
            {state.menuOpen && !state.suspended && <QuestMenu />}
            {state.dialog && <DialogView dialog={state.dialog} />}
            <Toasts />
        </>
    );
}
