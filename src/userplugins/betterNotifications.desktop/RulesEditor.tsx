/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { GuildStore, RelationshipStore, useEffect, useMemo, useRef, UserStore, useState } from "@webpack/common";
import type { ReactNode } from "react";

import { describe, Rule, RuleKind, Rules, ShowRule, SoundRule, withoutRule, withRule } from "./rules";
import { settings } from "./settings";

const SHOW_OPTIONS: [ShowRule | undefined, string][] = [[undefined, "Hériter"], ["always", "Toujours"], ["mentions", "Mentions"], ["never", "Jamais"]];
const SOUND_OPTIONS: [SoundRule | undefined, string][] = [[undefined, "Hériter"], ["on", "Activé"], ["off", "Coupé"]];

interface Choice {
    id: string;
    name: string;
    sub?: string;
    icon?: string;
}

function Segmented<T>({ options, value, onChange, label }: { options: [T, string][]; value: T; onChange(v: T): void; label: string; }) {
    return (
        <div className="vc-bn-seg" role="radiogroup" aria-label={label}>
            {options.map(([v, text]) => (
                <button
                    key={text}
                    type="button"
                    role="radio"
                    aria-checked={v === value}
                    className={v === value ? "vc-bn-seg-on" : undefined}
                    onClick={() => onChange(v)}
                >
                    {text}
                </button>
            ))}
        </div>
    );
}

function Avatar({ src, name, glyph }: { src?: string; name: string; glyph?: string; }) {
    return src
        ? <img className="vc-bn-rule-icon" src={src} alt="" />
        : <div className="vc-bn-rule-icon vc-bn-rule-glyph">{glyph ?? name[0]?.toUpperCase()}</div>;
}

function guildIcon(id: string) {
    const guild = GuildStore.getGuild(id);
    return guild?.icon ? `https://cdn.discordapp.com/icons/${id}/${guild.icon}.png?size=40` : undefined;
}

const userIcon = (id: string) => UserStore.getUser(id)?.getAvatarURL?.(undefined, 40);

function iconFor(id: string, kind: RuleKind) {
    if (kind === "guild") return guildIcon(id);
    if (kind === "user") return userIcon(id);
}

/** Searchable drop-down list: picking an entry adds a rule for it */
function Picker({ label, choices, onPick }: { label: string; choices: () => Choice[]; onPick(id: string): void; }) {
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState("");
    const ref = useRef<HTMLDivElement>(null);

    // Only built while the list is open: some accounts have hundreds of friends
    const all = useMemo(() => open ? choices() : [], [open]);
    const needle = query.trim().toLocaleLowerCase();
    const shown = needle ? all.filter(c => `${c.name} ${c.sub ?? ""}`.toLocaleLowerCase().includes(needle)) : all;

    useEffect(() => {
        if (!open) return;
        const onDown = (e: MouseEvent) => {
            if (!ref.current?.contains(e.target as Node)) setOpen(false);
        };
        document.addEventListener("mousedown", onDown);
        return () => document.removeEventListener("mousedown", onDown);
    }, [open]);

    const pick = (id: string) => {
        onPick(id);
        setOpen(false);
        setQuery("");
    };

    return (
        <div className="vc-bn-picker" ref={ref}>
            <button type="button" className="vc-bn-picker-toggle" aria-expanded={open} onClick={() => setOpen(o => !o)}>
                <span>+ {label}</span>
                <span className="vc-bn-caret">{open ? "▴" : "▾"}</span>
            </button>
            {open && (
                <div className="vc-bn-picker-panel">
                    <input
                        className="vc-bn-input"
                        placeholder="Rechercher…"
                        autoFocus
                        value={query}
                        onChange={e => setQuery(e.currentTarget.value)}
                        onKeyDown={e => {
                            if (e.key === "Escape") setOpen(false);
                            if (e.key === "Enter" && shown[0]) pick(shown[0].id);
                        }}
                    />
                    <div className="vc-bn-picker-list" role="listbox">
                        {shown.map(choice => (
                            <button key={choice.id} type="button" role="option" aria-selected={false} className="vc-bn-picker-item" onClick={() => pick(choice.id)}>
                                <Avatar src={choice.icon} name={choice.name} />
                                <span className="vc-bn-picker-name">{choice.name}</span>
                                {choice.sub && <span className="vc-bn-picker-sub">{choice.sub}</span>}
                            </button>
                        ))}
                        {!shown.length && <div className="vc-bn-empty">{all.length ? "Aucun résultat." : "Tout est déjà dans la liste."}</div>}
                    </div>
                </div>
            )}
        </div>
    );
}

