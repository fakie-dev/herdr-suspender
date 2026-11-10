// What a terminal is to the mod, from the labels the mod put on it. Labels
// survive the loss of a terminal (a Herdr or PC restart), its command does
// not, so they are how a shell that came back in place of an agent is told
// apart from a shell someone opened.
//
// The verdict never starts anything: at worst it shows a strip with "Resume".
// Anything half-labelled or unknown counts as not ours.

import { type AgentId, isAgentId, type SessionKey, sessionKey } from "./model.ts";

export const LABEL_AGENT = "suspender.agent";
export const LABEL_SESSION = "suspender.session";
/** `running` while the agent runs; `exited` once the person left it. */
export const LABEL_STATE = "suspender.state";

export type LabelState = "running" | "exited";

export type Classification =
  | { kind: "foreign" }
  /** Ours and the agent is there. */
  | { kind: "running"; agent: AgentId; sessionId: string; key: SessionKey }
  /** Ours, marked running, but no agent process: a restart took it. */
  | { kind: "interrupted"; agent: AgentId; sessionId: string; key: SessionKey }
  /** The person left the agent; leave the terminal alone. */
  | { kind: "exited"; agent: AgentId; sessionId: string; key: SessionKey };

/**
 * @param agentPresent whether the terminal runs this agent now (the adapter's
 *   `matches`). Pass false when unsure: that shows a strip, it starts nothing.
 */
export function classifyTerminal(t: { labels: Record<string, string> }, agentPresent: boolean): Classification {
  const agent = t.labels[LABEL_AGENT];
  const sessionId = t.labels[LABEL_SESSION];
  const state = t.labels[LABEL_STATE];
  if (agent === undefined || !isAgentId(agent) || sessionId === undefined || sessionId === "") {
    return { kind: "foreign" };
  }
  const ours = { agent, sessionId, key: sessionKey(agent, sessionId) };
  switch (state) {
    case "running":
      return { kind: agentPresent ? "running" : "interrupted", ...ours };
    case "exited":
      return { kind: "exited", ...ours };
    default:
      return { kind: "foreign" };
  }
}

/** The labels to put on a terminal running `agent` with `sessionId`. */
export function sessionLabels(agent: AgentId, sessionId: string, state: LabelState): Record<string, string> {
  return { [LABEL_AGENT]: agent, [LABEL_SESSION]: sessionId, [LABEL_STATE]: state };
}
