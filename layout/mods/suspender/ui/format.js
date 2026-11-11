// What the strip of a sleeping tab says, as plain data: the status line, the
// items of the info line, the buttons, the last screen. Pure, so it is tested
// without Herdr; `sleepPane.ts` only lays it out.
import { fitSegments, SEPARATOR } from "../core/fit.js";
import { repoPath, shortBranch } from "../core/paths.js";
import { scaleOf, toMod } from "../core/scale.js";
import { hasMessage, t } from "../i18n/index.js";
import { uiMeasure } from "./textWidth.js";
/** Widths of the strip's items, as in the approved mockup (session-info.html v4). */
const BRANCH_MAX = 28;
const FOLDER_MAX = 34;
/** Between the parts of the status line. */
const JOIN = " · ";
const pad = (n) => String(n).padStart(2, "0");
/** "14:05" today, "2026-11-08 09:30" on another day (local time). */
export function clock(ms, nowMs) {
    const d = new Date(ms);
    const now = new Date(nowMs);
    const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
    return sameDay ? time : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${time}`;
}
/** The strip's second line: what state the session is in and anything worth knowing about it. */
export function stripStatus(rec, o) {
    const time = rec.sleptAtMs === null ? "" : clock(rec.sleptAtMs, o.now);
    const parts = [];
    switch (rec.state) {
        case "asleep":
            parts.push(t("strip.asleep", { time }));
            break;
        case "interrupted":
            parts.push(t("strip.interrupted", { time }));
            break;
        case "stopping":
            return t("strip.stopping");
        case "waking":
            return wakeSteps(o.progress).find((s) => s.state === "now")?.label ?? t("strip.waking.starting");
        case "elsewhere":
            return t("strip.elsewhere");
        case "missing":
            return t("strip.missing");
        case "error": {
            const reason = rec.error !== null && hasMessage(rec.error) ? t(rec.error, { agent: o.agentName }) : "";
            return t("error.startFailed", { agent: o.agentName, reason });
        }
        default:
            return "";
    }
    if (rec.forced) {
        parts.push(t("strip.stoppedForcefully"));
    }
    if (o.fresh !== null) {
        parts.push(t("strip.updatedAfterSleep", { time: clock(o.fresh.atMs, o.now), count: o.fresh.added }));
    }
    return parts.join(JOIN);
}
const STEPS = [
    { step: "found", key: "strip.waking.found" },
    { step: "starting", key: "strip.waking.starting" },
    { step: "ready", key: "strip.waking.ready" },
];
/** found session → starting → ready, with the current one marked (none yet: the first). */
export function wakeSteps(current) {
    const at = Math.max(0, STEPS.findIndex((s) => s.step === current));
    return STEPS.map((s, i) => ({ label: t(s.key), state: i < at ? "done" : i === at ? "now" : "todo" }));
}
/** The strip's buttons for this state. `busy`: a copy is acting on the session, so nothing is pressable. */
export function stripActions(rec, busy) {
    switch (rec.state) {
        case "asleep":
        case "interrupted":
            return [{ action: "resume", label: t("strip.resume"), enabled: !busy }];
        case "elsewhere":
            return [{ action: "resume", label: t("strip.resume"), enabled: false }];
        case "missing":
            return [
                { action: "startNew", label: t("strip.startNew"), enabled: !busy },
                { action: "forget", label: t("strip.forget"), enabled: !busy },
            ];
        case "error":
            return [{ action: "retry", label: t("strip.retry"), enabled: !busy }];
        default:
            return [];
    }
}
/** The info line after the title: branch → model → folder (from the repository root); no data, no item. */
export function stripSegments(info, sep) {
    const segs = [];
    if (info.branch) {
        segs.push({ key: "branch", text: shortBranch(info.branch, BRANCH_MAX), priority: 1 });
    }
    if (info.model) {
        segs.push({ key: "model", text: info.model, priority: 2 });
    }
    if (info.cwd) {
        segs.push({ key: "folder", text: repoPath(info.cwd, info.repoRoot, sep, FOLDER_MAX), priority: 3 });
    }
    return segs;
}
// The strip, as sleepPane.ts draws it, in the mod's px: what `fitStrip` counts.
export const STRIP_TEXT = 12.5;
export const STRIP_BADGE_TEXT = 11;
/** Padding left and right of the strip. */
export const STRIP_PAD_LEFT = 12;
export const STRIP_PAD_RIGHT = 10;
/** The moon at the strip's start. */
export const STRIP_MOON_PX = 14;
/** Between the moon, the info line and each button. */
export const STRIP_GAP = 10;
/** Between the elements of the info line (title, separators, items, badge). */
export const STRIP_ITEM_GAP = 8;
/** An item's 12 px icon and the 4 px before its text. */
const STRIP_ICON_PX = 16;
/** A button's padding (12 + 12); the first is filled, the others have a 1 px border. */
export const STRIP_BUTTON_PAD = 12;
/** The play icon of Resume and the gap after it. */
export const STRIP_PLAY_PX = 11;
export const STRIP_PLAY_GAP = 7;
/** The badge's padding (6 + 6) and border (1 + 1). */
const STRIP_BADGE_CHROME = 14;
/** Kerning and rounding. */
const STRIP_SPARE = 4;
/** A strip button's width in the mod's px. */
export function stripButtonWidth(a, first, measure) {
    const icon = first && a.action === "resume" ? STRIP_PLAY_PX + STRIP_PLAY_GAP : 0;
    return 2 * STRIP_BUTTON_PAD + (first ? 0 : 2) + icon + measure(a.label, STRIP_TEXT, "semibold");
}
/**
 * The strip's info line: whether the title shows, which items, how many went
 * to "+N". `paneWidth` is the sleeping pane's width as Herdr reports it (window
 * px); the strip is drawn in the mod's px, so the width goes through the zoom.
 */
export function fitStrip(info, actions, paneWidth, sep, scale, measure = uiMeasure) {
    const segs = stripSegments(info, sep).map((s) => ({ ...s, extra: STRIP_ICON_PX }));
    const buttons = actions.reduce((sum, a, i) => sum + STRIP_GAP + stripButtonWidth(a, i === 0, measure), 0);
    const chrome = STRIP_PAD_LEFT + STRIP_PAD_RIGHT + STRIP_MOON_PX + STRIP_GAP + STRIP_SPARE + buttons;
    const width = Math.max(0, toMod(scale, paneWidth) - chrome);
    const text = (s) => measure(s, STRIP_TEXT);
    const fit = fitSegments(info.title, segs, width, text, {
        title: (s) => measure(s, STRIP_TEXT, "semibold"),
        separator: 2 * STRIP_ITEM_GAP + text(SEPARATOR.trim()),
        badge: (n) => STRIP_ITEM_GAP + STRIP_BADGE_CHROME + measure(`+${n}`, STRIP_BADGE_TEXT),
    });
    return { title: fit.title, segs: segs.filter((s) => fit.shown.includes(s.key)), hidden: fit.hidden };
}
/** The last `max` lines of a screen, without the blank lines under the prompt. */
export function screenLines(text, max) {
    if (text === null || max <= 0) {
        return [];
    }
    const lines = text.replace(/\r\n?/g, "\n").split("\n");
    while (lines.length > 0 && (lines.at(-1) ?? "").trim() === "") {
        lines.pop();
    }
    return lines.slice(-max);
}
/**
 * An estimate of a text's width in px at `size` px (gpui does not measure
 * text for scripts): wide characters (CJK, emoji) count about double.
 */
export function measureAt(size) {
    return (text) => {
        let units = 0;
        for (const ch of text) {
            const code = ch.codePointAt(0) ?? 0;
            units += code > 0x2e80 ? 1.1 : /[A-Z]/.test(ch) ? 0.66 : 0.56;
        }
        return units * size;
    };
}
/** Measured fonts (their hhea metrics; Herdr's cells match them at every size tried). */
const FONTS = {
    "jetbrains mono": { advance: 0.6, height: 1.32 },
    "geist mono": { advance: 0.6, height: 1.3 },
    consolas: { advance: 1126 / 2048, height: 2398 / 2048 },
    "cascadia mono": { advance: 1200 / 2048, height: 2380 / 2048 },
};
/** Herdr falls back to JetBrains Mono for a font the machine lacks; any other font is guessed as it. */
const FALLBACK_FONT = "JetBrains Mono";
const FALLBACK_METRICS = { advance: 0.6, height: 1.32 };
/** A light line's thickness per px of font (measured on JetBrains Mono: 1 px at 14, 2 at 24 and 30, 3 at 40). */
const LINE_WEIGHT = 0.075;
/** Lines of the last screen when the pane's height is not known yet. */
export const DEFAULT_ROWS = 30;
/** How much of the foreground the dimmed screen keeps. */
export const SCREEN_DIM = 0.3;
const positive = (value, fallback) => typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
const nonNegative = (value, fallback) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
/** From `settings()`: the shown layout's terminal font, size, padding and the zoom. */
export function screenLook(look) {
    const named = look["font_family"];
    const font = typeof named === "string" && named !== "" ? named : FALLBACK_FONT;
    const size = positive(look["font_size"], 14);
    const scale = scaleOf(look);
    const zoom = scale.zoom;
    const metrics = FONTS[font.toLowerCase()] ?? FALLBACK_METRICS;
    const device = size * zoom;
    const cellW = Math.max(1, Math.round(device * metrics.advance)) / zoom;
    const cellH = Math.max(1, Math.round(device * metrics.height)) / zoom;
    const pad = look["terminal_padding"];
    const padX = nonNegative(Array.isArray(pad) ? pad[0] : pad, 0);
    const padY = nonNegative(Array.isArray(pad) ? (pad[1] ?? pad[0]) : pad, 0);
    return {
        font,
        glyph: size,
        run: cellW / metrics.advance,
        cellW,
        cellH,
        padX,
        padY,
        stroke: Math.max(1, Math.round(device * LINE_WEIGHT)) / zoom,
        scale,
    };
}
/**
 * Rows that fit a pane `reported` px tall (window px, as Herdr reports it), and
 * where the first starts, in the mod's px: what is left under the last row is
 * shared above and below, as the terminal does.
 */
export function screenGrid(reported, l) {
    if (reported <= 0) {
        return { rows: DEFAULT_ROWS, top: l.padY };
    }
    const height = toMod(l.scale, reported);
    const inside = Math.max(0, height - 2 * l.padY);
    const rows = Math.floor(inside / l.cellH + 1e-9);
    return { rows, top: l.padY + Math.floor((inside - rows * l.cellH) / 2) };
}
const ZERO_WIDTH = [
    [0x0300, 0x036f],
    [0x0483, 0x0489],
    [0x0591, 0x05bd],
    [0x0610, 0x061a],
    [0x064b, 0x065f],
    [0x0e31, 0x0e31],
    [0x0e34, 0x0e3a],
    [0x1ab0, 0x1aff],
    [0x1dc0, 0x1dff],
    [0x200b, 0x200f],
    [0x2028, 0x202e],
    [0x2060, 0x2064],
    [0x20d0, 0x20ff],
    [0xfe00, 0xfe0f],
    [0xfe20, 0xfe2f],
    [0xfeff, 0xfeff],
    [0x1f3fb, 0x1f3ff],
    [0xe0000, 0xe0fff],
];
/** East Asian wide and full-width characters and emoji shown as pictures (Unicode 15). */
const WIDE = [
    [0x1100, 0x115f],
    [0x231a, 0x231b],
    [0x2329, 0x232a],
    [0x23e9, 0x23ec],
    [0x23f0, 0x23f0],
    [0x23f3, 0x23f3],
    [0x25fd, 0x25fe],
    [0x2614, 0x2615],
    [0x2648, 0x2653],
    [0x267f, 0x267f],
    [0x2693, 0x2693],
    [0x26a1, 0x26a1],
    [0x26aa, 0x26ab],
    [0x26bd, 0x26be],
    [0x26c4, 0x26c5],
    [0x26ce, 0x26ce],
    [0x26d4, 0x26d4],
    [0x26ea, 0x26ea],
    [0x26f2, 0x26f3],
    [0x26f5, 0x26f5],
    [0x26fa, 0x26fa],
    [0x26fd, 0x26fd],
    [0x2705, 0x2705],
    [0x270a, 0x270b],
    [0x2728, 0x2728],
    [0x274c, 0x274c],
    [0x274e, 0x274e],
    [0x2753, 0x2755],
    [0x2757, 0x2757],
    [0x2795, 0x2797],
    [0x27b0, 0x27b0],
    [0x27bf, 0x27bf],
    [0x2b1b, 0x2b1c],
    [0x2b50, 0x2b50],
    [0x2b55, 0x2b55],
    [0x2e80, 0x303e],
    [0x3041, 0x33ff],
    [0x3400, 0x4dbf],
    [0x4e00, 0x9fff],
    [0xa000, 0xa4cf],
    [0xa960, 0xa97f],
    [0xac00, 0xd7a3],
    [0xf900, 0xfaff],
    [0xfe10, 0xfe19],
    [0xfe30, 0xfe6f],
    [0xff00, 0xff60],
    [0xffe0, 0xffe6],
    [0x16fe0, 0x16fe4],
    [0x17000, 0x18cff],
    [0x1b000, 0x1b2ff],
    [0x1f004, 0x1f004],
    [0x1f0cf, 0x1f0cf],
    [0x1f18e, 0x1f18e],
    [0x1f191, 0x1f19a],
    [0x1f200, 0x1f202],
    [0x1f210, 0x1f23b],
    [0x1f240, 0x1f248],
    [0x1f250, 0x1f251],
    [0x1f260, 0x1f265],
    [0x1f300, 0x1f320],
    [0x1f32d, 0x1f335],
    [0x1f337, 0x1f37c],
    [0x1f37e, 0x1f393],
    [0x1f3a0, 0x1f3ca],
    [0x1f3cf, 0x1f3d3],
    [0x1f3e0, 0x1f3f0],
    [0x1f3f4, 0x1f3f4],
    [0x1f3f8, 0x1f43e],
    [0x1f440, 0x1f440],
    [0x1f442, 0x1f4fc],
    [0x1f4ff, 0x1f53d],
    [0x1f54b, 0x1f54e],
    [0x1f550, 0x1f567],
    [0x1f57a, 0x1f57a],
    [0x1f595, 0x1f596],
    [0x1f5a4, 0x1f5a4],
    [0x1f5fb, 0x1f64f],
    [0x1f680, 0x1f6c5],
    [0x1f6cc, 0x1f6cc],
    [0x1f6d0, 0x1f6d2],
    [0x1f6d5, 0x1f6d7],
    [0x1f6dc, 0x1f6df],
    [0x1f6eb, 0x1f6ec],
    [0x1f6f4, 0x1f6fc],
    [0x1f7e0, 0x1f7eb],
    [0x1f7f0, 0x1f7f0],
    [0x1f90c, 0x1f93a],
    [0x1f93c, 0x1f945],
    [0x1f947, 0x1f9ff],
    [0x1fa70, 0x1faff],
    [0x20000, 0x2fffd],
    [0x30000, 0x3fffd],
];
function inRanges(cp, ranges) {
    let lo = 0;
    let hi = ranges.length - 1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const r = ranges[mid];
        if (r === undefined) {
            return false;
        }
        if (cp < r[0]) {
            hi = mid - 1;
        }
        else if (cp > r[1]) {
            lo = mid + 1;
        }
        else {
            return true;
        }
    }
    return false;
}
/** How many cells a character takes in the terminal: marks and joiners none, CJK and emoji two. */
export function cellWidth(cp) {
    if (inRanges(cp, ZERO_WIDTH)) {
        return 0;
    }
    return inRanges(cp, WIDE) ? 2 : 1;
}
/** Characters every terminal font carries at its own advance: they can share one piece of text. */
function plain(cp) {
    return (cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa0 && cp <= 0x52f) || (cp >= 0x2010 && cp <= 0x2027);
}
// Light lines: which halves of the cell's middle lines a character has.
const L = 1;
const R = 2;
const U = 4;
const D = 8;
const LINES = new Map([
    [0x2500, L | R],
    [0x2502, U | D],
    [0x250c, R | D],
    [0x2510, L | D],
    [0x2514, R | U],
    [0x2518, L | U],
    [0x251c, U | D | R],
    [0x2524, U | D | L],
    [0x252c, L | R | D],
    [0x2534, L | R | U],
    [0x253c, L | R | U | D],
    [0x2574, L],
    [0x2575, U],
    [0x2576, R],
    [0x2577, D],
]);
const ARCS = new Map([
    [0x256d, "tl"],
    [0x256e, "tr"],
    [0x256f, "br"],
    [0x2570, "bl"],
]);
// Quadrants: upper left, upper right, lower left, lower right.
const UL = 1;
const UR = 2;
const LL = 4;
const LR = 8;
const QUADRANTS = new Map([
    [0x2596, LL],
    [0x2597, LR],
    [0x2598, UL],
    [0x2599, UL | LL | LR],
    [0x259a, UL | LR],
    [0x259b, UL | UR | LL],
    [0x259c, UL | UR | LR],
    [0x259d, UR],
    [0x259e, UR | LL],
    [0x259f, UR | LL | LR],
]);
const FULL_BLOCK = 0x2588;
const RULE = 0x2500;
function fill(x, y, w, h, shade = 1) {
    return { kind: "fill", x, y, w, h, shade };
}
/** A light line or its rounded corner in the cell at (x, y), through the cell's middles. */
function line(cp, x, y, l) {
    const { cellW: w, cellH: h, stroke: s } = l;
    const mx = Math.floor(w / 2) - Math.floor(s / 2);
    const my = Math.floor(h / 2) - Math.floor(s / 2);
    const sides = LINES.get(cp);
    if (sides !== undefined) {
        const out = [];
        if (sides & L && sides & R) {
            out.push(fill(x, y + my, w, s));
        }
        else if (sides & L) {
            out.push(fill(x, y + my, mx + s, s));
        }
        else if (sides & R) {
            out.push(fill(x + mx, y + my, w - mx, s));
        }
        if (sides & U && sides & D) {
            out.push(fill(x + mx, y, s, h));
        }
        else if (sides & U) {
            out.push(fill(x + mx, y, s, my + s));
        }
        else if (sides & D) {
            out.push(fill(x + mx, y + my, s, h - my));
        }
        return out;
    }
    const corner = ARCS.get(cp);
    if (corner === undefined) {
        return null;
    }
    const left = corner === "tl" || corner === "bl";
    const top = corner === "tl" || corner === "tr";
    return [
        {
            kind: "arc",
            corner,
            x: left ? x + mx : x,
            y: top ? y + my : y,
            w: left ? w - mx : mx + s,
            h: top ? h - my : my + s,
            radius: Math.max(1, Math.round(Math.min(w, h) * 0.4)),
        },
    ];
}
/** A block element in the cell at (x, y): halves, eighths, quadrants, shades. */
function block(cp, x, y, l) {
    const { cellW: w, cellH: h } = l;
    const hw = Math.floor(w / 2);
    const hh = Math.floor(h / 2);
    const quad = QUADRANTS.get(cp);
    if (quad !== undefined) {
        const out = [];
        if (quad & UL) {
            out.push(fill(x, y, hw, hh));
        }
        if (quad & UR) {
            out.push(fill(x + hw, y, w - hw, hh));
        }
        if (quad & LL) {
            out.push(fill(x, y + hh, hw, h - hh));
        }
        if (quad & LR) {
            out.push(fill(x + hw, y + hh, w - hw, h - hh));
        }
        return out;
    }
    if (cp === 0x2580) {
        return [fill(x, y, w, hh)];
    }
    if (cp >= 0x2581 && cp <= 0x2587) {
        const part = cp === 0x2584 ? h - hh : Math.round((h * (cp - 0x2580)) / 8);
        return [fill(x, y + h - part, w, part)];
    }
    if (cp === FULL_BLOCK) {
        return [fill(x, y, w, h)];
    }
    if (cp >= 0x2589 && cp <= 0x258f) {
        const part = cp === 0x258c ? hw : Math.round((w * (0x2590 - cp)) / 8);
        return [fill(x, y, part, h)];
    }
    if (cp === 0x2590) {
        return [fill(x + hw, y, w - hw, h)];
    }
    if (cp >= 0x2591 && cp <= 0x2593) {
        return [fill(x, y, w, h, (cp - 0x2590) / 4)];
    }
    if (cp === 0x2594) {
        return [fill(x, y, w, Math.round(h / 8))];
    }
    if (cp === 0x2595) {
        const part = Math.round(w / 8);
        return [fill(x + w - part, y, part, h)];
    }
    return null;
}
/** The marks of one line of the screen, `row` rows down. */
function lineMarks(text, row, l) {
    const marks = [];
    const y = row * l.cellH;
    const chars = [...text];
    let col = 0;
    // The run of plain text being gathered, and the last text mark (a combining mark joins it).
    let run = null;
    let last = null;
    const endRun = () => {
        const done = run?.text.trimEnd() ?? "";
        if (run !== null && done !== "") {
            last = { kind: "text", x: run.col * l.cellW, y, text: done, size: l.run };
            marks.push(last);
        }
        run = null;
    };
    for (let i = 0; i < chars.length; i++) {
        const ch = chars[i] ?? "";
        const cp = ch.codePointAt(0) ?? 0;
        if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) {
            continue;
        }
        const width = cellWidth(cp);
        if (width === 0) {
            if (run !== null) {
                run.text += ch;
            }
            else if (last !== null) {
                last.text += ch;
            }
            continue;
        }
        if (width === 1 && plain(cp)) {
            if (run === null && cp !== 0x20) {
                run = { col, text: "" };
            }
            if (run !== null) {
                run.text += ch;
            }
            col += 1;
            continue;
        }
        endRun();
        last = null;
        const x = col * l.cellW;
        if (cp === FULL_BLOCK || cp === RULE) {
            // A row of full blocks or of rules is one rectangle.
            let n = 1;
            while (chars[i + n] === ch) {
                n++;
            }
            const one = (cp === RULE ? line(cp, x, y, l) : block(cp, x, y, l))?.[0];
            if (one?.kind === "fill") {
                marks.push({ ...one, w: one.w + (n - 1) * l.cellW });
            }
            i += n - 1;
            col += n;
            continue;
        }
        const drawn = width === 1 ? (line(cp, x, y, l) ?? block(cp, x, y, l)) : null;
        if (drawn !== null) {
            marks.push(...drawn);
        }
        else {
            last = { kind: "text", x, y, text: ch, size: l.glyph };
            marks.push(last);
        }
        col += width;
    }
    endRun();
    return marks;
}
/**
 * Every line of the screen as pieces on the terminal's grid: runs of plain
 * text (one piece each, at the size where a character is exactly one cell),
 * any other character on its own at its cell and the terminal's size, lines
 * and blocks as rectangles. Wide characters take two cells, marks none.
 */
export function screenMarks(lines, l) {
    return lines.flatMap((text, row) => lineMarks(text, row, l));
}
/** `#rrggbb` `t` of the way from `from` to `to` (an alpha pair, if any, is dropped). */
export function mixColor(from, to, t) {
    const rgb = (c) => {
        const hex = c.replace("#", "");
        return [0, 2, 4].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) || 0);
    };
    const a = rgb(from);
    const b = rgb(to);
    return `#${a
        .map((v, i) => Math.round(v + ((b[i] ?? 0) - v) * t)
        .toString(16)
        .padStart(2, "0"))
        .join("")}`;
}
