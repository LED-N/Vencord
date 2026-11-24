/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Confirmations shown by the menu, and the menu stepping aside while something else needs the screen

import { abortError, CaptchaRequired, toast } from "./runtime";
import { Dialog, emit, state } from "./state";

const openDialogs = new Set<() => void>();

/** Dismisses every dialog still waiting for an answer */
export function cancelDialogs() {
    for (const cancel of openDialogs) cancel();
}

/** Hides the menu until the returned function is called; overlapping reasons stack */
export function suspendMenu() {
    state.suspended++;
    emit();
    let released = false;
    return () => {
        if (released) return;
        released = true;
        state.suspended = Math.max(0, state.suspended - 1);
        emit();
    };
}

/** Shows a QC dialog; resolves false when dismissed, stopped or superseded by an account change */
function askDialog(make: (resolve: (value: boolean) => void) => Dialog, signal: AbortSignal): Promise<boolean> {
    return new Promise(resolve => {
        if (signal.aborted || state.dialog) {
            if (state.dialog) toast("Une confirmation est déjà ouverte.", "info");
            resolve(false);
            return;
        }

        let settled = false;
        const finish = (value: boolean) => {
            if (settled) return;
            settled = true;
            signal.removeEventListener("abort", abort);
            openDialogs.delete(abort);
            if (state.dialog === dialog) state.dialog = null;
            emit();
            resolve(value);
        };
        const abort = () => finish(false);
        const dialog = make(finish);

        signal.addEventListener("abort", abort, { once: true });
        openDialogs.add(abort);
        state.dialog = dialog;
        emit();
    });
}

export function confirmActivityRisk(quest: any, signal: AbortSignal) {
    return askDialog(resolve => ({ type: "risk", quest, resolve }), signal);
}

/** Human-in-the-loop captcha: QC never solves it, it waits for the user to solve Discord's own */
export async function promptHumanCaptcha(label: string, signal: AbortSignal) {
    const release = suspendMenu();
    try {
        const solved = await askDialog(resolve => ({ type: "captcha", label, resolve }), signal);
        if (signal.aborted) throw abortError();
        if (!solved) throw new CaptchaRequired();
    } finally {
        release();
    }
}
