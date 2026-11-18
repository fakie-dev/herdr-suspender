// How long a Resume waits once the agent is up. Measured on Herdr 0.1.16 in an
// isolated core (2026-11-18): the woken Claude Code reported its status to the
// core 2.7 s after its command was typed, but Herdr's terminals() showed it
// only 3 s later, as the terminal is not in a tab yet. The engine read the
// status from Herdr's list, so it waited out SETTLE_MS, then took a PowerShell
// process snapshot (1.2 s) to find the agent's process, which the core names
// as the terminal's foreground already. The person: «И ускорить
// засыпание/просыпание?»

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentAdapter } from "../../src/adapters/contract.ts";
import type { AgentId, SessionKey } from "../../src/core/model.ts";
import { Engine, newCoordinator } from "../../src/runtime/engine.ts";
import { fakeAdapter, Sim } from "./sim.ts";

const KEY: SessionKey = "claude:s1";

async function asleep() {
  const sim = new Sim();
  sim.listsUnadopted = true;
  const ports = sim.ports();
  const claude = fakeAdapter("claude");
  const adapters: Record<AgentId, AgentAdapter> = { claude, codex: fakeAdapter("codex") };
  const engine = new Engine({ host: sim, ports, id: "leader", adapters, coordinator: newCoordinator() });
  const agent = sim.addTerminal({ agent: "claude" });
  claude.state.sessions.set(agent.address, "s1");
  await engine.tick();
  await engine.sleep(KEY);
  assert.equal(engine.record(KEY)?.state, "asleep");
  return { sim, engine };
}

describe("a Resume, once the agent is up", () => {
  it("takes the agent's status from the core, not from Herdr's list of a terminal not in a tab yet", async () => {
    const { sim, engine } = await asleep();
    const start = sim.now;
    await engine.resume(KEY);
    assert.equal(engine.record(KEY)?.state, "running");
    // The agent reports 500 ms after it is typed; the shell's prompt and the polls add a little.
    const took = sim.now - start;
    assert.ok(took < 2_000, `${took} ms`);
  });

  it("finds the agent's process as the core's foreground, without a process snapshot", async () => {
    const { sim, engine } = await asleep();
    const before = sim.execCalls.length;
    await engine.resume(KEY);
    assert.equal(engine.record(KEY)?.state, "running");
    assert.equal(
      sim.execCalls.slice(before).filter((c) => /powershell/i.test(c.cmd)).length,
      0,
      "no PowerShell for the agent's process",
    );
  });

  it("takes a process snapshot when what is in front is another program, though run with the session's id", async () => {
    const { sim, engine } = await asleep();
    sim.foregroundOverride = { pid: 4242, name: "helper.exe", argv: ["helper.exe", "--resume", "s1"] };
    const before = sim.execCalls.length;
    await engine.resume(KEY);
    assert.equal(engine.record(KEY)?.state, "running");
    assert.equal(sim.execCalls.slice(before).filter((c) => /powershell/i.test(c.cmd)).length, 1);
  });

  it("an agent that reports late is shown when the core has its status, not seconds later", async () => {
    const { sim, engine } = await asleep();
    // Up after SETTLE_MS: found by a process snapshot first, then its status is waited for.
    sim.reportAfterMs = 6_000;
    const start = sim.now;
    await engine.resume(KEY);
    assert.equal(engine.record(KEY)?.state, "running");
    const took = sim.now - start;
    assert.ok(took < 7_500, `${took} ms`);
  });
});
