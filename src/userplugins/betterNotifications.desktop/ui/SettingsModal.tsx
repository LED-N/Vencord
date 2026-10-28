/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import ErrorBoundary from "@components/ErrorBoundary";
import type { RenderModalProps } from "@vencord/discord-types";
import { ChannelStore, Modal, openModal, useEffect, useRef, useState } from "@webpack/common";

import { settings } from "../settings";
import type { OverlayPosition } from "../types";
import { bridge } from "./bridge";
import { Card, cl, Row, Section, SettingRow } from "./controls";
import { ExceptionsTab, groupRules } from "./Exceptions";
import { Icon, IconName } from "./icons";
import { ReceptionTab } from "./Reception";

export type Tab = "reception" | "exceptions" | "appearance" | "content" | "game";

const TABS: { id: Tab; label: string; icon: IconName; }[] = [
    { id: "reception", label: "Réception", icon: "inbox" },
    { id: "exceptions", label: "Exceptions", icon: "target" },
    { id: "appearance", label: "Apparence", icon: "layout" },
    { id: "content", label: "Contenu", icon: "eye" },
    { id: "game", label: "En jeu", icon: "gamepad" }
];

const px = (v: number) => `${Math.round(v)} px`;
const pct = (v: number) => `${Math.round(v)} %`;
const seconds = (v: number) => `${Math.round(v * 10) / 10} s`;

// ── Appearance ─────────────────────────────────────────────────────────────────

const POSITIONS: OverlayPosition[] = ["top-left", "top-center", "top-right", "bottom-left", "bottom-center", "bottom-right"];

function PositionPicker() {
    const { position } = settings.use(["position"]);
    const labels = Object.fromEntries(settings.def.position.options.map(o => [o.value, o.label]));

    return (
        <div className="vc-bn-screen" role="radiogroup" aria-label="Emplacement des notifications">
            {POSITIONS.map(p => (
                <button
                    key={p}
                    type="button"
                    role="radio"
                    aria-checked={p === position}
                    title={labels[p]}
                    className={cl("vc-bn-spot", `vc-bn-spot-${p}`, p === position && "vc-bn-spot-on")}
                    onClick={() => settings.store.position = p}
                >
                    <span className="vc-bn-spot-card" />
                    <span className="vc-bn-spot-card" />
                </button>
            ))}
            <div className="vc-bn-screen-bar" />
        </div>
    );
}

function AppearanceTab() {
    const { position } = settings.use(["position"]);
    const centered = position.endsWith("center");

    return (
        <>
            <Section title="Emplacement" description="Clique sur l'endroit de l'écran où les notifications doivent apparaître.">
                <Card className="vc-bn-placement">
                    <PositionPicker />
                    <div className="vc-bn-placement-side">
                        <SettingRow k="display" title="Écran" />
                        <SettingRow k="offsetX" title="Décalage horizontal" step={5} format={px} disabled={centered} />
                        <SettingRow k="offsetY" title="Décalage vertical" step={5} format={px} />
                    </div>
                </Card>
            </Section>

            <Section title="Taille et style">
                <Card>
                    <SettingRow k="maxWidth" title="Largeur maximale" step={10} format={px} />
                    <SettingRow k="scale" title="Échelle" step={0.05} format={v => `${Math.round(v * 100)} %`} />
                    <SettingRow k="opacity" title="Opacité du fond" format={pct} />
                </Card>
            </Section>

            <Section title="Empilement et durée">
                <Card>
                    <SettingRow k="duration" title="Durée d'affichage" step={0.5} format={seconds} />
                    <SettingRow k="maxVisible" title="Notifications simultanées" />
                    <SettingRow k="maxHeight" title="Hauteur maximale" step={5} format={pct} />
                    <SettingRow k="groupMessages" title="Regrouper par conversation" />
                    <SettingRow k="collapseOlder" title="Réduire les anciennes" />
                    <SettingRow k="autoCollapse" title="Réduire aussi la plus récente" step={0.5} format={v => v ? seconds(v) : "Jamais"} />
                </Card>
            </Section>
        </>
    );
}

// ── Content ────────────────────────────────────────────────────────────────────

