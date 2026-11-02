/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { app, BrowserWindow, globalShortcut, IpcMainInvokeEvent, powerMonitor, screen, shell } from "electron";
import PAGE from "file://overlay.html";

import type { OverlayAction, OverlayLayout, OverlayMonitor, OverlayNotification } from "./types";
import { ForegroundWindow, watchForeground } from "./windowsForeground";

/** Must match the inset of #root in overlay.html */
const PAGE_MARGIN = 12;
/** Must match PREFIX in overlay.html */
const MESSAGE_PREFIX = "__VC_BN__";
/** Cursor polling while it is near the overlay, and while it is elsewhere on screen */
const TICK_NEAR = 50;
const TICK_FAR = 150;
/** Distance around the window, in screen pixels, under which the cursor counts as near */
const NEAR_MARGIN = 60;
/** Re-assert the topmost position this often, in case a game steals it */
const REASSERT_INTERVAL = 1000;
/** Ghost mode: how long the cursor must rest on a card before it captures the mouse */
const GHOST_DWELL = 700;
/** How often the system idle time is read to detect typing */
const TYPING_CHECK = 400;
/** The cursor must have been still this long for input to count as typing */
const TYPING_STILL = 1100;
/** "Any activity" trigger: within this distance of a card (CSS pixels) the cursor is heading for it, so nothing fades */
const NEAR_CARD = 80;
/** The hidden window is destroyed after this long without notifications, to free its renderer process */
const IDLE_DESTROY = 10 * 60_000;
/** Controller input counts as activity for this long, the page reports it at most every PAD_REPORT ms (overlay.html) */
const PAD_ACTIVE = 1000;
/** Unlocked cards lock again once the cursor has stayed away from them this long */
const UNLOCK_IDLE = 6000;

type Rect = [left: number, top: number, right: number, bottom: number];

type PageMessage =
    | { type: "rects"; rects: Rect[]; viewport?: { width: number; height: number; }; }
    | { type: "empty"; seq: number; }
    | { type: "link"; url: string; }
    | { type: "drag"; active: boolean; }
    | { type: "pointer"; active: boolean; }
    | { type: "focus"; }
    | { type: "pad"; }
    | { type: "action"; action: OverlayAction; };

let win: BrowserWindow | null = null;
let ready: Promise<void> | null = null;
let discordWin: BrowserWindow | null = null;

let tickTimer: NodeJS.Timeout | null = null;
let idleTimer: NodeJS.Timeout | null = null;
let lastReassert = 0;
let cardRects: Rect[] = [];
/** The viewport measured in the same animation frame as the card rects, before native/CSS zoom conversion */
let pageViewport: { width: number; height: number; } | null = null;
let interactive = false;
/** On Windows, permitted clicks need a normally activatable window, including after hide/showInactive reuse. */
let focusable = false;
/** A card is being swiped: keep capturing the mouse even outside the hit boxes */
let dragging = false;
/** Keep a press on a card/control intact, including before a swipe reaches its movement threshold */
let pointerDown = false;
let layout: OverlayLayout | null = null;
/** Zoom applied through webContents: card rects are in CSS pixels and must be multiplied by it. 1 when the page zooms itself */
let nativeZoom = 1;
/** Incremented before every push; an "empty" report only counts if the page had seen the latest push */
let pushSeq = 0;

/** Ghost mode: since when the cursor rests on a card (0 when it is elsewhere), and which box is faded */
let hoverSince = 0;
let ghostIndex = -1;

let typing = false;
let lastCursor: Electron.Point | null = null;
let lastMoveAt = 0;
let lastTypingCheck = 0;
/** Last controller input seen by the page */
let lastPadAt = 0;

/** Only actual game process ids, excluding launchers and Quest Completer's synthetic games */
let gamePids = new Set<number>();
let foreground: ForegroundWindow | null = null;
let foregroundAt = 0;
let stopForeground: (() => void) | null = null;
/** Remember the game's monitor across Alt+Tab; moving the cursor must not change it */
let gameDisplayId: number | null = null;
let placedDisplayId: number | null = null;
/** The unlock shortcut made the cards clickable, until unlockedUntil */
let unlocked = false;
let unlockedUntil = 0;

/** Accelerators asked for by the layout, and those actually registered (the others belong to another application) */
let shortcutKey: string | null = null;
let registered: string[] = [];