function RuleRow({ id, rule, rules }: { id: string; rule: Rule; rules: Rules; }) {
    const name = describe(id, rule.kind) ?? rule.name ?? id;
    const update = (patch: Partial<Rule>) => settings.store.rules = withRule(rules, id, rule.kind, patch);
    const snoozed = rule.snoozedUntil && rule.snoozedUntil > Date.now();
    const username = rule.kind === "user" ? UserStore.getUser(id)?.username : undefined;

    return (
        <div className="vc-bn-rule">
            <div className="vc-bn-rule-head">
                <Avatar src={iconFor(id, rule.kind)} name={name} glyph={rule.kind === "channel" ? "#" : undefined} />
                <div className="vc-bn-rule-name">
                    <div>{name}{username && username !== name && <span className="vc-bn-picker-sub"> {username}</span>}</div>
                    {snoozed && (
                        <div className="vc-bn-rule-sub">
                            Silence jusqu'à {new Date(rule.snoozedUntil!).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}
                            {" · "}
                            <button type="button" className="vc-bn-link" onClick={() => update({ snoozedUntil: undefined })}>lever</button>
                        </div>
                    )}
                </div>
                <button
                    type="button"
                    className={"vc-bn-star" + (rule.priority ? " vc-bn-star-on" : "")}
                    title="Prioritaire : reste affichée jusqu'à fermeture, même en Ne pas déranger"
                    aria-pressed={!!rule.priority}
                    onClick={() => update({ priority: rule.priority ? undefined : true })}
                >
                    ★
                </button>
                <button type="button" className="vc-bn-remove" title="Retirer de la liste" onClick={() => settings.store.rules = withoutRule(rules, id)}>✕</button>
            </div>
            <div className="vc-bn-rule-controls">
                <span>Affichage</span>
                <Segmented label="Affichage" options={SHOW_OPTIONS} value={rule.show} onChange={show => update({ show })} />
                <span>Son</span>
                <Segmented label="Son" options={SOUND_OPTIONS} value={rule.sound} onChange={sound => update({ sound })} />
            </div>
        </div>
    );
}

function Group({ title, hint, kind, rules, picker }: { title: string; hint?: string; kind: RuleKind; rules: Rules; picker?: ReactNode; }) {
    const entries = Object.entries(rules).filter(([, rule]) => rule.kind === kind);
    if (!entries.length && !picker) return null;

    return (
        <div className="vc-bn-group">
            <div className="vc-bn-group-head">
                <div className="vc-bn-group-title">{title}{entries.length > 0 && ` · ${entries.length}`}</div>
                {picker}
            </div>
            {hint && !entries.length && <div className="vc-bn-empty">{hint}</div>}
            {entries.map(([id, rule]) => <RuleRow key={id} id={id} rule={rule} rules={rules} />)}
        </div>
    );
}

const byName = (a: Choice, b: Choice) => a.name.localeCompare(b.name, "fr", { sensitivity: "base" });

export function RulesEditor() {
    const { rules } = settings.use(["rules"]);

    // A new entry is shown "always", which is what the "only the chosen ones" modes need; it can be changed right away
    const add = (id: string, kind: RuleKind) => {
        if (!settings.store.rules[id]) settings.store.rules = withRule(settings.store.rules, id, kind, { show: "always" });
    };

    const guildChoices = (): Choice[] => Object.values(GuildStore.getGuilds())
        .filter(guild => !settings.store.rules[guild.id])
        .map(guild => ({ id: guild.id, name: guild.name, icon: guildIcon(guild.id) }))
        .sort(byName);

    const friendChoices = (): Choice[] => RelationshipStore.getFriendIDs()
        .filter(id => !settings.store.rules[id])
        .flatMap(id => {
            const user = UserStore.getUser(id);
            return user ? [user] : [];
        })
        .map(user => {
            const name = RelationshipStore.getNickname(user.id) || (user as any).globalName || user.username;
            return { id: user.id, name, sub: name !== user.username ? user.username : undefined, icon: userIcon(user.id) };
        })
        .sort(byName);

    return (
        <div className="vc-bn-rules">
            <div className="vc-bn-rules-title">Serveurs et amis</div>
            <div className="vc-bn-rules-help">
                Ajoute un serveur ou un ami depuis les listes ci-dessous, puis choisis son affichage et son son. Avec « Seulement les serveurs / personnes choisis »,
                seuls ceux de la liste en « Toujours » ou « Mentions » sont notifiés. « Toujours » et « Mentions » passent outre les mutes de Discord.
                La règle la plus précise l'emporte : personne, puis salon, catégorie, serveur.
            </div>

            <Group
                title="Serveurs"
                kind="guild"
                rules={rules}
                hint="Aucun serveur dans la liste."
                picker={<Picker label="Ajouter un serveur" choices={guildChoices} onPick={id => add(id, "guild")} />}
            />
            <Group
                title="Amis et personnes"
                kind="user"
                rules={rules}
                hint="Aucune personne dans la liste. Clic droit sur n'importe quel utilisateur → BetterNotifications pour ajouter quelqu'un qui n'est pas ton ami."
                picker={<Picker label="Ajouter un ami" choices={friendChoices} onPick={id => add(id, "user")} />}
            />
            <Group title="Salons, catégories et conversations (clic droit → BetterNotifications)" kind="channel" rules={rules} />
        </div>
    );
}