function ContentTab() {
    const { fullEmbeds, privacy } = settings.use(["fullEmbeds", "privacy"]);

    return (
        <>
            <Section title="Contenu des cartes">
                <Card>
                    <SettingRow k="fullEmbeds" title="Message complet" />
                    <SettingRow k="showImages" title="Grandes images" disabled={!fullEmbeds} />
                    <SettingRow k="showGifs" title="GIFs et emojis animés" disabled={!fullEmbeds} />
                    <SettingRow k="showButtons" title="Boutons des bots" />
                </Card>
            </Section>

            <Section title="Confidentialité" description="Pour streamer ou partager ton écran sans dévoiler tes conversations privées.">
                <Card>
                    <SettingRow k="privacy" title="Masquer le contenu privé" />
                    <SettingRow k="privacyHideAuthor" title="Masquer aussi l'auteur" disabled={privacy === "off"} />
                </Card>
            </Section>
        </>
    );
}

// ── In game ────────────────────────────────────────────────────────────────────

const NAMED_KEYS: Record<string, string> = {
    Space: "Space", Enter: "Enter", Tab: "Tab", Backspace: "Backspace", Delete: "Delete", Insert: "Insert",
    Home: "Home", End: "End", PageUp: "PageUp", PageDown: "PageDown",
    ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right",
    Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]", Semicolon: ";", Quote: "'",
    Comma: ",", Period: ".", Slash: "/", Backslash: "\\", Backquote: "`"
};

/** The key part of an Electron accelerator, from the physical key so the layout does not matter; null for a lone modifier */
function acceleratorKey(e: KeyboardEvent) {
    const { code } = e;
    if (/^Key[A-Z]$/.test(code)) return code.slice(3);
    if (/^Digit\d$/.test(code)) return code.slice(5);
    if (/^F\d{1,2}$/.test(code)) return code;
    if (/^Numpad\d$/.test(code)) return `num${code.slice(6)}`;
    return NAMED_KEYS[code] ?? null;
}

function ShortcutInput() {
    const { shortcut } = settings.use(["shortcut"]);
    const [recording, setRecording] = useState(false);
    const [error, setError] = useState("");
    const keys = shortcut.split("+").map(k => k.trim()).filter(Boolean);

    useEffect(() => {
        if (!recording) return;
        // Captured before Discord's own shortcuts, and before Escape closes the window
        const onKey = (e: KeyboardEvent) => {
            e.preventDefault();
            e.stopImmediatePropagation();
            if (e.key === "Escape") {
                setRecording(false);
                return;
            }

            const key = acceleratorKey(e);
            if (!key) return;
            const modifiers = [e.ctrlKey && "Ctrl", e.altKey && "Alt", e.shiftKey && "Shift", e.metaKey && "Super"].filter(Boolean);
            if (!modifiers.length && !/^F\d+$/.test(key)) {
                setError("Ajoute Ctrl, Alt ou Maj : une touche seule serait capturée dans tous tes jeux.");
                return;
            }

            settings.store.shortcut = [...modifiers, key].join("+");
            setError("");
            setRecording(false);
        };
        window.addEventListener("keydown", onKey, true);
        return () => window.removeEventListener("keydown", onKey, true);
    }, [recording]);

    return (
        <div className="vc-bn-shortcut">
            <button
                type="button"
                className={cl("vc-bn-keys", recording && "vc-bn-keys-rec")}
                onClick={() => {
                    setError("");
                    setRecording(r => !r);
                }}
                onBlur={() => setRecording(false)}
            >
                {recording
                    ? "Appuie sur la combinaison…"
                    : keys.length ? keys.map(k => <kbd key={k}>{k}</kbd>) : <span className="vc-bn-muted">Aucun</span>}
            </button>
            {shortcut && !recording && (
                <button type="button" className="vc-bn-btn vc-bn-btn-ghost" onClick={() => settings.store.shortcut = ""}>Désactiver</button>
            )}
            {error && <div className="vc-bn-error">{error}</div>}
        </div>
    );
}

