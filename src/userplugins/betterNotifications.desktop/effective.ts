/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ChannelStore } from "@webpack/common";

import { NOTIFY_LABELS, outcome, SOUND_LABELS } from "./labels";
import { resolve, Resolved, Rule, RuleKind, Rules, scopeChain, sourceOf, withRule } from "./rules";
import { sourceDefaults } from "./settings";

// What a server, channel or person ends up receiving, shared by the settings window and the context menus.
// Not in rules.ts: settings.ts reads rules.ts while it is being evaluated, so rules.ts cannot import settings.ts

/** Silences left aside; null for people, whose messages can come from anywhere */
export function effectiveFor(id: string, kind: RuleKind, rules: Rules): Resolved | null {
    if (kind === "user") return null;
    if (kind === "guild") return resolve(rules, [id], sourceDefaults("servers"), Infinity);

    const channel = ChannelStore.getChannel(id);
    if (channel) return resolve(rules, scopeChain(undefined, channel), sourceDefaults(sourceOf(channel)), Infinity);

    const { guildId } = rules[id] ?? {};
    return resolve(rules, guildId ? [id, guildId] : [id], sourceDefaults(guildId ? "servers" : "dms"), Infinity);
}

/** Labels of the "Default" choices: the value the scope would inherit if its own were cleared */
export function inheritedLabels(id: string, kind: RuleKind, rules: Rules) {
    const notify = effectiveFor(id, kind, withRule(rules, id, kind, { notify: undefined }, true))?.notify;
    const sound = effectiveFor(id, kind, withRule(rules, id, kind, { sound: undefined }, true))?.sound;
    return {
        notify: notify ? `Par défaut · ${NOTIFY_LABELS[notify]}` : "Par défaut",
        sound: sound ? `Par défaut · ${SOUND_LABELS[sound]}` : "Par défaut"
    };
}

export const snoozeEnd = (rule?: Rule) => rule?.snoozedUntil && rule.snoozedUntil > Date.now() ? rule.snoozedUntil : undefined;

export const clock = (ms: number) => new Date(ms).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });

/** One sentence telling what the scope receives, silences included */
export function summaryFor(id: string, kind: RuleKind, rules: Rules) {
    const rule = rules[id] as Rule | undefined;
    const snoozed = snoozeEnd(rule);
    if (snoozed) return `Silence jusqu'à ${clock(snoozed)}`;

    const effective = effectiveFor(id, kind, rules);
    if (effective) return outcome(effective.notify, effective.sound);
    if (!rule?.notify && !rule?.sound) return "Réglages par défaut";

    const notify = rule.notify ?? "discord";
    const sound = !rule.sound || rule.sound === "same" ? notify : rule.sound;
    return `${outcome(notify, sound)}, partout où cette personne écrit`;
}
