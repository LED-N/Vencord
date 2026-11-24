/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { getUserSettingLazy } from "@api/UserSettings";
import { Button } from "@components/Button";
import ErrorBoundary from "@components/ErrorBoundary";
import { classNameFactory } from "@utils/css";
import definePlugin, { OptionType } from "@utils/types";
import { FluxStore, RenderModalProps } from "@vencord/discord-types";
import { findComponentByCodeLazy, findStoreLazy } from "@webpack";
import { FluxDispatcher, Modal, openModal, RunningGameStore, showToast, TextInput, useMemo, useState, useStateFromStores } from "@webpack/common";

import managedStyle from "./styles.css?managed";

interface DetectableGame {
    id: string;
    name: string;
    aliases?: readonly string[];
    executables?: readonly { os: string; name: string; isLauncher?: boolean; }[];
}

interface GameStore extends FluxStore {
    readonly games: Iterable<DetectableGame>;
    getDetectableGame(id: string): DetectableGame | undefined;
}

// Every game Discord knows how to detect
const GameStore: GameStore = findStoreLazy("GameStore");
const PanelButton = findComponentByCodeLazy(".GREEN,positionKeyStemOverride:");
const ShowCurrentGame = getUserSettingLazy<boolean>("status", "showCurrentGame")!;

const cl = classNameFactory("vc-gamespoofer-");
const MAX_RESULTS = 50;
const MAX_RECENT = 8;
// Windows process ids are multiples of 4: this one never points at a real process
const FAKE_PID = 1_000_003;

const settings = definePluginSettings({
    recent: {
        type: OptionType.CUSTOM,
        default: [] as string[]
    }
});

// What Discord looks for to detect the game, e.g. "valorant.exe" or "riot games/valorant/live/valorant.exe"
function executable(game: DetectableGame) {
    return game.executables?.find(exe => exe.os === "win32" && !exe.isLauncher)?.name;
}

