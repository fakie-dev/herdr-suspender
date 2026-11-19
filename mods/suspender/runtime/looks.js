// Herdr's program table for every copy of the mod in this window (core/agentLook.ts):
// asked once with knownAgents(), which runs a check process, and live panes'
// programs until it answers. The views draw agents' icons from it, and the engine
// publishes them for the tab bar (ADR 19). Never loaded by the tests.
import { knownAgents, panes } from "herdr";
import { AgentLooks } from "../core/agentLook.js";
export const agentLooks = new AgentLooks({
    known: () => knownAgents(),
    live: () => panes().map((p) => p.program),
});
