/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { OptionType } from "@utils/types";
import { useEffect, useMemo, useRef, useState } from "@webpack/common";
import type { CSSProperties, ReactNode, RefObject } from "react";

import { settings, SettingsKey } from "../settings";

export const cl = (...names: (string | false | null | undefined)[]) => names.filter(Boolean).join(" ");

// ── Layout ─────────────────────────────────────────────────────────────────────

export function Section({ title, description, actions, children }: { title: string; description?: ReactNode; actions?: ReactNode; children: ReactNode; }) {
    return (
        <section className="vc-bn-section">
            <header className="vc-bn-section-head">
                <div>
                    <h3 className="vc-bn-section-title">{title}</h3>
                    {description && <p className="vc-bn-section-desc">{description}</p>}
                </div>
                {actions}
            </header>
            {children}
        </section>
    );
}

export function Card({ children, className }: { children: ReactNode; className?: string; }) {
    return <div className={cl("vc-bn-card", className)}>{children}</div>;
}

/** A setting line: title and hint on the left, control on the right (or below when stacked) */
export function Row({ title, hint, children, stacked, disabled }: { title: ReactNode; hint?: ReactNode; children: ReactNode; stacked?: boolean; disabled?: boolean; }) {
    return (
        <div className={cl("vc-bn-row", stacked && "vc-bn-row-stacked", disabled && "vc-bn-disabled")}>
            <div className="vc-bn-row-text">
                <div className="vc-bn-row-title">{title}</div>
                {hint && <div className="vc-bn-row-hint">{hint}</div>}
            </div>
            <div className="vc-bn-row-control">{children}</div>
        </div>
    );
}

// ── Inputs ─────────────────────────────────────────────────────────────────────

export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange(value: boolean): void; label?: string; disabled?: boolean; }) {
    return (
        <input
            type="checkbox"
            role="switch"
            className="vc-bn-switch"
            aria-label={label}
            checked={checked}
            disabled={disabled}
            onChange={e => onChange(e.currentTarget.checked)}
        />
    );
}

export function Segmented<T>({ options, value, onChange, label, disabled }: {
    options: readonly (readonly [T, string])[];
    value: T;
    onChange(value: T): void;
    label: string;
    disabled?: boolean;
}) {
    return (
        <div className={cl("vc-bn-seg", disabled && "vc-bn-disabled")} role="radiogroup" aria-label={label}>
            {options.map(([v, text]) => (
                <button
                    key={String(v)}
                    type="button"
                    role="radio"
                    aria-checked={v === value}
                    disabled={disabled}
                    className={v === value ? "vc-bn-seg-on" : undefined}
                    onClick={() => onChange(v)}
                >
                    {text}
                </button>
            ))}
        </div>
    );
}

export function Chip({ on, onClick, children, title }: { on: boolean; onClick(): void; children: ReactNode; title?: string; }) {
    return (
        <button type="button" className={cl("vc-bn-chip", on && "vc-bn-chip-on")} aria-pressed={on} title={title} onClick={onClick}>
            <span className="vc-bn-chip-check">{on ? "✓" : "+"}</span>
            {children}
        </button>
    );
}

/** Writes the value once the thumb is released: every change of a setting is saved to disk */
export function Range({ value, min, max, step, format, onChange, disabled }: {
    value: number;
    min: number;
    max: number;
    step: number;
    format(value: number): string;
    onChange(value: number): void;
    disabled?: boolean;
}) {
    const [local, setLocal] = useState(value);
    const dragging = useRef(false);
    useEffect(() => {
        if (!dragging.current) setLocal(value);
    }, [value]);

    const commit = () => {
        dragging.current = false;
        if (local !== value) onChange(local);
    };
    const pct = ((Math.min(Math.max(local, min), max) - min) / (max - min)) * 100;

    return (
        <div className={cl("vc-bn-range", disabled && "vc-bn-disabled")}>
            <input
                type="range"
                min={min}
                max={max}
                step={step}
                value={local}
                disabled={disabled}
                style={{ "--vc-bn-pct": `${pct}%` } as CSSProperties}
                onChange={e => {
                    dragging.current = true;
                    setLocal(Number(e.currentTarget.value));
                }}
                onPointerUp={commit}
                onKeyUp={commit}
                onBlur={commit}
            />
            <output className="vc-bn-range-value">{format(local)}</output>
        </div>
    );
}

