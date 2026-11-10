// The data the mod keeps about agent sessions. Pure types: nothing here
// imports Herdr, so the core runs (and is tested) in plain Node.
/** Every agent the mod has an adapter for. */
export const AGENT_IDS = ["claude", "codex"];
export function isAgentId(value) {
    return AGENT_IDS.includes(value);
}
/** Every session state, in the order the panel lists them. */
export const SESSION_STATES = [
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
export function sessionKey(agent, sessionId) {
    return `${agent}:${sessionId}`;
}
