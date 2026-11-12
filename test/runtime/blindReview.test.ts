// What the blind review of v0.1.0 found (ticket F5): each case as the
// simulated Herdr can play it, seen failing before its fix.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentAdapter } from "../../src/adapters/contract.ts";
import type { AgentId, SessionKey, SessionRecord } from "../../src/core/model.ts";
import { defaultStorePath, parseStore } from "../../src/core/store.ts";
import { Engine, GONE_GRACE_MS, newCoordinator } from "../../src/runtime/engine.ts";
import type { FakePorts } from "../fakePorts.ts";
import { fakeAdapter, Sim, TAB } from "./sim.ts";

const KEY: SessionKey = "claude:s1";

function stored(ports: FakePorts): Record<string, SessionRecord> {
  return parseStore(ports.files.get(defaultStorePath(ports)) ?? null).sessions;
}

function world() {
  const sim = new Sim();
  const ports = sim.ports();
  const claude = fakeAdapter("claude");
  const codex = fakeAdapter("codex");
  const adapters: Record<AgentId, AgentAdapter> = { claude, codex };
  const engine = new Engine({ host: sim, ports, id: "leader", adapters, coordinator: newCoordinator() });
  const agent = sim.addTerminal({ agent: "claude", status: "idle" });
  claude.state.sessions.set(agent.address, "s1");
  return { sim, ports, engine, claude, agent };
}

/** The sleeping panes of a session in a tab (only Suspender splits mod panes with its name). */
const sleepPanes = (sim: Sim, tab = TAB): string[] =>
  sim.paneList.filter((p) => p.tab === tab && p.mod === "suspender").map((p) => p.pane);

/** Ticks the leader every 5 s for `ms`. */
async function ticks(sim: Sim, engine: Engine, ms: number): Promise<void> {
  for (let t = 0; t < ms; t += 5_000) {
    await engine.tick();
    await sim.advance(5_000);
  }
  await engine.tick();
}

describe("finding 1: two sleeping panes in one tab", () => {
  // Cause: the sleeping pane is found by comparing panes() before and after the
  // split. When Herdr shows it later than the wait (a busy window), the stop goes
  // on without it, and placing the pane split a second time: the first pane came
  // in late beside the second, with the same session, and stayed after Resume.
  it("a sleeping pane Herdr shows late is waited for, not split again", async () => {
    const { sim, ports, engine } = world();
    await engine.tick();
    sim.modPaneDelays = [3_500];
    await engine.sleep(KEY);
    await sim.advance(5_000);

    const rec = stored(ports)[KEY];
    assert.equal(rec?.state, "asleep");
    assert.deepEqual(sleepPanes(sim), [rec?.pane], "one sleeping pane, the record's");
    assert.equal(sim.commands.filter((c) => c.command === "pane.split").length, 1, "one split");
  });

  it("ten sleeps and wakes in a row, each with a slow window, leave one pane in the tab", async () => {
    const { sim, ports, engine } = world();
    await engine.tick();
    for (let cycle = 0; cycle < 10; cycle++) {
      sim.modPaneDelays = [cycle % 2 === 0 ? 3_500 : 0];
      await engine.sleep(KEY);
      await sim.advance(5_000);
      assert.equal(sleepPanes(sim).length, 1, `cycle ${cycle}: asleep`);
      await engine.resume(KEY);
      await ticks(sim, engine, 5_000);
      assert.equal(stored(ports)[KEY]?.state, "running", `cycle ${cycle}: running`);
      assert.deepEqual(sleepPanes(sim), [], `cycle ${cycle}: no sleeping pane beside the agent`);
      assert.equal(sim.row().length, 1, `cycle ${cycle}: only the agent's pane`);
    }
  });

  // A second layer, for a pane left over by any cause: the leader closes a
  // Suspender pane no record owns, in a tab a session lives in, once nothing
  // is acting there.
  it("a sleeping pane no session owns is closed by the leader, after a grace", async () => {
    const { sim, engine } = world();
    await engine.tick();
    const stray = sim.addModPane(TAB, { role: "sleep", key: KEY });
    await engine.tick();
    assert.ok(sim.pane(stray), "not at once: a pane being placed is not owned yet");
    await ticks(sim, engine, GONE_GRACE_MS + 5_000);
    assert.equal(sim.pane(stray), undefined, "closed");
    assert.equal(sim.row().length, 1, "the agent's pane stays");
  });

  it("leaves the session's own sleeping pane, and Suspender panes in tabs without a session", async () => {
    const { sim, ports, engine } = world();
    await engine.tick();
    await engine.sleep(KEY);
    sim.addTab("tb-other");
    const elsewhere = sim.addModPane("tb-other", { role: "sleep", key: "claude:gone" });
    await ticks(sim, engine, GONE_GRACE_MS + 10_000);
    const own = stored(ports)[KEY]?.pane ?? "";
    assert.ok(sim.pane(own), "the record's pane stays");
    assert.ok(sim.pane(elsewhere), "a tab with no session is not touched");
  });
});

