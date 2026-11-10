// What the strip of a sleeping tab says, as plain data: the status line, the
// items of the info line, the buttons, the last screen. Pure, so it is tested
// without Herdr; `sleepPane.ts` only lays it out.

import type { Segment } from "../core/fit.ts";
import type { SessionInfo, SessionRecord } from "../core/model.ts";
import { repoPath, type Sep, shortBranch } from "../core/paths.ts";
import { hasMessage, type MessageKey, t } from "../i18n/index.ts";
import type { Freshness, WakeStep } from "../runtime/engine.ts";

/** Widths of the strip's items, as in the approved mockup (session-info.html v4). */
const BRANCH_MAX = 28;
const FOLDER_MAX = 34;
/** Between the parts of the status line. */
const JOIN = " · ";

const pad = (n: number): string => String(n).padStart(2, "0");

/** "14:05" today, "2026-11-08 09:30" on another day (local time). */
export function clock(ms: number, nowMs: number): string {
  const d = new Date(ms);
  const now = new Date(nowMs);
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const sameDay =
    d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  return sameDay ? time : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${time}`;
}

export interface StatusOptions {
  now: number;
  agentName: string;
  progress: WakeStep | null;
  fresh: Freshness | null;
}

/** The strip's second line: what state the session is in and anything worth knowing about it. */
export function stripStatus(rec: SessionRecord, o: StatusOptions): string {
  const time = rec.sleptAtMs === null ? "" : clock(rec.sleptAtMs, o.now);
  const parts: string[] = [];
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

export type StepState = "done" | "now" | "todo";

const STEPS: readonly { step: WakeStep; key: MessageKey }[] = [
  { step: "found", key: "strip.waking.found" },
  { step: "starting", key: "strip.waking.starting" },
  { step: "ready", key: "strip.waking.ready" },
];

/** found session → starting → ready, with the current one marked (none yet: the first). */
export function wakeSteps(current: WakeStep | null): { label: string; state: StepState }[] {
  const at = Math.max(
    0,
    STEPS.findIndex((s) => s.step === current),
  );
  return STEPS.map((s, i) => ({ label: t(s.key), state: i < at ? "done" : i === at ? "now" : "todo" }));
}

export type StripAction = "resume" | "retry" | "startNew" | "forget";

/** The strip's buttons for this state. `busy`: a copy is acting on the session, so nothing is pressable. */
export function stripActions(
  rec: SessionRecord,
  busy: boolean,
): { action: StripAction; label: string; enabled: boolean }[] {
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
export function stripSegments(info: SessionInfo, sep: Sep): Segment[] {
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
  return segs;
}

/** The last `max` lines of a screen, without the blank lines under the prompt. */
export function screenLines(text: string | null, max: number): string[] {
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
export function measureAt(size: number): (text: string) => number {
  return (text) => {
    let units = 0;
    for (const ch of text) {
      const code = ch.codePointAt(0) ?? 0;
      units += code > 0x2e80 ? 1.1 : /[A-Z]/.test(ch) ? 0.66 : 0.56;
    }
    return units * size;
  };
}
