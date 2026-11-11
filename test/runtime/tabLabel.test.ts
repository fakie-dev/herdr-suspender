// "Sessions · N" in the live copy of the tab bar: the copy cannot import the
// mod, so the engine publishes the label as `shared("suspender.tabLabel")`.
// Setting a shared value redraws every mod in the window, so it is set only
// when the text changes.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentId, SessionKey } from "../../src/core/model.ts";
import { Engine, newCoordinator, TAB_LABEL_KEY } from "../../src/runtime/engine.ts";
import { fakeAdapter, Sim } from "./sim.ts";

const KEY: SessionKey = "claude:s1";

function world() {
  const sim = new Sim();
  const ports = sim.ports();
  const claude = fakeAdapter("claude");
  const adapters: Record<AgentId, ReturnType<typeof fakeAdapter>> = { claude, codex: fakeAdapter("codex") };
  const coordinator = newCoordinator();
  const engine = new Engine({ host: sim, ports, id: "copy-a", adapters, coordinator });
  const agent = sim.addTerminal({ agent: "claude", status: "idle" });
  claude.state.sessions.set(agent.address, "s1");
  const sets: unknown[] = [];
  const set = sim.setShared.bind(sim);
  sim.setShared = (key, value) => {
    if (key === TAB_LABEL_KEY) {
      sets.push(value);
    }
    set(key, value);
  };
  return { sim, ports, engine, adapters, coordinator, sets };
}

describe("the tab bar's label", () => {
  it("is published under suspender.tabLabel", () => {
    assert.equal(TAB_LABEL_KEY, "suspender.tabLabel");
  });

  it("says how many sessions sleep, from the first round on", async () => {
    const { sim, engine } = world();
    await engine.tick();
    assert.equal(sim.shared(TAB_LABEL_KEY), "Sessions · 0");
    await engine.sleep(KEY);
    assert.equal(engine.record(KEY)?.state, "asleep");
    assert.equal(sim.shared(TAB_LABEL_KEY), "Sessions · 1", "at once, not at the next round");
  });

  it("is set only when its text changes, however many rounds and copies run", async () => {
    const { sim, ports, engine, adapters, coordinator, sets } = world();
    const other = new Engine({ host: sim, ports, id: "copy-b", adapters, coordinator });
    for (let i = 0; i < 4; i++) {
      await engine.tick();
      await other.tick();
      await sim.advance(5_000);
    }
    assert.deepEqual(sets, ["Sessions · 0"]);
    await engine.sleep(KEY);
    await engine.tick();
    await other.tick();
    assert.deepEqual(sets, ["Sessions · 0", "Sessions · 1"]);
  });
});
