// The only place where a session changes state. `transition` is pure: it
// says what the new state is and which effects the engine must carry out, in
// order. If an effect finds a problem (a check fails), the engine dispatches
// the matching event and drops the rest of that list.
//
// The table names every (state, event) pair, so a new state or event does not
// compile until each of its pairs has an answer. IGNORE means: no change, no
// effects.

import type { SessionState } from "./model.ts";

export type Event =
  | { t: "sleep" }
  | { t: "sleepWhenDone" }
  | { t: "interruptAndSleep" }
  | { t: "cancel" }
  | { t: "agentIdle" }
  | { t: "agentWorking" }
  | { t: "agentExited"; byUser: boolean }
  | { t: "stopped"; forced: boolean }
  | { t: "stopTimeout" }
  /** `argv`: the adapter's resume command for this session. */
  | { t: "resume"; argv: string[] }
  | { t: "resumeAll"; argv: string[] }
  | { t: "started" }
  | { t: "startFailed"; reason: string }
  | { t: "openElsewhere"; where: string }
  | { t: "closedElsewhere" }
  | { t: "transcriptMissing" }
  | { t: "lostOnRestart" }
  | { t: "forget" }
  /** `argv`: the adapter's command for a new session in the same folder. */
  | { t: "startNew"; argv: string[] };

export type EventType = Event["t"];

export type Effect =
  | { e: "snapshot" }
  | { e: "sendStop" }
  | { e: "kill" }
  | { e: "placeSleepPane" }
  | { e: "checkElsewhere" }
  | { e: "checkTranscript" }
  | { e: "startAgent"; argv: string[] }
  | { e: "removeRecord" }
  | { e: "notify"; key: string };

export interface Step {
  state: SessionState;
  effects: Effect[];
}

/** Every event type, in the order of the interface. */
export const EVENT_TYPES: readonly EventType[] = [
  "sleep",
  "sleepWhenDone",
  "interruptAndSleep",
  "cancel",
  "agentIdle",
  "agentWorking",
  "agentExited",
  "stopped",
  "stopTimeout",
  "resume",
  "resumeAll",
  "started",
  "startFailed",
  "openElsewhere",
  "closedElsewhere",
  "transcriptMissing",
  "lostOnRestart",
  "forget",
  "startNew",
];

const IGNORE = "ignore";
type EventOf<K extends EventType> = Extract<Event, { t: K }>;
type Rule<K extends EventType> = typeof IGNORE | ((ev: EventOf<K>) => Step);
type Row = { readonly [K in EventType]: Rule<K> };

/** A rule that always goes to `state` with `effects` (copied on every use). */
const to =
  (state: SessionState, ...effects: Effect[]) =>
  (): Step => ({ state, effects: effects.map((effect) => ({ ...effect })) });

/** Snapshot first: the stop steps may change what the transcript says last. */
const goToSleep = to("stopping", { e: "snapshot" }, { e: "sendStop" });
const placePane = (state: SessionState) => to(state, { e: "placeSleepPane" });
const forget = (state: SessionState) => to(state, { e: "removeRecord" });
const wake = (ev: { argv: string[] }): Step => ({
  state: "waking",
  effects: [{ e: "checkTranscript" }, { e: "checkElsewhere" }, { e: "startAgent", argv: [...ev.argv] }],
});
/** The person left the agent (`/exit`): forget it rather than keep a sleeping tab. A crash keeps it, interrupted. */
const exitedOnItsOwn =
  (state: SessionState) =>
  (ev: { byUser: boolean }): Step =>
    ev.byUser ? forget(state)() : placePane("interrupted")();

