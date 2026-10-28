/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { useState } from "@webpack/common";

import { MENTION_LABELS, outcome, SOURCES } from "../labels";
import { Level, MENTION_KINDS, MentionKind, parseKeywords, SoundLevel, SourceKind } from "../rules";
import { setSource, settings, SOURCE_KEYS } from "../settings";
import { Card, Chip, cl, Section, Segmented, SettingRow, Toggle } from "./controls";
import { Icon, IconName } from "./icons";

type SourceValues = Record<SourceKind, [Level, SoundLevel]>;

interface Preset {
    title: string;
    hint: string;
    values: SourceValues;
}

const PRESETS: Preset[] = [
    {
        title: "Comme Discord",
        hint: "Tes réglages Discord, partout",
        values: { servers: ["discord", "same"], dms: ["discord", "same"], groups: ["discord", "same"] }
    },
    {
        title: "Mentions seulement",
        hint: "Serveurs et groupes : mentions. MP : tous",
        values: { servers: ["mentions", "same"], dms: ["discord", "same"], groups: ["mentions", "same"] }
    },
    {
        title: "Discret",
        hint: "Tout s'affiche, seules les mentions sonnent",
        values: { servers: ["discord", "mentions"], dms: ["discord", "same"], groups: ["discord", "mentions"] }
    },
    {
        title: "Son seulement",
        hint: "Aucune carte, juste le son",
        values: { servers: ["none", "discord"], dms: ["none", "discord"], groups: ["none", "discord"] }
    },
    {
        title: "Exceptions seulement",
        hint: "Rien, sauf ce que tu ajoutes aux exceptions",
        values: { servers: ["none", "none"], dms: ["none", "none"], groups: ["none", "none"] }
    }
];

const SOURCE_ICONS: Record<SourceKind, IconName> = { servers: "server", dms: "user", groups: "users" };

function SourceCard({ source, exceptions, onShowExceptions }: { source: SourceKind; exceptions: number; onShowExceptions(): void; }) {
    const values = settings.use([...SOURCE_KEYS[source]]);
    const [notifyKey, soundKey] = SOURCE_KEYS[source];
    const notify = values[notifyKey];
    const sound = values[soundKey];
    const info = SOURCES[source];
    const enabled = notify !== "none" || sound !== "none";
    const resolvedSound = sound === "same" ? notify : sound;

    return (
        <Card className={cl("vc-bn-source", !enabled && "vc-bn-source-off")}>
            <div className="vc-bn-source-head">
                <div className="vc-bn-source-icon"><Icon name={SOURCE_ICONS[source]} /></div>
                <div className="vc-bn-source-text">
                    <div className="vc-bn-source-title">{info.title}</div>
                    <div className="vc-bn-source-summary">{outcome(notify, resolvedSound, source)}</div>
                </div>
                <Toggle
                    label={info.title}
                    checked={enabled}
                    onChange={on => setSource(source, on ? "discord" : "none", on ? "same" : "none")}
                />
            </div>
            {enabled && (
                <div className="vc-bn-source-grid">
                    <span className="vc-bn-source-label"><Icon name="bell" size={14} /> Notification</span>
                    <Segmented label={`${info.title} : notification`} options={info.notify} value={notify} onChange={v => settings.store[notifyKey] = v} />
                    <span className="vc-bn-source-label"><Icon name="sound" size={14} /> Son</span>
                    <Segmented label={`${info.title} : son`} options={info.sound} value={sound} onChange={v => settings.store[soundKey] = v} />
                </div>
            )}
            {exceptions > 0 && (
                <button type="button" className="vc-bn-link vc-bn-source-foot" onClick={onShowExceptions}>
                    {exceptions} exception{exceptions > 1 ? "s" : ""} pour {source === "servers" ? "des serveurs ou salons" : source === "dms" ? "des personnes ou conversations" : "des groupes"} →
                </button>
            )}
        </Card>
    );
}

function Presets() {
    // Not at the top of the module: settings.ts imports this file while it is still being evaluated
    const values = settings.use(Object.values(SOURCE_KEYS).flat());
    const current = (Object.keys(SOURCE_KEYS) as SourceKind[]).map(s => `${values[SOURCE_KEYS[s][0]]}/${values[SOURCE_KEYS[s][1]]}`).join();

    return (
        <div className="vc-bn-presets">
            {PRESETS.map(preset => {
                const key = (Object.keys(SOURCE_KEYS) as SourceKind[]).map(s => preset.values[s].join("/")).join();
                const on = key === current;
                return (
                    <button
                        key={preset.title}
                        type="button"
                        className={cl("vc-bn-preset", on && "vc-bn-preset-on")}
                        aria-pressed={on}
                        onClick={() => {
                            for (const [source, [notify, sound]] of Object.entries(preset.values) as [SourceKind, [Level, SoundLevel]][])
                                setSource(source, notify, sound);
                        }}
                    >
                        <span className="vc-bn-preset-title">{preset.title}</span>
                        <span className="vc-bn-preset-hint">{preset.hint}</span>
                    </button>
                );
            })}
        </div>
    );
}

