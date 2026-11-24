/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Small helpers shared by the engine modules: nothing here depends on them

import { isPluginEnabled, plugins } from "@api/PluginManager";
import { Logger } from "@utils/Logger";
import type { PluginNative } from "@utils/types";
import { findByProps } from "@webpack";
import { UserStore } from "@webpack/common";

import { PLUGIN_NAME, settings } from "./settings";
import { emit, state, ToastType } from "./state";

export const Native = VencordNative.pluginHelpers[PLUGIN_NAME] as PluginNative<typeof import("./native")>;
export const logger = new Logger(PLUGIN_NAME, "#C084FC");

export class CaptchaRequired extends Error {
    constructor() {
        super("Captcha requis");
    }
}

export const abortError = () => new DOMException("Arrêt demandé", "AbortError");
export const isAbort = (error: any) => error?.name === "AbortError";
export const currentAccountId = (): string | undefined => UserStore.getCurrentUser()?.id;
export const nameOf = (quest: any): string => quest?.config?.messages?.questName ?? quest?.config?.application?.name ?? "Quête";

// ── Timers ───────────────────────────────────────────────────────────────────

const timers = new Set<ReturnType<typeof setTimeout>>();

export function later(action: () => void, delay: number) {
    const timer = setTimeout(() => {
        timers.delete(timer);
        action();
    }, delay);
    timers.add(timer);
    return timer;
}

export function cancelLater(timer: ReturnType<typeof setTimeout> | null) {
    if (timer == null) return;
    clearTimeout(timer);
    timers.delete(timer);
}

/** Cancels everything scheduled with later() */
export function clearTimers() {
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
}

// ── Toasts and announcements ─────────────────────────────────────────────────

let toastId = 0;

export function toast(text: string, type: ToastType = "info", ttl = 4500) {
    const id = ++toastId;
    state.toasts = [...state.toasts.slice(-3), { id, text, type }];
    emit();
    later(() => {
        state.toasts = state.toasts.map(t => t.id === id ? { ...t, leaving: true } : t);
        emit();
        later(() => {
            state.toasts = state.toasts.filter(t => t.id !== id);
            emit();
        }, 250);
    }, ttl);
}

/** A card in BetterNotifications' overlay, visible over games; false when that plugin is not running */
export function announce(id: string, title: string, text: string) {
    if (!settings.store.overlayNotify || !isPluginEnabled("BetterNotifications")) return false;
    try {
        return !!(plugins.BetterNotifications as any).showExternal?.({ id: `qc-${id}-${Date.now()}`, title, subtitle: "Quêtes", text });
    } catch (e) {
        logger.error("BetterNotifications announcement failed", e);
        return false;
    }
}

// ── Discord's quest store ────────────────────────────────────────────────────

let questsStoreCache: any = null;
export function questsStore(): any {
    return questsStoreCache ??= findByProps("getQuest");
}
