/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { Channel } from "@vencord/discord-types";
import { ChannelStore, GuildChannelStore, GuildStore, RelationshipStore, SortedGuildStore, useEffect, useRef, UserStore, useState } from "@webpack/common";

import { clock, effectiveFor, inheritedLabels, snoozeEnd, summaryFor } from "../effective";
import { LEVEL_HINTS, MENTION_LABELS, NOTIFY_LABELS, RULE_NOTIFY, RULE_SOUND, SOUND_LABELS } from "../labels";
import { describe, groupName, MENTION_KINDS, MentionKind, resolve, Rule, RuleKind, Rules, withoutRules, withRule } from "../rules";
import { settings, sourceDefaults } from "../settings";
import { Avatar, Card, Chip, Choice, cl, Dropdown, Picker, Section } from "./controls";
import { Icon } from "./icons";

const SNOOZES: [number, string][] = [[15, "15 min"], [60, "1 h"], [8 * 60, "8 h"], [24 * 60, "24 h"]];
const CATEGORY = 4;
const VOICE = 2;

function guildIcon(id: string) {
    const guild = GuildStore.getGuild(id);
    return guild?.icon ? `https://cdn.discordapp.com/icons/${id}/${guild.icon}.png?size=64` : undefined;
}

const userIcon = (id: string) => UserStore.getUser(id)?.getAvatarURL?.(undefined, 64);

function channelGlyph(channel?: Channel) {
    if (!channel) return "#";
    if (channel.type === CATEGORY) return "≡";
    if (channel.type === VOICE) return "♪";
    return "#";
}

function iconFor(id: string, kind: RuleKind) {
    if (kind === "guild") return guildIcon(id);
    if (kind === "user") return userIcon(id);

    const channel = ChannelStore.getChannel(id);
    if (channel?.isDM()) return userIcon(channel.recipients?.[0]);
    if (channel?.isGroupDM() && channel.icon) return `https://cdn.discordapp.com/channel-icons/${id}/${channel.icon}.png?size=64`;
}

/** The channels of a server in the order of its channel list: loose channels, then each category followed by its channels */
function orderedChannels(guildId: string): Channel[] {
    const all: any = GuildChannelStore.getChannels(guildId);
    if (!all) return [];
    const categories: Channel[] = (all[CATEGORY] ?? []).map((c: any) => c.channel).filter((c: Channel) => c?.id !== guildId);
    const channels: Channel[] = [...(all.SELECTABLE ?? []), ...(all.VOCAL ?? [])].map((c: any) => c.channel).filter(Boolean);

    const out = channels.filter(c => !c.parent_id);
    for (const category of categories) out.push(category, ...channels.filter(c => c.parent_id === category.id));
    return out;
}

function channelChoices(guildId: string): Choice[] {
    const { rules } = settings.store;
    return orderedChannels(guildId)
        .filter(c => !rules[c.id])
        .map(c => ({
            id: c.id,
            name: c.name,
            glyph: channelGlyph(c),
            sub: c.type === CATEGORY ? "Catégorie entière" : undefined,
            indent: c.type !== CATEGORY && !!c.parent_id
        }));
}

const byName = (a: Choice, b: Choice) => a.name.localeCompare(b.name, "fr", { sensitivity: "base" });

function guildChoices(): Choice[] {
    const { rules } = settings.store;
    const order = SortedGuildStore?.getFlattenedGuildIds?.() ?? Object.keys(GuildStore.getGuilds());
    return order
        .filter(id => !rules[id])
        .flatMap(id => {
            const guild = GuildStore.getGuild(id);
            return guild ? [{ id, name: guild.name, icon: guildIcon(id) }] : [];
        });
}