const pendingActions: OverlayAction[] = [];
let actionWaiter: ((action: OverlayAction | null) => void) | null = null;

function run(code: string) {
    if (win && !win.isDestroyed()) win.webContents.executeJavaScript(code).catch(() => { });
}

function getWindow() {
    if (win && !win.isDestroyed()) return win;

    win = new BrowserWindow({
        width: 480,
        height: 600,
        show: false,
        frame: false,
        transparent: true,
        backgroundColor: "#00000000",
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        // Showing the overlay never activates it; permitted clicks can enable activation below.
        focusable: false,
        skipTaskbar: true,
        hasShadow: false,
        alwaysOnTop: true,
        // Keeps the window out of Alt+Tab
        type: "toolbar",
        webPreferences: {
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
            backgroundThrottling: false
        }
    });

    win.setIgnoreMouseEvents(true);
    interactive = false;
    focusable = false;
    // On Windows, levels from "pop-up-menu" upward are also placed above the taskbar
    win.setAlwaysOnTop(true, "screen-saver");

    const { webContents } = win;
    webContents.on("will-navigate", e => e.preventDefault());
    webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    // Older Electron passes (event, level, message), newer passes an event carrying `message`.
    // Rest parameters keep the listener's arity at 1, which avoids Electron's deprecation warning.
    webContents.on("console-message", (e: any, ...legacy: unknown[]) => {
        const text = typeof e?.message === "string" ? e.message : legacy[1];
        if (typeof text !== "string" || !text.startsWith(MESSAGE_PREFIX)) return;

        try {
            handlePageMessage(JSON.parse(text.slice(MESSAGE_PREFIX.length)));
        } catch (err) {
            console.error("[BetterNotifications] Bad overlay message", err);
        }
    });

    win.on("closed", () => {
        win = null;
        ready = null;
        layout = null;
        pageViewport = null;
        stopTicking();
        unregisterShortcuts();
        screen.removeListener("display-added", refreshPlacement);
        screen.removeListener("display-removed", refreshPlacement);
        screen.removeListener("display-metrics-changed", refreshPlacement);
    });
    screen.on("display-added", refreshPlacement);
    screen.on("display-removed", refreshPlacement);
    screen.on("display-metrics-changed", refreshPlacement);

    ready = win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(PAGE)).then(() => { });

    return win;
}

function handlePageMessage(msg: PageMessage) {
    switch (msg.type) {
        case "rects":
            cardRects = msg.rects;
            pageViewport = msg.viewport && Number.isFinite(msg.viewport.width) && Number.isFinite(msg.viewport.height)
                && msg.viewport.width > 0 && msg.viewport.height > 0 ? msg.viewport : null;
            break;
        case "empty":
            // Resizing the window when showing it triggers a layout report before the card arrives
            if (msg.seq === pushSeq) hideOverlay();
            break;
        case "link":
            openLink(msg.url);
            break;
        case "drag":
            dragging = msg.active;
            break;
        case "pointer":
            pointerDown = msg.active && interactive && !!layout?.clickable && !isLocked();
            break;
        case "focus":
            focusDiscord();
            break;
        case "pad":
            lastPadAt = Date.now();
            break;
        case "action":
            // Opening the message brings Discord forward, menu entries and closings act in the background
            if (msg.action.type === "jump" || msg.action.type === "button") focusDiscord();
            queueAction(msg.action);
            break;
    }
}

function openLink(url: string) {
    try {
        const { protocol, href } = new URL(url);
        if (protocol === "https:" || protocol === "http:") shell.openExternal(href);
    } catch { }
}

function focusDiscord() {
    const w = discordWin;
    if (!w || w.isDestroyed()) return;

    if (w.isMinimized()) w.restore();
    w.show();
    w.focus();
}

function queueAction(action: OverlayAction) {
    if (!actionWaiter) {
        pendingActions.push(action);
        return;
    }

    const resolve = actionWaiter;
    actionWaiter = null;
    resolve(action);
}

function setInteractive(value: boolean) {
    if (!win || value === interactive) return;
    interactive = value;
    win.setIgnoreMouseEvents(!value);

    // Once the window ignores the mouse, the page may never get mouseleave: tell it directly
    if (!value) run("window.pointerLeft?.()");
}

