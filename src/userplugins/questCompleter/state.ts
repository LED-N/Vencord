/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// State shared by the engine (index.tsx) and the React interface (ui/*). The interface never mutates it directly:
// it calls `actions`, which the plugin fills in when it starts.

import { useEffect, useReducer } from "@webpack/common";

import { QuestQueue } from "./catalog";

export type ToastType = "info" | "success" | "error" | "warn";

export interface Toast {
    id: number;
    text: string;
    type: ToastType;
    leaving?: boolean;
}

export type Dialog =
    | { type: "risk"; quest: any; resolve(accepted: boolean): void; }
    | { type: "captcha"; label: string; resolve(solved: boolean): void; };

export interface Stats {
    orbs: number;
    quests: number;
}

export const state = {
    queue: new QuestQueue(),
    catalog: new Map<string, any>(),
    catalogUpdated: 0,
    catalogError: "",
    loading: false,
    running: false,
    /** Quests whose reward is being claimed through Discord's own flow */
    claiming: new Set<string>(),
    menuOpen: false,
    /** The menu steps aside while Discord's claim modal or a captcha needs the screen (one count per reason) */
    suspended: 0,
    toasts: [] as Toast[],
    dialog: null as Dialog | null,
    stats: { orbs: 0, quests: 0 } as Stats,
    /** The account's Orb balance, null while unknown */
    balance: null as number | null,
    /**
     * Whether the account really gets the Nitro Orb multiplier: `claimed` from what Discord paid on past claims,
     * `orbsNitro` when the Nitro itself was bought with Orbs (no multiplier). Undefined while unknown.
     */
    boost: {} as { claimed?: boolean; orbsNitro?: boolean; },
    /** Menu selection, kept while the menu is suspended or closed */
    ui: { tab: "all", search: "", view: "quests" as "quests" | "settings", scroll: 0 }
};

export interface Actions {
    openMenu(): void;
    closeMenu(): void;
    refresh(): void;
    enqueue(quests: any[], bulk?: boolean): void;
    stop(): void;
    remove(id: string): void;
    moveUp(id: string): void;
    claim(quests: any[]): void;
    /** Quest status as the interface should show it, see index.tsx */
    blocked(quest: any): string | undefined;
    bulkExcluded(quest: any): string | undefined;
}

export const actions = {} as Actions;

const listeners = new Set<() => void>();
let version = 0;
let queued = false;

/** Schedules one re-render of the interface, however many changes happen in the current task */
export function emit() {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
        queued = false;
        version++;
        listeners.forEach(listener => listener());
    });
}

/** Re-renders the calling component after every emit() */
export function useQcState() {
    const [, force] = useReducer((x: number) => x + 1, 0);
    useEffect(() => {
        listeners.add(force);
        return () => void listeners.delete(force);
    }, []);
    return version;
}

export function onChange(listener: () => void) {
    listeners.add(listener);
    return () => void listeners.delete(listener);
}
