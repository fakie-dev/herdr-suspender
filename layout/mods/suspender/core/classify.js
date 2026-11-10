// What a terminal is to the mod, from the labels the mod put on it. Labels
// survive the loss of a terminal (a Herdr or PC restart), its command does
// not, so they are how a shell that came back in place of an agent is told
// apart from a shell someone opened.
//
// The verdict never starts anything: at worst it shows a strip with "Resume".
// Anything half-labelled or unknown counts as not ours.
import { isAgentId, sessionKey } from "./model.js";
export const LABEL_AGENT = "suspender.agent";
export const LABEL_SESSION = "suspender.session";
/** `running` while the agent runs; `exited` once the person left it. */
export const LABEL_STATE = "suspender.state";
/**
 * @param agentPresent whether the terminal runs this agent now (the adapter's
 *   `matches`). Pass false when unsure: that shows a strip, it starts nothing.
 */
export function classifyTerminal(t, agentPresent) {
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
export function sessionLabels(agent, sessionId, state) {
    return { [LABEL_AGENT]: agent, [LABEL_SESSION]: sessionId, [LABEL_STATE]: state };
}