function syncFocusable() {
    if (process.platform !== "win32" || !win || win.isDestroyed()) return;
    const allowed = !!layout?.clickable && !isLocked();
    if (allowed === focusable) return;
    focusable = allowed;
    // A permanently non-activating window can receive mouseup without mousedown after being hidden and reused.
    // setFocusable only permits activation on a deliberate click; showInactive keeps notifications in the background.
    win.setFocusable(allowed);
}

function setGhost(index: number) {
    if (index === ghostIndex) return;
    ghostIndex = index;
    run(`window.setGhost?.(${index})`);
}

function setTyping(value: boolean) {
    if (value === typing) return;
    typing = value;
    run(`window.setTyping?.(${value})`);
}

function bringToFront(w: BrowserWindow) {
    w.setAlwaysOnTop(true, "screen-saver");
    w.moveTop();
}

function dismissAll() {
    run("window.dismissAll?.()");
}

/** Unlocked cards are clickable and fully visible, whatever the game, ghost and typing states, and their timers wait */
function setUnlocked(value: boolean) {
    unlockedUntil = Date.now() + UNLOCK_IDLE;
    if (value === unlocked) return;
    unlocked = value;
    run(`window.setUnlocked?.(${value})`);
}

function toggleUnlocked() {
    setUnlocked(!unlocked);
    // Applied right away rather than on the next tick, which may be 150 ms away
    if (tickTimer) {
        clearTimeout(tickTimer);
        tickTimer = null;
        tick();
    }
}

function registerShortcuts(l: OverlayLayout) {
    const key = l.shortcut + "\n" + l.unlockShortcut;
    if (shortcutKey === key) return;
    unregisterShortcuts();
    shortcutKey = key;

    const register = (accelerator: string, callback: () => void) => {
        if (!accelerator || registered.includes(accelerator)) return;
        try {
            if (globalShortcut.register(accelerator, callback)) registered.push(accelerator);
        } catch {
            // Invalid accelerator: the setting is free text
        }
    };
    register(l.shortcut, dismissAll);
    register(l.unlockShortcut, toggleUnlocked);
}

function unregisterShortcuts() {
    for (const accelerator of registered) {
        try {
            globalShortcut.unregister(accelerator);
        } catch { }
    }
    registered = [];
    shortcutKey = null;
}

/** On Windows, distinguish a foreground game from a background game, another app and the Start menu. */
function inGame() {
    if (!gamePids.size || (discordWin && !discordWin.isDestroyed() && discordWin.isFocused())) return false;
    if (process.platform === "win32")
        return !!foreground && Date.now() - foregroundAt < 1500 && gamePids.has(foreground.pid);
    return true;
}

function onOtherDisplay() {
    return gameDisplayId != null && placedDisplayId != null && placedDisplayId !== gameDisplayId;
}

/** In game, the cards let the mouse through until the unlock shortcut */
function isLocked() {
    return !!layout?.lockInGame && !unlocked && inGame() && !onOtherDisplay();
}

/** Which card box the cursor is over, in the coordinates the page reports them in */
function hoveredBox(cursor: Electron.Point, bounds: Electron.Rectangle, margin = 0) {
    if (bounds.width <= 0 || bounds.height <= 0) return -1;
    // Match the viewport actually rendered on this monitor. The requested zoom alone is not a measurement:
    // Chromium's effective viewport can differ after a monitor/DPI change or when setZoomFactor is unavailable.
    const scaleX = pageViewport ? bounds.width / pageViewport.width : nativeZoom;
    const scaleY = pageViewport ? bounds.height / pageViewport.height : nativeZoom;
    const x = (cursor.x - bounds.x) / scaleX;
    const y = (cursor.y - bounds.y) / scaleY;
    return cardRects.findIndex(([left, top, right, bottom]) =>
        x >= left - margin && x <= right + margin && y >= top - margin && y <= bottom + margin);
}

function updateHover(index: number, now: number) {
    if (isLocked() || !layout?.clickable) {
        pointerDown = dragging = false;
        hoverSince = 0;
        setGhost(-1);
        setInteractive(false);
        return;
    }

    if (dragging || pointerDown) {
        setGhost(-1);
        setInteractive(true);
        return;
    }

    if (index < 0) {
        hoverSince = 0;
        setGhost(-1);
        setInteractive(false);
        return;
    }

    if (layout?.hover === "ghost" && !unlocked) {
        hoverSince ||= now;
        const rested = now - hoverSince >= GHOST_DWELL;
        setGhost(rested ? -1 : index);
        setInteractive(rested && !!layout.clickable);
    } else {
        setGhost(-1);
        setInteractive(!!layout?.clickable);
    }
}

