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

  // Review of F5, condition 2: a pane later than both waits of the flow.
  it("a sleeping pane Herdr shows after the flow stopped waiting becomes its session's", async () => {
    const { sim, ports, engine } = world();
    await engine.tick();
    sim.modPaneDelays = [7_000];
    await engine.sleep(KEY);
    assert.equal(stored(ports)[KEY]?.pane, null, "the flow gave up waiting");
    await ticks(sim, engine, GONE_GRACE_MS + 30_000);
    const rec = stored(ports)[KEY];
    assert.equal(rec?.state, "asleep", "the record is not dropped as gone");
    assert.deepEqual(sleepPanes(sim), [rec?.pane], "it owns the pane that came late");
    await engine.resume(KEY);
    await ticks(sim, engine, 5_000);
    assert.equal(engine.record(KEY)?.state, "running");
    assert.deepEqual(sleepPanes(sim), [], "and Resume replaces it as usual");
  });

  it("a session whose pane is still on the way is not dropped as gone (20 s, past the record's grace)", async () => {
    const { sim, ports, engine } = world();
    await engine.tick();
    sim.modPaneDelays = [20_000];
    await engine.sleep(KEY);
    await ticks(sim, engine, 40_000);
    const rec = stored(ports)[KEY];
    assert.equal(rec?.state, "asleep");
    assert.deepEqual(sleepPanes(sim), [rec?.pane]);
  });

  // A second layer, for a pane left over all the same: the leader closes a
  // sleeping pane its session no longer owns, in a tab a session lives in.
  it("a sleeping pane whose session was forgotten before it showed is closed, after a grace", async () => {
    const { sim, ports, engine, claude } = world();
    const other = sim.addTerminal({ agent: "claude" });
    claude.state.sessions.set(other.address, "s2");
    await engine.tick();
    sim.modPaneDelays = [7_000];
    await engine.sleep(KEY);
    await engine.forget(KEY);
    assert.equal(stored(ports)[KEY], undefined);
    await ticks(sim, engine, 10_000);
    const stray = sleepPanes(sim)[0] ?? "";
    assert.ok(sim.pane(stray), "it showed, and is not closed at once");
    await ticks(sim, engine, GONE_GRACE_MS + 5_000);
    assert.equal(sim.pane(stray), undefined, "closed");
    assert.ok(sim.pane(other.pane), "the other session's pane stays");
  });

  it("never closes a Suspender pane that is not a sleeping one (a Sessions list split in by hand)", async () => {
    const { sim, engine } = world();
    await engine.tick();
    // Herdr's panes() has no props: the mod cannot read this one's role, and must not guess it.
    const list = sim.addModPane(TAB, { role: "panel" });
    await ticks(sim, engine, GONE_GRACE_MS + 30_000);
    assert.ok(sim.pane(list));
  });

  // Recheck of F6, finding 1: while a late pane is waited for, a Suspender pane
  // someone splits in by hand must not be taken for it. A new tab (no pane of
  // the session's tab left to split beside) is a tab of its own: a pane in a tab
  // that was there before the split is not the one it asked for.
  it("a Sessions pane opened in another tab while a new tab's pane is late is not taken for it", async () => {
    const { sim, ports, engine, claude, agent } = world();
    sim.addTab("tb2");
    const other = sim.addTerminal({ agent: "claude", tab: "tb2" });
    claude.state.sessions.set(other.address, "s2");
    await engine.tick();
    // The agent's pane is gone (its terminal runs on): its tab has nothing to split beside.
    sim.removePane(agent.pane);
    sim.modPaneDelays = [20_000];
    await engine.sleep(KEY);
    assert.equal(stored(ports)[KEY]?.pane, null, "the flow gave up waiting");
    const list = sim.addModPane("tb2", { role: "window" });
    await ticks(sim, engine, GONE_GRACE_MS + 30_000);
    const rec = stored(ports)[KEY];
    const own = sim.paneList.find((p) => p.mod === "suspender" && p.props?.["role"] === "sleep")?.pane;
    assert.equal(rec?.state, "asleep");
    assert.notEqual(rec?.pane, list, "the Sessions pane is not the session's");
    assert.equal(rec?.pane, own, "its own pane, from the new tab, is");
    assert.ok(sim.pane(list), "and the Sessions pane is not swept");
    await engine.resume(KEY);
    assert.equal(engine.record(KEY)?.state, "running");
    assert.equal(sim.pane(own ?? ""), undefined, "Resume replaced its own pane");
    await ticks(sim, engine, GONE_GRACE_MS + 5_000);
    assert.ok(sim.pane(list), "and the Sessions pane is not closed");
  });

  it("leaves the session's own sleeping pane, and a stray alone in a tab (closing it would close the tab)", async () => {
    const { sim, ports, engine } = world();
    await engine.tick();
    sim.modPaneDelays = [7_000];
    await engine.sleep(KEY);
    await engine.forget(KEY);
    await ticks(sim, engine, GONE_GRACE_MS + 30_000);
    assert.equal(sleepPanes(sim).length, 1, "alone in its tab: left");
    const w = world();
    await w.engine.tick();
    await w.engine.sleep(KEY);
    await ticks(w.sim, w.engine, GONE_GRACE_MS + 30_000);
    const own = stored(w.ports)[KEY]?.pane ?? "";
    assert.ok(w.sim.pane(own), "the record's pane stays");
    void ports;
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

describe("review of F5: «Updated after sleep · +0 messages»", () => {
  it("a conversation written to elsewhere without a new message is not called updated", async () => {
    const { engine, claude } = world();
    await engine.tick();
    await engine.sleep(KEY);
    // Resumed and left elsewhere: the file grew (a resume record), the messages did not.
    claude.state.info.set("s1", { transcriptMtimeMs: 1_700_000_100_000, transcriptSize: 1_200, messages: 10 });
    await engine.refreshOnShow(KEY);
    assert.equal(engine.freshness(KEY), null);
  });

  it("one with new messages is, with how many", async () => {
    const { engine, claude } = world();
    await engine.tick();
    await engine.sleep(KEY);
    claude.state.info.set("s1", { transcriptMtimeMs: 1_700_000_100_000, transcriptSize: 1_200, messages: 12 });
    await engine.refreshOnShow(KEY);
    assert.equal(engine.freshness(KEY)?.added, 2);
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
