// The adapter registry. A new agent is one file implementing `AgentAdapter`
// plus one line here (and its id in `core/model.ts` `AgentId`).

import type { AgentId } from "../core/model.ts";
import { claudeAdapter } from "./claude.ts";
import { codexAdapter } from "./codex.ts";
import type { AgentAdapter, TerminalView } from "./contract.ts";

export const ADAPTERS: Readonly<Record<AgentId, AgentAdapter>> = {
  claude: claudeAdapter,
  codex: codexAdapter,
};

export function adapterFor(agent: AgentId): AgentAdapter {
  return ADAPTERS[agent];
}

/** The adapter for the agent running in `t`, or null if it runs none we know. */
export function detectAgent(t: TerminalView): AgentAdapter | null {
  return Object.values(ADAPTERS).find((a) => a.matches(t)) ?? null;
}

export type { AgentAdapter, StopStep, TerminalView } from "./contract.ts";
