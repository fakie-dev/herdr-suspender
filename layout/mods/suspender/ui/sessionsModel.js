// What the Sessions panel, its popup, the "Sessions · N" button and the sleep
// pill say, as plain data: groups and their order, the memory figures, which
// items a row keeps at a width, the popup's facts, where it opens, when memory
// is measured. Pure, so it is tested without Herdr; `panel.ts`, `popup.ts`,
// `toggle.ts` and `pill.ts` only lay it out.
import { fitSegments, SEPARATOR } from "../core/fit.js";
import { homePath, midId, repoPath, shortBranch, shortId } from "../core/paths.js";
import { modPx, toMod, toWindow, windowPx, } from "../core/scale.js";
import { t } from "../i18n/index.js";
import { clock, measureAt } from "./format.js";
import { textWidth } from "./textWidth.js";
// ---- states and groups
/** States whose tab holds a sleep pane: what "Sessions · N" counts. */
const SLEEPING = new Set([
    "asleep",
    "interrupted",
    "waking",
    "elsewhere",
    "missing",
    "error",
]);
export const isSleeping = (state) => SLEEPING.has(state);
export const sleepingCount = (records) => records.filter((r) => isSleeping(r.state)).length;
/** Inside a space: running first, then asleep, then interrupted (and the ones that failed). */
const RANK = {
    running: 0,
    working: 0,
    confirming: 0,
    stopping: 0,
    asleep: 1,
    waking: 1,
    elsewhere: 1,
    interrupted: 2,
    missing: 2,
    error: 2,
};
function byRow(a, b) {
    const rank = RANK[a.state] - RANK[b.state];
    if (rank !== 0) {
        return rank;
    }
    const ta = a.info.title ?? "";
    const tb = b.info.title ?? "";
    if (ta !== tb) {
        // Untitled last.
        if (ta === "" || tb === "") {
            return ta === "" ? 1 : -1;
        }
        const byTitle = ta.localeCompare(tb);
        if (byTitle !== 0) {
            return byTitle;
        }
    }
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}
/** Groups by space in the order Herdr lists the spaces; spaces it no longer has come last. */
export function groupSessions(records, spaces) {
    const bySpace = new Map();
    for (const rec of records) {
        bySpace.set(rec.spaceId, [...(bySpace.get(rec.spaceId) ?? []), rec]);
    }
    const make = (spaceId, name) => {
        const rows = bySpace.get(spaceId);
        if (rows === undefined) {
            return null;
        }
        rows.sort(byRow);
        const resumable = rows.filter((r) => r.state === "asleep" || r.state === "interrupted").map((r) => r.key);
        return { spaceId, name, rows, resumable };
    };
    const known = new Set(spaces.map((s) => s.id));
    const groups = spaces.map((s) => make(s.id, s.name));
    const gone = [...bySpace.keys()]
        .filter((id) => !known.has(id))
        .sort()
        .map((id) => make(id, t("panel.unknownSpace")));
    return [...groups, ...gone].filter((g) => g !== null);
}
// ---- memory
/** 780 → "780 MB", 1100 → "1.1 GB". */
export function formatMb(mb) {
    return mb >= 1000 ? `${(mb / 1000).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}
/** The panel's header: what the sleeping sessions freed, or null when no figure is known. */
export function memoryFreedText(records) {
    const total = records.reduce((sum, r) => sum + (isSleeping(r.state) ? (r.memFreedMb ?? 0) : 0), 0);
    return total > 0 ? t("panel.memoryFreed", { amount: formatMb(total) }) : null;
}
/** The figure at the right of a row: freed (a sleeper's) or used (a runner's, measured now). Nothing known: null. */
export function rowMemory(rec, usedMb) {
    if (isSleeping(rec.state)) {
        return rec.memFreedMb === null ? null : { kind: "freed", text: formatMb(rec.memFreedMb) };
    }
    return usedMb === null ? null : { kind: "used", text: formatMb(usedMb) };
}
/**
 * The "uses" figure of a row: only one measured in the terminal the session
 * runs in now. A woken session runs in a new terminal, so the figure from
 * before its last sleep does not come back while the next one is taken.
 */
export function usedNow(rec, used) {
    const figure = used.get(rec.key);
    return figure !== undefined && rec.terminal !== null && figure.terminal === rec.terminal ? figure.mb : null;
}
/** Measures at most once per `everyMs`, and only while the panel is shown. */
export class MemoryPolicy {
    everyMs;
    last = Number.NEGATIVE_INFINITY;
    constructor(everyMs) {
        this.everyMs = everyMs;
    }
    /** Whether to measure now; says yes at most once per interval, so closing and reopening does not reset it. */
    due(now, shown) {
        if (!shown || now - this.last < this.everyMs) {
            return false;
        }
        this.last = now;
        return true;
    }
}
// ---- a row's second line
/**
 * Room a row keeps around its second line, in the mod's px: its margins (4 + 4),
 * padding (8 + 8), the agent tile (16) and its gap (8), the panel's border
 * (1 + 1), and 4 to spare (kerning, rounding).
 */
export const ROW_CHROME_PX = 54;
/** The second line's text, the badge's and the memory figure's (panel.ts draws them at these sizes). */
export const ROW_TEXT = 11.5;
export const ROW_SMALL_TEXT = 11;
/** Between two elements of the second line (its items, separators, the badge). */
export const ROW_ITEM_GAP = 6;
/** The badge's padding (6 + 6) and border (1 + 1) around "+N". */
export const ROW_BADGE_CHROME_PX = 14;
/** The memory figure's icon (the moon, 11; the dot is narrower) and its gap (4). */
export const ROW_MEM_ICON_PX = 15;
/** Between the items and the memory figure. */
export const ROW_MEM_GAP_PX = 8;
/** An item's 12 px icon and the gap after it. */
const ICON_PX = 16;
const BRANCH_MAX = 22;
const FOLDER_MAX = 24;
/** The context item: its fill when the window is known, else the tokens in it; nothing known, none. */
function contextItem(info) {
    if (info.contextPct !== null) {
        return t("row.context", { pct: Math.max(0, Math.min(100, Math.round(info.contextPct))) });
    }
    const amount = present(info.contextText);
    return amount === null ? null : t("row.contextInUse", { amount });
}
/**
 * branch → model → context → folder → id (8 characters), as in the approved mockup with
 * the context added after the model; no data, no item. The context goes after the branch
 * and before the model when the row is narrow: it changes while the agent works.
 */
function rowSegments(info, sep) {
    const segs = [];
    if (info.branch) {
        segs.push({ key: "branch", text: shortBranch(info.branch, BRANCH_MAX), priority: 1, extra: ICON_PX });
    }
    if (info.model) {
        segs.push({ key: "model", text: info.model, priority: 2 });
    }
    const context = contextItem(info);
    if (context !== null) {
        segs.push({ key: "context", text: context, priority: 1.5 });
    }
    if (info.cwd) {
        segs.push({
            key: "folder",
            text: repoPath(info.cwd, info.repoRoot, sep, FOLDER_MAX),
            priority: 3,
            extra: ICON_PX,
        });
    }
    if (info.sessionId) {
        segs.push({ key: "id", text: `#${shortId(info.sessionId)}`, priority: 4 });
    }
    return segs;
}
/**
 * The items of a row's second line that fit, and how many went (the `+N`).
 * `panelWidth` is the panel's width as Herdr reports it (window px); the row is
 * drawn in the mod's px, so the width goes through the zoom first. `measure`
 * gives a text's width at a size in the mod's px (Geist's advances by default).
 */