export const TRANSITIONS: Readonly<Record<SessionState, Row>> = {
  running: {
    sleep: goToSleep,
    sleepWhenDone: IGNORE,
    interruptAndSleep: IGNORE,
    cancel: IGNORE,
    agentIdle: IGNORE,
    agentWorking: to("working"),
    agentExited: exitedOnItsOwn("running"),
    stopped: IGNORE,
    stopTimeout: IGNORE,
    resume: IGNORE,
    resumeAll: IGNORE,
    started: IGNORE,
    startFailed: IGNORE,
    openElsewhere: IGNORE,
    closedElsewhere: IGNORE,
    transcriptMissing: IGNORE,
    lostOnRestart: placePane("interrupted"),
    forget: IGNORE,
    startNew: IGNORE,
  },
  working: {
    sleep: to("confirming"),
    sleepWhenDone: IGNORE,
    interruptAndSleep: IGNORE,
    cancel: IGNORE,
    agentIdle: to("running"),
    agentWorking: IGNORE,
    agentExited: exitedOnItsOwn("working"),
    stopped: IGNORE,
    stopTimeout: IGNORE,
    resume: IGNORE,
    resumeAll: IGNORE,
    started: IGNORE,
    startFailed: IGNORE,
    openElsewhere: IGNORE,
    closedElsewhere: IGNORE,
    transcriptMissing: IGNORE,
    lostOnRestart: placePane("interrupted"),
    forget: IGNORE,
    startNew: IGNORE,
  },
  // The person pressed Sleep while the agent was answering. Choosing "sleep
  // when done" only closes the question: once the agent is idle, it sleeps.
  confirming: {
    sleep: IGNORE,
    sleepWhenDone: to("confirming"),
    interruptAndSleep: goToSleep,
    cancel: to("working"),
    agentIdle: goToSleep,
    agentWorking: IGNORE,
    agentExited: exitedOnItsOwn("confirming"),
    stopped: IGNORE,
    stopTimeout: IGNORE,
    resume: IGNORE,
    resumeAll: IGNORE,
    started: IGNORE,
    startFailed: IGNORE,
    openElsewhere: IGNORE,
    closedElsewhere: IGNORE,
    transcriptMissing: IGNORE,
    lostOnRestart: placePane("interrupted"),
    forget: IGNORE,
    startNew: IGNORE,
  },
  stopping: {
    sleep: IGNORE,
    sleepWhenDone: IGNORE,
    interruptAndSleep: IGNORE,
    cancel: IGNORE,
    agentIdle: IGNORE,
    agentWorking: IGNORE,
    agentExited: placePane("asleep"),
    stopped: placePane("asleep"),
    stopTimeout: to("stopping", { e: "kill" }),
    resume: IGNORE,
    resumeAll: IGNORE,
    started: IGNORE,
    startFailed: IGNORE,
    openElsewhere: IGNORE,
    closedElsewhere: IGNORE,
    transcriptMissing: IGNORE,
    lostOnRestart: placePane("interrupted"),
    forget: IGNORE,
    startNew: IGNORE,
  },
  asleep: {
    sleep: IGNORE,
    sleepWhenDone: IGNORE,
    interruptAndSleep: IGNORE,
    cancel: IGNORE,
    agentIdle: IGNORE,
    agentWorking: IGNORE,
    agentExited: IGNORE,
    stopped: IGNORE,
    stopTimeout: IGNORE,
    resume: wake,
    resumeAll: wake,
    started: IGNORE,
    startFailed: IGNORE,
    openElsewhere: to("elsewhere"),
    closedElsewhere: IGNORE,
    transcriptMissing: to("missing"),
    lostOnRestart: IGNORE,
    forget: forget("asleep"),
    startNew: IGNORE,
  },
  interrupted: {
    sleep: IGNORE,
    sleepWhenDone: IGNORE,
    interruptAndSleep: IGNORE,
    cancel: IGNORE,
    agentIdle: IGNORE,
    agentWorking: IGNORE,
    agentExited: IGNORE,
    stopped: IGNORE,
    stopTimeout: IGNORE,
    resume: wake,
    resumeAll: wake,
    started: IGNORE,
    startFailed: IGNORE,
    openElsewhere: to("elsewhere"),
    closedElsewhere: IGNORE,
    transcriptMissing: to("missing"),
    lostOnRestart: IGNORE,
    forget: forget("interrupted"),
    startNew: IGNORE,
  },
  waking: {
    sleep: IGNORE,
    sleepWhenDone: IGNORE,
    interruptAndSleep: IGNORE,
    cancel: IGNORE,
    agentIdle: IGNORE,
    agentWorking: IGNORE,
    agentExited: IGNORE,
    stopped: IGNORE,
    stopTimeout: IGNORE,
    resume: IGNORE,
    resumeAll: IGNORE,
    started: to("running"),
    startFailed: to("error", { e: "notify", key: "error.startFailed" }),
    openElsewhere: to("elsewhere"),
    closedElsewhere: IGNORE,
    transcriptMissing: to("missing"),
    lostOnRestart: placePane("interrupted"),
    forget: IGNORE,
    startNew: IGNORE,
  },
  // Resume stays blocked until the agent's own records say the other copy closed.
  elsewhere: {
    sleep: IGNORE,
    sleepWhenDone: IGNORE,
    interruptAndSleep: IGNORE,
    cancel: IGNORE,
    agentIdle: IGNORE,
    agentWorking: IGNORE,
    agentExited: IGNORE,
    stopped: IGNORE,
    stopTimeout: IGNORE,
    resume: IGNORE,
    resumeAll: IGNORE,
    started: IGNORE,
    startFailed: IGNORE,
    openElsewhere: IGNORE,
    closedElsewhere: to("asleep"),
    transcriptMissing: to("missing"),
    lostOnRestart: IGNORE,
    forget: forget("elsewhere"),
    startNew: IGNORE,
  },
  missing: {
    sleep: IGNORE,
    sleepWhenDone: IGNORE,
    interruptAndSleep: IGNORE,
    cancel: IGNORE,
    agentIdle: IGNORE,
    agentWorking: IGNORE,
    agentExited: IGNORE,
    stopped: IGNORE,
    stopTimeout: IGNORE,
    resume: IGNORE,
    resumeAll: IGNORE,
    started: IGNORE,
    startFailed: IGNORE,
    openElsewhere: IGNORE,
    closedElsewhere: IGNORE,
    transcriptMissing: IGNORE,
    lostOnRestart: IGNORE,
    forget: forget("missing"),
    startNew: (ev) => ({ state: "waking", effects: [{ e: "startAgent", argv: [...ev.argv] }] }),
  },
  // A failed start: "Retry" is resume again; nothing retries by itself.
  error: {
    sleep: IGNORE,
    sleepWhenDone: IGNORE,
    interruptAndSleep: IGNORE,
    cancel: IGNORE,
    agentIdle: IGNORE,
    agentWorking: IGNORE,
    agentExited: IGNORE,
    stopped: IGNORE,
    stopTimeout: IGNORE,
    resume: wake,
    resumeAll: wake,
    started: IGNORE,
    startFailed: IGNORE,
    openElsewhere: to("elsewhere"),
    closedElsewhere: IGNORE,
    transcriptMissing: to("missing"),
    lostOnRestart: IGNORE,
    forget: forget("error"),
    startNew: IGNORE,
  },
};

export function transition(s: SessionState, ev: Event): Step {
  const rule = TRANSITIONS[s]?.[ev.t] as Rule<typeof ev.t> | undefined;
  if (rule === undefined || rule === IGNORE) {
    return { state: s, effects: [] };
  }
  return (rule as (e: Event) => Step)(ev);
}
