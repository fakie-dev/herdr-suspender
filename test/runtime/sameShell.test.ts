// `/exit` and `claude` again in the same shell, within one round: the shell
// is the same, the agent's process is a new one with a new session. The mod
// knew the old process only: it saw it gone while Herdr still showed the
// agent's status, took that for a kill, and three seconds later put the tab
// to sleep, killing the terminal with the new Claude in it. A gone process is
// now looked for again under the shell before anything is concluded.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentAdapter } from "../../src/adapters/contract.ts";
import type { AgentId, SessionKey } from "../../src/core/model.ts";
import { ABSENT_GRACE_MS, Engine, newCoordinator } from "../../src/runtime/engine.ts";
import { fakeAdapter, Sim } from "./sim.ts";

const KEY: SessionKey = "claude:s1";

function world() {
  const sim = new Sim();
  const ports = sim.ports();
  const claude = fakeAdapter("claude");
  const adapters: Record<AgentId, AgentAdapter> = { claude, codex: fakeAdapter("codex") };
  const engine = new Engine({ host: sim, ports, id: "leader", adapters, coordinator: newCoordinator() });
  const agent = sim.addTerminal({ agent: "claude" });
  claude.state.sessions.set(agent.address, "s1");
  return { sim, ports, claude, engine, agent };
}

describe("an agent started again in the same shell", () => {
  it("is not taken for a killed one: nothing is killed, and the record moves to its new session", async () => {
    const w = world();
    await w.engine.tick();
    assert.equal(w.engine.record(KEY)?.state, "running");
    // Within one round: /exit, then `claude` again. A new process, a new conversation and its title.
    const t = w.sim.term(w.agent.address);
    t.agentPid = 7777;
    t.agentStartMs = w.sim.now;
    t.title = "Another synthetic conversation";
    w.claude.state.sessions.set(w.agent.address, "s9");

    for (let i = 0; i < 4; i++) {
      await w.engine.tick();
      await w.sim.advance(ABSENT_GRACE_MS);
    }

    assert.deepEqual(w.sim.killed, [], "the terminal with the new Claude is not killed");
    assert.equal(w.engine.record(KEY), null);
    assert.equal(w.engine.record("claude:s9")?.state, "running");
    assert.equal(w.engine.record("claude:s9")?.terminal, w.agent.address);
  });

  it("Sleep right after such a restart puts the new session to sleep, not the old one", async () => {
    const w = world();
    await w.engine.tick();
    // The round did not see it (same title): the process the mod knows is the old one.
    const t = w.sim.term(w.agent.address);
    t.agentPid = 7778;
    t.agentStartMs = w.sim.now;
    w.claude.discoverSession = async (view) => {
      w.claude.state.views.push(view);
      // As the real adapter: the session of the process in front, none for a process that is gone.
      return view.foreground?.pid === 7778 ? "s9" : null;
    };

    await w.engine.sleep(KEY);

    assert.equal(w.engine.record("claude:s9")?.state, "asleep");
    assert.equal(w.engine.record(KEY), null);
  });

  it("the agent of a terminal is the one nearest its shell, not a `claude -p` it runs", async () => {
    const w = world();
    const t = w.sim.term(w.agent.address);
    // The agent runs a helper Claude of its own; the process table happens to list the helper first.
    const table = (w.sim as unknown as { processTable: () => string }).processTable.bind(w.sim);
    (w.sim as unknown as { processTable: () => string }).processTable = () =>
      `9001\t${t.agentPid}\t${w.sim.now}\tclaude.exe\t"C:\\bin\\claude.exe" -p "summarise"\r\n${table()}`;
    w.sim.setStatus(w.agent.address, "working");
    await w.engine.tick();
    w.sim.setStatus(w.agent.address, "idle"); // the turn ends: the session is looked up again
    await w.engine.tick();
    assert.equal(w.claude.state.views.at(-1)?.foreground?.pid, t.agentPid);
  });

  it("an agent that is really gone (killed hard) is still found gone", async () => {
    const w = world();
    await w.engine.tick();
    w.sim.killAgent(w.agent.address);
    for (let i = 0; i < 4; i++) {
      await w.engine.tick();
      await w.sim.advance(ABSENT_GRACE_MS);
    }
    assert.equal(w.engine.record(KEY)?.state, "interrupted");
  });
});
