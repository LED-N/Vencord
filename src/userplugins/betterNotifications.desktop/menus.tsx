/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { NavContextMenuPatchCallback } from "@api/ContextMenu";
import type { Channel, Guild, User } from "@vencord/discord-types";
import { Menu } from "@webpack/common";

import { clock, inheritedLabels, snoozeEnd, summaryFor } from "./effective";
import { NOTIFY_LABELS, RULE_NOTIFY, RULE_SOUND, SOUND_LABELS } from "./labels";
import { Rule, RuleKind, Rules, withoutRules, withRule } from "./rules";
import { settings } from "./settings";
import { openSettings } from "./ui/SettingsModal";

const SNOOZES: [number, string][] = [[15, "15 minutes"], [60, "1 heure"], [8 * 60, "8 heures"], [24 * 60, "24 heures"]];

/**
 * Patches run while the context menu renders, so this hook makes the menu re-render as soon as a rule changes:
 * without it, the new check mark only showed up once the mouse moved to another row.
 * Called unconditionally at the top of every patch, to keep the hook order stable.
 * The source settings are listened to as well, since the inherited values shown depend on them.
 */
const useRules = () => settings.use(["rules", "serversNotify", "serversSound", "dmsNotify", "dmsSound", "groupsNotify", "groupsSound"]).rules;

function ruleMenu(rules: Rules, id: string, kind: RuleKind) {
    const rule: Rule | undefined = rules[id];
    // Like in the settings window, an exception only goes away with "Remove": going back to the defaults keeps it listed.
    // Nothing is created either for a change that leaves it empty
    const set = (patch: Partial<Rule>) => {
        const { rules } = settings.store;
        settings.store.rules = withRule(rules, id, kind, patch, !!rules[id]);
    };
    const snoozed = snoozeEnd(rule);
    const inherited = inheritedLabels(id, kind, rules);
    const notifyLabel = rule?.notify ? NOTIFY_LABELS[rule.notify] : inherited.notify;
    const soundLabel = rule?.sound ? SOUND_LABELS[rule.sound] : inherited.sound;

    return (
        <Menu.MenuGroup key="vc-bn">
            <Menu.MenuItem id="vc-bn" label="BetterNotifications">
                <Menu.MenuGroup>
                    <Menu.MenuItem id="vc-bn-status" label={summaryFor(id, kind, rules)} disabled />
                </Menu.MenuGroup>
                <Menu.MenuGroup>
                    <Menu.MenuItem id="vc-bn-notify" label={`Notification : ${notifyLabel}`}>
                        {RULE_NOTIFY.map(value => (
                            <Menu.MenuRadioItem
                                key={value ?? "default"}
                                group="vc-bn-notify"
                                id={`vc-bn-notify-${value ?? "default"}`}
                                label={value ? NOTIFY_LABELS[value] : inherited.notify}
                                checked={rule?.notify === value}
                                action={() => set({ notify: value })}
                            />
                        ))}
                    </Menu.MenuItem>
                    <Menu.MenuItem id="vc-bn-sound" label={`Son : ${soundLabel}`}>
                        {RULE_SOUND.map(value => (
                            <Menu.MenuRadioItem
                                key={value ?? "default"}
                                group="vc-bn-sound"
                                id={`vc-bn-sound-${value ?? "default"}`}
                                label={value ? SOUND_LABELS[value] : inherited.sound}
                                checked={rule?.sound === value}
                                action={() => set({ sound: value })}
                            />
                        ))}
                    </Menu.MenuItem>
                    <Menu.MenuCheckboxItem
                        id="vc-bn-priority"
                        label="★ Prioritaire"
                        checked={!!rule?.priority}
                        action={() => set({ priority: rule?.priority ? undefined : true })}
                    />
                    <Menu.MenuItem id="vc-bn-snooze" label={snoozed ? `Silence jusqu'à ${clock(snoozed)}` : "Silence temporaire"}>
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
                <Menu.MenuGroup>
                    <Menu.MenuItem
                        id="vc-bn-open"
                        label="Modifier dans les réglages…"
                        action={() => {
                            // Listed even before anything is set, so the window can open on it
                            const { rules } = settings.store;
                            if (!rules[id]) settings.store.rules = withRule(rules, id, kind, {}, true);
                            openSettings("exceptions", id);
                        }}
                    />
                    {rule && (
                        <Menu.MenuItem
                            id="vc-bn-remove"
                            label="Retirer l'exception"
                            color="danger"
                            action={() => settings.store.rules = withoutRules(settings.store.rules, [id])}
                        />
                    )}
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