/** Friends, and everyone you have a conversation with */
function userChoices(): Choice[] {
    const { rules } = settings.store;
    const ids = new Set(RelationshipStore.getFriendIDs());
    for (const channel of ChannelStore.getSortedPrivateChannels())
        if (channel.isDM() && channel.recipients?.[0]) ids.add(channel.recipients[0]);

    return [...ids]
        .filter(id => !rules[id])
        .flatMap(id => {
            const user = UserStore.getUser(id);
            return user ? [user] : [];
        })
        .map(user => {
            const name = RelationshipStore.getNickname(user.id) || (user as any).globalName || user.username;
            const friend = RelationshipStore.isFriend(user.id);
            return { id: user.id, name, sub: friend ? (name !== user.username ? user.username : undefined) : "Pas ami", icon: userIcon(user.id) };
        })
        .sort(byName);
}

function groupChoices(): Choice[] {
    const { rules } = settings.store;
    return ChannelStore.getSortedPrivateChannels()
        .filter(c => c.isGroupDM() && !rules[c.id])
        .map(c => ({ id: c.id, name: c.name || groupName(c), icon: iconFor(c.id, "channel"), glyph: "👥" }));
}

function MentionOverride({ rule, update }: { rule?: Rule; update(patch: Partial<Rule>): void; }) {
    const inherited = rule?.mentions == null;
    const current = rule?.mentions ?? settings.store.mentionKinds;
    const toggle = (kind: MentionKind) => {
        const next = current.includes(kind) ? current.filter(k => k !== kind) : MENTION_KINDS.filter(k => k === kind || current.includes(k));
        update({ mentions: next });
    };

    return (
        <div className="vc-bn-advanced-block">
            <div className="vc-bn-advanced-title">Mentions comptées ici</div>
            <div className="vc-bn-chips">
                <Chip on={inherited} title="Celles choisies dans Réception" onClick={() => update({ mentions: undefined })}>Par défaut</Chip>
                {MENTION_KINDS.map(kind => (
                    <Chip key={kind} on={!inherited && current.includes(kind)} title={MENTION_LABELS[kind].hint} onClick={() => toggle(kind)}>
                        {MENTION_LABELS[kind].label}
                    </Chip>
                ))}
            </div>
        </div>
    );
}

interface RuleRowProps {
    id: string;
    kind: RuleKind;
    rules: Rules;
    /** Channel shown inside its server card: no server name before it */
    nested?: boolean;
    head?: boolean;
    onRemove(): void;
    removeLabel: string;
    meta?: string;
    /** Opened from a context menu: scrolled to, highlighted and expanded */
    focused?: boolean;
}

