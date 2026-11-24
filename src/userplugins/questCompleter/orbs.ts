/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Orbs: whether the account gets the Nitro multiplier, and its balance

import * as DataStore from "@api/DataStore";
import { Flux, RestAPI } from "@webpack/common";

import { boostEvidence } from "./catalog";
import { currentAccountId, logger } from "./runtime";
import { discordBoostEligibility, hasNitro } from "./selectors";
import { PLUGIN_NAME } from "./settings";
import { emit, state } from "./state";

/** What past claims taught about the Nitro multiplier, by account id */
export const BOOST_KEY = `${PLUGIN_NAME}-boost`;
const BALANCE_TTL = 60_000;
/** Discord EntitlementType: bought in the Shop with Orbs; PREMIUM_SUBSCRIPTION: a paid Nitro subscription */
const ENTITLEMENT_VIRTUAL_CURRENCY = 12;
const ENTITLEMENT_PREMIUM_SUBSCRIPTION = 2;

/** Learns from what Discord really paid whether this account gets the Nitro multiplier, and remembers it per account */
export function updateBoostEvidence() {
    const evidence = boostEvidence(state.catalog.values());
    if (evidence === undefined || evidence === state.boost.claimed) return;
    state.boost = { ...state.boost, claimed: evidence };
    const accountId = currentAccountId();
    if (accountId) DataStore.update<Record<string, boolean>>(BOOST_KEY, all => ({ ...all, [accountId]: evidence })).catch(() => { });
    emit();
}

/**
 * Until a claim tells, the entitlements do: Nitro bought in the Shop with Orbs is an entitlement redeemed with virtual
 * currency, and does not get the multiplier although the account shows as Nitro.
 */
export async function checkOrbsNitro() {
    const accountId = currentAccountId();
    // Discord’s own eligibility check makes this guess unnecessary
    if (!hasNitro() || state.boost.claimed != null || !accountId || discordBoostEligibility() !== undefined) return;
    try {
        const response = await RestAPI.get({ url: "/users/@me/entitlements", query: { with_sku: true, exclude_ended: true } });
        const entitlements = response?.body ?? response;
        if (!Array.isArray(entitlements) || currentAccountId() !== accountId) return;

        const now = Date.now();
        const active = (e: any) => !e?.deleted && (!e?.ends_at || Date.parse(e.ends_at) > now);
        const premium = (e: any) => e?.subscription_plan != null || /nitro/i.test(e?.sku?.name ?? "");
        const boughtWithOrbs = entitlements.some(e => active(e) && e.type === ENTITLEMENT_VIRTUAL_CURRENCY && premium(e));
        const paid = entitlements.some(e => active(e) && e.type === ENTITLEMENT_PREMIUM_SUBSCRIPTION);
        state.boost = { ...state.boost, orbsNitro: boughtWithOrbs && !paid };
        emit();
    } catch (error) {
        logger.info("Entitlements unavailable, the Nitro multiplier will be confirmed by the next claim", error);
    }
}

let balanceFetchedAt = 0;
let balanceWarned = false;

/** Discord keeps the balance shown in Quest Home and the Shop in a store; its name is not documented */
function balanceFromStores(): number | undefined {
    try {
        for (const store of (Flux.Store as any).getAll?.() ?? []) {
            if (!/virtualcurrency|orb/i.test(store?.getName?.() ?? "")) continue;
            for (const key of ["getBalance", "getVirtualCurrencyBalance", "getOrbsBalance", "getOrbBalance"]) {
                if (typeof store[key] !== "function") continue;
                const value = store[key]();
                const amount = Number(typeof value === "object" ? value?.balance ?? value?.amount : value);
                if (value != null && Number.isFinite(amount)) return amount;
            }
            if (Number.isFinite(store.balance)) return store.balance;
        }
    } catch { }
}

export async function fetchBalance(force = false) {
    if (!force && Date.now() - balanceFetchedAt < BALANCE_TTL) return;
    balanceFetchedAt = Date.now();
    const accountId = currentAccountId();

    let balance = balanceFromStores();
    if (balance == null) {
        try {
            const response = await RestAPI.get({ url: "/users/@me/virtual-currency/balance" });
            const body = response?.body ?? response;
            const amount = Number(body?.balance ?? body?.amount);
            if (Number.isFinite(amount)) balance = amount;
        } catch { }
    }

    if (currentAccountId() !== accountId) return;
    if (balance == null) {
        if (!balanceWarned) {
            balanceWarned = true;
            const names = ((Flux.Store as any).getAll?.() ?? []).map((store: any) => store?.getName?.()).filter((name: string) => /currency|orb|wallet|balance/i.test(name ?? ""));
            logger.info("Orb balance not found; stores that look related:", names);
        }
        return;
    }
    if (balance !== state.balance) {
        state.balance = balance;
        emit();
    }
}

/** The next fetchBalance() asks again instead of trusting the last answer */
export function resetBalance() {
    balanceFetchedAt = 0;
}
