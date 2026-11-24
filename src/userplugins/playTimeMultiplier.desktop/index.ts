/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType } from "@utils/types";

const settings = definePluginSettings({
    multiplier: {
        type: OptionType.SELECT,
        description: "Multiplicateur appliqué au temps de jeu",
        default: 2,
        options: [
            { label: "×2", value: 2 },
            { label: "×3", value: 3 },
            { label: "×5", value: 5 },
            { label: "×10", value: 10 },
            { label: "×30", value: 30 },
            { label: "×60 (1 min = 1 h)", value: 60, default: false },
        ]
    }
});

export default definePlugin({
    name: "PlayTimeMultiplier",
    description: "Multiplie le temps de jeu comptabilisé par Discord dans les heartbeats analytics",
    authors: [{ name: "LEDEN", id: 224552140117508096n }],
    settings,

    patches: [
        {
            find: '"RunningGameHeartbeatManager"',
            replacement: {
                match: /(\i=\i\?0:Math\.round\(\i-\i\.lastHeartbeatTime\))/,
                replace: "$1*$self.getMultiplier()"
            }
        }
    ],

    getMultiplier() {
        return settings.store.multiplier;
    }
});
