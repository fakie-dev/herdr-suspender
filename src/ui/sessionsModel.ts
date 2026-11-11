// What the Sessions panel, its popup, the "Sessions · N" button and the sleep
// pill say, as plain data: groups and their order, the memory figures, which
// items a row keeps at a width, the popup's facts, where it opens, when memory
// is measured. Pure, so it is tested without Herdr; `panel.ts`, `popup.ts`,
// `toggle.ts` and `pill.ts` only lay it out.

import { fitSegments, type Segment } from "../core/fit.ts";
import type { AgentId, SessionInfo, SessionKey, SessionRecord, SessionState } from "../core/model.ts";
import { homePath, midId, repoPath, type Sep, shortBranch, shortId } from "../core/paths.ts";
import { t } from "../i18n/index.ts";
import { clock, measureAt } from "./format.ts";

// ---- states and groups

/** States whose tab holds a sleep pane: what "Sessions · N" counts. */
const SLEEPING: ReadonlySet<SessionState> = new Set([
  "asleep",
  "interrupted",
  "waking",
  "elsewhere",
  "missing",
  "error",
]);

export const isSleeping = (state: SessionState): boolean => SLEEPING.has(state);

export const sleepingCount = (records: readonly SessionRecord[]): number =>
  records.filter((r) => isSleeping(r.state)).length;

