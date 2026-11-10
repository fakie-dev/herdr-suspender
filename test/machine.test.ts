import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type Effect, EVENT_TYPES, type Event, TRANSITIONS, transition } from "../src/core/machine.ts";
import { SESSION_STATES, type SessionState } from "../src/core/model.ts";
import { hasMessage } from "../src/i18n/index.ts";

// The enumerations as interfaces.md defines them, written out here on purpose:
// the completeness check must not take its list from the code under test.
const SPEC_STATES = [
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
const SPEC_EVENTS = [
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

const RESUME_ARGV = ["claude", "--resume", "8d65845f-73cb-4be6-aa62-4ab2279d0de0"];
const NEW_ARGV = ["claude"];

/** One example of every event, for walking the whole table. */
const SAMPLE_EVENTS: Event[] = [
  { t: "sleep" },
  { t: "sleepWhenDone" },
  { t: "interruptAndSleep" },
  { t: "cancel" },
  { t: "agentIdle" },
  { t: "agentWorking" },
  { t: "agentExited", byUser: true },
  { t: "agentExited", byUser: false },
  { t: "stopped", forced: false },
  { t: "stopped", forced: true },
  { t: "stopTimeout" },
  { t: "resume", argv: RESUME_ARGV },
  { t: "resumeAll", argv: RESUME_ARGV },
  { t: "started" },
  { t: "startFailed", reason: "not installed" },
  { t: "openElsewhere", where: "Windows Terminal" },
  { t: "closedElsewhere" },
  { t: "transcriptMissing" },
  { t: "lostOnRestart" },
  { t: "forget" },
  { t: "startNew", argv: NEW_ARGV },
];

/** Runs events in order; returns the final state and each step's effects. */
function walk(from: SessionState, events: Event[]): { state: SessionState; steps: Effect[][] } {
  let state = from;
  const steps: Effect[][] = [];
  for (const ev of events) {
    const out = transition(state, ev);
    state = out.state;
    steps.push(out.effects);
  }
  return { state, steps };
}

describe("transition table", () => {
  it("knows exactly the states and events of the interface", () => {
    assert.deepEqual([...SESSION_STATES], SPEC_STATES);
    assert.deepEqual([...EVENT_TYPES], SPEC_EVENTS);
  });

  it("handles every (state, event) pair explicitly", () => {
    const missing: string[] = [];
    for (const state of SPEC_STATES) {
      const row = (TRANSITIONS as Record<string, Record<string, unknown>>)[state];
      for (const event of SPEC_EVENTS) {
        if (row === undefined || !Object.hasOwn(row, event)) {
          missing.push(`${state} × ${event}`);
        }
      }
    }
    assert.deepEqual(missing, []);
  });

  it("leaves an unexpected pair unchanged and does nothing", () => {
    assert.deepEqual(transition("asleep", { t: "agentWorking" }), { state: "asleep", effects: [] });
    assert.deepEqual(transition("running", { t: "resume", argv: RESUME_ARGV }), { state: "running", effects: [] });
    assert.deepEqual(transition("stopping", { t: "cancel" }), { state: "stopping", effects: [] });
  });

  it("only ever moves to a known state, and notifies only with texts that exist", () => {
    for (const state of SESSION_STATES) {
      for (const ev of SAMPLE_EVENTS) {
        const out = transition(state, ev);
        assert.ok(SESSION_STATES.includes(out.state), `${state} × ${ev.t} -> ${out.state}`);
        for (const effect of out.effects) {
          if (effect.e === "notify") {
            assert.ok(hasMessage(effect.key), `${state} × ${ev.t}: no text for ${effect.key}`);
          }
        }
      }
    }
  });

  it("hands out fresh effect lists, so a caller's change cannot leak into the table", () => {
    const first = transition("running", { t: "sleep" });
    first.effects.push({ e: "kill" });
    assert.deepEqual(transition("running", { t: "sleep" }).effects, [{ e: "snapshot" }, { e: "sendStop" }]);
  });
});

describe("going to sleep", () => {
  it("an idle agent: snapshot and stop, then the sleep pane", () => {
    const { state, steps } = walk("running", [{ t: "sleep" }, { t: "stopped", forced: false }]);
    assert.equal(state, "asleep");
    assert.deepEqual(steps, [[{ e: "snapshot" }, { e: "sendStop" }], [{ e: "placeSleepPane" }]]);
  });

  it("an idle agent that exits on its own while stopping is asleep too", () => {
    const { state, steps } = walk("running", [{ t: "sleep" }, { t: "agentExited", byUser: false }]);
    assert.equal(state, "asleep");
    assert.deepEqual(steps[1], [{ e: "placeSleepPane" }]);
  });

  it("a working agent is asked first, and nothing is stopped yet", () => {
    assert.deepEqual(transition("working", { t: "sleep" }), { state: "confirming", effects: [] });
  });

  it("sleep when done: the question closes, the agent keeps working until the engine stops it", () => {
    // The choice itself is the engine's to remember: once it sees the agent
    // idle it dispatches interruptAndSleep, which stops at once.
    const { state, steps } = walk("working", [
      { t: "sleep" },
      { t: "sleepWhenDone" },
      { t: "agentWorking" },
      { t: "agentIdle" },
      { t: "interruptAndSleep" },
    ]);
    assert.equal(state, "stopping");
    assert.deepEqual(steps, [[], [], [], [], [{ e: "snapshot" }, { e: "sendStop" }]]);
  });

  it("an agent that goes idle while the question is open is not put to sleep", () => {
    assert.deepEqual(transition("confirming", { t: "agentIdle" }), { state: "confirming", effects: [] });
  });

  it("cancel is not lost when the agent goes idle afterwards", () => {
    const { state, steps } = walk("working", [{ t: "sleep" }, { t: "cancel" }, { t: "agentIdle" }]);
    assert.equal(state, "running");
    assert.deepEqual(steps, [[], [], []]);
  });

  it("interrupt and sleep: stops at once", () => {
    const { state, steps } = walk("working", [{ t: "sleep" }, { t: "interruptAndSleep" }]);
    assert.equal(state, "stopping");
    assert.deepEqual(steps[1], [{ e: "snapshot" }, { e: "sendStop" }]);
  });

  it("cancel: back to working, nothing done", () => {
    const { state, steps } = walk("working", [{ t: "sleep" }, { t: "cancel" }]);
    assert.equal(state, "working");
    assert.deepEqual(steps[1], []);
  });

  it("an agent that does not exit in time is killed, and still ends asleep", () => {
    const { state, steps } = walk("stopping", [{ t: "stopTimeout" }, { t: "stopped", forced: true }]);
    assert.equal(state, "asleep");
    assert.deepEqual(steps, [[{ e: "kill" }], [{ e: "placeSleepPane" }]]);
  });

  it("an agent the person exited by hand is forgotten, not turned into a sleeping tab", () => {
    for (const from of ["running", "working", "confirming"] as const) {
      const out = transition(from, { t: "agentExited", byUser: true });
      assert.notEqual(out.state, "asleep", from);
      assert.deepEqual(out.effects, [{ e: "removeRecord" }], from);
    }
  });

  it("tracks the agent's own idle and working reports", () => {
    assert.equal(transition("running", { t: "agentWorking" }).state, "working");
    assert.equal(transition("working", { t: "agentIdle" }).state, "running");
  });
});

describe("waking up", () => {
  it("resume: checks, then starts the agent with the given command, then running", () => {
    const { state, steps } = walk("asleep", [{ t: "resume", argv: RESUME_ARGV }, { t: "started" }]);
    assert.equal(state, "running");
    assert.deepEqual(steps, [
      [{ e: "checkTranscript" }, { e: "checkElsewhere" }, { e: "startAgent", argv: RESUME_ARGV }],
      [],
    ]);
  });

  it("a session open elsewhere blocks resume until it is closed there", () => {
    const { state, steps } = walk("asleep", [
      { t: "resume", argv: RESUME_ARGV },
      { t: "openElsewhere", where: "Windows Terminal" },
      { t: "resume", argv: RESUME_ARGV },
      { t: "resumeAll", argv: RESUME_ARGV },
    ]);
    assert.equal(state, "elsewhere");
    assert.deepEqual(steps.slice(1), [[], [], []]);

    const reopened = walk("elsewhere", [{ t: "closedElsewhere" }, { t: "resume", argv: RESUME_ARGV }]);
    assert.equal(reopened.state, "waking");
    assert.deepEqual(reopened.steps[0], []);
    assert.deepEqual(reopened.steps[1]?.at(-1), { e: "startAgent", argv: RESUME_ARGV });
  });

  it("a sleeping session can be found open elsewhere before resume is pressed", () => {
    assert.equal(transition("asleep", { t: "openElsewhere", where: "x" }).state, "elsewhere");
    assert.equal(transition("interrupted", { t: "openElsewhere", where: "x" }).state, "elsewhere");
  });

  it("a conversation gone from disk: missing, then start new or forget", () => {
    const { state } = walk("asleep", [{ t: "resume", argv: RESUME_ARGV }, { t: "transcriptMissing" }]);
    assert.equal(state, "missing");
    assert.deepEqual(transition("missing", { t: "startNew", argv: NEW_ARGV }), {
      state: "waking",
      effects: [{ e: "startAgent", argv: NEW_ARGV }],
    });
    assert.deepEqual(transition("missing", { t: "forget" }).effects, [{ e: "removeRecord" }]);
    assert.deepEqual(transition("missing", { t: "resume", argv: RESUME_ARGV }).effects, []);
  });

  it("a start that fails shows the error, and resume retries it", () => {
    const failed = transition("waking", { t: "startFailed", reason: "not installed" });
    assert.equal(failed.state, "error");
    // The reason reaches the text: the notice is not "Couldn't start {agent}: {reason}".
    assert.deepEqual(failed.effects, [{ e: "notify", key: "error.startFailed", params: { reason: "not installed" } }]);
    assert.equal(transition("error", { t: "resume", argv: RESUME_ARGV }).state, "waking");
  });

  it("resume all wakes sleeping and interrupted sessions like resume does", () => {
    for (const from of ["asleep", "interrupted"] as const) {
      assert.deepEqual(transition(from, { t: "resumeAll", argv: RESUME_ARGV }), {
        state: "waking",
        effects: [{ e: "checkTranscript" }, { e: "checkElsewhere" }, { e: "startAgent", argv: RESUME_ARGV }],
      });
    }
  });
});

describe("restart and forgetting", () => {
  it("an agent lost to a restart is interrupted and waits for the button", () => {
    for (const from of ["running", "working", "confirming", "stopping"] as const) {
      assert.deepEqual(
        transition(from, { t: "lostOnRestart" }),
        {
          // A snapshot first: the strip of an interrupted tab has something to show.
          state: "interrupted",
          effects: [{ e: "snapshot" }, { e: "placeSleepPane" }],
        },
        from,
      );
    }
    const back = walk("interrupted", [{ t: "resume", argv: RESUME_ARGV }, { t: "started" }]);
    assert.equal(back.state, "running");
  });

  it("every way into interrupted takes a snapshot before placing the pane", () => {
    for (const state of SESSION_STATES) {
      for (const ev of SAMPLE_EVENTS) {
        const out = transition(state, ev);
        if (out.state === "interrupted" && state !== "interrupted") {
          assert.deepEqual(out.effects.slice(0, 2), [{ e: "snapshot" }, { e: "placeSleepPane" }], `${state} × ${ev.t}`);
        }
      }
    }
    assert.equal(transition("running", { t: "agentExited", byUser: false }).state, "interrupted");
  });

  it("nothing starts by itself after a restart", () => {
    for (const state of SESSION_STATES) {
      for (const ev of [{ t: "lostOnRestart" }, { t: "agentIdle" }, { t: "closedElsewhere" }] as Event[]) {
        const starts = transition(state, ev).effects.filter((e) => e.e === "startAgent");
        assert.deepEqual(starts, [], `${state} × ${ev.t}`);
      }
    }
  });

  it("forget removes the record of a session that is not running", () => {
    for (const from of ["asleep", "interrupted", "elsewhere", "missing", "error"] as const) {
      assert.deepEqual(transition(from, { t: "forget" }).effects, [{ e: "removeRecord" }], from);
    }
    assert.deepEqual(transition("running", { t: "forget" }).effects, []);
  });
});
