/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Tooltip } from "@webpack/common";

import { formatNumber } from "../catalog";
import { claimableCount, eligibleCount, getCatalog } from "../selectors";
import { settings } from "../settings";
import { actions, state, useQcState } from "../state";
import { QuestIcon } from "./icons";

export type LauncherPlace = "header" | "account" | "floating";

const badge = (count: number) => count > 99 ? "99+" : String(count);

/** Progress of the running quest, drawn around the icon */
function Ring({ value }: { value: number; }) {
    const circumference = 2 * Math.PI * 15;
    return (
        <svg className="qc-ring" viewBox="0 0 34 34" aria-hidden="true">
            <circle className="qc-ring-track" cx="17" cy="17" r="15" />
            <circle
                className="qc-ring-fill"
                cx="17"
                cy="17"
                r="15"
                strokeDasharray={circumference}
                strokeDashoffset={circumference * (1 - Math.max(0.02, Math.min(1, value)))}
            />
        </svg>
    );
}

export function Launcher({ place }: { place: LauncherPlace; }) {
    useQcState();
    const { launcher, showBadges } = settings.use(["launcher", "showBadges"]);
    const wanted = place === "floating" ? launcher === "floating" : launcher === place || launcher === "both";
    if (!wanted) return null;

    const quests = getCatalog();
    const available = showBadges ? eligibleCount(quests) : 0;
    const ready = showBadges ? claimableCount(quests) : 0;
    const job = state.queue.current;
    const running = state.running && job?.status === "running" ? job : null;

    const parts = ["Quêtes"];
    if (running) parts.push(`en cours : ${running.quest.config.messages?.questName ?? "quête"} · ${Math.round(running.progress * 100)} %`);
    if (available) parts.push(`${available} disponible${available > 1 ? "s" : ""}`);
    if (ready) parts.push(`${ready} à récupérer`);
    if (state.balance != null) parts.push(`solde : ${formatNumber(state.balance)} Orbs`);
    const label = parts.join(" · ");

    const render = (tooltip: object) => (
        <button
            {...tooltip}
            type="button"
            className={`qc-launcher qc-launcher-${place}` + (state.menuOpen ? " qc-launcher-on" : "") + (running ? " qc-launcher-busy" : "")}
            aria-label={label}
            onClick={() => state.menuOpen ? actions.closeMenu() : actions.openMenu()}
        >
            {running && <Ring value={running.progress} />}
            <QuestIcon size={place === "floating" ? 26 : 20} />
            {available > 0 && <span className="qc-badge qc-badge-red">{badge(available)}</span>}
            {ready > 0 && <span className="qc-badge qc-badge-green">{badge(ready)}</span>}
        </button>
    );

    // The floating button lives outside Discord's React tree, where its tooltips have no layer to render in
    if (place === "floating") return render({ title: label });

    return (
        <Tooltip text={label} position={place === "account" ? "top" : "bottom"}>
            {render}
        </Tooltip>
    );
}