describe("finding 4: the bare shell seen while waking", () => {
  it("the new shell gets its place in the tab only once the agent runs in it", async () => {
    const { sim, engine } = world();
    await engine.tick();
    await engine.sleep(KEY);
    await engine.resume(KEY);
    const address = engine.record(KEY)?.terminal ?? "";
    assert.equal(engine.record(KEY)?.state, "running");
    assert.deepEqual(
      sim.typed.map((x) => x.shown),
      [false],
      "the command is typed into a shell nobody sees",
    );
    assert.deepEqual(
      sim.adopted.at(-1),
      { address, agent: true, reported: true },
      "shown with the agent already in it",
    );
  });

  // Live, cycle 6 of 10: the agent's process was there, but its screen was not
  // drawn yet when the shell got its pane: the shell's own screen showed for a moment.
  it("an agent slow to draw its screen is shown only once it reports", async () => {
    const { sim, engine } = world();
    await engine.tick();
    await engine.sleep(KEY);
    sim.reportAfterMs = 6_000;
    await engine.resume(KEY);
    assert.equal(engine.record(KEY)?.state, "running");
    assert.equal(sim.adopted.at(-1)?.reported, true, "its screen is up when it is shown");
  });

  it("an agent that reports nothing (at its own prompt) is still shown, after a while", async () => {
    const { sim, engine } = world();
    await engine.tick();
    await engine.sleep(KEY);
    sim.reportAfterMs = null;
    await engine.resume(KEY);
    assert.equal(engine.record(KEY)?.state, "running");
    assert.equal(sim.adopted.at(-1)?.agent, true);
  });

  it("a start that fails never shows its shell", async () => {
    const { sim, engine } = world();
    await engine.tick();
    await engine.sleep(KEY);
    sim.typedStartsNothing = true;
    const adoptedBefore = sim.adopted.length;
    await engine.resume(KEY);
    assert.equal(engine.record(KEY)?.state, "error");
    assert.equal(sim.adopted.length, adoptedBefore, "no shell in the tab");
    assert.equal(sleepPanes(sim).length, 1, "the sleeping pane stays, with the error");
  });
});

describe("finding 2: a session opened in another tab while asleep", () => {
  it("is shown as open elsewhere at the leader's next round, before anyone presses Resume", async () => {
    const { sim, engine, claude } = world();
    await engine.tick();
    await engine.sleep(KEY);
    assert.equal(engine.record(KEY)?.state, "asleep");
    sim.addTab("tb2");
    const other = sim.addTerminal({ agent: "claude", tab: "tb2" });
    claude.state.sessions.set(other.address, "s1");
    claude.state.elsewhere.set("s1", `pid ${sim.term(other.address).pid}`);
    await engine.tick();
    assert.equal(engine.record(KEY)?.state, "elsewhere");
  });

  it("an agent in another tab running another session leaves the sleeping one as it is", async () => {
    const { sim, engine, claude } = world();
    await engine.tick();
    await engine.sleep(KEY);
    sim.addTab("tb2");
    const other = sim.addTerminal({ agent: "claude", tab: "tb2" });
    claude.state.sessions.set(other.address, "s2");
    await ticks(sim, engine, 15_000);
    assert.equal(engine.record(KEY)?.state, "asleep");
  });

  it("checking it is free: open elsewhere when it is, asleep when it is not", async () => {
    const { engine, claude } = world();
    await engine.tick();
    await engine.sleep(KEY);
    await engine.recheckOpen(KEY);
    assert.equal(engine.record(KEY)?.state, "asleep", "nobody has it open");
    claude.state.elsewhere.set("s1", "pid 4242");
    await engine.recheckOpen(KEY);
    assert.equal(engine.record(KEY)?.state, "elsewhere");
  });
});

describe("finding 5: running sessions in the list", () => {
  it("get the same facts as sleeping ones once they are known", async () => {
    const { engine, claude } = world();
    await engine.tick();
    assert.equal(engine.record(KEY)?.info.title, null, "bound: nothing read yet");
    claude.state.info.set("s1", { title: "Synthetic title", branch: "feat/x", model: "opus" });
    await engine.refreshRunning();
    const info = engine.record(KEY)?.info;
    assert.equal(info?.title, "Synthetic title");
    assert.equal(info?.branch, "feat/x");
    assert.equal(info?.model, "opus");
  });

  it("are not read again while their conversation has not changed", async () => {
    const { ports, engine, claude } = world();
    await engine.tick();
    await engine.refreshRunning();
    const writes = ports.writes.length;
    const snapshots = claude.state.snapshots.length;
    await engine.refreshRunning();
    assert.equal(ports.writes.length, writes, "nothing new: no write");
    assert.equal(
      claude.state.snapshots.length,
      snapshots + 1,
      "one look per session (the adapter checks the file's change)",
    );
  });
});
