// "Memory freed" belongs to the sleep it is shown for. A record kept the
// figure of an earlier sleep when the new one was not measured, and the
// measurement ran alongside the stop: on a busy machine (two sleeps at once)
// PowerShell listed the processes after the agent had exited and its shell had
// been ended, found nothing under the terminal, and gave no figure (measured
// in an isolated core with the listing slowed down: the old figure stayed).

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentAdapter } from "../../src/adapters/contract.ts";
import type { AgentId, SessionKey } from "../../src/core/model.ts";
import { Engine, MEMORY_WAIT_MS, newCoordinator } from "../../src/runtime/engine.ts";
import { fakeAdapter, Sim } from "./sim.ts";

const KEY: SessionKey = "claude:s1";
/** The sim's tree: the shell (40 MB private) and the agent under it (200 MB). */
const TREE_MB = 240;
const SHELL_MB = 40;

function world() {
  const sim = new Sim();
  const ports = sim.ports();
  const claude = fakeAdapter("claude");
  const adapters: Record<AgentId, AgentAdapter> = { claude, codex: fakeAdapter("codex") };
  const co = newCoordinator();
  const engine = new Engine({ host: sim, ports, id: "leader", adapters, coordinator: co });
  const agent = sim.addTerminal({ agent: "claude" });
  claude.state.sessions.set(agent.address, "s1");
  return { sim, ports, engine, claude, agent, co };
}

/** When the memory listing answered, and when each key went to the agent's terminal (sim time). */
function timeline(w: ReturnType<typeof world>) {
  const listed: number[] = [];
  const keys: { at: number; keys: string[] }[] = [];
  const exec = w.ports.exec;
  w.ports.exec = async (cmd, args, opts) => {
    const out = await exec(cmd, args, opts);
    if (args.join(" ").includes("WorkingSetPrivate")) {
      listed.push(w.sim.now);
    }
    return out;
  };
  const hc = w.sim.hc.bind(w.sim);
  w.sim.hc = async (args) => {
    if (args[0] === "keys") {
      keys.push({ at: w.sim.now, keys: args.slice(2) });
    }
    return hc(args);
  };
  return { listed, keys };
}

async function ticks(sim: Sim, engine: Engine, ms: number): Promise<void> {
  for (let t = 0; t < ms; t += 1_000) {
    await sim.advance(1_000);
    await engine.tick();
  }
}

describe("memory freed belongs to the sleep it is shown for", () => {
  it("a sleep that could not be measured shows no figure, not the last sleep's", async () => {
    const w = world();
    await w.engine.tick();
    await w.engine.sleep(KEY);
    assert.equal(w.engine.record(KEY)?.memFreedMb, TREE_MB, "the first sleep is measured");
    await w.engine.resume(KEY);
    assert.equal(w.engine.record(KEY)?.state, "running");
    // The second time PowerShell answers nothing (a timeout, a failure).
    const exec = w.ports.exec;
    w.ports.exec = async (cmd, args, opts) =>
      args.join(" ").includes("WorkingSetPrivate") ? { code: 1, stdout: "", stderr: "" } : exec(cmd, args, opts);
    await w.engine.sleep(KEY);
    assert.equal(w.engine.record(KEY)?.state, "asleep");
    assert.equal(w.engine.record(KEY)?.memFreedMb, null);
  });

  it("a screen that could not be read is not the last sleep's screen", async () => {
    const w = world();
    await w.engine.tick();
    await w.engine.sleep(KEY);
    assert.ok(w.engine.record(KEY)?.lastScreen, "the first sleep's screen");
    await w.engine.resume(KEY);
    const hc = w.sim.hc.bind(w.sim);
    w.sim.hc = async (args) => (args[0] === "read" ? { code: 1, stdout: "", stderr: "gone" } : hc(args));
    await w.engine.sleep(KEY);
    assert.equal(w.engine.record(KEY)?.state, "asleep");
    assert.equal(w.engine.record(KEY)?.lastScreen, null);
  });

  it("a sleep its copy did not finish (the leader finished it) shows no figure, not the last sleep's", async () => {
    const w = world();
    await w.engine.tick();
    await w.engine.sleep(KEY);
    assert.equal(w.engine.record(KEY)?.memFreedMb, TREE_MB);
    await w.engine.resume(KEY);
    // Another copy starts Sleep and is closed half-way: its transcript read never answers.
    const closing = new Engine({
      host: w.sim,
      ports: w.ports,
      id: "closing",
      adapters: { claude: { ...w.claude, snapshot: () => new Promise(() => undefined) }, codex: fakeAdapter("codex") },
      coordinator: w.co,
    });
    void closing.sleep(KEY);
    for (let i = 0; i < 2_000 && w.engine.record(KEY)?.state !== "asleep"; i++) {
      await new Promise((resolve) => setImmediate(resolve));
      await w.engine.load();
    }
    await ticks(w.sim, w.engine, 70_000);
    const rec = w.engine.record(KEY);
    assert.equal(rec?.state, "asleep");
    assert.equal(rec?.terminal, null, "the leader finished it");
    assert.equal(rec?.memFreedMb, null);
  });

  it("a slow listing still counts the whole tree: the agent is stopped only once it is in", async () => {
    const w = world();
    await w.engine.tick();
    const t = timeline(w);
    w.sim.memoryQueryMs = 2_000;
    await w.engine.sleep(KEY);
    assert.equal(w.engine.record(KEY)?.memFreedMb, TREE_MB);
    const first = t.keys[0]?.at ?? Number.NEGATIVE_INFINITY;
    assert.ok((t.listed[0] ?? Number.POSITIVE_INFINITY) <= first, "no key reaches the agent before the listing");
  });

  it(`a listing slower than ${MEMORY_WAIT_MS} ms holds the stop no longer, and its late figure does not count`, async () => {
    const w = world();
    await w.engine.tick();
    // The agent ignores its exit command, so the tree is all there when the late listing answers.
    w.sim.exitsOnStop = false;
    const start = w.sim.now;
    const t = timeline(w);
    w.sim.memoryQueryMs = MEMORY_WAIT_MS + 3_000;
    await w.engine.sleep(KEY);
    assert.equal(w.engine.record(KEY)?.state, "asleep");
    const first = t.keys[0]?.at ?? Number.POSITIVE_INFINITY;
    assert.ok(first - start <= MEMORY_WAIT_MS + 100, `the first key went out ${first - start} ms after Sleep`);
    assert.ok((t.listed[0] ?? 0) > first, "the listing answered after the stop began");
    assert.equal(w.engine.record(KEY)?.memFreedMb, null);
  });

  it("an agent killed hard: what its shell gives back, measured before the shell is ended", async () => {
    const w = world();
    await w.engine.tick();
    w.sim.memoryQueryMs = 2_000;
    w.sim.killAgent(w.agent.address);
    await ticks(w.sim, w.engine, 15_000);
    assert.equal(w.engine.record(KEY)?.state, "interrupted");
    assert.equal(w.engine.record(KEY)?.memFreedMb, SHELL_MB);
  });
});