function RuleRow({ id, kind, rules, nested, head, onRemove, removeLabel, meta, focused }: RuleRowProps) {
    const rule = rules[id] as Rule | undefined;
    const [open, setOpen] = useState(!!focused);
    const ref = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (focused) ref.current?.scrollIntoView({ block: "center" });
    }, []);
    const update = (patch: Partial<Rule>) => settings.store.rules = withRule(settings.store.rules, id, kind, patch, true);

    const channel = kind === "channel" ? ChannelStore.getChannel(id) : undefined;
    const name = describe(id, kind, !nested) ?? rule?.name ?? (kind === "guild" ? "Serveur inconnu" : id);
    const snoozed = snoozeEnd(rule);
    const inherited = inheritedLabels(id, kind, rules);
    const username = kind === "user" ? UserStore.getUser(id)?.username : undefined;

    const notifyOptions = RULE_NOTIFY.map(v => ({ value: v, label: v ? NOTIFY_LABELS[v] : "Par défaut", hint: v ? LEVEL_HINTS[v] : "Reprend le niveau au-dessus" }));
    const soundOptions = RULE_SOUND.map(v => ({ value: v, label: v ? SOUND_LABELS[v] : "Par défaut", hint: v ? LEVEL_HINTS[v] : "Reprend le niveau au-dessus" }));

    return (
        <div ref={ref} className={cl("vc-bn-rule", head && "vc-bn-rule-head", nested && "vc-bn-rule-nested", open && "vc-bn-rule-open", focused && "vc-bn-rule-focus")}>
            <div className="vc-bn-rule-main">
                <Avatar
                    src={iconFor(id, kind)}
                    name={name}
                    glyph={kind === "channel" ? (channel?.isGroupDM() ? "👥" : channelGlyph(channel)) : undefined}
                    size={nested ? 24 : 32}
                />
                <div className="vc-bn-rule-text">
                    <div className="vc-bn-rule-name">
                        {name}
                        {username && username !== name && <span className="vc-bn-rule-meta"> {username}</span>}
                        {meta && <span className="vc-bn-rule-meta"> · {meta}</span>}
                    </div>
                    <div className="vc-bn-rule-summary">
                        {snoozed
                            ? <>Silence jusqu'à {clock(snoozed)} · <button type="button" className="vc-bn-link" onClick={() => update({ snoozedUntil: undefined })}>lever</button></>
                            : summaryFor(id, kind, rules)}
                    </div>
                </div>
                <div className="vc-bn-rule-controls">
                    <Dropdown
                        label="Notification"
                        icon={<Icon name="bell" size={14} />}
                        options={notifyOptions}
                        value={rule?.notify}
                        muted={!rule?.notify}
                        display={rule?.notify ? NOTIFY_LABELS[rule.notify] : inherited.notify}
                        onChange={notify => update({ notify })}
                    />
                    <Dropdown
                        label="Son"
                        icon={<Icon name="sound" size={14} />}
                        options={soundOptions}
                        value={rule?.sound}
                        muted={!rule?.sound}
                        display={rule?.sound ? SOUND_LABELS[rule.sound] : inherited.sound}
                        onChange={sound => update({ sound })}
                    />
                </div>
                <div className="vc-bn-rule-actions">
                    <button
                        type="button"
                        className={cl("vc-bn-icon-btn", rule?.priority && "vc-bn-star-on")}
                        title="Prioritaire : reste affichée jusqu'à fermeture, même en Ne pas déranger"
                        aria-pressed={!!rule?.priority}
                        onClick={() => update({ priority: rule?.priority ? undefined : true })}
                    >
                        <Icon name="star" size={16} />
                    </button>
                    <button
                        type="button"
                        className={cl("vc-bn-icon-btn", "vc-bn-chevron", open && "vc-bn-chevron-open")}
                        title="Mentions et silence temporaire"
                        aria-expanded={open}
                        onClick={() => setOpen(o => !o)}
                    >
                        <Icon name="chevron" size={16} />
                    </button>
                    <button type="button" className="vc-bn-icon-btn vc-bn-remove" title={removeLabel} aria-label={removeLabel} onClick={onRemove}>
                        <Icon name="close" size={16} />
                    </button>
                </div>
            </div>
            {open && (
                <div className="vc-bn-advanced">
                    <MentionOverride rule={rule} update={update} />
                    <div className="vc-bn-advanced-block">
                        <div className="vc-bn-advanced-title">Silence temporaire</div>
                        <div className="vc-bn-chips">
                            {SNOOZES.map(([minutes, label]) => (
                                <button key={minutes} type="button" className="vc-bn-chip" onClick={() => update({ snoozedUntil: Date.now() + minutes * 60_000 })}>
                                    <Icon name="clock" size={12} /> {label}
                                </button>
                            ))}
                            {snoozed && <button type="button" className="vc-bn-chip vc-bn-chip-on" onClick={() => update({ snoozedUntil: undefined })}>Lever le silence</button>}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}

function ServerCard({ guildId, channelIds, rules, focusId }: { guildId: string; channelIds: string[]; rules: Rules; focusId?: string; }) {
    const own = !!rules[guildId];
    const order = orderedChannels(guildId).map(c => c.id);
    const sorted = [...channelIds].sort((a, b) => (order.indexOf(a) + 1 || 1e9) - (order.indexOf(b) + 1 || 1e9));
    const count = channelIds.length;

    return (
        <Card className="vc-bn-server">
            <RuleRow
                id={guildId}
                kind="guild"
                rules={rules}
                head
                focused={focusId === guildId}
                meta={count ? `${count} salon${count > 1 ? "s" : ""}` : undefined}
                removeLabel={own ? "Retirer l'exception du serveur (ses salons restent)" : `Retirer ce serveur et ses ${count} salon${count > 1 ? "s" : ""}`}
                onRemove={() => settings.store.rules = withoutRules(settings.store.rules, own ? [guildId] : channelIds)}
            />
            {sorted.map(id => (
                <RuleRow
                    key={id}
                    id={id}
                    kind="channel"
                    rules={rules}
                    nested
                    focused={focusId === id}
                    removeLabel="Retirer ce salon"
                    onRemove={() => settings.store.rules = withoutRules(settings.store.rules, [id])}
                />
            ))}
            <div className="vc-bn-server-foot">
                <Picker label="Salon ou catégorie" variant="subtle" choices={() => channelChoices(guildId)} onPick={id => add(id, "channel")} />
            </div>
        </Card>
    );
}

/**
 * A new entry starts on the defaults, and so changes nothing until a level is picked. Except when it would receive
 * nothing at all: adding it then means letting it through (a server as Discord would, a channel, person or group fully)
 */
function add(id: string, kind: RuleKind) {
    const { rules } = settings.store;
    if (rules[id]) return;

    const next = withRule(rules, id, kind, {}, true);
    const effective = effectiveFor(id, kind, next) ?? resolve(next, [id], sourceDefaults("dms"), Infinity);
    const silent = effective.notify === "none" && effective.sound === "none";
    settings.store.rules = silent ? withRule(next, id, kind, { notify: kind === "guild" ? "discord" : "all" }, true) : next;
}

function Tips() {
    return (
        <details className="vc-bn-tips">
            <summary><Icon name="bulb" size={16} /> Exemples de réglages</summary>
            <ul>
                <li><b>Juste le son, pour les mentions d'un serveur :</b> ajoute le serveur, Notification « Rien », Son « Mentions ». Désactive « Serveurs » dans Réception pour ignorer tous les autres.</li>
                <li><b>Seulement quelques salons d'un serveur :</b> ajoute le serveur en « Rien », puis ses salons en « Mentions » ou « Tous les messages ».</li>
                <li><b>Toutes les mentions de rôle, et rien d'autre :</b> dans Réception, Serveurs sur « Mentions » et ne garde que « @rôles ». Ou seulement pour un serveur, avec la flèche ▾ de sa ligne.</li>
                <li><b>Un ami toujours notifié :</b> ajoute-le en « Tous les messages » et marque-le ★ pour passer le Ne pas déranger.</li>
                <li><b>Un serveur bruyant :</b> Son « Aucun son », la notification reste.</li>
            </ul>
        </details>
    );
}

export interface Grouped {
    guilds: Map<string, string[]>;
    users: string[];
    conversations: string[];
}

/** Rules sorted into server cards (with their channels), people, and private conversations */
export function groupRules(rules: Rules): Grouped {
    const guilds = new Map<string, string[]>();
    const users: string[] = [];
    const conversations: string[] = [];
    const guildOf = (id: string) => {
        if (!guilds.has(id)) guilds.set(id, []);
        return guilds.get(id)!;
    };

    for (const [id, rule] of Object.entries(rules)) {
        if (rule.kind === "guild") guildOf(id);
        else if (rule.kind === "user") users.push(id);
        else {
            const guildId = ChannelStore.getChannel(id)?.guild_id || rule.guildId;
            if (guildId) guildOf(guildId).push(id);
            else conversations.push(id);
        }
    }

    const order = SortedGuildStore?.getFlattenedGuildIds?.() ?? [];
    const sorted = new Map([...guilds].sort(([a], [b]) => (order.indexOf(a) + 1 || 1e9) - (order.indexOf(b) + 1 || 1e9)));
    return { guilds: sorted, users, conversations };
}

export function ExceptionsTab({ focusId }: { focusId?: string; }) {
    const { rules } = settings.use(["rules", "serversNotify", "serversSound", "dmsNotify", "dmsSound", "groupsNotify", "groupsSound", "mentionKinds"]);
    const [query, setQuery] = useState("");
    const { guilds, users, conversations } = groupRules(rules);

    const needle = query.trim().toLocaleLowerCase();
    const matches = (id: string, kind: RuleKind) => !needle || (describe(id, kind) ?? rules[id]?.name ?? "").toLocaleLowerCase().includes(needle);
    const shownGuilds = [...guilds].filter(([id, channels]) => matches(id, "guild") || channels.some(c => matches(c, "channel")));
    const shownUsers = users.filter(id => matches(id, "user"));
    const shownConversations = conversations.filter(id => matches(id, "channel"));
    const total = Object.keys(rules).length;

    const remove = (id: string) => settings.store.rules = withoutRules(settings.store.rules, [id]);

    return (
        <>
            <Section
                title="Exceptions"
                description={<>Elles remplacent tes réglages de Réception pour un serveur, un salon, une personne ou un groupe. La plus précise l'emporte : <b>personne › salon › catégorie › serveur › Réception</b>. « Par défaut », en gris, reprend la valeur du niveau au-dessus.</>}
            >
                <div className="vc-bn-toolbar">
                    {total > 3 && (
                        <label className="vc-bn-search">
                            <Icon name="search" size={16} />
                            <input placeholder="Filtrer…" value={query} onChange={e => setQuery(e.currentTarget.value)} />
                        </label>
                    )}
                    <div className="vc-bn-toolbar-actions">
                        <Picker label="Serveur" choices={guildChoices} onPick={id => add(id, "guild")} />
                        <Picker label="Personne" choices={userChoices} onPick={id => add(id, "user")} />
                        <Picker label="Groupe" choices={groupChoices} onPick={id => add(id, "channel")} />
                    </div>
                </div>
                <Tips />
            </Section>

            {!total && (
                <div className="vc-bn-empty">
                    <Icon name="target" size={32} />
                    <div className="vc-bn-empty-title">Aucune exception</div>
                    <div>Ajoute un serveur, une personne ou un groupe avec les boutons ci-dessus, ou fais un clic droit sur n'importe lequel dans Discord → BetterNotifications.</div>
                </div>
            )}

            {shownGuilds.length > 0 && (
                <Section title={`Serveurs · ${shownGuilds.length}`}>
                    <div className="vc-bn-list">
                        {shownGuilds.map(([id, channels]) => <ServerCard key={id} guildId={id} channelIds={channels} rules={rules} focusId={focusId} />)}
                    </div>
                </Section>
            )}

            {shownUsers.length > 0 && (
                <Section title={`Personnes · ${shownUsers.length}`} description="S'applique à leurs messages privés comme à leurs messages sur les serveurs.">
                    <Card className="vc-bn-list-card">
                        {shownUsers.map(id => <RuleRow key={id} id={id} kind="user" rules={rules} focused={focusId === id} removeLabel="Retirer cette personne" onRemove={() => remove(id)} />)}
                    </Card>
                </Section>
            )}

            {shownConversations.length > 0 && (
                <Section title={`Conversations · ${shownConversations.length}`}>
                    <Card className="vc-bn-list-card">
                        {shownConversations.map(id => <RuleRow key={id} id={id} kind="channel" rules={rules} focused={focusId === id} removeLabel="Retirer cette conversation" onRemove={() => remove(id)} />)}
                    </Card>
                </Section>
            )}

            {total > 0 && needle && !shownGuilds.length && !shownUsers.length && !shownConversations.length && (
                <div className="vc-bn-empty-small">Aucune exception ne correspond à « {query} ».</div>
            )}
        </>
    );
}
