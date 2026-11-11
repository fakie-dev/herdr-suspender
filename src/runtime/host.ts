// Host: the part of Herdr's live API the engine uses (terminals, panes, tabs,
// commands, shared values), behind one interface so the engine runs in tests
// on a fake. `herdrHost.ts` is the implementation on "herdr"; this file
// imports nothing from Herdr.

import type { TerminalView } from "../adapters/contract.ts";
import type { SessionKey } from "../core/model.ts";

/** A core terminal, reduced to what the engine reads. */
export interface HostTerminal {
  address: string;
  /** "live", "finished", … */
  state: string;
  /** The terminal's own process (its shell, or the program it was started with). */
  pid: number | null;
  argv: string[];
  cwd: string;
  labels: Record<string, string>;
  /** Agent status word ("working", "blocked", "idle", "done"), or null. */
  status: string | null;
  /** What the agent reported as its app, else the program table's agent key, else null. */
  app: string | null;
  foreground: { pid: number; argv: string[]; name: string } | null;
  createdMs: number;
  /** The terminal that started it (sub-agents), or null. */
  parent: string | null;
  /** The title its program set (an agent sets its own; the shell's comes back when it ends), or null. */
  title: string | null;
}

export interface HostPane {
  pane: string;
  /** null for a mod pane. */
  terminal: string | null;
  /** The mod's name for a mod pane, else null. */
  mod: string | null;
  tab: string;
}

export interface HostTab {
  id: string;
  space: string;
  /** The tab its space shows. */
  active: boolean;
  /** Its space is the shown one. */
  spaceActive: boolean;
}

export type NoticeLevel = "info" | "warning" | "error";

export interface Host {
  terminals(): HostTerminal[];
  panes(): HostPane[];
  tabs(): HostTab[];
  /** This machine's layout document is loaded: panes() and tabs() are complete. */
  ready(): boolean;
  focused(): { pane: string | null; terminal: string | null } | null;
  /** An app command (`pane.split`, …). Never throws. */
  run(command: string, args: Record<string, unknown>): void;
  shared(key: string): unknown;
  setShared(key: string, value: unknown): void;
  sleep(ms: number): Promise<void>;
  notify(text: string, level: NoticeLevel): void;
  /** Shows the question for a working agent ("Sleep when done" / "Interrupt and sleep" / "Cancel"). */
  askConfirm(key: SessionKey): void;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown): string | null => (typeof value === "string" ? value : null);
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];

/**
 * A terminal from `terminals()` or `hc get --json`, whichever shape: `status`
 * is a word there and `{app, state}` here; the agent's report is `report` or
 * `status`. Null for anything without an address.
 */
export function normalizeTerminal(raw: unknown): HostTerminal | null {
  if (!isRecord(raw)) {
    return null;
  }
  const address = str(raw["address"]);
  if (address === null || address === "") {
    return null;
  }
  const statusRaw = raw["status"];
  const report = isRecord(raw["report"]) ? raw["report"] : isRecord(statusRaw) ? statusRaw : null;
  const status = typeof statusRaw === "string" ? statusRaw : report !== null ? str(report["state"]) : null;
  const program = isRecord(raw["program"]) ? raw["program"] : null;
  const programAgent = program !== null && program["agent"] === true ? str(program["key"]) : null;
  const labels: Record<string, string> = {};
  if (isRecord(raw["labels"])) {
    for (const [k, v] of Object.entries(raw["labels"])) {
      if (typeof v === "string") {
        labels[k] = v;
      }
    }
  }
  const fg = isRecord(raw["foreground"]) ? raw["foreground"] : null;
  const fgPid = fg === null ? null : num(fg["pid"]);
  return {
    address,
    state: str(raw["state"]) ?? "live",
    pid: num(raw["pid"]),
    argv: strings(raw["argv"]),
    // The live folder is the foreground process's; the record's own is where it started.
    cwd: (fg !== null ? str(fg["cwd"]) : null) ?? str(raw["cwd"]) ?? "",
    labels,
    status: status === "" ? null : status,
    app: (report !== null ? str(report["app"]) : null) ?? programAgent,
    foreground:
      fg !== null && fgPid !== null ? { pid: fgPid, argv: strings(fg["argv"]), name: str(fg["name"]) ?? "" } : null,
    createdMs: num(raw["created_ms"]) ?? 0,
    parent: str(raw["parent"]),
    title: str(raw["title"]),
  };
}

export function toTerminalView(t: HostTerminal): TerminalView {
  return {
    address: t.address,
    cwd: t.cwd,
    labels: { ...t.labels },
    status: t.status,
    app: t.app,
    foreground: t.foreground,
    createdMs: t.createdMs,
    state: t.state,
  };
}

/** A pane from `panes()`. */
export function normalizePane(raw: unknown): HostPane | null {
  if (!isRecord(raw)) {
    return null;
  }
  const pane = str(raw["pane"]);
  const tab = str(raw["tab"]);
  if (pane === null || tab === null) {
    return null;
  }
  return { pane, terminal: str(raw["terminal"]), mod: str(raw["mod"]), tab };
}
