// The agent's icon on a sleeping tab: the tab bar draws a tab's icon from the
// program of its pane, and a sleeping tab holds only our pane, which has none.
// The engine publishes each session's tab with its agent's icon from Herdr's
// program table (`shared("suspender.tabIcons")`), and the live copy of the tab
// bar uses it for a tab whose pane is ours (runtime/tabsClone.ts).

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentId, SessionKey } from "../../src/core/model.ts";
import { Engine, newCoordinator, PANE_HEADS_KEY, TAB_ICONS_KEY, TAB_LABEL_KEY } from "../../src/runtime/engine.ts";
import { fakeAdapter, Sim } from "./sim.ts";

const KEY: SessionKey = "claude:s1";
const CLAUDE = { icon: "icons/claude.svg", tint: false };
const CODEX = { icon: "icons/codex.svg", tint: true };

function world() {
  const sim = new Sim();
  sim.programs = { claude: CLAUDE, codex: CODEX, nvim: { icon: "icons/nvim.svg", tint: true } };
  const ports = sim.ports();
  const claude = fakeAdapter("claude");
  const codex = fakeAdapter("codex");
  const adapters: Record<AgentId, ReturnType<typeof fakeAdapter>> = { claude, codex };
  const coordinator = newCoordinator();
  const engine = new Engine({ host: sim, ports, id: "copy-a", adapters, coordinator });
  const agent = sim.addTerminal({ agent: "claude", status: "idle" });
  claude.state.sessions.set(agent.address, "s1");
  const sets: unknown[] = [];
  const set = sim.setShared.bind(sim);
  sim.setShared = (key, value) => {
    if (key === TAB_ICONS_KEY) {
      sets.push(value);
    }
    set(key, value);
  };
  return { sim, ports, engine, adapters, coordinator, sets, codex };
}

const tabOf = (engine: Engine, key: SessionKey): string => {
  const tab = engine.record(key)?.tabId;
  assert.ok(tab !== undefined, `${key} has a record`);
  return tab;
};

describe("the agent's icon on its tab", () => {
  it("is published under suspender.tabIcons", () => {
    assert.equal(TAB_ICONS_KEY, "suspender.tabIcons");
  });

  it("names the session's tab with its agent's icon from the first round, before it sleeps", async () => {
    const { sim, engine } = world();
    await engine.tick();
    assert.deepEqual(sim.shared(TAB_ICONS_KEY), { [tabOf(engine, KEY)]: CLAUDE });
  });

  it("keeps the icon on the tab while the session sleeps", async () => {
    const { sim, engine } = world();
    await engine.tick();
    await engine.sleep(KEY);
    assert.equal(engine.record(KEY)?.state, "asleep");
    assert.deepEqual(sim.shared(TAB_ICONS_KEY), { [tabOf(engine, KEY)]: CLAUDE });
  });

  it("gives each agent its own icon", async () => {
    const { sim, engine, codex } = world();
    const other = sim.addTerminal({ agent: "codex", status: "idle", tab: "tb-other" });
    codex.state.sessions.set(other.address, "c1");
    await engine.tick();
    assert.notEqual(tabOf(engine, KEY), tabOf(engine, "codex:c1"));
    assert.deepEqual(sim.shared(TAB_ICONS_KEY), {
      [tabOf(engine, KEY)]: CLAUDE,
      [tabOf(engine, "codex:c1")]: CODEX,
    });
  });

  it("shows on a tab with two agents the one whose sleeping pane is there", async () => {
    const { sim, engine, codex } = world();
    const other = sim.addTerminal({ agent: "codex", status: "idle" });
    codex.state.sessions.set(other.address, "c1");
    await engine.tick();
    assert.equal(tabOf(engine, KEY), tabOf(engine, "codex:c1"));
    await engine.sleep(KEY);
    assert.equal(engine.record(KEY)?.state, "asleep");
    assert.deepEqual(sim.shared(TAB_ICONS_KEY), { [tabOf(engine, KEY)]: CLAUDE });
  });

  it("leaves out an agent Herdr's table has no icon for", async () => {
    const { sim, engine } = world();
    sim.programs = { codex: CODEX };
    await engine.tick();
    assert.deepEqual(sim.shared(TAB_ICONS_KEY), {});
  });

  it("asks Herdr's table once, however many rounds run", async () => {
    const { sim, engine } = world();
    for (let i = 0; i < 4; i++) {
      await engine.tick();
      await sim.advance(5_000);
    }
    assert.equal(sim.programCalls, 1);
  });

  it("does without icons when the table cannot be read, and the rest goes on", async () => {
    const { sim, engine } = world();
    sim.programsFail = true;
    await engine.tick();
    assert.deepEqual(sim.shared(TAB_ICONS_KEY), {});
    assert.equal(sim.shared(TAB_LABEL_KEY), "Sessions");
    await engine.sleep(KEY);
    assert.equal(engine.record(KEY)?.state, "asleep");
  });

  it("is set only when it changes, however many rounds and copies run", async () => {
    const { sim, ports, engine, adapters, coordinator, sets } = world();
    const other = new Engine({ host: sim, ports, id: "copy-b", adapters, coordinator });
    for (let i = 0; i < 4; i++) {
      await engine.tick();
      await other.tick();
      await sim.advance(5_000);
    }
    await engine.sleep(KEY);
    await engine.tick();
    await other.tick();
    assert.deepEqual(sets, [{}, { [tabOf(engine, KEY)]: CLAUDE }]);
  });
});

describe("the sleeping pane's header (ADR 20)", () => {
  it("names each sleeping pane with its agent, icon and folder, and only while it sleeps", async () => {
    const { sim, engine } = world();
    await engine.tick();
    assert.deepEqual(sim.shared(PANE_HEADS_KEY), {}, "a running session has no pane of ours");
    await engine.sleep(KEY);
    const rec = engine.record(KEY);
    assert.ok(rec?.pane);
    assert.deepEqual(sim.shared(PANE_HEADS_KEY), {
      [rec.pane]: { key: "claude", name: "Claude Code", icon: CLAUDE.icon, tint: CLAUDE.tint, cwd: rec.cwd },
    });
    await engine.resume(KEY);
    await engine.tick();
    assert.deepEqual(sim.shared(PANE_HEADS_KEY), {}, "woken: its pane is gone");
  });

  it("still names the agent and folder when Herdr's table has no icon for it", async () => {
    const { sim, engine } = world();
    sim.programs = {};
    await engine.tick();
    await engine.sleep(KEY);
    const rec = engine.record(KEY);
    assert.ok(rec?.pane);
    assert.deepEqual(sim.shared(PANE_HEADS_KEY), { [rec.pane]: { key: "claude", name: "Claude Code", cwd: rec.cwd } });
  });
});
