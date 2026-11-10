// The adapter registry. A new agent is one file implementing `AgentAdapter`
// plus one line here (and its id in `core/model.ts` `AgentId`).
import { claudeAdapter } from "./claude.js";
import { codexAdapter } from "./codex.js";
export const ADAPTERS = {
    claude: claudeAdapter,
    codex: codexAdapter,
};
export function adapterFor(agent) {
    return ADAPTERS[agent];
}
/** The adapter for the agent running in `t`, or null if it runs none we know. */
export function detectAgent(t) {
    return Object.values(ADAPTERS).find((a) => a.matches(t)) ?? null;
}
