/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { OverlayMonitor } from "../types";

/** Filled by index.tsx, so the settings window can reach the overlay without importing the plugin */
export const bridge = {
    sendTest() { },
    async getDisplays(): Promise<OverlayMonitor[]> { return []; }
};