/**
 * In game, the cards stay faded whatever the input device: keyboard, mouse or controller. While they are locked,
 * the cursor going past them is the game's camera, not the user heading for a card, so it does not bring them back.
 *
 * Elsewhere, input activity without a hook, from the system idle time (any keyboard or mouse input during the last second):
 * - "keyboard": only counts while the cursor stays still, so moving the mouse never fades anything;
 * - "any": counts any input, keys held in a game and controller input (reported by the page) included,
 *   unless the cursor is close to a card.
 * Only read every TYPING_CHECK ms, and never while the cursor is on (or, for "any", near) a card.
 */
function updateTyping(cursor: Electron.Point, bounds: Electron.Rectangle, now: number) {
    if (!layout || layout.typing === "off" || unlocked || (inGame() && onOtherDisplay())) {
        setTyping(false);
        return;
    }

    const moved = !lastCursor || cursor.x !== lastCursor.x || cursor.y !== lastCursor.y;
    if (moved) {
        lastCursor = cursor;
        lastMoveAt = now;
    }

    if (isLocked()) {
        setTyping(true);
        return;
    }

    const gaming = inGame();

    // Alt+Tab/Start releases the in-game protection even if the game keeps running in the background.
    if (gamePids.size && !gaming && process.platform === "win32") {
        setTyping(false);
        return;
    }

    // The cursor is on a card, or heading for one: the user wants to read it
    if (interactive || ghostIndex >= 0 || ((gaming || layout.typingTrigger === "any") && hoveredBox(cursor, bounds, NEAR_CARD) >= 0)) {
        setTyping(false);
        return;
    }

    if (gaming) {
        setTyping(true);
        return;
    }

    if (layout.typingTrigger !== "any") {
        if (moved) {
            setTyping(false);
            return;
        }
        if (now - lastMoveAt < TYPING_STILL) return;
    }

    if (layout.typingTrigger === "any" && now - lastPadAt < PAD_ACTIVE) {
        setTyping(true);
        return;
    }

    if (now - lastTypingCheck < TYPING_CHECK) return;
    lastTypingCheck = now;
    setTyping(powerMonitor.getSystemIdleTime() === 0);
}

/** Unlocked cards lock again once the cursor stayed away from them for UNLOCK_IDLE */
function updateUnlocked(index: number, now: number) {
    if (!unlocked) return;
    if (index >= 0 || dragging) unlockedUntil = now + UNLOCK_IDLE;
    else if (now >= unlockedUntil) setUnlocked(false);
}

/**
 * The window covers a whole column of the screen but must stay click-through outside of the cards.
 * Polling the cursor avoids the system-wide mouse hook that Electron's mouse forwarding installs,
 * and polling slows down while the cursor is away from the overlay.
 */
function tick() {
    tickTimer = null;
    if (!win || win.isDestroyed() || !win.isVisible()) return;

    const now = Date.now();
    const cursor = screen.getCursorScreenPoint();
    const bounds = win.getContentBounds();

    const index = hoveredBox(cursor, bounds);
    updateUnlocked(index, now);
    syncFocusable();
    updateHover(index, now);
    updateTyping(cursor, bounds, now);

    // Restacking a native window during a press can interrupt its pointer capture on Windows.
    if (!pointerDown && !dragging && now - lastReassert >= REASSERT_INTERVAL) {
        lastReassert = now;
        bringToFront(win);
    }

    const near = cursor.x >= bounds.x - NEAR_MARGIN && cursor.x <= bounds.x + bounds.width + NEAR_MARGIN
        && cursor.y >= bounds.y - NEAR_MARGIN && cursor.y <= bounds.y + bounds.height + NEAR_MARGIN;
    tickTimer = setTimeout(tick, near || dragging || hoverSince ? TICK_NEAR : TICK_FAR);
}

function startTicking() {
    tickTimer ??= setTimeout(tick, TICK_NEAR);
}

function stopTicking() {
    if (tickTimer) clearTimeout(tickTimer);
    tickTimer = null;
    hoverSince = 0;
    lastCursor = null;
}

/**
 * Puts the page back to full opacity and forgets the ghost / typing states. setGhost and setTyping only message the page
 * on change, so resetting the flags here without telling the page left the next notifications faded for good.
 */
