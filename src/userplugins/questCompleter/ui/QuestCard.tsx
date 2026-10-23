/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { CSSProperties } from "react";

import {
    formatDuration, formatNumber, getQuestApplication, getQuestTask, questArt, questOrbs, remainingSeconds, rewardLabels,
    TASK_LABELS, TaskKind, taskKind, taskProgress, timeLeft
} from "../catalog";
import { isCompleted } from "../selectors";
import { actions, state } from "../state";
import { NitroIcon, OrbGem, OrbIcon, TaskIcon } from "./icons";

const hideOnError = (e: { currentTarget: HTMLImageElement; }) => { e.currentTarget.style.display = "none"; };

export function questName(quest: any): string {
    return quest.config.messages?.questName ?? quest.config.application?.name ?? "Quête sans titre";
}

/** What the quest asks, worded like Discord's quest page */
function taskSentence(quest: any, kind: TaskKind, target: number, reward: string) {
    const game = getQuestApplication(quest).name ?? quest.config.messages?.gameTitle ?? "le jeu";
    const time = target ? formatDuration(target) : "";
    switch (kind) {
        case "video": return `Regarde la vidéo pour gagner ${reward} !`;
        case "stream": return `Stream ${game} à un ami pendant ${time}`;
        case "activity": return `Joue à ${game} dans une activité pendant ${time}`;
        case "achievement": return `Atteins l'objectif demandé dans ${game}`;
        case "device": return `Joue à ${game} sur console ou mobile`;
        default: return `Joue à ${game} pendant ${time}`;
    }
}

export function Progress({ value, label }: { value: number; label?: string; }) {
    const pct = Math.round(Math.max(0, Math.min(1, value)) * 100);
    return (
        <div className="qc-progress">
            <div className="qc-progress-track" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
                <div className="qc-progress-fill" style={{ width: `${pct}%` }} />
            </div>
            <div className="qc-progress-label"><span>{pct} %</span>{label && <span>{label}</span>}</div>
        </div>
    );
}

export function OrbsValue({ value, multiplier }: { value: number; multiplier?: number; }) {
    return (
        <>
            <span className="qc-orbs"><OrbIcon size={15} />{formatNumber(value)} Orbs</span>
            {multiplier && (
                <span className="qc-nitro" title="Bonus Nitro appliqué par Discord">
                    <NitroIcon />×{String(multiplier).replace(".", ",")}
                </span>
            )}
        </>
    );
}

export function QuestCard({ quest, nitro }: { quest: any; nitro: boolean; }) {
    const job = state.queue.jobs.get(quest.id);
    const art = questArt(quest);
    const task = getQuestTask(quest);
    const kind = taskKind(task?.name);
    const { target, done } = taskProgress(quest);
    const orbs = questOrbs(quest, nitro);
    const rewards = rewardLabels(quest, nitro);
    const rewardText = orbs ? `${formatNumber(orbs.value)} Orbs` : rewards.join(" · ") || "une récompense";

    const completed = isCompleted(quest) || job?.status === "completed";
    const running = job?.status === "running";
    const queued = job?.status === "queued";
    const claiming = state.claiming.has(quest.id);
    const blocked = completed ? undefined : actions.blocked(quest);
    const excluded = completed || blocked ? undefined : actions.bulkExcluded(quest);

    const fraction = running ? job!.progress : target ? done / target : 0;
    const remaining = remainingSeconds(quest, running ? job!.progress : undefined);
    const deadline = timeLeft(completed ? quest.config.rewardsConfig?.rewardsExpireAt ?? quest.config.expiresAt : quest.config.expiresAt);

    const status = (job && !queued && job.detail)
        || (completed ? "Récompense prête à être récupérée"
            : blocked ?? (queued ? "Dans la file d'attente" : quest.userStatus?.enrolledAt ? "Quête acceptée" : "Acceptée au lancement"));

    let button: { label: string; className: string; onClick?: () => void; disabled?: boolean; };
    if (completed) button = claiming
        ? { label: "Récupération…", className: "qc-btn-success", disabled: true }
        : { label: "Récupérer", className: "qc-btn-success", onClick: () => actions.claim([quest]) };
    else if (running) button = { label: `${Math.round(fraction * 100)} %`, className: "qc-btn-ghost", disabled: true };
    else if (queued) button = { label: "Retirer", className: "qc-btn-ghost", onClick: () => actions.remove(quest.id) };
    else if (blocked) button = { label: "Indisponible", className: "qc-btn-ghost", disabled: true };
    else button = { label: state.running ? "Ajouter à la file" : "Lancer", className: "qc-btn-primary", onClick: () => actions.enqueue([quest]) };

    const style = art.colors ? { "--qc-c1": art.colors[0], "--qc-c2": art.colors[1] } as CSSProperties : undefined;
    const classes = ["qc-card"];
    if (completed) classes.push("qc-card-done");
    if (running) classes.push("qc-card-running");
    if (blocked) classes.push("qc-card-blocked");
    if (orbs) classes.push("qc-card-orbs");

    return (
        <article className={classes.join(" ")} style={style}>
            <div className="qc-card-hero">
                {art.hero && <img className="qc-card-hero-img" src={art.hero} alt="" loading="lazy" decoding="async" onError={hideOnError} />}
                <div className="qc-card-shade" />
                {art.logo && <img className="qc-card-logo" src={art.logo} alt="" loading="lazy" decoding="async" onError={hideOnError} />}
                <span className="qc-chip">
                    <TaskIcon kind={kind} />
                    {TASK_LABELS[kind]}
                    {target > 0 && kind !== "achievement" && kind !== "device" ? ` · ${formatDuration(target)}` : ""}
                </span>
                {deadline && (
                    <span className={"qc-chip qc-chip-time" + (deadline.soon ? " qc-chip-soon" : "")} title={completed ? "Récupération possible jusqu'à" : "Expire"}>
                        {completed ? "À récupérer · " : ""}{deadline.text}
                    </span>
                )}
                {completed && <span className="qc-ribbon">Terminée</span>}
            </div>

            <div className="qc-card-body">
                <div className="qc-reward">
                    <div className="qc-reward-art">
                        {orbs
                            ? <OrbGem size={46} />
                            : art.reward
                                ? <img src={art.reward} alt="" loading="lazy" decoding="async" onError={hideOnError} />
                                : <OrbIcon size={26} />}
                    </div>
                    <div className="qc-reward-text">
                        <span className="qc-eyebrow">Quête : {questName(quest)}</span>
                        <div className="qc-reward-value">
                            <span>Récupère</span>
                            {orbs ? <OrbsValue value={orbs.value} multiplier={orbs.multiplier} /> : <span className="qc-reward-name">{rewards.join(" · ") || "une récompense"}</span>}
                        </div>
                        <span className="qc-task">{taskSentence(quest, kind, target, rewardText)}</span>
                    </div>
                </div>

                {!completed && (running || fraction > 0) && (
                    <Progress value={fraction} label={remaining ? `${formatDuration(remaining)} restantes` : undefined} />
                )}
                {excluded && <p className="qc-note">{excluded}</p>}

                <div className="qc-card-foot">
                    <span className={"qc-status" + (job?.status === "failed" ? " qc-status-error" : "")}>{status}</span>
                    <button type="button" className={`qc-btn ${button.className}`} disabled={button.disabled} onClick={button.onClick}>
                        {button.label}
                    </button>
                </div>
            </div>
        </article>
    );
}
