/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/** A seal with alternating radii, built once */
function sealPath(points: number, outer: number, inner: number, c = 12) {
    const coords: string[] = [];
    for (let i = 0; i < points * 2; i++) {
        const r = i % 2 ? inner : outer;
        const a = Math.PI * i / points - Math.PI / 2;
        coords.push(`${(c + r * Math.cos(a)).toFixed(2)} ${(c + r * Math.sin(a)).toFixed(2)}`);
    }
    return `M${coords.join("L")}Z`;
}

const SPARKLE = "M12 6.4c.55 3.05 2.15 4.65 5.2 5.2v.8c-3.05.55-4.65 2.15-5.2 5.2h-.8c-.55-3.05-2.15-4.65-5.2-5.2v-.8c3.05-.55 4.65-2.15 5.2-5.2Z";
const SEAL = sealPath(12, 11, 9.4);
/** Octagonal gem, like Discord's Orb */
const GEM = "M8.3 2h7.4L22 8.3v7.4L15.7 22H8.3L2 15.7V8.3Z";
const GEM_INNER = "M9.1 4h5.8L20 9.1v5.8L14.9 20H9.1L4 14.9V9.1Z";

/** Quest badge: the launcher logo */
export function QuestIcon({ size = 20 }: { size?: number; }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
            <path fill="currentColor" fillRule="evenodd" d={SEAL + SPARKLE} />
        </svg>
    );
}

/** Small Orb glyph, inline with text */
export function OrbIcon({ size = 14 }: { size?: number; }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" className="qc-orb-icon">
            <path fill="currentColor" fillRule="evenodd" d={GEM + GEM_INNER} />
            <path fill="currentColor" d={SPARKLE} />
        </svg>
    );
}

/** Large coloured Orb, used as the reward picture of Orb quests */
export function OrbGem({ size = 44 }: { size?: number; }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" className="qc-orb-gem">
            <defs>
                <linearGradient id="qc-gem-fill" x1="0" y1="0" x2="1" y2="1">
                    <stop offset="0" stopColor="#8a7bff" />
                    <stop offset="0.55" stopColor="#4b3fd6" />
                    <stop offset="1" stopColor="#1d1a5c" />
                </linearGradient>
                <radialGradient id="qc-gem-glow" cx="0.5" cy="0.45" r="0.5">
                    <stop offset="0" stopColor="#c8f1ff" stopOpacity="0.9" />
                    <stop offset="1" stopColor="#c8f1ff" stopOpacity="0" />
                </radialGradient>
            </defs>
            <path fill="url(#qc-gem-fill)" d={GEM} />
            <path fill="none" stroke="#b9b2ff" strokeOpacity="0.55" strokeWidth="0.7" d={GEM_INNER} />
            <circle cx="12" cy="12" r="7" fill="url(#qc-gem-glow)" />
            <path fill="#fff" d={SPARKLE} />
        </svg>
    );
}

export function NitroIcon({ size = 12 }: { size?: number; }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
            <path
                fill="currentColor"
                fillRule="evenodd"
                d="M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20Zm0 4.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11Zm0 2.5a3 3 0 1 1 0 6 3 3 0 0 1 0-6Z"
            />
        </svg>
    );
}

export function RefreshIcon() {
    return (
        <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
            <path fill="currentColor" d="M12 4a8 8 0 0 1 7.75 6h-2.1A6 6 0 1 0 18 14h2.07A8 8 0 1 1 12 4Zm6-1v6h-6l2.3-2.3A6 6 0 0 0 12 6V4a8 8 0 0 1 3.7.9Z" />
        </svg>
    );
}

export function CogIcon() {
    return (
        <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
            <path fill="currentColor" fillRule="evenodd" d="M10.6 2h2.8l.5 2.6a7.9 7.9 0 0 1 1.9 1.1l2.5-.9 1.4 2.4-2 1.8a8 8 0 0 1 0 2.2l2 1.8-1.4 2.4-2.5-.9a7.9 7.9 0 0 1-1.9 1.1l-.5 2.6h-2.8l-.5-2.6a7.9 7.9 0 0 1-1.9-1.1l-2.5.9-1.4-2.4 2-1.8a8 8 0 0 1 0-2.2l-2-1.8 1.4-2.4 2.5.9a7.9 7.9 0 0 1 1.9-1.1ZM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z" transform="translate(0 1)" />
        </svg>
    );
}

export function CloseIcon() {
    return (
        <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
            <path fill="currentColor" d="M17.3 5.3a1 1 0 1 1 1.4 1.4L13.4 12l5.3 5.3a1 1 0 0 1-1.4 1.4L12 13.4l-5.3 5.3a1 1 0 0 1-1.4-1.4l5.3-5.3-5.3-5.3a1 1 0 0 1 1.4-1.4l5.3 5.3Z" />
        </svg>
    );
}

export function SearchIcon() {
    return (
        <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
            <path fill="currentColor" d="M10.5 3a7.5 7.5 0 0 1 6 12l4.2 4.3a1 1 0 0 1-1.4 1.4L15 16.5A7.5 7.5 0 1 1 10.5 3Zm0 2a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11Z" />
        </svg>
    );
}

const TASK_GLYPHS: Record<string, string> = {
    video: "M8 5.5v13a1 1 0 0 0 1.5.86l10.4-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5Z",
    game: "M7 7h10a5 5 0 0 1 4.9 6l-.7 3.6a2.3 2.3 0 0 1-3.9 1.1L15.6 16H8.4l-1.7 1.7a2.3 2.3 0 0 1-3.9-1.1L2.1 13A5 5 0 0 1 7 7Zm0 3v1.5H5.5v1.5H7v1.5h1.5V13H10v-1.5H8.5V10Zm9 .5a1 1 0 1 0 0 2 1 1 0 0 0 0-2Zm-2 2a1 1 0 1 0 0 2 1 1 0 0 0 0-2Z",
    stream: "M3 5h18a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1h-7v2h3v2H7v-2h3v-2H3a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Zm7 3v6l5-3Z",
    activity: "M12 2l2.4 6.6L21 9l-5.2 4.3L17.5 20 12 16.3 6.5 20l1.7-6.7L3 9l6.6-.4Z",
    achievement: "M7 3h10v3h3v2a5 5 0 0 1-4.3 5A5 5 0 0 1 13 15.9V18h3v3H8v-3h3v-2.1A5 5 0 0 1 8.3 13 5 5 0 0 1 4 8V6h3Zm-1 5a3 3 0 0 0 1 2.2V8Zm12 0h-1v2.2A3 3 0 0 0 18 8Z",
    device: "M7 2h10a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Zm5 16a1 1 0 1 0 0 2 1 1 0 0 0 0-2Z"
};

export function TaskIcon({ kind, size = 13 }: { kind: string; size?: number; }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
            <path fill="currentColor" fillRule="evenodd" d={TASK_GLYPHS[kind] ?? TASK_GLYPHS.game} />
        </svg>
    );
}
