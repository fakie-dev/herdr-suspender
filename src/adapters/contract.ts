// What the mod needs from each agent CLI. One adapter per agent implements
// this; adding an agent is one file plus one line in `index.ts`.
// Adapters see the world only through `Ports`: no "herdr" import.

import type { AgentId, SessionInfo } from "../core/model.ts";
import type { Ports } from "../platform/ports.ts";

/** A terminal as Herdr describes it, reduced to what the adapters need. */
export interface TerminalView {
  address: string;
  cwd: string;
  labels: Record<string, string>;
  /** Agent status word, if the program reports one. */
  status: string | null;
  /** What the agent reported as its app (`claude-code`, `codex`), or null. */
  app: string | null;
  /** The terminal's foreground process (on Windows: its shell). */
  foreground: { pid: number; argv: string[]; name: string } | null;
  createdMs: number;
  state: string;
}

/** One step of a graceful stop, run in order by the engine. */
export type StopStep = { send: string } | { key: "escape" } | { waitIdleMs: number } | { waitExitMs: number };

export interface AgentAdapter {
  id: AgentId;
  /** "Claude Code" | "Codex" */
  displayName: string;
  /** Whether this terminal runs this agent (by status.app / program / foreground). */
  matches(t: TerminalView): boolean;
  /** The agent's own session id for the session running in `t`, found without hooks; null if not (yet) known. */
  discoverSession(t: TerminalView, p: Ports): Promise<string | null>;
  /**
   * What the strip, the list and the popup show. With `prev` (an earlier
   * snapshot of the same session) it reads nothing if the transcript did not
   * change, and only the new bytes if it grew.
   */
  snapshot(sessionId: string, cwd: string, p: Ports, prev?: SessionInfo): Promise<SessionInfo>;
  /** False once the conversation is gone from disk (expired or deleted). */
  transcriptExists(sessionId: string, cwd: string, p: Ports): Promise<boolean>;
  /** Whether a live process other than the one in `exceptTerminal` holds this session. */
  openElsewhere(sessionId: string, p: Ports, exceptTerminal?: string): Promise<{ open: boolean; where?: string }>;
  /** Resolves when something that `openElsewhere` looks at may have changed (Claude: its sessions folder). */
  watchOpenness?(p: Ports): Promise<void>;
  /** Claude: Esc, wait idle, "/exit"; Codex: "/quit". */
  stopSteps(): StopStep[];
  /** ["claude","--resume",id] | ["codex","resume",id] */
  resumeArgv(sessionId: string, cwd: string): string[];
  /** A fresh session in `cwd` ("Start new session"). */
  newArgv(cwd: string): string[];
  /** Whether the prompt holds text not sent yet (only if the adapter can tell). */
  unsentInput?(screen: string): boolean;
}
