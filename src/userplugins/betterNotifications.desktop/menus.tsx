/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { NavContextMenuPatchCallback } from "@api/ContextMenu";
import type { Channel, Guild, User } from "@vencord/discord-types";
import { Menu } from "@webpack/common";

import { Rule, RuleKind, Rules, ShowRule, SoundRule, withRule } from "./rules";
import { settings } from "./settings";

const SHOW_OPTIONS: [ShowRule | undefined, string][] = [
    [undefined, "Par défaut"],
    ["always", "Toujours (même si muté)"],
    ["mentions", "Mentions seulement"],
    ["never", "Jamais"]
];
const SOUND_OPTIONS: [SoundRule | undefined, string][] = [[undefined, "Par défaut"], ["on", "Activé"], ["off", "Coupé"]];
const SNOOZES: [number, string][] = [[15, "15 minutes"], [60, "1 heure"], [8 * 60, "8 heures"], [24 * 60, "24 heures"]];

/**
 * Patches run while the context menu renders, so this hook makes the menu re-render as soon as a rule changes:
 * without it, the new check mark only showed up once the mouse moved to another row.
 * Called unconditionally at the top of every patch, to keep the hook order stable.
 */
const useRules = () => settings.use(["rules"]).rules;

function ruleMenu(rules: Rules, id: string, kind: RuleKind) {
    const rule: Rule | undefined = rules[id];
    const set = (patch: Partial<Rule>) => settings.store.rules = withRule(settings.store.rules, id, kind, patch);
    const snoozed = !!rule?.snoozedUntil && rule.snoozedUntil > Date.now();

    return (
        <Menu.MenuGroup key="vc-bn">
            <Menu.MenuItem id="vc-bn" label="BetterNotifications">
                <Menu.MenuGroup label="Affichage">
                    {SHOW_OPTIONS.map(([value, label]) => (
                        <Menu.MenuRadioItem
                            key={label}
                            group="vc-bn-show"
                            id={`vc-bn-show-${value ?? "default"}`}
                            label={label}
                            checked={rule?.show === value}
                            action={() => set({ show: value })}
                        />
                    ))}
                </Menu.MenuGroup>
                <Menu.MenuGroup label="Son">
                    {SOUND_OPTIONS.map(([value, label]) => (
                        <Menu.MenuRadioItem
                            key={label}
                            group="vc-bn-sound"
                            id={`vc-bn-sound-${value ?? "default"}`}
                            label={label}
                            checked={rule?.sound === value}
                            action={() => set({ sound: value })}
                        />
                    ))}
                </Menu.MenuGroup>
                <Menu.MenuGroup>
                    <Menu.MenuCheckboxItem
                        id="vc-bn-priority"
                        label="Prioritaire (reste affichée)"
                        checked={!!rule?.priority}
                        action={() => set({ priority: rule?.priority ? undefined : true })}
                    />
                    <Menu.MenuItem id="vc-bn-snooze" label={snoozed ? "Silence en cours" : "Silence temporaire"}>
                        {snoozed && <Menu.MenuItem id="vc-bn-snooze-off" label="Lever le silence" action={() => set({ snoozedUntil: undefined })} />}
                        {SNOOZES.map(([minutes, label]) => (
                            <Menu.MenuItem
                                key={minutes}
                                id={`vc-bn-snooze-${minutes}`}
                                label={label}
                                action={() => set({ snoozedUntil: Date.now() + minutes * 60_000 })}
                            />
                        ))}
                    </Menu.MenuItem>
                </Menu.MenuGroup>
            </Menu.MenuItem>
        </Menu.MenuGroup>
    );
}

const guildContext: NavContextMenuPatchCallback = (children, { guild }: { guild?: Guild; }) => {
    const rules = useRules();
    if (guild) children.push(ruleMenu(rules, guild.id, "guild"));
};

const channelContext: NavContextMenuPatchCallback = (children, { channel }: { channel?: Channel; }) => {
    const rules = useRules();
    if (channel) children.push(ruleMenu(rules, channel.id, "channel"));
};

const userContext: NavContextMenuPatchCallback = (children, { user }: { user?: User; }) => {
    const rules = useRules();
    if (user) children.push(ruleMenu(rules, user.id, "user"));
};

export const contextMenus = {
    "guild-context": guildContext,
    "channel-context": channelContext,
    "thread-context": channelContext,
    "gdm-context": channelContext,
    "user-context": userContext
};
