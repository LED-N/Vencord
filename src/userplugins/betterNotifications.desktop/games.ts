/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { RunningGame } from "@vencord/discord-types";
import { findByPropsLazy, findStoreLazy } from "@webpack";
import { FluxDispatcher, RunningGameStore } from "@webpack/common";

export interface DetectableGame {
    id: string;
    name: string;
}

interface DetectableGameStore {
    readonly games: Iterable<DetectableGame>;
    /** By id, then by name, then by executable: what the profile shows for a running game without an id */
    findGame(game: Partial<RunningGame>): DetectableGame | null;
}

/** Every game Discord knows how to detect */
export const GameStore: DetectableGameStore = findStoreLazy("GameStore");

// Discord only gathers the windows that could be added as games while a page asks for them
const GameDetection: {
    setCandidateGamesCallback(callback: (games: RunningGame[]) => void): void;
    clearCandidateGamesCallback(): void;
} = findByPropsLazy("setCandidateGamesCallback", "clearCandidateGamesCallback");

/** Games that count for the overlay: launchers and the games Quest Completer simulates are left out */
export function detectedGames() {
    return RunningGameStore.getRunningGames()
        .filter(game => !game.isLauncher && !(game as { vcQuestFake?: boolean; }).vcQuestFake);
}

/** The profile shows the game's page, not only its name */
export function isKnownGame(game: RunningGame) {
    return game.id != null || GameStore.findGame(game) != null;
}

/** Feeds Discord's list of windows that could be added as games until the returned function is called */
export function watchCandidates() {
    GameDetection.setCandidateGamesCallback(games => FluxDispatcher.dispatch({ type: "CANDIDATE_GAMES_CHANGE", games }));
    return () => GameDetection.clearCandidateGamesCallback();
}

/** Same as "Add it!" in Discord's registered games */
export function addGame(pid: number) {
    FluxDispatcher.dispatch({ type: "RUNNING_GAME_ADD_OVERRIDE", pid });
}

/**
 * Renames an added game after a game Discord knows: the profile then finds that game by its name and shows its page.
 * Discord saves the new name with the executable, so it is kept for the next sessions.
 */
export function linkGame(game: RunningGame, target: DetectableGame) {
    FluxDispatcher.dispatch({ type: "RUNNING_GAME_EDIT_NAME", game, newName: target.name });
}
