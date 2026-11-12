// Waking or sleeping a session in a tab the person is not on leaves the screen
// as it is: the tab and the space shown, the focus, and with them the side
// panel (Herdr's tab bar keeps the panel per space, so going to another space
// closed it). Measured on Herdr 0.1.15 in an isolated core: `pane.focus` of a
// pane in another tab shows that tab and its space, and so does `tab.new`;
// `pane.split`, `pane.swap`, `pane.close`, `terminal.park`, `terminal.kill`
// and adoption by labels in a tab that is not shown change nothing on screen.
// The simulated Herdr plays those rules (sim.ts, `select`).

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentAdapter } from "../../src/adapters/contract.ts";
import type { AgentId, SessionKey } from "../../src/core/model.ts";
import { Engine, newCoordinator } from "../../src/runtime/engine.ts";
import { fakeAdapter, Sim, SPACE, TAB } from "./sim.ts";

const KEY: SessionKey = "claude:s1";

/**
 * The person works in a shell in TAB (shown, focused). The agent of session s1
 * is in tab tb2: of another space, or another tab of the same space.
 */
function world(where: "another space" | "the same space") {
  const sim = new Sim();
  const ports = sim.ports();
  const claude = fakeAdapter("claude");
  const codex = fakeAdapter("codex");
  const adapters: Record<AgentId, AgentAdapter> = { claude, codex };
  const engine = new Engine({ host: sim, ports, id: "leader", adapters, coordinator: newCoordinator() });
  const space = where === "another space" ? "sp2" : SPACE;
  sim.addTab("tb2", space);
  if (space !== SPACE) {
    // The tab its own space shows.
    const tb2 = sim.tabList.find((t) => t.id === "tb2");
    if (tb2) {
      tb2.active = true;
    }
  }
  const shell = sim.addTerminal({ agent: null });
  const agent = sim.addTerminal({ agent: "claude", tab: "tb2", space });
  claude.state.sessions.set(agent.address, "s1");
  sim.focus = { pane: shell.pane, terminal: shell.address };
  return { sim, ports, engine, claude, agent, shell, space };
}

/** The screen as the person sees it: the tab shown, its space, the focus, and the tab each space shows. */
function screen(sim: Sim) {
  return {
    tab: sim.shownTab(),
    focus: sim.focus,
    perSpace: sim.tabList.filter((t) => t.active).map((t) => `${t.space}:${t.id}`),
  };
}

for (const where of ["another space", "the same space"] as const) {
  describe(`a session in a tab of ${where}, while the person works elsewhere`, () => {
    it("Sleep leaves the screen as it was", async () => {
      const { sim, engine } = world(where);
      await engine.tick();
      const before = screen(sim);
      await engine.sleep(KEY);
      assert.equal(engine.record(KEY)?.state, "asleep");
      assert.deepEqual(sim.screenChanges, [], "the screen never went anywhere");
      assert.deepEqual(screen(sim), before);
    });

    it("Resume leaves the screen as it was: no tab, space or focus taken", async () => {
      const { sim, engine } = world(where);
      await engine.tick();
      await engine.sleep(KEY);
      const before = screen(sim);
      await engine.resume(KEY);
      assert.equal(engine.record(KEY)?.state, "running");
      const woken = engine.record(KEY)?.terminal ?? "";
      assert.equal(sim.paneList.find((p) => p.terminal === woken)?.tab, "tb2", "the agent is back in its tab");
      assert.deepEqual(sim.screenChanges, [], "the screen never went anywhere");
      assert.deepEqual(screen(sim), before);
    });
  });
}

describe("Resume all in a space that is not shown", () => {
  it("wakes every session there and leaves the screen as it was", async () => {
    const { sim, engine, claude } = world("another space");
    sim.addTab("tb3", "sp2");
    const second = sim.addTerminal({ agent: "claude", tab: "tb3", space: "sp2" });
    claude.state.sessions.set(second.address, "s2");
    await engine.tick();
    await engine.sleep(KEY);
    await engine.sleep("claude:s2");
    const before = screen(sim);
    const { woken } = await engine.resumeAll("sp2");
    assert.deepEqual([...woken].sort(), [KEY, "claude:s2"]);
    assert.deepEqual(sim.screenChanges, []);
    assert.deepEqual(screen(sim), before);
  });
});

describe("Resume of the tab on screen", () => {
  it("still puts the focus on the agent", async () => {
    const sim = new Sim();
    const ports = sim.ports();
    const claude = fakeAdapter("claude");
    const adapters: Record<AgentId, AgentAdapter> = { claude, codex: fakeAdapter("codex") };
    const engine = new Engine({ host: sim, ports, id: "leader", adapters, coordinator: newCoordinator() });
    const agent = sim.addTerminal({ agent: "claude" });
    claude.state.sessions.set(agent.address, "s1");
    await engine.tick();
    await engine.sleep(KEY);
    const sleepPane = engine.record(KEY)?.pane ?? null;
    sim.focus = { pane: sleepPane, terminal: null };
    await engine.resume(KEY);
    const woken = engine.record(KEY)?.terminal ?? "";
    const pane = sim.paneList.find((p) => p.terminal === woken)?.pane ?? null;
    assert.ok(pane);
    assert.deepEqual(sim.focus, { pane, terminal: woken });
    assert.equal(sim.shownTab(), TAB);
  });
});

describe("a sleep whose tab has no pane left for ours (a new tab in its space)", () => {
  it("gives the screen back: the tab, the focus and the tab its space showed", async () => {
    const { sim, engine, agent } = world("another space");
    // Herdr shows the agent nowhere: its tab has no pane to split.
    sim.paneList = sim.paneList.filter((p) => p.pane !== agent.pane);
    // Herdr lists a new tab and its pane after its next update, not when tab.new returns.
    sim.modPaneDelays = [16];
    await engine.tick();
    const before = screen(sim);
    await engine.sleep(KEY);
    assert.equal(engine.record(KEY)?.state, "asleep");
    const pane = engine.record(KEY)?.pane ?? "";
    const tab = sim.paneList.find((p) => p.pane === pane)?.tab ?? "";
    assert.ok(tab !== "" && tab !== "tb2", "our pane is in a new tab");
    assert.equal(sim.tabList.find((t) => t.id === tab)?.space, "sp2", "of the session's space");
    assert.deepEqual(screen(sim), before);
  });
});
