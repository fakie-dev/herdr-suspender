// After a restart (the PC, or Herdr's core), a session keeps what it was: one
// that was running wakes by itself, one that was asleep stays asleep. The
// person asked for it: «сессия спала? - после перезапуска спит. Сессия
// работала? - после перезапуска работает», «по очереди», and «пока идет
// запуск ... не должен иметь возможность что-то запустить сам или натыкать».
// So the woken sessions go one at a time, the one on screen first, and while
// a session waits for its turn nothing a person presses can start, forget or
// wake it.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentAdapter } from "../../src/adapters/contract.ts";
import type { AgentId, SessionKey } from "../../src/core/model.ts";
import { ABSENT_GRACE_MS, Engine, newCoordinator } from "../../src/runtime/engine.ts";
import { fakeAdapter, Sim, SPACE, TAB } from "./sim.ts";

const ON_SCREEN: SessionKey = "claude:on-screen";
const BEHIND: SessionKey = "claude:behind";
const ASLEEP: SessionKey = "claude:asleep";

/** Real time for the background wake to take its turns (the simulated clock moves by itself). */
const drain = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 15));

/**
 * Two agents: one in the first tab (TAB) and one in tb2, which is the tab on
 * screen. Tab order and the session ids would both take the first one first;
 * only the screen puts tb2's ahead. A third session sleeps in tb3.
 */
async function world(opts: { withAsleep?: boolean } = {}) {
  const sim = new Sim();
  const ports = sim.ports();
  const claude = fakeAdapter("claude");
  const adapters: Record<AgentId, AgentAdapter> = { claude, codex: fakeAdapter("codex") };
  const engine = new Engine({ host: sim, ports, id: "leader", adapters, coordinator: newCoordinator() });
  sim.addTab("tb2", SPACE);
  const behind = sim.addTerminal({ agent: "claude", tab: TAB });
  claude.state.sessions.set(behind.address, "behind");
  const onScreen = sim.addTerminal({ agent: "claude", tab: "tb2" });
  claude.state.sessions.set(onScreen.address, "on-screen");
  sim.select("tb2");
  if (opts.withAsleep) {
    sim.addTab("tb3", SPACE);
    const sleeper = sim.addTerminal({ agent: "claude", tab: "tb3" });
    claude.state.sessions.set(sleeper.address, "asleep");
  }
  await engine.tick();
  if (opts.withAsleep) {
    await engine.sleep(ASLEEP);
    assert.equal(engine.record(ASLEEP)?.state, "asleep");
  }
  assert.equal(engine.record(ON_SCREEN)?.state, "running");
  assert.equal(engine.record(BEHIND)?.state, "running");
  return { sim, ports, claude, adapters, engine, behind, onScreen };
}

/** The machine restarts: every agent's terminal comes back as a bare shell. */
function restart(w: Awaited<ReturnType<typeof world>>): void {
  w.sim.loseTerminal(w.behind.address);
  w.sim.loseTerminal(w.onScreen.address);
}

/** Rounds as the window runs them, with the time for each to finish what it started. */
async function rounds(w: { engine: Engine; sim: Sim }, n: number, stepMs = 1_000): Promise<void> {
  for (let i = 0; i < n; i++) {
    await w.engine.tick();
    await drain();
    await w.sim.advance(stepMs);
    await drain();
  }
}

/** The order the sessions were started in, and the other session's state at each start. */
function watchStarts(w: Awaited<ReturnType<typeof world>>): { key: SessionKey; others: string[] }[] {
  const starts: { key: SessionKey; others: string[] }[] = [];
  const hc = w.sim.hc.bind(w.sim);
  w.sim.hc = async (args: string[]) => {
    if (args[0] === "send") {
      const key = w.engine
        .records()
        .find((r) => r.state === "waking" && (r.terminal === args[1] || r.terminal === null))?.key;
      if (key !== undefined) {
        starts.push({
          key,
          others: w.engine
            .records()
            .filter((r) => r.key !== key)
            .map((r) => r.state),
        });
      }
    }
    return hc(args);
  };
  return starts;
}