function KeywordInput() {
    const { keywords } = settings.use(["keywords"]);
    const [draft, setDraft] = useState("");
    const list = parseKeywords(keywords);

    const add = (text: string) => {
        const fresh = parseKeywords(text).filter(k => !list.some(l => l.toLocaleLowerCase() === k.toLocaleLowerCase()));
        if (fresh.length) settings.store.keywords = [...list, ...fresh].join(", ");
        setDraft("");
    };
    const remove = (keyword: string) => settings.store.keywords = list.filter(k => k !== keyword).join(", ");

    return (
        <div className="vc-bn-tags" onClick={e => (e.currentTarget.querySelector("input") as HTMLInputElement)?.focus()}>
            {list.map(keyword => (
                <span key={keyword} className="vc-bn-tag">
                    {keyword}
                    <button type="button" className="vc-bn-tag-remove" aria-label={`Retirer ${keyword}`} onClick={() => remove(keyword)}>✕</button>
                </span>
            ))}
            <input
                className="vc-bn-tags-input"
                placeholder={list.length ? "Ajouter…" : "Ton pseudo, un sujet… puis Entrée"}
                value={draft}
                onChange={e => {
                    const text = e.currentTarget.value;
                    if (text.includes(",")) add(text);
                    else setDraft(text);
                }}
                onKeyDown={e => {
                    if (e.key === "Enter" && draft.trim()) add(draft);
                    if (e.key === "Backspace" && !draft && list.length) remove(list[list.length - 1]);
                }}
                onBlur={() => draft.trim() && add(draft)}
            />
        </div>
    );
}

function Mentions() {
    const { mentionKinds } = settings.use(["mentionKinds"]);
    const toggle = (kind: MentionKind) => settings.store.mentionKinds = mentionKinds.includes(kind)
        ? mentionKinds.filter(k => k !== kind)
        : MENTION_KINDS.filter(k => k === kind || mentionKinds.includes(k));

    return (
        <Card>
            <div className="vc-bn-chips">
                {MENTION_KINDS.map(kind => (
                    <Chip key={kind} on={mentionKinds.includes(kind)} title={MENTION_LABELS[kind].hint} onClick={() => toggle(kind)}>
                        {MENTION_LABELS[kind].label}
                    </Chip>
                ))}
            </div>
            <div className="vc-bn-row-hint">
                {mentionKinds.length
                    ? mentionKinds.map(k => MENTION_LABELS[k].hint).join(" · ")
                    : "Aucune mention n'est comptée : les réglages « Mentions » ne laisseront rien passer."}
            </div>
            {mentionKinds.includes("keywords") && (
                <div className="vc-bn-keywords">
                    <div className="vc-bn-row-title">Mots-clés</div>
                    <KeywordInput />
                    <div className="vc-bn-row-hint">Insensibles à la casse. Ils passent aussi les mutes de Discord avec « Selon Discord ».</div>
                </div>
            )}
        </Card>
    );
}

export function ReceptionTab({ exceptionCounts, onShowExceptions }: { exceptionCounts: Record<SourceKind, number>; onShowExceptions(): void; }) {
    return (
        <>
            <Section title="Préréglages" description="Un point de départ en un clic. Tu peux ensuite ajuster chaque source ci-dessous.">
                <Presets />
            </Section>

            <Section
                title="Recevoir les notifications de…"
                description={<>Choisis séparément la <b>notification</b> (la carte à l'écran) et le <b>son</b>. Une source désactivée ne laisse passer que tes exceptions.</>}
            >
                <div className="vc-bn-sources">
                    {(Object.keys(SOURCES) as SourceKind[]).map(source => (
                        <SourceCard key={source} source={source} exceptions={exceptionCounts[source]} onShowExceptions={onShowExceptions} />
                    ))}
                </div>
            </Section>

            <Section title="Ce qui compte comme une mention" description="Utilisé partout où « Mentions » est choisi, sauf exception qui précise les siennes.">
                <Mentions />
            </Section>

            <Section title="Quand">
                <Card>
                    <SettingRow k="hideNativeNotifications" title="Remplacer les notifications Windows" />
                    <SettingRow k="onlyWhenUnfocused" title="Seulement quand Discord est en arrière-plan" />
                    <div className="vc-bn-note">
                        <Icon name="moon" size={16} />
                        <span>En <b>Ne pas déranger</b>, rien ne passe, sauf les exceptions marquées <b>★ prioritaires</b>.</span>
                    </div>
                </Card>
            </Section>
        </>
    );
}