export function fitRow(rec, panelWidth, memText, sep, measure, scale) {
    const segs = rowSegments(rec.info, sep);
    const text = (s) => measure(s, ROW_TEXT);
    const memory = memText === null ? 0 : measure(memText, ROW_SMALL_TEXT) + ROW_MEM_ICON_PX + ROW_MEM_GAP_PX;
    const width = Math.max(0, toMod(scale, panelWidth) - ROW_CHROME_PX - memory);
    const fit = fitSegments(null, segs, width, text, {
        separator: 2 * ROW_ITEM_GAP + text(SEPARATOR.trim()),
        badge: (n) => ROW_ITEM_GAP + ROW_BADGE_CHROME_PX + measure(`+${n}`, ROW_SMALL_TEXT),
    });
    return { segs: segs.filter((s) => fit.shown.includes(s.key)), hidden: fit.hidden };
}
const BRANCH_POPUP_MAX = 34;
const FOLDER_POPUP_MAX = 38;
const TONE = {
    running: "live",
    working: "live",
    confirming: "live",
    stopping: "live",
    asleep: "sleep",
    waking: "sleep",
    elsewhere: "sleep",
    interrupted: "warn",
    missing: "error",
    error: "error",
};
/** The state's word ("asleep", "working", …). */
export const stateWord = (state) => t(`state.${state}`);
/** The state word of a session; a sleeper's and an interrupted one's carry the time they went. */
export function stateText(rec, now) {
    const word = stateWord(rec.state);
    const timed = (rec.state === "asleep" || rec.state === "interrupted") && rec.sleptAtMs !== null;
    return timed ? t("popup.stateAt", { state: word, time: clock(rec.sleptAtMs ?? 0, now) }) : word;
}
const present = (text) => (text === null || text === "" ? null : text);
/** The context line: the fill with its bar when the window is known, else the tokens in use; nothing known, no line. */
function contextFacts(pct, text) {
    if (pct !== null) {
        return { pct, label: t("popup.context", { pct }), detail: text };
    }
    return text === null
        ? null
        : { pct: null, label: t("popup.contextUnknown"), detail: t("popup.contextInUse", { amount: text }) };
}
/** What the popup shows, in the order of the approved mockup (session-info.html v4). */
export function popupFacts(rec, o) {
    const info = rec.info;
    const rows = [];
    if (info.branch) {
        rows.push({ id: "branch", label: t("popup.branch"), value: shortBranch(info.branch, BRANCH_POPUP_MAX) });
    }
    if (info.model) {
        rows.push({ id: "model", label: t("popup.model"), value: info.model });
    }
    if (info.messages !== null) {
        rows.push({ id: "messages", label: t("popup.messages"), value: String(info.messages) });
    }
    const memory = rowMemory(rec, o.usedMb);
    if (memory !== null) {
        rows.push({
            id: "memory",
            label: memory.kind === "freed" ? t("popup.memoryFreed") : t("popup.memoryUsed"),
            value: memory.kind === "freed" ? `~${memory.text}` : memory.text,
        });
    }
    const cwd = info.cwd || rec.cwd;
    rows.push({
        id: "folder",
        label: t("popup.folder"),
        value: homePath(cwd, o.home, o.sep, FOLDER_POPUP_MAX),
        copy: cwd,
    });
    const sessionId = info.sessionId || rec.sessionId;
    rows.push({ id: "session", label: t("popup.session"), value: midId(sessionId), copy: sessionId });
    const pct = info.contextPct === null ? null : Math.max(0, Math.min(100, Math.round(info.contextPct)));
    return {
        agent: rec.agent,
        agentName: o.agentName,
        state: stateText(rec, o.now),
        tone: TONE[rec.state],
        title: present(info.title),
        ...titleLayout(present(info.title)),
        prompt: present(info.firstPrompt),
        reply: present(info.lastReply),
        promptLines: quoteLines(present(info.firstPrompt)),
        replyLines: quoteLines(present(info.lastReply)),
        context: contextFacts(pct, present(info.contextText)),
        tokens: present(info.tokensText),
        rows,
    };
}
/** The popup's width: about 340 px, as approved. */
export const POPUP_WIDTH = 344;
const POPUP_PAD = 12;
const POPUP_GAP = 9;
const HEADER_PX = 18;
/** The popup's text column. */
const POPUP_TEXT_PX = POPUP_WIDTH - 2 * POPUP_PAD;
/** The name: 13.5 px semibold, a fixed line height so whole lines fit, up to three of them. */
export const TITLE_TEXT = 13.5;
export const TITLE_LINE_PX = 19;
export const TITLE_MAX_LINES = 3;
/**
 * measureAt's estimate, a little large: Herdr drew "Перевести авторизацию
 * портала на" (32 characters, semibold 13.5) 246 px wide, measureAt says 242.
 */