// Same shape as a game Discord detects. The path ends with one of the game's executables, so Discord's analytics mark it as verified
function fakeGame(game: DetectableGame) {
    const folder = game.name.toLowerCase().replace(/[\\/:*?"<>|]/g, "");
    const exePath = `c:/games/${folder}/${executable(game) ?? `${folder}.exe`}`;
    const exeName = exePath.split("/").pop()!;

    return {
        id: game.id,
        name: game.name,
        pid: FAKE_PID,
        pidPath: [],
        exePath,
        exeName,
        cmdLine: exePath,
        processName: exeName,
        distributor: null,
        windowHandle: null,
        nativeProcessObserverId: 0,
        fullscreenType: 0,
        hidden: false,
        elevated: false,
        isLauncher: false,
        lastFocused: 0,
        start: Date.now()
    };
}

let spoofed: ReturnType<typeof fakeGame> | null = null;
let randomTimer: ReturnType<typeof setInterval> | null = null;

function notifyGamesChanged() {
    FluxDispatcher.dispatch({ type: "RUNNING_GAMES_CHANGE", games: RunningGameStore.getRunningGames(), added: [], removed: [] });
}

function play(game: DetectableGame) {
    stopRandom();
    spoofed = fakeGame(game);
    settings.store.recent = [game.id, ...settings.store.recent.filter(id => id !== game.id)].slice(0, MAX_RECENT);
    notifyGamesChanged();
    showToast({ text: `Discord pense que tu joues à ${game.name}`, variant: "success" });
}

function playRandom() {
    const games = Array.from(GameStore.games);
    if (!games.length) return;
    spoofed = fakeGame(games[Math.floor(Math.random() * games.length)]);
    notifyGamesChanged();
}

function startRandom() {
    stopRandom();
    playRandom();
    randomTimer = setInterval(playRandom, 15_000);
    showToast({ text: "Mode aléatoire : un jeu toutes les 15 s", variant: "success" });
}

function stopRandom() {
    if (!randomTimer) return;
    clearInterval(randomTimer);
    randomTimer = null;
}

function stopPlaying() {
    if (!spoofed) return;
    stopRandom();
    spoofed = null;
    notifyGamesChanged();
    showToast({ text: "Faux jeu arrêté" });
}

const useSpoofed = () => useStateFromStores([RunningGameStore], () => spoofed);
const useRandom = () => useStateFromStores([RunningGameStore], () => randomTimer != null);


function search(index: { game: DetectableGame; keys: string[]; }[], query: string) {
    const q = query.trim().toLowerCase();
    // Exact names first, then names starting with the query, then the shortest names
    const rank = ({ keys }: { keys: string[]; }) => keys[0] === q ? 0 : keys[0].startsWith(q) ? 1 : 2;

    return index
        .filter(({ keys }) => keys.some(key => key.includes(q)))
        .sort((a, b) => rank(a) - rank(b) || a.keys[0].length - b.keys[0].length)
        .slice(0, MAX_RESULTS)
        .map(({ game }) => game);
}

function SpooferModal({ modalProps }: { modalProps: RenderModalProps; }) {
    const [query, setQuery] = useState("");
    const current = useSpoofed();
    const random = useRandom();
    const showCurrentGame = ShowCurrentGame.useSetting();
    const { recent } = settings.use(["recent"]);

    const index = useMemo(() => Array.from(GameStore.games, game => ({
        game,
        keys: [game.name, ...game.aliases ?? []].map(key => key.toLowerCase())
    })), []);

    const searching = query.trim() !== "";
    const games = searching
        ? search(index, query)
        : recent.map(id => GameStore.getDetectableGame(id)).filter(game => game != null);

    const empty = !index.length
        ? "La liste des jeux de Discord n'est pas encore chargée. Réessaie dans quelques secondes."
        : searching ? "Aucun jeu trouvé." : "Tape le nom d'un jeu.";

    return (
        <Modal
            {...modalProps}
            title="Simuler un jeu"
            subtitle={random
                ? `Mode aléatoire : ${current?.name ?? "…"} (change toutes les 15 s)`
                : current
                    ? `Discord pense que tu joues à ${current.name}.`
                    : "Choisis un jeu : Discord pensera que tu y joues, comme s'il avait détecté son exécutable."}
            notice={showCurrentGame ? undefined : {
                type: "critical",
                message: "Le partage de ton activité est désactivé : tes amis ne verront pas le jeu."
            }}
            actions={[
                ...showCurrentGame ? [] : [{ text: "Partager mon activité", variant: "primary", onClick: () => ShowCurrentGame.updateSetting(true) }],
                ...current ? [{ text: random ? "Arrêter le mode aléatoire" : `Arrêter ${current.name}`, variant: "critical-primary", onClick: stopPlaying }] : [],
                ...!random ? [{ text: "Mode aléatoire (15 s)", variant: "secondary", onClick: () => { startRandom(); modalProps.onClose(); } }] : []
            ]}
        >
            <TextInput autoFocus value={query} onChange={setQuery} placeholder={`Rechercher parmi ${index.length.toLocaleString()} jeux`} />
            {!searching && games.length > 0 && <div className={cl("heading")}>Récents</div>}
            <div className={cl("list")}>
                {games.map(game => (
                    <button
                        key={game.id}
                        type="button"
                        className={cl("game", { active: current?.id === game.id })}
                        onClick={() => {
                            play(game);
                            modalProps.onClose();
                        }}
                    >
                        <span className={cl("name")}>{game.name}</span>
                        <span className={cl("exe")}>{executable(game)?.split("/").pop()}</span>
                    </button>
                ))}
                {!games.length && <div className={cl("empty")}>{empty}</div>}
            </div>
        </Modal>
    );
}

const SafeModal = ErrorBoundary.wrap(SpooferModal);

function openSpooferModal() {
    openModal(modalProps => <SafeModal modalProps={modalProps} />);
}

function JoystickIcon() {
    const active = useSpoofed() != null;

    return (
        <svg width="20" height="20" viewBox="0 0 24 24" fill={active ? "var(--status-positive)" : "currentColor"}>
            <circle cx="12" cy="6" r="3.5" />
            <rect x="11" y="9" width="2" height="6" />
            <rect x="3" y="14" width="18" height="7" rx="2" />
        </svg>
    );
}

function SpooferButton({ nameplate }: { nameplate?: unknown; }) {
    const current = useSpoofed();
    const random = useRandom();

    const tooltip = random
        ? `Aléatoire : ${current?.name ?? "…"} (clic droit pour arrêter)`
        : current
            ? `Faux jeu : ${current.name} (clic droit pour arrêter)`
            : "Simuler un jeu";

    return (
        <PanelButton
            tooltipText={tooltip}
            icon={JoystickIcon}
            plated={nameplate != null}
            onClick={openSpooferModal}
            onContextMenu={current ? stopPlaying : undefined}
        />
    );
}

const SafeButton = ErrorBoundary.wrap(SpooferButton, { noop: true });

export default definePlugin({
    name: "GameSpoofer",
    description: "Fait croire à Discord que tu joues au jeu de ton choix, parmi tous les jeux qu'il sait détecter",
    authors: [{ name: "LEDEN", id: 224552140117508096n }],
    dependencies: ["UserSettingsAPI"],
    settings,
    managedStyle,

    patches: [
        {
            find: 'displayName="RunningGameStore"',
            replacement: [
                {
                    // The "Playing" activity shared with friends
                    match: /(?<=getVisibleGame\(\)\{return )\i(?=\})/,
                    replace: "$self.orSpoofed($&)"
                },
                {
                    // Game launch analytics and client heartbeats
                    match: /(?<=getCurrentGameForAnalytics\(\)\{return )\i(?=\})/,
                    replace: "$self.orSpoofed($&)"
                }
            ]
        },
        {
            // Play time heartbeats (start, every 5 minutes, end), which Discord counts as hours played.
            // Only here and not in getRunningGames(): quests and BetterNotifications keep ignoring the fake game
            find: '"RunningGameHeartbeatManager"',
            replacement: {
                match: /(?<=processSessionChanges\(\)\{let \i=)\i\.\i\.getRunningGames\(\)/,
                replace: "$self.withSpoofed($&)"
            }
        },
        {
            // Account panel, next to mute / deafen, alongside GameActivityToggle's and CompleteDiscordQuests' buttons
            find: "#{intl::USER_PROFILE_ACCOUNT_POPOUT_BUTTON_A11Y_LABEL}",
            replacement: {
                match: /children:\[(?=(?:Vencord\.Plugins\.plugins\[[^\]]+\]\.\i\((?:arguments\[0\])?\),)*.{0,25}?accountContainerRef)/,
                replace: "children:[$self.renderButton(arguments[0]),"
            }
        }
    ],

    orSpoofed: (real: unknown) => spoofed ?? real,
    withSpoofed: (games: unknown[]) => spoofed ? [...games, spoofed] : games,
    renderButton: (props?: { nameplate?: unknown; }) => <SafeButton key="vc-gamespoofer" nameplate={props?.nameplate} />,

    settingsAboutComponent: () => (
        <Button onClick={openSpooferModal}>Choisir un jeu</Button>
    ),

    stop: stopPlaying
});
