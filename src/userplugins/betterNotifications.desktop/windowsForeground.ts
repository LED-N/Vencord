/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { spawn } from "child_process";
import { createInterface } from "readline";

export interface ForegroundWindow {
    pid: number;
    /** Physical monitor bounds; Electron converts these to DIPs before matching a display */
    monitor: { x: number; y: number; width: number; height: number; };
}

/** Read-only Win32 polling, without keyboard hooks or intercepting Windows/Alt+Tab shortcuts. */
const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Threading;

public static class BetterNotificationsForeground {
    [StructLayout(LayoutKind.Sequential)]
    struct Rect { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)]
    struct MonitorInfo { public int Size; public Rect Monitor, Work; public uint Flags; }

    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
    [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr window, uint flags);
    [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr monitor, ref MonitorInfo info);
    [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);

    public static void Watch() {
        // Per-monitor aware: GetMonitorInfo must return physical pixels, including on mixed-DPI setups.
        SetThreadDpiAwarenessContext(new IntPtr(-4));
        while (true) {
            IntPtr window = GetForegroundWindow();
            uint processId = 0;
            GetWindowThreadProcessId(window, out processId);
            var info = new MonitorInfo();
            info.Size = Marshal.SizeOf(typeof(MonitorInfo));
            GetMonitorInfo(MonitorFromWindow(window, 2), ref info);
            Rect r = info.Monitor;
            // Heartbeat as well as state changes: a stalled helper must never leave the cards locked.
            Console.WriteLine("{0},{1},{2},{3},{4}", processId, r.Left, r.Top, r.Right - r.Left, r.Bottom - r.Top);
            Console.Out.Flush();
            Thread.Sleep(150);
        }
    }
}
'@
[BetterNotificationsForeground]::Watch()
`;

/** One hidden helper per game session; stopped when the last game exits or the plugin/Discord stops. */
export function watchForeground(onChange: (window: ForegroundWindow | null) => void): () => void {
    const child = spawn("powershell.exe", [
        "-NoLogo", "-NoProfile", "-NonInteractive",
        "-EncodedCommand", Buffer.from(SCRIPT, "utf16le").toString("base64")
    ], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const lines = createInterface({ input: child.stdout! });
    let stopped = false;
    let diagnostics = "";

    child.stderr!.on("data", chunk => diagnostics = (diagnostics + chunk).slice(-2000));

    lines.on("line", line => {
        if (stopped) return;
        const parts = line.split(",").map(Number);
        if (parts.length !== 5 || !parts.every(Number.isInteger)) return;
        const [pid, x, y, width, height] = parts;
        onChange(pid > 0 && width > 0 && height > 0 ? { pid, monitor: { x, y, width, height } } : null);
    });
    child.on("error", err => {
        if (stopped) return;
        console.error("[BetterNotifications] Cannot observe the foreground game", err);
        onChange(null);
    });
    child.on("exit", code => {
        if (!stopped) {
            if (code) console.error("[BetterNotifications] Foreground observer stopped", code, diagnostics);
            onChange(null);
        }
        lines.close();
    });

    return () => {
        stopped = true;
        lines.close();
        child.kill();
    };
}
