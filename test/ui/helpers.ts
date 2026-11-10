// Synthetic session records for the Sessions panel and popup tests.

import type { SessionInfo, SessionRecord, SessionState } from "../../src/core/model.ts";

export const HOME = "C:\\Users\\tester";

export function info(over: Partial<SessionInfo> = {}): SessionInfo {
  return {
    title: null,
    firstPrompt: null,
    lastReply: null,
    messages: null,
    branch: null,
    model: null,
    cwd: `${HOME}\\dev\\api-gateway`,
    repoRoot: `${HOME}\\dev\\api-gateway`,
    sessionId: "8d65845f-73cb-4be6-aa62-4ab2279d0de0",
    contextPct: null,
    contextText: null,
    tokensText: null,
    transcriptMtimeMs: null,
    transcriptSize: null,
    ...over,
  };
}

export function rec(
  id: string,
  state: SessionState,
  over: Partial<Omit<SessionRecord, "info">> & { info?: Partial<SessionInfo> } = {},
): SessionRecord {
  const { info: infoOver, ...rest } = over;
  return {
    key: `claude:${id}`,
    agent: "claude",
    sessionId: id,
    cwd: `${HOME}\\dev\\api-gateway`,
    state,
    spaceId: "sp1",
    tabId: "tb1",
    terminal: null,
    pane: null,
    info: info({ sessionId: id, ...infoOver }),
    lastScreen: null,
    sleptAtMs: null,
    memFreedMb: null,
    forced: false,
    error: null,
    ...rest,
  };
}
