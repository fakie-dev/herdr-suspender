// A session that sleeps in one tab (or says "open elsewhere") and is found
// running in a live terminal of Herdr, by that terminal's own process tree:
// Claude's /resume of a conversation that sleeps in another tab, or the
// conversation opened again by hand in a new tab. The session runs there now:
// its record goes there as running and its old sleeping pane goes. Before, a
// rekey deleted the terminal's own record and made nothing (the tab was
// invisible to the mod), and an "elsewhere" record kept the live terminal
// unbound for good, with a process listing every ten seconds.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { emptyInfo } from "../../src/adapters/common.ts";
import type { AgentAdapter } from "../../src/adapters/contract.ts";
import type { AgentId, SessionKey, SessionRecord } from "../../src/core/model.ts";
import { defaultStorePath, parseStore, serializeStore } from "../../src/core/store.ts";
import { Engine, newCoordinator } from "../../src/runtime/engine.ts";
import { fakeAdapter, Sim, SPACE, TAB } from "./sim.ts";

function world() {
  const sim = new Sim();
  const ports = sim.ports();
  const claude = fakeAdapter("claude");
  const codex = fakeAdapter("codex");
  const adapters: Record<AgentId, AgentAdapter> = { claude, codex };
  const co = newCoordinator();
  const engine = new Engine({ host: sim, ports, id: "leader", adapters, coordinator: co });
  // A second space with its own tab: where the other session sleeps.
  sim.addTab("tb2", "sp2");
  return { sim, ports, claude, codex, engine, co };
}

const stored = (w: ReturnType<typeof world>): Record<string, SessionRecord> =>
  parseStore(w.ports.files.get(defaultStorePath(w.ports)) ?? null).sessions;

async function ticks(w: ReturnType<typeof world>, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await w.engine.tick();
    await w.sim.advance(5_000);
  }
}