const TITLE_MEASURE = measureAt(TITLE_TEXT * 1.03);
/** A prompt or reply: two lines of 12 px at this height, so the second is never cut through. */
export const QUOTE_LINE_PX = 18;
export const QUOTE_MAX_LINES = 2;
export const QUOTE_TEXT = 12;
/** Its label column (52) and the gap after it (8). */
export const QUOTE_LABEL_PX = 52;
export const QUOTE_GAP_PX = 8;
/** The quote's text column: the popup's text column less the label and its gap. */
export const QUOTE_TEXT_PX = POPUP_WIDTH - 2 * POPUP_PAD - QUOTE_LABEL_PX - QUOTE_GAP_PX;
const CONTEXT_PX = 28;
/** The context line without its bar (the window is unknown). */
const CONTEXT_TEXT_PX = 16;
const TOKENS_PX = 16;
/** A fact row (Branch, Model, … Session): its height and the space between two rows. */
export const FACT_ROW_PX = 18;
export const FACT_GAP_PX = 3;
const FACTS_PAD_PX = 9;
/** The popup's height: the blocks it shows, the name at its lines, a quote at its widest (two lines). */
export function popupHeight(facts) {
    const blocks = [
        HEADER_PX,
        facts.titleLines.length * TITLE_LINE_PX,
        facts.promptLines.length * QUOTE_LINE_PX,
        facts.replyLines.length * QUOTE_LINE_PX,
        facts.context === null ? 0 : facts.context.pct === null ? CONTEXT_TEXT_PX : CONTEXT_PX,
        facts.tokens === null ? 0 : TOKENS_PX,
        FACTS_PAD_PX + facts.rows.length * FACT_ROW_PX + Math.max(0, facts.rows.length - 1) * FACT_GAP_PX,
    ].filter((px) => px > 0);
    return POPUP_PAD * 2 + blocks.reduce((sum, px) => sum + px, 0) + (blocks.length - 1) * POPUP_GAP;
}
/** The gap between the popup and the window's edge or its anchor. */
const EDGE_PX = modPx(8);
/** A row's popup starts this far above the row's top. */
const ROW_LIFT_PX = modPx(6);
/** A strip's popup ends this far left of the strip's right end (clear of its buttons). */
const STRIP_INSET_PX = modPx(120);
const clamp = (value, min, max) => Math.max(min, Math.min(value, max));
/**
 * The popup's size: its width, and its height up to what the window holds. In
 * a window too short for it the fact rows go, whole, from the bottom, so none
 * is cut through; a window shorter still clips what is left at its height.
 */
