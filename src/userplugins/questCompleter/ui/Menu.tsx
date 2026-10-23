/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { useEffect, useLayoutEffect, useRef } from "@webpack/common";

import { formatDuration, formatNumber, primaryTask, QuestJob, remainingSeconds,REWARD_GROUPS, rewardGroups, rewardSummary, TASK_LABELS, taskKind } from "../catalog";
import { boostStatus, claimableCount, getCatalog, isCompleted, orbBoost, orbTotals, queueEta } from "../selectors";
import { settings } from "../settings";
import { actions, emit, state } from "../state";
import { CloseIcon, CogIcon, NitroIcon, OrbIcon, QuestIcon, RefreshIcon, SearchIcon, TaskIcon } from "./icons";
import { Progress, QuestCard, questName } from "./QuestCard";
import { SettingsView } from "./Settings";

const STATUS: Record<string, string> = {
    queued: "En attente", running: "En cours", completed: "Terminée", failed: "Échec", cancelled: "Arrêtée", skipped: "Ignorée"
};

const SORTS = settings.def.menuFilter.options;

function matchesTab(quest: any, tab: string) {
    if (tab === "all") return true;
    if (tab === "pending") return isCompleted(quest);
    return rewardGroups(quest).includes(tab);
}

function matchesSearch(quest: any, query: string, nitro: boolean) {
    if (!query) return true;
    const text = `${questName(quest)} ${quest.config.messages?.gameTitle ?? ""} ${quest.config.application?.name ?? ""} ${rewardSummary(quest, nitro)}`;
    return text.toLocaleLowerCase().includes(query);
}

function Stat({ value, label, tone, icon }: { value: string; label: string; tone?: string; icon?: any; }) {
    return (
        <div className={"qc-stat" + (tone ? ` qc-stat-${tone}` : "")}>
            <strong>{icon}{value}</strong>
            <span>{label}</span>
        </div>
    );
}

function Hero({ quests, nitro }: { quests: any[]; nitro: boolean; }) {
    const { toEarn, toClaim } = orbTotals(quests);
    const ready = claimableCount(quests);
    const eta = queueEta();
    const { stats } = state;

    return (
        <header className="qc-hero">
            <div className="qc-hero-brand">
                <span className="qc-hero-logo"><QuestIcon size={30} /></span>
                <div>
                    <h1>Quêtes</h1>
                    <p>
                        {nitro && <span className="qc-nitro qc-nitro-hero"><NitroIcon />Bonus Nitro ×1,2 sur les Orbs</span>}
                        {boostStatus() === "ineligible" && (
                            <span className="qc-hero-note" title="Discord a versé le montant normal lors de tes récupérations, ou ton Nitro a été obtenu avec des Orbs. Réglable dans ⚙ → Bonus Nitro.">
                                Nitro sans bonus Orbs (obtenu avec des Orbs ou des crédits)
                            </span>
                        )}
                        {stats.quests > 0 && <span>{stats.quests} quête{stats.quests > 1 ? "s" : ""} terminée{stats.quests > 1 ? "s" : ""} · {formatNumber(stats.orbs)} Orbs récupérés</span>}
                    </p>
                </div>
            </div>
            <div className="qc-hero-stats">
                {state.balance != null && <Stat tone="balance" icon={<OrbIcon size={16} />} value={formatNumber(state.balance)} label="Solde d’Orbs" />}
                <Stat tone="orb" icon={<OrbIcon size={16} />} value={formatNumber(toEarn)} label="Orbs à gagner" />
                <Stat tone="green" value={String(ready)} label={toClaim ? `à récupérer · ${formatNumber(toClaim)} Orbs` : "à récupérer"} />
                <Stat value={eta ? formatDuration(eta) : "—"} label="file d'attente" />
            </div>
            <div className="qc-hero-actions">
                <button type="button" className="qc-icon-btn" title="Actualiser" aria-label="Actualiser les quêtes" disabled={state.loading} onClick={actions.refresh}>
                    <span className={state.loading ? "qc-spin" : undefined}><RefreshIcon /></span>
                </button>
                <button
                    type="button"
                    className={"qc-icon-btn" + (state.ui.view === "settings" ? " qc-icon-btn-on" : "")}
                    title="Réglages"
                    aria-label="Réglages"
                    onClick={() => { state.ui.view = state.ui.view === "settings" ? "quests" : "settings"; emit(); }}
                >
                    <CogIcon />
                </button>
                <button type="button" className="qc-icon-btn" title="Fermer" aria-label="Fermer" onClick={actions.closeMenu}><CloseIcon /></button>
            </div>
        </header>
    );
}

