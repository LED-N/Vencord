/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Shared between the Discord renderer (index.tsx), the main process (native.ts) and the overlay page (overlay.html)

/** Markdown already parsed by Discord, reduced to what the overlay page knows how to draw */
export type RichNode =
    | string
    | { t: "b" | "i" | "u" | "s" | "spoiler" | "quote" | "sub"; c: RichNode[]; }
    | { t: "h"; level: number; c: RichNode[]; }
    | { t: "code" | "pre"; text: string; }
    | { t: "link"; href: string; c: RichNode[]; }
    | { t: "mention"; text: string; color?: string; }
    | { t: "emoji"; src: string; name: string; }
    | { t: "list"; ordered: boolean; start?: number; items: RichNode[][]; }
    | { t: "br"; };

export interface OverlayImage {
    src: string;
    width?: number;
    height?: number;
}

export interface OverlayEmbed {
    color?: string;
    author?: { name: string; icon?: string; url?: string; };
    title?: RichNode[];
    url?: string;
    description?: RichNode[];
    fields: { name: RichNode[]; value: RichNode[]; inline: boolean; }[];
    thumbnail?: string;
    image?: OverlayImage;
    footer?: { text?: string; icon?: string; timestamp?: string; };
}

export interface OverlayButton {
    label?: string;
    emoji?: { src?: string; text?: string; };
    /** Discord button style: 1 primary, 2 secondary, 3 success, 4 danger, 5 link */
    style: number;
    disabled: boolean;
    url?: string;
}

/** Entry of the menu opened by right-clicking a card */
export interface OverlayMenuItem {
    key: string;
    label: string;
    danger?: boolean;
}

export type OverlayPosition = "bottom-right" | "top-right" | "bottom-left" | "top-left" | "top-center" | "bottom-center";

/** Which monitor the overlay appears on */
export type OverlayDisplay = "cursor" | "primary" | "discord";

/** What happens to the cards while the user types in another application */
export type TypingBehavior = "off" | "fade" | "hide";

/** "keyboard": typing with the mouse still; "any": any keyboard or mouse activity away from the cards (games) */
export type TypingTrigger = "keyboard" | "any";

/** "interact": hovering captures the mouse; "ghost": the card fades and lets clicks through until the cursor rests on it */
export type HoverBehavior = "interact" | "ghost";

export interface OverlayLayout {
    position: OverlayPosition;
    display: OverlayDisplay;
    /** Distance from the screen edges, in screen pixels */
    offsetX: number;
    offsetY: number;
    /** Widest a card can grow, in CSS pixels (before scaling) */
    maxWidth: number;
    /** Zoom factor of the whole overlay */
    scale: number;
    /** Background opacity of the cards, 0 to 1 */
    opacity: number;
    maxVisible: number;
    /** Height of the overlay column, as a fraction of the screen height */
    maxHeight: number;
    /** Only the newest (or hovered) card is expanded, the others shrink to a single line */
    collapseOlder: boolean;
    /** The newest card also shrinks to a single line after this many milliseconds, 0 to never */
    autoCollapse: number;
    /** When off, the overlay never captures the mouse */
    clickable: boolean;
    hover: HoverBehavior;
    typing: TypingBehavior;
    typingTrigger: TypingTrigger;
    /** Opacity of the cards while typing, 0 to 1 */
    typingOpacity: number;
    /** Electron accelerator closing every card while some are displayed, empty to disable */
    shortcut: string;
}

export interface OverlayNotification {
    /** Message id, used to update the card and to resolve click actions */
    id: string;
    layout: OverlayLayout;
    title: string;
    subtitle?: string;
    icon?: string;
    /** One-line text shown when the card is collapsed */
    preview?: string;
    content?: RichNode[];
    embeds?: OverlayEmbed[];
    images?: OverlayImage[];
    buttons?: OverlayButton[];
    /** Right-click menu of the card */
    menu?: OverlayMenuItem[];
    /** Display time in milliseconds */
    duration: number;
    /** Stays until closed, highlighted */
    priority?: boolean;
    /** Replaces the card with the same id if it is still displayed, never creates a new one */
    update?: boolean;
    /** Takes over this card if it is still displayed (several messages of the same conversation) */
    replaces?: string;
}

/** Sent back to the Discord renderer when the user clicks a card, one of its interaction buttons or a menu entry */
export type OverlayAction =
    | { type: "jump"; id: string; }
    | { type: "button"; id: string; index: number; }
    | { type: "menu"; id: string; key: string; }
    /** Cards that left the screen, so their conversation starts a new card and their edits are no longer pushed */
    | { type: "closed"; ids: string[]; };