export function popupSize(facts, viewport, scale) {
    const room = toMod(scale, viewport.height) - 2 * EDGE_PX;
    const width = modPx(POPUP_WIDTH);
    for (let rows = facts.rows.length; rows > 0; rows--) {
        const height = popupHeight({ ...facts, rows: facts.rows.slice(0, rows) });
        if (height <= room) {
            return { width, height: modPx(height), rows };
        }
    }
    const height = popupHeight({ ...facts, rows: [] });
    return { width, height: modPx(Math.max(0, Math.min(height, room))), rows: 0 };
}
/**
 * Where the popup opens, in window px (what `openOverlay({at})` takes): left of
 * a list row, so it does not cover the Sessions panel, or right of it when there
 * is no room on the left (Sessions in a window); when neither side has room,
 * the side that covers the row least. Above a strip, near its right end. Inside
 * the window. The anchor and the window are as Herdr reports them; the popup's
 * size is the mod's, which Herdr draws times the zoom.
 */
export function popupPosition(anchor, kind, size, viewport, scale) {
    const px = (len) => toWindow(scale, len);
    const width = px(size.width);
    const height = px(size.height);
    const edge = px(EDGE_PX);
    const maxX = Math.max(edge, viewport.width - width - edge);
    const maxY = Math.max(edge, viewport.height - height - edge);
    if (kind === "strip") {
        return {
            x: windowPx(clamp(anchor.left + anchor.width - width - px(STRIP_INSET_PX), edge, maxX)),
            y: windowPx(clamp(anchor.top - height - edge, edge, maxY)),
        };
    }
    const y = windowPx(clamp(anchor.top - px(ROW_LIFT_PX), edge, maxY));
    const left = anchor.left - edge - width;
    if (left >= edge) {
        return { x: windowPx(left), y };
    }
    const right = anchor.left + anchor.width + edge;
    if (right <= maxX) {
        return { x: windowPx(right), y };
    }
    // No room on either side: cover as little of the row as can be.
    const coverLeft = edge + width - (anchor.left - edge);
    const coverRight = anchor.left + anchor.width + edge - maxX;
    return { x: windowPx(coverLeft <= coverRight ? edge : maxX), y };
}
// ---- layout facts
/** Whether the layout's node `id` is on screen: it exists and is not hidden. */
export function panelShown(layout, id) {
    const visit = (node) => {
        if (typeof node !== "object" || node === null) {
            return null;
        }
        const n = node;
        if (n.id === id) {
            return n.hidden !== true;
        }
        if (Array.isArray(n.children)) {
            for (const child of n.children) {
                const hit = visit(child);
                if (hit !== null) {
                    return hit;
                }
            }
        }
        return null;
    };
    return visit(layout) ?? false;
}
// ---- the "Sessions · N" block (role "toggle", toggle.ts draws it)
/** Its padding inside the layout block (6 + 6), the button's padding (8 + 8), the moon (14) and its gap (5). */
export const TOGGLE_OUTER_PAD = 6;
export const TOGGLE_PAD = 8;
export const TOGGLE_ICON_PX = 14;
export const TOGGLE_GAP = 5;
export const TOGGLE_TEXT = 12;
/** How wide "Sessions · N" is drawn, in the mod's px. */
export function toggleWidth(count, measure) {
    return (2 * TOGGLE_OUTER_PAD +
        2 * TOGGLE_PAD +
        TOGGLE_ICON_PX +
        TOGGLE_GAP +
        measure(t("toggle.label", { count }), TOGGLE_TEXT));
}
// ---- the pill
/** The agent the pill offers to sleep: the focused terminal's, when it is live and an agent. */
export function pillAgent(terminal, detect) {
    return terminal === null || terminal.state !== "live" ? null : detect(terminal);
}
/**
 * The share of the column a quote line may fill. The width table runs ~0.9 % narrow
 * (its own check against Herdr's drawing), so a line filled to the edge could be cut
 * by "…" on a real font: 3 % keeps it clear of that and of a slightly wider UI font.
 */