/** Inside a space: running first, then asleep, then interrupted (and the ones that failed). */
const RANK: Readonly<Record<SessionState, 0 | 1 | 2>> = {
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

export interface SpaceInfo {
  id: string;
  name: string;
}

export interface Group {
  spaceId: string;
  name: string;
  rows: SessionRecord[];
  /** What "Resume all in project" wakes: asleep and interrupted, in row order. */
  resumable: SessionKey[];
}

function byRow(a: SessionRecord, b: SessionRecord): number {
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
export function groupSessions(records: readonly SessionRecord[], spaces: readonly SpaceInfo[]): Group[] {
  const bySpace = new Map<string, SessionRecord[]>();
  for (const rec of records) {
    bySpace.set(rec.spaceId, [...(bySpace.get(rec.spaceId) ?? []), rec]);
  }
  const make = (spaceId: string, name: string): Group | null => {
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
  return [...groups, ...gone].filter((g): g is Group => g !== null);
}

// ---- memory

/** 780 → "780 MB", 1100 → "1.1 GB". */
export function formatMb(mb: number): string {
  return mb >= 1000 ? `${(mb / 1000).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

/** The panel's header: what the sleeping sessions freed, or null when no figure is known. */
export function memoryFreedText(records: readonly SessionRecord[]): string | null {
  const total = records.reduce((sum, r) => sum + (isSleeping(r.state) ? (r.memFreedMb ?? 0) : 0), 0);
  return total > 0 ? t("panel.memoryFreed", { amount: formatMb(total) }) : null;
}

/** The figure at the right of a row: freed (a sleeper's) or used (a runner's, measured now). Nothing known: null. */
export function rowMemory(rec: SessionRecord, usedMb: number | null): { kind: "freed" | "used"; text: string } | null {
  if (isSleeping(rec.state)) {
    return rec.memFreedMb === null ? null : { kind: "freed", text: formatMb(rec.memFreedMb) };
  }
  return usedMb === null ? null : { kind: "used", text: formatMb(usedMb) };
}

/** Measures at most once per `everyMs`, and only while the panel is shown. */
export class MemoryPolicy {
  private readonly everyMs: number;
  private last = Number.NEGATIVE_INFINITY;

  constructor(everyMs: number) {
    this.everyMs = everyMs;
  }

  /** Whether to measure now; says yes at most once per interval, so closing and reopening does not reset it. */
  due(now: number, shown: boolean): boolean {
    if (!shown || now - this.last < this.everyMs) {
      return false;
    }
    this.last = now;
    return true;
  }
}

// ---- a row's second line

/** Room a row keeps for its margins, padding and the agent tile. */
export const ROW_CHROME_PX = 54;
/** The memory figure's icon and the gap before it. */
const MEM_ICON_PX = 15;
const MEM_GAP_PX = 8;
/** An item's 12 px icon and the gap after it. */
const ICON_PX = 16;
const BRANCH_MAX = 22;
const FOLDER_MAX = 24;

/** branch → model → folder → id (8 characters), as in the approved mockup; no data, no item. */
function rowSegments(info: SessionInfo, sep: Sep): Segment[] {
  const segs: Segment[] = [];
  if (info.branch) {
    segs.push({ key: "branch", text: shortBranch(info.branch, BRANCH_MAX), priority: 1 });
  }
  if (info.model) {
    segs.push({ key: "model", text: info.model, priority: 2 });
  }
  if (info.cwd) {
    segs.push({ key: "folder", text: repoPath(info.cwd, info.repoRoot, sep, FOLDER_MAX), priority: 3 });
  }
  if (info.sessionId) {
    segs.push({ key: "id", text: `#${shortId(info.sessionId)}`, priority: 4 });
  }
  return segs;
}

/** The items of a row's second line that fit a panel `panelWidth` px wide, and how many went (the `+N`). */
export function fitRow(
  rec: SessionRecord,
  panelWidth: number,
  memText: string | null,
  sep: Sep,
  measure: (text: string) => number,
): { segs: Segment[]; hidden: number } {
  const segs = rowSegments(rec.info, sep);
  const icons = new Map(segs.filter((s) => s.key === "branch" || s.key === "folder").map((s) => [s.text, ICON_PX]));
  const withIcons = (text: string): number => measure(text) + (icons.get(text) ?? 0);
  const memory = memText === null ? 0 : measure(memText) + MEM_ICON_PX + MEM_GAP_PX;
  const width = Math.max(0, panelWidth - ROW_CHROME_PX - memory);
  const fit = fitSegments(null, segs, width, withIcons);
  return { segs: segs.filter((s) => fit.shown.includes(s.key)), hidden: fit.hidden };
}

// ---- the popup

export type Tone = "live" | "sleep" | "warn" | "error";

export interface PopupRow {
  id: "branch" | "model" | "messages" | "memory" | "folder" | "session";
  label: string;
  value: string;
  /** What the copy button puts on the clipboard (the whole value), when there is one. */
  copy?: string;
}

export interface PopupFacts {
  agent: AgentId;
  agentName: string;
  /** The state word, with the time for a sleeper ("asleep · 14:20"). */
  state: string;
  tone: Tone;
  /** The whole name (the tooltip shows it when the lines cut it). */
  title: string | null;
  /** The name as the popup draws it: up to TITLE_MAX_LINES lines, an ellipsis only past the last. */
  titleLines: string[];
  titleCut: boolean;
  prompt: string | null;
  reply: string | null;
  context: { pct: number; label: string; detail: string | null } | null;
  tokens: string | null;
  rows: PopupRow[];
}

const BRANCH_POPUP_MAX = 34;
const FOLDER_POPUP_MAX = 38;

const TONE: Readonly<Record<SessionState, Tone>> = {
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
export const stateWord = (state: SessionState): string => t(`state.${state}`);

/** The state word of a session; a sleeper's and an interrupted one's carry the time they went. */
export function stateText(rec: SessionRecord, now: number): string {
  const word = stateWord(rec.state);
  const timed = (rec.state === "asleep" || rec.state === "interrupted") && rec.sleptAtMs !== null;
  return timed ? t("popup.stateAt", { state: word, time: clock(rec.sleptAtMs ?? 0, now) }) : word;
}

const present = (text: string | null): string | null => (text === null || text === "" ? null : text);

/** What the popup shows, in the order of the approved mockup (session-info.html v4). */
export function popupFacts(
  rec: SessionRecord,
  o: { agentName: string; home: string; sep: Sep; now: number; usedMb: number | null },
): PopupFacts {
  const info = rec.info;
  const rows: PopupRow[] = [];
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
    context: pct === null ? null : { pct, label: t("popup.context", { pct }), detail: present(info.contextText) },
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
const QUOTE_PX = 2 * QUOTE_LINE_PX;
const CONTEXT_PX = 28;
const TOKENS_PX = 16;
/** A fact row (Branch, Model, … Session): its height and the space between two rows. */
export const FACT_ROW_PX = 18;
export const FACT_GAP_PX = 3;
const FACTS_PAD_PX = 9;

/** The popup's height: the blocks it shows, the name at its lines, a quote at its widest (two lines). */
export function popupHeight(facts: PopupFacts): number {
  const blocks = [
    HEADER_PX,
    facts.titleLines.length * TITLE_LINE_PX,
    facts.prompt === null ? 0 : QUOTE_PX,
    facts.reply === null ? 0 : QUOTE_PX,
    facts.context === null ? 0 : CONTEXT_PX,
    facts.tokens === null ? 0 : TOKENS_PX,
    FACTS_PAD_PX + facts.rows.length * FACT_ROW_PX + Math.max(0, facts.rows.length - 1) * FACT_GAP_PX,
  ].filter((px) => px > 0);
  return POPUP_PAD * 2 + blocks.reduce((sum, px) => sum + px, 0) + (blocks.length - 1) * POPUP_GAP;
}

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

const EDGE_PX = 8;

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(value, max));

/**
 * Where the popup opens: left of a list row (so it never covers the panel), or
 * right of it when there is no room on the left (Sessions in a window); above a
 * strip, near its right end. Always inside the window.
 */
export function popupPosition(
  anchor: Rect,
  kind: "row" | "strip",
  size: { width: number; height: number },
  viewport: { width: number; height: number },
): { x: number; y: number } {
  const maxX = viewport.width - size.width - EDGE_PX;
  const maxY = viewport.height - size.height - EDGE_PX;
  if (kind === "strip") {
    return {
      x: clamp(anchor.left + anchor.width - size.width - 120, EDGE_PX, maxX),
      y: clamp(anchor.top - size.height - EDGE_PX, EDGE_PX, maxY),
    };
  }
  const left = anchor.left - EDGE_PX - size.width;
  return {
    x: left >= EDGE_PX ? left : clamp(anchor.left + anchor.width + EDGE_PX, EDGE_PX, maxX),
    y: clamp(anchor.top - 6, EDGE_PX, maxY),
  };
}

// ---- layout facts

/** Whether the layout's node `id` is on screen: it exists and is not hidden. */
export function panelShown(layout: unknown, id: string): boolean {
  const visit = (node: unknown): boolean | null => {
    if (typeof node !== "object" || node === null) {
      return null;
    }
    const n = node as { id?: unknown; hidden?: unknown; children?: unknown };
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

// ---- the pill

/** The agent the pill offers to sleep: the focused terminal's, when it is live and an agent. */
export function pillAgent<T extends { state: string }>(
  terminal: T | null,
  detect: (terminal: T) => AgentId | null,
): AgentId | null {
  return terminal === null || terminal.state !== "live" ? null : detect(terminal);
}

/** The name's lines in the popup's text column. */
function titleLayout(title: string | null): { titleLines: string[]; titleCut: boolean } {
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
 */
export function wrapLines(text: string, width: number, max: number, measure: (text: string) => number): string[] {
  const lines: string[] = [];
  let line = "";
  const words = text.split(/\s+/).filter((w) => w !== "");
  for (let i = 0; i < words.length; i++) {
    let word = words[i] ?? "";
    const tried = line === "" ? word : `${line} ${word}`;
    if (measure(tried) <= width) {
      line = tried;
      continue;
    }
    if (line !== "") {
      lines.push(line);
      line = "";
    }
    // A word wider than a line: as much of it as fits, the rest on the next lines.
    while (measure(word) > width) {
      const chars = [...word];
      let n = 1;
      while (n < chars.length && measure(chars.slice(0, n + 1).join("")) <= width) {
        n++;
      }
      lines.push(chars.slice(0, n).join(""));
      word = chars.slice(n).join("");
    }
    line = word;
  }
  if (line !== "") {
    lines.push(line);
  }
  if (lines.length <= max) {
    return lines;
  }
  const kept = lines.slice(0, max);
  let last = lines.slice(max - 1).join(" ");
  while (last !== "" && measure(last + ELLIPSIS) > width) {
    last = [...last].slice(0, -1).join("");
  }
  kept[max - 1] = last.trimEnd() + ELLIPSIS;
  return kept;
}