function resetPageEffects() {
    ghostIndex = -1;
    typing = false;
    unlocked = false;
    run("window.setGhost?.(-1); window.setTyping?.(false); window.setUnlocked?.(false)");
}

function hideOverlay() {
    stopTicking();
    resetPageEffects();
    unregisterShortcuts();
    dragging = false;
    pointerDown = false;
    setInteractive(false);
    cardRects = [];
    pageViewport = null;
    if (win && !win.isDestroyed()) win.hide();

    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
        idleTimer = null;
        if (win && !win.isDestroyed() && !win.isVisible()) win.destroy();
    }, IDLE_DESTROY);
}

function targetDisplay(l: OverlayLayout) {
    if (gamePids.size && l.gameDisplay) {
        const selected = screen.getAllDisplays().find(d => String(d.id) === l.gameDisplay);
        if (selected) return selected;
    }
    if (l.display === "primary") return screen.getPrimaryDisplay();
    if (l.display === "discord" && discordWin && !discordWin.isDestroyed()) return screen.getDisplayMatching(discordWin.getBounds());
    // Keep the game's display stable while its cursor is released onto another monitor.
    if (gamePids.size && gameDisplayId != null) {
        const gaming = screen.getAllDisplays().find(d => d.id === gameDisplayId);
        if (gaming) return gaming;
    }
    return screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
}

/** The window is a column in the chosen corner, as tall as allowed; cards stack inside it */
function place(w: BrowserWindow, l: OverlayLayout) {
    const display = targetDisplay(l);
    placedDisplayId = display.id;
    const { workArea } = display;
    const offsetX = Math.max(0, Math.min(l.offsetX, workArea.width / 2));
    const offsetY = Math.max(0, Math.min(l.offsetY, workArea.height / 2));
    const width = Math.min(workArea.width - offsetX, Math.ceil((l.maxWidth + 2 * PAGE_MARGIN) * l.scale));
    const height = Math.min(workArea.height - offsetY, Math.round(workArea.height * l.maxHeight));

    // Discord's Electron build lacks setZoomFactor, the page then applies CSS zoom itself
    const webContents = w.webContents as Electron.WebContents & Partial<Pick<Electron.WebContents, "setZoomFactor">>;
    if (typeof webContents.setZoomFactor === "function") {
        webContents.setZoomFactor(l.scale);
        nativeZoom = l.scale;
    } else {
        nativeZoom = 1;
    }

    const [vertical, horizontal] = l.position.split("-");
    const x = horizontal === "left" ? workArea.x + offsetX
        : horizontal === "center" ? workArea.x + Math.round((workArea.width - width) / 2)
            : workArea.x + workArea.width - width - offsetX;
    const y = vertical === "top" ? workArea.y + offsetY : workArea.y + workArea.height - height - offsetY;

    w.setBounds({ x: Math.round(x), y: Math.round(y), width, height });
}

function refreshPlacement() {
    if (win && !win.isDestroyed() && win.isVisible() && layout) {
        dragging = false;
        pointerDown = false;
        hoverSince = 0;
        setGhost(-1);
        setInteractive(false);
        place(win, layout);
        syncFocusable();
    }
}

function receiveForeground(value: ForegroundWindow | null) {
    const wasGaming = inGame();
    foreground = value;
    foregroundAt = Date.now();
    if (value && gamePids.has(value.pid)) {
        const bounds = screen.screenToDipRect(null, value.monitor);
        const display = screen.getDisplayMatching(bounds);
        if (gameDisplayId !== display.id) {
            gameDisplayId = display.id;
            refreshPlacement();
        }
    }
    if (wasGaming !== inGame()) {
        dragging = false;
        pointerDown = false;
        hoverSince = 0;
        setGhost(-1);
        setInteractive(false);
    }
    syncFocusable();
}

function stopObservingGames() {
    stopForeground?.();
    stopForeground = null;
    foreground = null;
    foregroundAt = 0;
    app.removeListener("will-quit", stopObservingGames);
}

/** Plain serializable display data for the renderer's screen picker. */
export function getDisplays(): OverlayMonitor[] {
    const primary = screen.getPrimaryDisplay().id;
    return screen.getAllDisplays().map(d => ({
        id: String(d.id),
        label: d.label,
        primary: d.id === primary,
        width: Math.round(d.size.width * d.scaleFactor),
        height: Math.round(d.size.height * d.scaleFactor)
    }));
}