/** Opens a floating panel above its trigger when there is not enough room below it in the scrolling pane */
function useFloating(ref: RefObject<HTMLElement | null>, open: boolean, close: () => void, height = 300) {
    const [up, setUp] = useState(false);

    useEffect(() => {
        if (!open || !ref.current) return;
        const box = ref.current.getBoundingClientRect();
        const pane = (ref.current.closest(".vc-bn-scroll") ?? document.body).getBoundingClientRect();
        const below = pane.bottom - box.bottom;
        setUp(below < height && box.top - pane.top > below);

        const onDown = (e: MouseEvent) => {
            if (!ref.current?.contains(e.target as Node)) close();
        };
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") {
                // Escape would also close the whole window
                e.stopPropagation();
                close();
            }
        };
        document.addEventListener("mousedown", onDown);
        document.addEventListener("keydown", onKey, true);
        return () => {
            document.removeEventListener("mousedown", onDown);
            document.removeEventListener("keydown", onKey, true);
        };
    }, [open]);

    return up;
}

export interface DropdownOption<T> {
    value: T;
    label: string;
    hint?: string;
}

export function Dropdown<T>({ options, value, onChange, display, icon, label, muted }: {
    options: DropdownOption<T>[];
    value: T;
    onChange(value: T): void;
    /** Text of the closed control, the selected label by default */
    display?: ReactNode;
    icon?: ReactNode;
    label: string;
    /** Greyed out text, for inherited values */
    muted?: boolean;
}) {
    const [open, setOpen] = useState(false);
    const ref = useRef<HTMLDivElement>(null);
    const up = useFloating(ref, open, () => setOpen(false));
    const selected = options.find(o => o.value === value);

    return (
        <div className="vc-bn-dropdown" ref={ref}>
            <button
                type="button"
                className={cl("vc-bn-dropdown-toggle", muted && "vc-bn-dropdown-muted")}
                aria-haspopup="listbox"
                aria-expanded={open}
                aria-label={label}
                title={label}
                onClick={() => setOpen(o => !o)}
            >
                {icon}
                <span className="vc-bn-dropdown-text">{display ?? selected?.label}</span>
                <span className="vc-bn-caret">▾</span>
            </button>
            {open && (
                <div className={cl("vc-bn-floating", up && "vc-bn-floating-up")} role="listbox" aria-label={label}>
                    {options.map(option => (
                        <button
                            key={String(option.value)}
                            type="button"
                            role="option"
                            aria-selected={option.value === value}
                            className={cl("vc-bn-option", option.value === value && "vc-bn-option-on")}
                            onClick={() => {
                                onChange(option.value);
                                setOpen(false);
                            }}
                        >
                            <span className="vc-bn-option-label">{option.label}</span>
                            {option.hint && <span className="vc-bn-option-hint">{option.hint}</span>}
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
}

export interface Choice {
    id: string;
    name: string;
    sub?: string;
    icon?: string;
    glyph?: string;
    /** Indented under the previous entry, for channels under their category */
    indent?: boolean;
}

export function Avatar({ src, name, glyph, size = 32 }: { src?: string; name: string; glyph?: string; size?: number; }) {
    const style = { width: size, height: size };
    return src
        ? <img className="vc-bn-avatar" style={style} src={src} alt="" />
        : <div className="vc-bn-avatar vc-bn-avatar-glyph" style={style}>{glyph ?? name[0]?.toUpperCase()}</div>;
}

/** Searchable list: picking an entry adds an exception for it */
export function Picker({ label, choices, onPick, variant = "primary" }: { label: string; choices: () => Choice[]; onPick(id: string): void; variant?: "primary" | "subtle"; }) {
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState("");
    const ref = useRef<HTMLDivElement>(null);
    const close = () => {
        setOpen(false);
        setQuery("");
    };
    const up = useFloating(ref, open, close, 340);

    // Only built while the list is open: some accounts have hundreds of friends
    const all = useMemo(() => open ? choices() : [], [open]);
    const needle = query.trim().toLocaleLowerCase();
    const shown = needle ? all.filter(c => `${c.name} ${c.sub ?? ""}`.toLocaleLowerCase().includes(needle)) : all;

    const pick = (id: string) => {
        onPick(id);
        close();
    };

    return (
        <div className="vc-bn-dropdown" ref={ref}>
            <button type="button" className={cl("vc-bn-btn", variant === "primary" ? "vc-bn-btn-secondary" : "vc-bn-btn-ghost")} aria-expanded={open} onClick={() => open ? close() : setOpen(true)}>
                <span className="vc-bn-plus">+</span> {label}
            </button>
            {open && (
                <div className={cl("vc-bn-floating", "vc-bn-picker", up && "vc-bn-floating-up")}>
                    <input
                        className="vc-bn-input"
                        placeholder="Rechercher…"
                        autoFocus
                        value={query}
                        onChange={e => setQuery(e.currentTarget.value)}
                        onKeyDown={e => {
                            if (e.key === "Enter" && shown[0]) pick(shown[0].id);
                        }}
                    />
                    <div className="vc-bn-picker-list" role="listbox">
                        {shown.map(choice => (
                            <button
                                key={choice.id}
                                type="button"
                                role="option"
                                aria-selected={false}
                                className={cl("vc-bn-option", "vc-bn-picker-item", choice.indent && !needle && "vc-bn-indent")}
                                onClick={() => pick(choice.id)}
                            >
                                <Avatar src={choice.icon} name={choice.name} glyph={choice.glyph} size={24} />
                                <span className="vc-bn-picker-name">{choice.name}</span>
                                {choice.sub && <span className="vc-bn-option-hint">{choice.sub}</span>}
                            </button>
                        ))}
                        {!shown.length && <div className="vc-bn-empty-small">{all.length ? "Aucun résultat." : "Tout est déjà dans la liste."}</div>}
                    </div>
                </div>
            )}
        </div>
    );
}

// ── Settings bound controls ────────────────────────────────────────────────────

interface SettingRowProps {
    k: SettingsKey;
    title: string;
    /** Sliders: step between values and how the value is written */
    step?: number;
    format?(value: number): string;
    /** Selects with long labels are shown as a drop-down */
    dropdown?: boolean;
    disabled?: boolean;
}

/** A row driven by the definition of a setting: its description is the hint, its options the choices */
export function SettingRow({ k, title, step, format, dropdown, disabled }: SettingRowProps) {
    const value: any = settings.use([k])[k];
    const def: any = settings.def[k];
    const set = (v: any) => (settings.store as any)[k] = v;

    switch (def.type) {
        case OptionType.BOOLEAN:
            return (
                <Row title={title} hint={def.description} disabled={disabled}>
                    <Toggle checked={!!value} onChange={set} label={title} disabled={disabled} />
                </Row>
            );
        case OptionType.SELECT: {
            const { options } = def;
            return (
                <Row title={title} hint={def.description} disabled={disabled} stacked={!dropdown}>
                    {dropdown
                        ? <Dropdown label={title} options={options.map(o => ({ value: o.value, label: o.label }))} value={value} onChange={set} />
                        : <Segmented label={title} options={options.map(o => [o.value, o.label] as const)} value={value} onChange={set} disabled={disabled} />}
                </Row>
            );
        }
        case OptionType.SLIDER: {
            const { markers } = def;
            return (
                <Row title={title} hint={def.description} disabled={disabled}>
                    <Range
                        value={value}
                        min={markers[0]}
                        max={markers[markers.length - 1]}
                        step={step ?? 1}
                        format={format ?? String}
                        onChange={set}
                        disabled={disabled}
                    />
                </Row>
            );
        }
        default:
            return null;
    }
}
