// After Herdr starts (or the mod loads), a record still says what was true
// before ("running") until the leader has looked at its terminal: a terminal
// lost in a restart comes back as a shell, and the session turns
// "interrupted" only after ABSENT_GRACE_MS. Until the engine has confirmed a
// running record in this run, it is "checking", so the panel does not say
// "running" for seconds and then "interrupted".

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentAdapter } from "../../src/adapters/contract.ts";
import type { AgentId, SessionKey } from "../../src/core/model.ts";
import { ABSENT_GRACE_MS, CHECKED_KEY, Engine, newCoordinator } from "../../src/runtime/engine.ts";
import { fakeAdapter, Sim } from "./sim.ts";

const KEY: SessionKey = "claude:s1";

/** An agent bound in a run before this one: the store and the labels say "running". */
async function boundBefore() {
  const sim = new Sim();
  const ports = sim.ports();
  const claude = fakeAdapter("claude");
  const adapters: Record<AgentId, AgentAdapter> = { claude, codex: fakeAdapter("codex") };
  const agent = sim.addTerminal({ agent: "claude" });
  claude.state.sessions.set(agent.address, "s1");
  const before = new Engine({ host: sim, ports, id: "last-run", adapters, coordinator: newCoordinator() });
  await before.tick();
  assert.equal(before.record(KEY)?.state, "running");
  before.release();
  // This run: a new module load, so a new coordinator.
  const co = newCoordinator();
  const engine = new Engine({ host: sim, ports, id: "leader", adapters, coordinator: co });
  return { sim, ports, adapters, co, engine, agent };
}

describe("a session's state is checking until the engine has confirmed it in this run", () => {
  it("a running record from before is checking until the leader has looked, then running", async () => {
    const { engine } = await boundBefore();
    await engine.load();
    assert.equal(engine.record(KEY)?.state, "running");
    assert.equal(engine.checking(KEY), true);

    await engine.tick();

    assert.equal(engine.record(KEY)?.state, "running");
    assert.equal(engine.checking(KEY), false);
  });

  it("a terminal lost in the restart stays checking through the grace, then is interrupted", async () => {
    const { sim, engine, agent } = await boundBefore();
    sim.loseTerminal(agent.address);

    await engine.tick();
    assert.equal(engine.record(KEY)?.state, "running", "the store still says running");
    assert.equal(engine.checking(KEY), true, "so the panel says checking, not running");

    await sim.advance(ABSENT_GRACE_MS);
    await engine.tick();
    assert.equal(engine.record(KEY)?.state, "interrupted");
    assert.equal(engine.checking(KEY), false);
  });

  it("a sleeping session is never checking: its pane is what it says", async () => {
    const { ports, adapters, engine } = await boundBefore();
    await engine.tick();
    await engine.sleep(KEY);
    assert.equal(engine.record(KEY)?.state, "asleep");

    const later = new Engine({ host: engine["host"], ports, id: "next", adapters, coordinator: newCoordinator() });
    await later.load();
    assert.equal(later.checking(KEY), false);
  });

  it("a session woken in this run is running at once, not checking until the next round", async () => {
    const { sim, ports, adapters, engine } = await boundBefore();
    await engine.tick();
    await engine.sleep(KEY);

    const later = new Engine({ host: sim, ports, id: "next", adapters, coordinator: newCoordinator() });
    await later.resume(KEY);

    assert.equal(later.record(KEY)?.state, "running");
    assert.equal(later.checking(KEY), false);
  });

  it("an agent bound in this run is not checking", async () => {
    const sim = new Sim();
    const claude = fakeAdapter("claude");
    const engine = new Engine({
      host: sim,
      ports: sim.ports(),
      id: "leader",
      adapters: { claude, codex: fakeAdapter("codex") },
      coordinator: newCoordinator(),
    });
    const agent = sim.addTerminal({ agent: "claude" });
    claude.state.sessions.set(agent.address, "s1");
    await engine.tick();
    assert.equal(engine.checking(KEY), false);
  });

  it("a session that changes inside the agent (/clear) stays confirmed under its new id", async () => {
    const sim = new Sim();
    const claude = fakeAdapter("claude");
    const engine = new Engine({
      host: sim,
      ports: sim.ports(),
      id: "leader",
      adapters: { claude, codex: fakeAdapter("codex") },
      coordinator: newCoordinator(),
    });
    const agent = sim.addTerminal({ agent: "claude" });
    claude.state.sessions.set(agent.address, "s1");
    await engine.tick();
    sim.setStatus(agent.address, "working");
    await engine.tick();
    claude.state.sessions.set(agent.address, "s9"); // the person ran /clear; the turn ends
    sim.setStatus(agent.address, "idle");
    await engine.tick();

    assert.equal(engine.record("claude:s9")?.state, "running");
    assert.equal(engine.checking("claude:s9"), false);
  });

  it("another copy of the window sees the leader's checks", async () => {
    const { sim, ports, adapters, co, engine } = await boundBefore();
    const copy = new Engine({ host: sim, ports, id: "panel", adapters, coordinator: co });
    await engine.tick();
    await copy.tick();
    assert.equal(copy.isLeader(), false);
    assert.equal(copy.checking(KEY), false);
  });

  it("the copies are told once when a check ends, and not on rounds that change nothing", async () => {
    const { sim, engine } = await boundBefore();
    let told = 0;
    sim.onShared = (key) => {
      if (key === CHECKED_KEY) {
        told++;
      }
    };
    await engine.tick();
    assert.equal(told, 1, "the end of the check redraws the copies");
    await sim.advance(5_000);
    await engine.tick();
    await sim.advance(5_000);
    await engine.tick();
    assert.equal(told, 1, "rounds that confirm nothing new set nothing");
  });
});