function GameTab() {
    const { clickable, typing } = settings.use(["clickable", "typing"]);

    return (
        <>
            <Section title="Souris">
                <Card>
                    <SettingRow k="clickable" title="Cartes cliquables" />
                    <SettingRow k="hover" title="Au survol" disabled={!clickable} />
                </Card>
            </Section>

            <Section title="Pendant que tu joues" description="Les cartes s'effacent pour ne pas gêner. Approcher la souris d'une carte l'affiche normalement.">
                <Card>
                    <SettingRow k="typing" title="Quand tu es actif ailleurs" />
                    {typing !== "off" && <SettingRow k="typingTrigger" title="Déclencheur" />}
                    {typing === "fade" && <SettingRow k="typingOpacity" title="Opacité estompée" step={5} format={pct} />}
                </Card>
            </Section>

            <Section title="Raccourci clavier">
                <Card>
                    <Row title="Fermer toutes les notifications" hint={settings.def.shortcut.description}>
                        <ShortcutInput />
                    </Row>
                </Card>
            </Section>
        </>
    );
}

// ── Window ─────────────────────────────────────────────────────────────────────

function SettingsModal({ initialTab, focusId, ...props }: RenderModalProps & { initialTab?: Tab; focusId?: string; }) {
    const [tab, setTab] = useState<Tab>(initialTab ?? "reception");
    // Only the first visit of the tab highlights the entry the window was opened for
    const [focus, setFocus] = useState(focusId);
    const { rules } = settings.use(["rules"]);
    const scroller = useRef<HTMLDivElement>(null);

    // Not an effect on the tab: it would run after the highlighted entry scrolled itself into view, and undo it
    const go = (next: Tab) => {
        scroller.current?.scrollTo({ top: 0 });
        setFocus(undefined);
        setTab(next);
    };

    const { guilds, users, conversations } = groupRules(rules);
    const counts = {
        servers: [...guilds].reduce((n, [id, channels]) => n + (rules[id] ? 1 : 0) + channels.length, 0),
        dms: users.length + conversations.filter(id => ChannelStore.getChannel(id)?.isDM()).length,
        groups: conversations.filter(id => !ChannelStore.getChannel(id)?.isDM()).length
    };
    const total = Object.keys(rules).length;

    return (
        <Modal {...props} size="xl" title="BetterNotifications" subtitle="Tes notifications Discord par-dessus les jeux, réglées comme tu veux.">
            <div className="vc-bn-modal">
                <nav className="vc-bn-nav" aria-label="Sections">
                    {TABS.map(t => (
                        <button
                            key={t.id}
                            type="button"
                            className={cl("vc-bn-nav-item", t.id === tab && "vc-bn-nav-on")}
                            aria-current={t.id === tab ? "page" : undefined}
                            onClick={() => go(t.id)}
                        >
                            <Icon name={t.icon} />
                            <span>{t.label}</span>
                            {t.id === "exceptions" && total > 0 && <span className="vc-bn-badge">{total}</span>}
                        </button>
                    ))}
                    <div className="vc-bn-nav-foot">
                        <button type="button" className="vc-bn-btn vc-bn-btn-primary" onClick={() => bridge.sendTest()}>
                            <Icon name="send" size={16} /> Tester
                        </button>
                        <div className="vc-bn-nav-note">Enregistré automatiquement</div>
                    </div>
                </nav>
                <div className="vc-bn-scroll" ref={scroller}>
                    <div className="vc-bn-pane">
                        <ErrorBoundary>
                            {tab === "reception" && <ReceptionTab exceptionCounts={counts} onShowExceptions={() => go("exceptions")} />}
                            {tab === "exceptions" && <ExceptionsTab focusId={focus} />}
                            {tab === "appearance" && <AppearanceTab />}
                            {tab === "content" && <ContentTab />}
                            {tab === "game" && <GameTab />}
                        </ErrorBoundary>
                    </div>
                </div>
            </div>
        </Modal>
    );
}

export function openSettings(tab?: Tab, focusId?: string) {
    openModal(props => (
        <ErrorBoundary>
            <SettingsModal {...props} initialTab={tab} focusId={focusId} />
        </ErrorBoundary>
    ));
}
