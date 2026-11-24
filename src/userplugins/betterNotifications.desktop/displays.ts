/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { OverlayMonitor } from "./types";

// Shared between the main process (native.ts) and the settings window: both must agree on which monitor is chosen

type SavedMonitor = Partial<Omit<OverlayMonitor, "primary">>;

/** The value of the gameDisplay setting for this monitor */
export function saveMonitor({ id, label, x, y, width, height }: OverlayMonitor) {
    return JSON.stringify({ id, label, x, y, width, height });
}

function parseSaved(saved: string): SavedMonitor {
    try {
        const value = JSON.parse(saved);
        if (value && typeof value === "object") return value;
    } catch { }
    // Older versions saved the bare Electron id
    return { id: saved };
}

/**
 * The monitor a saved gameDisplay setting stands for, if it is plugged in.
 * Electron's display ids do not survive a Windows restart, so the name and the position count more than the id,
 * which only tells identical monitors apart until then.
 */
export function findMonitor<T extends OverlayMonitor>(saved: string, monitors: T[]) {
    if (!saved) return;
    const target = parseSaved(saved);

    let best: T | undefined;
    let bestScore = 0;
    for (const m of monitors) {
        const score = (target.label && m.label === target.label ? 4 : 0)
            + (m.x === target.x && m.y === target.y && m.width === target.width && m.height === target.height ? 2 : 0)
            + (m.id === target.id ? 1 : 0);
        if (score > bestScore) {
            best = m;
            bestScore = score;
        }
    }
    return best;
}