function Toolbar({ quests }: { quests: any[]; }) {
    const { ui } = state;
    const { menuFilter } = settings.use(["menuFilter"]);
    const tabs = [
        { key: "all", label: "Tout" },
        { key: "pending", label: "À récupérer" },
        ...REWARD_GROUPS.map(group => ({ key: group.key as string, label: group.label as string }))
    ].map(tab => ({ ...tab, count: quests.filter(quest => matchesTab(quest, tab.key)).length }))
        .filter(tab => tab.count || tab.key === "all");

    return (
        <div className="qc-toolbar">
            <div className="qc-tabs" role="tablist">
                {tabs.map(tab => (
                    <button
                        key={tab.key}
                        type="button"
                        role="tab"
                        aria-selected={ui.tab === tab.key}
                        className={"qc-tab" + (ui.tab === tab.key ? " qc-tab-on" : "") + (tab.key === "pending" ? " qc-tab-green" : "")}
                        onClick={() => { ui.tab = tab.key; emit(); }}
                    >
                        {tab.label}<span className="qc-tab-count">{tab.count}</span>
                    </button>
                ))}
            </div>
            <div className="qc-toolbar-end">
                <label className="qc-search">
                    <SearchIcon />
                    <input
                        type="search"
                        placeholder="Rechercher…"
                        aria-label="Rechercher une quête"
                        value={ui.search}
                        autoFocus
                        onChange={e => { ui.search = e.currentTarget.value; emit(); }}
                    />
                </label>
                <select className="qc-select" aria-label="Ordre des quêtes" value={menuFilter} onChange={e => settings.store.menuFilter = e.currentTarget.value}>
                    {SORTS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
            </div>
        </div>
    );
}

function Section({ title, quests, nitro, tone }: { title: string; quests: any[]; nitro: boolean; tone?: string; }) {
    if (!quests.length) return null;
    return (
        <section className="qc-section">
            <h2 className={"qc-section-title" + (tone ? ` qc-section-${tone}` : "")}>{title}<span>{quests.length}</span></h2>
            <div className="qc-grid">
                {quests.map(quest => <QuestCard key={quest.id} quest={quest} nitro={nitro} />)}
            </div>
        </section>
    );
}

function QueueRow({ job, index }: { job: QuestJob; index: number; }) {
    const quest = state.catalog.get(job.id) ?? job.quest;
    const remaining = remainingSeconds(quest);
    const name = questName(quest);
    return (
        <div className="qc-queue-row">
            <span className="qc-queue-index">{index + 1}</span>
            <span className="qc-queue-name">
                <TaskIcon kind={taskKind(primaryTask(quest))} />
                <span>{name}</span>
            </span>
            {remaining != null && <span className="qc-queue-time">{formatDuration(remaining)}</span>}
            <button type="button" className="qc-icon-btn qc-icon-sm" disabled={index === 0} title="Avancer" aria-label={`Avancer ${name}`} onClick={() => actions.moveUp(job.id)}>↑</button>
            <button type="button" className="qc-icon-btn qc-icon-sm" title="Retirer" aria-label={`Retirer ${name}`} onClick={() => actions.remove(job.id)}>✕</button>
        </div>
    );
}

function QueuePanel() {
    const { queue, running } = state;
    const current = running && queue.current?.status === "running" ? queue.current : null;
    const waiting = queue.waiting();
    const history = [...queue.jobs.values()].filter(job => !["running", "queued"].includes(job.status)).slice(-6).reverse();
    const eta = queueEta();

    return (
        <aside className="qc-side" aria-label="File d'attente">
            {current && (
                <div className="qc-now">
                    <span className="qc-eyebrow">En cours · {TASK_LABELS[taskKind(primaryTask(current.quest))]}</span>
                    <strong>{questName(current.quest)}</strong>
                    <Progress
                        value={current.progress}
                        label={(() => {
                            const left = remainingSeconds(current.quest, current.progress);
                            return left ? `${formatDuration(left)} restantes` : undefined;
                        })()}
                    />
                    <span className="qc-status">{current.detail}</span>
                    <button type="button" className="qc-btn qc-btn-danger-ghost" onClick={actions.stop}>Arrêter la file</button>
                </div>
            )}

            <div className="qc-side-head">
                <h3>File d'attente</h3>
                <span className="qc-pill">{waiting.length}</span>
                {eta > 0 && <span className="qc-side-eta">≈ {formatDuration(eta)}</span>}
            </div>
            {waiting.map((job, index) => <QueueRow key={job.id} job={job} index={index} />)}
            {!current && !waiting.length && <p className="qc-empty-small">Lance une quête : elle est acceptée puis traitée ici, une à la fois.</p>}

            {history.length > 0 && (
                <>
                    <div className="qc-side-head"><h3>Derniers résultats</h3></div>
                    {history.map(job => (
                        <div key={job.id} className="qc-result">
                            <span className={`qc-dot qc-dot-${job.claimed ? "claimed" : job.status}`} />
                            <div>
                                <strong>{questName(job.quest)}</strong>
                                <span>{job.claimed ? "Récompense récupérée" : job.detail && job.detail !== STATUS[job.status] ? `${STATUS[job.status]} · ${job.detail}` : STATUS[job.status]}</span>
                            </div>
                        </div>
                    ))}
                </>
            )}
        </aside>
    );
}

export function QuestMenu() {
    const { ui } = state;
    const nitro = orbBoost();
    const quests = getCatalog();
    const query = ui.search.trim().toLocaleLowerCase();
    const visible = quests.filter(quest => matchesTab(quest, ui.tab) && matchesSearch(quest, query, nitro));

    const ready = visible.filter(isCompleted);
    const runnable = visible.filter(quest => !isCompleted(quest) && !actions.blocked(quest));
    const blocked = visible.filter(quest => !isCompleted(quest) && actions.blocked(quest));

    const addable = runnable.filter(quest => !actions.bulkExcluded(quest) && !["queued", "running", "completed"].includes(state.queue.jobs.get(quest.id)?.status ?? ""));
    const claimable = ready.filter(quest => !state.claiming.has(quest.id));

    const scroller = useRef<HTMLDivElement>(null);
    // Coming back from Discord's claim modal or the settings restores the scroll position
    useLayoutEffect(() => {
        if (scroller.current) scroller.current.scrollTop = ui.scroll;
    }, [ui.view]);
    useEffect(() => () => { if (scroller.current) ui.scroll = scroller.current.scrollTop; }, []);

    return (
        <div className="qc-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) actions.closeMenu(); }}>
            <div className="qc-shell" role="dialog" aria-modal="true" aria-label="Quêtes">
                <Hero quests={quests} nitro={nitro} />
                {ui.view === "settings" ? <SettingsView /> : (
                    <>
                        <Toolbar quests={quests} />
                        {state.catalogError && <div className="qc-banner qc-banner-error">{state.catalogError}</div>}
                        <div className="qc-body">
                            <div className="qc-main" ref={scroller} onScroll={e => { ui.scroll = e.currentTarget.scrollTop; }}>
                                <Section title="Récompenses à récupérer" quests={ready} nitro={nitro} tone="green" />
                                <Section title="Disponibles" quests={runnable} nitro={nitro} />
                                <Section title="Non prises en charge" quests={blocked} nitro={nitro} tone="muted" />
                                {!visible.length && (
                                    <div className="qc-empty">
                                        <QuestIcon size={40} />
                                        <strong>{state.loading ? "Chargement des quêtes…" : "Aucune quête ici"}</strong>
                                        <span>{state.loading ? "Le catalogue arrive." : "Change de catégorie ou de recherche, ou actualise."}</span>
                                    </div>
                                )}
                            </div>
                            <QueuePanel />
                        </div>
                        <footer className="qc-foot">
                            <span className="qc-foot-note">
                                {ui.tab === "pending"
                                    ? "Résous l'éventuel captcha puis ferme la confirmation Discord pour passer à la récompense suivante."
                                    : "« Tout ajouter » suit les filtres des réglages ; un choix manuel reste toujours possible."}
                            </span>
                            {ui.tab !== "pending" && (
                                <button type="button" className="qc-btn qc-btn-primary" disabled={!addable.length} onClick={() => actions.enqueue(addable, true)}>
                                    Tout ajouter ({addable.length})
                                </button>
                            )}
                            {(ui.tab === "pending" || claimable.length > 0) && (
                                <button type="button" className="qc-btn qc-btn-success" disabled={!claimable.length || state.claiming.size > 0} onClick={() => actions.claim(claimable)}>
                                    {state.claiming.size ? "Récupération en cours…" : `Tout récupérer (${claimable.length})`}
                                </button>
                            )}
                        </footer>
                    </>
                )}
            </div>
        </div>
    );
}