describe("a sleeping session found running in a terminal of Herdr runs there", () => {
  it("Claude /resume in tab A of a conversation asleep in another space: A's record becomes that session", async () => {
    const w = world();
    const b = w.sim.addTerminal({ agent: "claude", tab: "tb2", space: "sp2", cwd: "C:\\work\\b" });
    w.claude.state.sessions.set(b.address, "s2");
    const a = w.sim.addTerminal({ agent: "claude", status: "working", cwd: "C:\\work\\b" });
    w.claude.state.sessions.set(a.address, "s1");
    await w.engine.tick();
    await w.engine.sleep("claude:s2");
    const sleepingPane = w.engine.record("claude:s2")?.pane ?? "";
    assert.ok(w.sim.pane(sleepingPane), "s2 sleeps in its pane in the other space");

    // In A the person runs /resume s2; the turn ends.
    w.claude.state.sessions.set(a.address, "s2");
    w.sim.setStatus(a.address, "idle");
    await w.engine.tick();

    const rec = w.engine.record("claude:s2");
    assert.equal(rec?.state, "running");
    assert.equal(rec?.terminal, a.address);
    assert.deepEqual([rec?.spaceId, rec?.tabId, rec?.pane], [SPACE, TAB, null], "where A is, not where s2 slept");
    assert.equal(w.engine.record("claude:s1"), null, "A's old id is let go");
    assert.equal(w.sim.term(a.address).labels["suspender.session"], "s2");
    assert.equal(w.sim.pane(sleepingPane), undefined, "the old sleeping pane is closed");
  });

  it("Codex: the same, at Sleep, and Sleep then puts the session to sleep in A", async () => {
    const w = world();
    const b = w.sim.addTerminal({ agent: "codex", tab: "tb2", space: "sp2" });
    w.codex.state.sessions.set(b.address, "c2");
    const a = w.sim.addTerminal({ agent: "codex" });
    w.codex.state.sessions.set(a.address, "c1");
    await w.engine.tick();
    await w.engine.sleep("codex:c2");
    w.codex.state.sessions.set(a.address, "c2"); // A's own process tree says it runs c2 now

    await w.engine.sleep("codex:c1");

    const rec = w.engine.record("codex:c2");
    assert.equal(rec?.state, "asleep", "Sleep in A put c2 to sleep, in A");
    assert.equal(rec?.tabId, TAB);
    assert.equal(w.engine.record("codex:c1"), null);
    assert.deepEqual(
      Object.values(stored(w)).map((r) => r.key),
      ["codex:c2"],
    );
  });

  it("an 'open elsewhere' record with a dead terminal gives way to the live terminal that runs it", async () => {
    const w = world();
    const pane = w.sim.addModPane("tb2", { role: "sleep", key: "claude:s1" });
    const twin = w.sim.addTerminal({ agent: "claude" });
    w.claude.state.sessions.set(twin.address, "s1");
    w.claude.state.elsewhere.set("s1", "pid 1");
    const rec: SessionRecord = {
      key: "claude:s1",
      agent: "claude",
      sessionId: "s1",
      cwd: "C:\\work\\repo",
      state: "elsewhere",
      spaceId: "sp2",
      tabId: "tb2",
      terminal: "t-dead",
      pane,
      info: emptyInfo("s1", "C:\\work\\repo"),
      lastScreen: null,
      sleptAtMs: null,
      memFreedMb: null,
      forced: false,
      error: null,
    };
    w.ports.files.set(defaultStorePath(w.ports), serializeStore({ version: 1, sessions: { "claude:s1": rec } }));

    await ticks(w, 3);

    const now = w.engine.record("claude:s1");
    assert.deepEqual([now?.state, now?.terminal, now?.pane], ["running", twin.address, null]);
    assert.deepEqual([now?.spaceId, now?.tabId], [SPACE, TAB]);
    assert.equal(w.sim.pane(pane), undefined, "the stale sleeping pane is closed");
    assert.equal(w.sim.term(twin.address).labels["suspender.session"], "s1");
    const asked = w.claude.state.discovers.length;
    await ticks(w, 4);
    assert.equal(w.claude.state.discovers.length, asked, "and nothing is looked up again");
  });

  it("a sleeping session that pinned its space's name gives the name back when it is found running elsewhere", async () => {
    const w = world();
    const b = w.sim.addTerminal({ agent: "claude", tab: "tb2", space: "sp2" });
    w.claude.state.sessions.set(b.address, "s2");
    await w.engine.tick();
    await w.engine.sleep("claude:s2");
    assert.equal(w.sim.spaces().find((s) => s.id === "sp2")?.named, true, "pinned at sleep");
    const twin = w.sim.addTerminal({ agent: "claude" });
    w.claude.state.sessions.set(twin.address, "s2");

    await ticks(w, 2);

    assert.equal(w.engine.record("claude:s2")?.terminal, twin.address);
    assert.ok(
      w.sim.commands.some((c) => c.command === "space.rename" && c.args["id"] === "sp2" && c.args["name"] === ""),
      "the pin is let go",
    );
  });

  it("a session a copy is acting on (a Resume under way) is not taken over", async () => {
    const w = world();
    const b = w.sim.addTerminal({ agent: "claude", tab: "tb2", space: "sp2" });
    w.claude.state.sessions.set(b.address, "s2");
    await w.engine.tick();
    await w.engine.sleep("claude:s2");
    w.co.busy.set("claude:s2", { owner: "another copy", at: w.sim.now });
    const twin = w.sim.addTerminal({ agent: "claude" });
    w.claude.state.sessions.set(twin.address, "s2");
    await w.engine.tick();
    assert.equal(w.engine.record("claude:s2")?.state, "asleep");
    assert.equal(w.engine.record("claude:s2")?.terminal, null);
  });

  it("a session that sleeps and is not run by any terminal of Herdr stays asleep", async () => {
    const w = world();
    const b = w.sim.addTerminal({ agent: "claude", tab: "tb2", space: "sp2" });
    w.claude.state.sessions.set(b.address, "s2");
    await w.engine.tick();
    await w.engine.sleep("claude:s2");
    w.sim.addTerminal({ agent: "claude" }); // another Claude, its own session not known yet
    await ticks(w, 3);
    assert.equal(w.engine.record("claude:s2")?.state, "asleep");
  });
});

describe("two terminals labelled with one running session", () => {
  it("a second terminal already labelled with the session (from before) does not take the record", async () => {
    const w = world();
    const one = w.sim.addTerminal({ agent: "claude" });
    w.claude.state.sessions.set(one.address, "s1");
    await w.engine.tick();
    const two = w.sim.addTerminal({
      agent: "claude",
      tab: "tb2",
      space: "sp2",
      labels: { "suspender.agent": "claude", "suspender.session": "s1", "suspender.state": "running" },
    });
    w.claude.state.sessions.set(two.address, "s1");
    await ticks(w, 2);
    const writes = w.ports.writes.length;
    await ticks(w, 4);
    assert.equal(w.engine.record("claude:s1" as SessionKey)?.terminal, one.address);
    assert.equal(w.ports.writes.length, writes);
  });

  it("the record stays with its own live terminal and the store is not written back and forth", async () => {
    const w = world();
    const one = w.sim.addTerminal({ agent: "claude" });
    w.claude.state.sessions.set(one.address, "s1");
    await w.engine.tick();
    // The same conversation opened by hand in a second tab (Claude allows it).
    const two = w.sim.addTerminal({ agent: "claude", tab: "tb2", space: "sp2" });
    w.claude.state.sessions.set(two.address, "s1");
    await ticks(w, 3);
    const writes = w.ports.writes.length;
    const asked = w.claude.state.discovers.filter((x) => x === two.address).length;
    await ticks(w, 6);
    assert.equal(w.engine.record("claude:s1" as SessionKey)?.terminal, one.address);
    assert.equal(w.ports.writes.length, writes, "no write per round");
    assert.equal(
      w.claude.state.discovers.filter((x) => x === two.address).length,
      asked,
      "and the second terminal is not looked up again every ten seconds",
    );
  });
});
