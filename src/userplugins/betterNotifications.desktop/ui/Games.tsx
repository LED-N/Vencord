/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Logger } from "@utils/Logger";
import { RunningGameStore, SettingsRouter, useCallback, useEffect, useStateFromStores } from "@webpack/common";

import { addGame, detectedGames, GameStore, isKnownGame, linkGame, watchCandidates } from "../games";
import { Card, Choice, Picker, Row, Section } from "./controls";

const logger = new Logger("BetterNotifications");

interface GameEntry {
    pid: number;
    name: string;
    exe: string;
    known: boolean;
}

const exeName = (path: string) => path.split(/[\\/]/).pop() || path;
// Games are renamed in place by Discord, so the lists are compared by value
const sameJson = <T,>(a: T, b: T) => JSON.stringify(a) === JSON.stringify(b);

function runningEntries(): GameEntry[] {
    return detectedGames()
        .filter(game => typeof game.pid === "number")
        .map(game => ({ pid: game.pid!, name: game.name, exe: exeName(game.exePath), known: isKnownGame(game) }));
}

function candidateChoices(): Choice[] {
    return RunningGameStore.getCandidateGames()
        .filter(game => typeof game.pid === "number")
        .map(game => ({ id: String(game.pid), name: game.name || exeName(game.exePath), sub: exeName(game.exePath), glyph: "🪟" }));
}

function detectableChoices(): Choice[] {
    return Array.from(GameStore.games, game => ({ id: game.id, name: game.name, glyph: "🎮" }));
}

function link(pid: number, gameId: string) {
    const game = RunningGameStore.getGameForPID(pid);
    const target = [...GameStore.games].find(g => g.id === gameId);
    if (game && target) linkGame(game, target);
}

function openRegisteredGames(close: () => void) {
    close();
    SettingsRouter.openUserSettings("registered_games_panel");
}

export function GameDetection({ onClose }: { onClose(): void; }) {
    const running = useStateFromStores([RunningGameStore, GameStore], runningEntries, null, sameJson);
    const candidates = useStateFromStores([RunningGameStore], candidateChoices, null, sameJson);
    const candidateList = useCallback(() => candidates, [candidates]);

    useEffect(() => {
        try {
            return watchCandidates();
        } catch (e) {
            logger.error("Failed to list the windows that could be added as games", e);
        }
    }, []);

    return (
        <Section
            title="Détection des jeux"
            description="Tout ce qui se passe « en jeu » ne s'applique qu'aux jeux détectés par Discord, ceux qu'il affiche dans « Joue à » sur ton profil. Un jeu absent de la liste ci-dessous peut être ajouté pendant qu'il tourne."
            actions={
                <button type="button" className="vc-bn-btn vc-bn-btn-ghost" onClick={() => openRegisteredGames(onClose)}>
                    Jeux enregistrés de Discord ↗
                </button>
            }
        >
            <Card>
                {running.length
                    ? running.map(game => (
                        <Row
                            key={game.pid}
                            title={<>{game.name} <span className="vc-bn-muted">· {game.exe}</span></>}
                            hint={game.known
                                ? "Détecté. Ton profil affiche la fiche du jeu."
                                : "Détecté, mais inconnu de Discord : ton profil n'affiche que ce nom. Associe-le au vrai jeu pour afficher sa fiche."}
                        >
                            {game.known
                                ? <span className="vc-bn-muted">✓</span>
                                : <Picker
                                    label="Associer au vrai jeu"
                                    variant="subtle"
                                    choices={detectableChoices}
                                    initialQuery={game.name}
                                    limit={50}
                                    empty="La liste des jeux de Discord n'est pas encore chargée."
                                    onPick={id => link(game.pid, id)}
                                />}
                        </Row>
                    ))
                    : <Row title="Aucun jeu détecté" hint="Lance ton jeu : il doit apparaître ici. Sinon, ajoute-le ci-dessous.">{null}</Row>}
                <Row title="Ton jeu n'est pas détecté ?" hint="Lance-le, puis choisis sa fenêtre. Discord s'en souviendra pour les prochaines fois.">
                    <Picker
                        label="Ajouter un jeu"
                        choices={candidateList}
                        empty="Aucune fenêtre trouvée. Vérifie que le jeu est lancé."
                        onPick={pid => addGame(Number(pid))}
                    />
                </Row>
            </Card>
        </Section>
    );
}