describe("after a restart", () => {
  it("the sessions that were running wake by themselves, one at a time, the one on screen first", async () => {
    const w = await world();
    const starts = watchStarts(w);
    restart(w);
    await rounds(w, 20);

    assert.equal(w.engine.record(ON_SCREEN)?.state, "running");
    assert.equal(w.engine.record(BEHIND)?.state, "running");
    assert.deepEqual(
      starts.map((s) => s.key),
      [ON_SCREEN, BEHIND],
      "the tab on screen first",
    );
    // Each one starts only once the one before is up: never two waking at once.
    for (const s of starts) {
      assert.ok(!s.others.includes("waking"), `${s.key} started beside a waking session`);
    }
    assert.equal(w.engine.record(ON_SCREEN)?.restore, undefined, "the mark goes once it ran");
    assert.equal(w.engine.record(BEHIND)?.restore, undefined);
  });

  it("never starts the next one while one is still starting", async () => {
    const w = await world();
    restart(w);
    // The first agent never comes up: its start does not return.
    const hc = w.sim.hc.bind(w.sim);
    let sends = 0;
    w.sim.hc = async (args: string[]) => {
      if (args[0] === "send") {
        sends++;
        return new Promise(() => undefined);
      }
      return hc(args);
    };
    await rounds(w, 15);
    assert.equal(sends, 1);
    assert.equal(w.engine.record(BEHIND)?.state, "interrupted", "still in line");
  });

  it("waits until the restart is recognised: the tab on screen goes first though its shell is listed late", async () => {
    const w = await world();
    restart(w);
    // Herdr lists the restored terminals one by one: the one on screen comes a few seconds later.
    w.sim.term(w.onScreen.address).listed = false;
    // A new window after the restart: nothing is confirmed in this run yet.
    const next = new Engine({
      host: w.sim,
      ports: w.ports,
      id: "next",
      adapters: w.adapters,
      coordinator: newCoordinator(),
    });
    w.engine.release();
    const starts: SessionKey[] = [];
    const hc = w.sim.hc.bind(w.sim);
    w.sim.hc = async (args: string[]) => {
      if (args[0] === "send") {
        const key = next.records().find((r) => r.state === "waking")?.key;
        if (key !== undefined) {
          starts.push(key);
        }
      }
      return hc(args);
    };
    await rounds({ engine: next, sim: w.sim }, 5);
    assert.equal(next.record(BEHIND)?.restore, true, "marked, and waiting");
    assert.equal(starts.length, 0, "nothing starts before the one on screen is found");
    w.sim.term(w.onScreen.address).listed = true;
    await rounds({ engine: next, sim: w.sim }, 20);
    assert.deepEqual(starts, [ON_SCREEN, BEHIND]);
  });

  it("waits for a shell still in its grace (Herdr's core restarted under an open window)", async () => {
    const w = await world();
    const starts = watchStarts(w);
    w.sim.loseTerminal(w.behind.address);
    await w.engine.tick();
    await w.sim.advance(1_000);
    w.sim.loseTerminal(w.onScreen.address);
    await w.engine.tick();
    await w.sim.advance(ABSENT_GRACE_MS - 1_000);
    await w.engine.tick();
    await drain();
    assert.equal(w.engine.record(BEHIND)?.restore, true, "the first is marked");
    assert.equal(starts.length, 0, "and waits for the one still in its grace");
    await rounds(w, 20);
    assert.deepEqual(
      starts.map((s) => s.key),
      [ON_SCREEN, BEHIND],
    );
  });

  it("says so once, in a toast, when it starts", async () => {
    const w = await world();
    restart(w);
    await rounds(w, 20);
    const told = w.sim.notices.filter((x) => x.text.includes("before the restart"));
    assert.equal(told.length, 1, JSON.stringify(w.sim.notices));
    assert.ok(told[0]?.text.includes("2"), told[0]?.text ?? "");
  });

  it("a session that was asleep stays asleep", async () => {
    const w = await world({ withAsleep: true });
    restart(w);
    await rounds(w, 20);
    assert.equal(w.engine.record(ASLEEP)?.state, "asleep");
    assert.equal(w.engine.record(ASLEEP)?.restore, undefined);
    assert.equal(w.engine.record(ON_SCREEN)?.state, "running");
  });

  it("a session interrupted before the restart (a crash) waits for its button, as before", async () => {
    const w = await world();
    // The agent behind dies on its own: interrupted, no restart.
    w.sim.killAgent(w.behind.address);
    await rounds(w, 4, 3_000);
    assert.equal(w.engine.record(BEHIND)?.state, "interrupted");
    assert.equal(w.engine.record(BEHIND)?.restore, undefined);
    await rounds(w, 10);
    assert.equal(w.engine.record(BEHIND)?.state, "interrupted", "nothing wakes it");
  });

  it("while a session waits its turn, nothing a person presses starts, forgets or wakes it", async () => {
    const w = await world();
    restart(w);
    // Interrupted and marked, the queue not started yet (it waits for the restart to settle).
    await w.engine.tick();
    await w.sim.advance(3_000);
    await w.engine.tick();
    assert.equal(w.engine.record(BEHIND)?.state, "interrupted");
    assert.equal(w.engine.record(BEHIND)?.restore, true);
    const sent = w.sim.hcCalls.filter((c) => c[0] === "send").length;

    assert.equal(w.engine.restoreWaiting(BEHIND), true);
    await w.engine.resume(BEHIND);
    await w.engine.forget(BEHIND);
    await w.engine.startNew(BEHIND);
    await w.engine.resumeAll(SPACE);
    const pane = w.engine.record(BEHIND)?.pane ?? null;
    w.sim.focus = { pane, terminal: null };
    await w.engine.toggleFocused();

    assert.equal(w.engine.record(BEHIND)?.state, "interrupted");
    assert.equal(w.engine.record(BEHIND)?.restore, true);
    assert.equal(w.sim.hcCalls.filter((c) => c[0] === "send").length, sent, "nothing was started");
    // Then it wakes in its turn.
    await rounds(w, 20);
    assert.equal(w.engine.record(BEHIND)?.state, "running");
  });

  it("a session that fails to start keeps its error, and the next one still goes", async () => {
    const w = await world();
    restart(w);
    w.sim.sendFails = true;
    await rounds(w, 30);
    assert.equal(w.engine.record(ON_SCREEN)?.state, "error");
    assert.equal(w.engine.record(BEHIND)?.state, "error");
    assert.equal(w.engine.record(ON_SCREEN)?.restore, undefined, "out of the queue: Retry is the person's again");
    assert.equal(w.engine.record(BEHIND)?.restore, undefined);
    assert.equal(w.engine.restoreWaiting(BEHIND), false);
  });

  it("carries on after Herdr itself restarts mid-way: the marks are in the store", async () => {
    const w = await world();
    restart(w);
    await w.engine.tick();
    await w.sim.advance(3_000);
    await w.engine.tick();
    assert.equal(w.engine.record(BEHIND)?.restore, true);
    // Another window loads the same store, with a coordinator of its own.
    const next = new Engine({
      host: w.sim,
      ports: w.ports,
      id: "next",
      adapters: w.adapters,
      coordinator: newCoordinator(),
    });
    w.engine.release();
    await rounds({ engine: next, sim: w.sim }, 20);
    assert.equal(next.record(ON_SCREEN)?.state, "running");
    assert.equal(next.record(BEHIND)?.state, "running");
  });

  it("tells the panel where each waiting session is in the line", async () => {
    const w = await world();
    restart(w);
    await w.engine.tick();
    await w.sim.advance(3_000);
    await w.engine.tick();
    assert.deepEqual(w.engine.restoreLine(), [ON_SCREEN, BEHIND]);
  });

  it("counts the line from its first session, so a place stays put while the line moves on", async () => {
    const w = await world();
    restart(w);
    // The first start is held until the test lets it go.
    const hc = w.sim.hc.bind(w.sim);
    let release: () => void = () => undefined;
    let held = false;
    w.sim.hc = async (args: string[]) => {
      if (args[0] === "send" && !held) {
        held = true;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return hc(args);
    };
    await rounds(w, 6);
    assert.equal(held, true);
    assert.deepEqual(w.engine.restoreProgress(), { total: 2, left: 2 });
    assert.deepEqual(w.engine.restorePlace(ON_SCREEN), { place: 1, count: 2 });
    assert.deepEqual(w.engine.restorePlace(BEHIND), { place: 2, count: 2 });
    release();
    // The first is up; the second is now the one waking, still the 2nd of 2.
    for (let i = 0; i < 20 && w.engine.record(ON_SCREEN)?.state !== "running"; i++) {
      await drain();
      await w.sim.advance(500);
    }
    assert.equal(w.engine.record(ON_SCREEN)?.state, "running");
    assert.equal(w.engine.restorePlace(ON_SCREEN), null);
    assert.deepEqual(w.engine.restoreProgress(), { total: 2, left: 1 });
    assert.deepEqual(w.engine.restorePlace(BEHIND), { place: 2, count: 2 });
    await rounds(w, 20);
    assert.equal(w.engine.restoreProgress(), null, "the line is through");
  });

  it("a later restart is a line of its own: told again, counted from its own first", async () => {
    const w = await world();
    restart(w);
    await rounds(w, 20);
    // Both run again in new terminals; the core restarts once more.
    const terms = [w.engine.record(ON_SCREEN)?.terminal ?? "", w.engine.record(BEHIND)?.terminal ?? ""];
    for (const address of terms) {
      w.sim.loseTerminal(address);
    }
    await w.engine.tick();
    await w.sim.advance(ABSENT_GRACE_MS);
    await w.engine.tick();
    await rounds(w, 20);
    const told = w.sim.notices.filter((x) => x.text.includes("before the restart"));
    assert.equal(told.length, 2, "told for each restart");
    assert.equal(w.engine.record(BEHIND)?.state, "running");
  });
});