/** Read-only troubleshooting data: window geometry and input state, without any notification/message content. */
export function getDiagnostics() {
    const visible = !!win && !win.isDestroyed() && win.isVisible();
    const bounds = win && !win.isDestroyed() ? win.getContentBounds() : null;
    const cursor = screen.getCursorScreenPoint();
    return {
        hitTest: "viewport-v1",
        visible,
        bounds,
        cursor,
        pageViewport,
        nativeZoom,
        cardRects,
        hovered: visible && bounds ? hoveredBox(cursor, bounds) : -1,
        interactive,
        focusable,
        pointerDown,
        dragging,
        clickable: layout?.clickable ?? false,
        gameInForeground: inGame(),
        locked: isLocked(),
        placedDisplayId,
        gameDisplayId,
        displays: screen.getAllDisplays().map(d => ({ id: d.id, bounds: d.bounds, scaleFactor: d.scaleFactor }))
    };
}

/** Moving the game-only display also moves cards that are already visible. */
export function setGameDisplay(_: IpcMainInvokeEvent, displayId: string) {
    if (!layout) return;
    layout = { ...layout, gameDisplay: displayId };
    refreshPlacement();
}

function sameLayout(a: OverlayLayout | null, b: OverlayLayout) {
    return a != null && (Object.keys(b) as (keyof OverlayLayout)[]).every(k => a[k] === b[k]);
}

export async function showNotification(event: IpcMainInvokeEvent, data: OverlayNotification) {
    discordWin = BrowserWindow.fromWebContents(event.sender) ?? discordWin;

    // The card an update was meant for is already gone: never create (or wake up) the window for it
    if (data.update && (!win || win.isDestroyed() || !win.isVisible())) return;

    const seq = ++pushSeq;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;

    const w = getWindow();
    await ready;
    if (w.isDestroyed()) return;

    if (!w.isVisible()) {
        if (data.update) return;
        resetPageEffects();
        place(w, data.layout);
        w.showInactive();
    } else if (!sameLayout(layout, data.layout)) {
        place(w, data.layout);
    }
    layout = data.layout;
    syncFocusable();
    if (!pointerDown && !dragging) bringToFront(w);
    registerShortcuts(data.layout);
    startTicking();

    const cssZoom = nativeZoom === 1 ? data.layout.scale : 1;
    await w.webContents.executeJavaScript(`window.pushNotification(${JSON.stringify(data)}, ${seq}, ${cssZoom})`);
}

/** Whether the Discord window really is the foreground window, as seen by the OS rather than by the page */
export function isDiscordFocused(event: IpcMainInvokeEvent) {
    const w = BrowserWindow.fromWebContents(event.sender);
    return !!w && w.isVisible() && !w.isMinimized() && w.isFocused();
}

export function setRunningGames(event: IpcMainInvokeEvent, pids: number[]) {
    discordWin = BrowserWindow.fromWebContents(event.sender) ?? discordWin;
    gamePids = new Set(pids.filter(pid => Number.isInteger(pid) && pid > 0));
    if (gamePids.size) {
        if (process.platform === "win32" && !stopForeground) {
            stopForeground = watchForeground(receiveForeground);
            app.on("will-quit", stopObservingGames);
        }
    } else {
        stopObservingGames();
        gameDisplayId = null;
    }
    refreshPlacement();
}

/** Resolves with the next click on a card, or null when superseded (plugin restart, renderer reload) */
export function nextAction(): Promise<OverlayAction | null> {
    const queued = pendingActions.shift();
    if (queued) return Promise.resolve(queued);

    actionWaiter?.(null);
    return new Promise(resolve => actionWaiter = resolve);
}

export function destroy() {
    stopTicking();
    unregisterShortcuts();
    stopObservingGames();
    gamePids.clear();
    gameDisplayId = null;
    placedDisplayId = null;
    pointerDown = dragging = false;
    screen.removeListener("display-added", refreshPlacement);
    screen.removeListener("display-removed", refreshPlacement);
    screen.removeListener("display-metrics-changed", refreshPlacement);
    unlocked = false;
    lastPadAt = 0;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
    actionWaiter?.(null);
    actionWaiter = null;
    pendingActions.length = 0;
    cardRects = [];
    pageViewport = null;
    layout = null;

    if (win && !win.isDestroyed()) win.destroy();
    win = null;
    ready = null;
}