const QUOTE_FILL = 0.97;
/** A prompt's or a reply's lines in the quote's column, at the size the popup draws them. */
function quoteLines(text) {
    return text === null
        ? []
        : wrapLines(text, QUOTE_TEXT_PX * QUOTE_FILL, QUOTE_MAX_LINES, (s) => textWidth(s, QUOTE_TEXT));
}
/** The name's lines in the popup's text column. */
function titleLayout(title) {
    if (title === null) {
        return { titleLines: [], titleCut: false };
    }
    const titleLines = wrapLines(title, POPUP_TEXT_PX, TITLE_MAX_LINES, TITLE_MEASURE);
    return { titleLines, titleCut: titleLines.join(" ") !== title.replace(/\s+/g, " ").trim() };
}
const ELLIPSIS = "…";
/**
 * `text` in lines no wider than `width` (by `measure`), broken at spaces, or
 * inside a word longer than a line. Past `max` lines the last one ends with an
 * ellipsis.
 *
 * Costs what is drawn, not the length of the text: Herdr interrupts a script
 * that runs too long, and a reply or a word may be long. Lines are made one at
 * a time and the work stops at the first line past `max`; no text longer than
 * about a line goes to `measure`. That takes a `measure` that never shrinks as
 * a text grows (every width table does), so the first prefix too wide ends the
 * search for the widest one that fits.
 */
export function wrapLines(text, width, max, measure) {
    const fits = (s) => fitsWithin(s, width, measure);
    const made = linesOf(text, fits);
    const lines = [];
    for (let next = made.next(); !next.done; next = made.next()) {
        lines.push(next.value);
        if (lines.length > max) {
            break;
        }
    }
    if (lines.length <= max) {
        return lines;
    }
    // The rest of the text from the last line on, as it would read joined: as much of it as fits with "…".
    const pieces = function* () {
        yield lines[max - 1] ?? "";
        yield lines[max] ?? "";
        for (let next = made.next(); !next.done; next = made.next()) {
            yield next.value;
        }
    };
    let last = "";
    let first = true;
    done: for (const piece of pieces()) {
        for (const ch of first ? piece : ` ${piece}`) {
            if (!fits(last + ch + ELLIPSIS)) {
                break done;
            }
            last += ch;
        }
        first = false;
    }
    const kept = lines.slice(0, max);
    kept[max - 1] = last.trimEnd() + ELLIPSIS;
    return kept;
}
/** The lines of `text`, one at a time, so a caller that has enough stops the work. */
function* linesOf(text, fits) {
    let line = "";
    for (const [word] of text.matchAll(/\S+/g)) {
        if (fits(line === "" ? word : `${line} ${word}`)) {
            line = line === "" ? word : `${line} ${word}`;
            continue;
        }
        if (line !== "") {
            yield line;
            line = "";
        }
        if (fits(word)) {
            line = word;
            continue;
        }
        // A word wider than a line: as much of it as fits (one character at least), the rest on the next lines.
        for (const ch of word) {
            if (line !== "" && !fits(line + ch)) {
                yield line;
                line = "";
            }
            line += ch;
        }
    }
    if (line !== "") {
        yield line;
    }
}
/** The first characters of `s` checked first, twice as many each time, so a long text costs about the room. */
const FIRST_LOOK = 32;
/** Whether `s` fits `width`, measuring no more of it than about the first prefix too wide. */
function fitsWithin(s, width, measure) {
    for (let n = FIRST_LOOK; n < s.length; n *= 2) {
        // Not between the two halves of a surrogate pair.
        const end = isHighSurrogate(s.charCodeAt(n - 1)) ? n + 1 : n;
        if (measure(s.slice(0, end)) > width) {
            return false;
        }
    }
    return measure(s) <= width;
}
const isHighSurrogate = (code) => code >= 0xd800 && code <= 0xdbff;
