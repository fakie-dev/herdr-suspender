// The data the mod keeps about agent sessions. Pure types: nothing here
// imports Herdr, so the core runs (and is tested) in plain Node.

export type AgentId = "claude" | "codex";

/** Every agent the mod has an adapter for. */
export const AGENT_IDS: readonly AgentId[] = ["claude", "codex"];

export function isAgentId(value: string): value is AgentId {
  return (AGENT_IDS as readonly string[]).includes(value);
}

/** Agent id plus the agent's own session id, e.g. `claude:8d65845f-…`. */
export type SessionKey = `${AgentId}:${string}`;

export type SessionState =
  | "running"
  | "working"
  | "confirming"
  | "stopping"
  | "asleep"
  | "interrupted"
  | "waking"
  | "elsewhere"
  | "missing"
  | "error";

/** Every session state, in the order the panel lists them. */
export const SESSION_STATES: readonly SessionState[] = [
  "running",
  "working",
  "confirming",
  "stopping",
  "asleep",
  "interrupted",
  "waking",
  "elsewhere",
  "missing",
  "error",
];

/** A snapshot of a session for the strip, the list and the popup. `null` = the agent does not keep it. */
export interface SessionInfo {
  title: string | null;
  firstPrompt: string | null;
  lastReply: string | null;
  messages: number | null;
  branch: string | null;
  model: string | null;
  cwd: string;
  repoRoot: string | null;
  sessionId: string;
  contextPct: number | null;
  contextText: string | null;
  tokensText: string | null;
  transcriptMtimeMs: number | null;
  transcriptSize: number | null;
}

export interface SessionRecord {
  key: SessionKey;
  agent: AgentId;
  sessionId: string;
  cwd: string;
  state: SessionState;
  spaceId: string;
  tabId: string;
  /** The terminal's address while it exists. */
  terminal: string | null;
  /** Our sleep pane's id while the session is asleep. */
  pane: string | null;
  /** Snapshot taken when the session went to sleep. */
  info: SessionInfo;
  /** `hc read` of the terminal when the session went to sleep. */
  lastScreen: string | null;
  sleptAtMs: number | null;
  memFreedMb: number | null;
  /** The agent was stopped with `terminal.kill`. */
  forced: boolean;
  /** i18n key of the last error. */
  error: string | null;
  /**
   * The name the mod gave the session's space at sleep, so it does not turn into
   * its folder's ("~") while no terminal is left there (ADR 14). Absent in older stores.
   */
  spaceName?: SpacePin | null;
}

/** A space name the mod pinned with `space.rename`; it gives the name back to Herdr when the space wakes. */
export interface SpacePin {
  space: string;
  name: string;
}

export interface StoreFile {
  version: 1;
  sessions: Record<SessionKey, SessionRecord>;
}

export function sessionKey(agent: AgentId, sessionId: string): SessionKey {
  return `${agent}:${sessionId}`;
}
