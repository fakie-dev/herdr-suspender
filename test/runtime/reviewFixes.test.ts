// What the review of the whole branch found in the engine (ticket F1): each
// case as the simulated Herdr plays it, seen failing before its fix.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { codexAdapter } from "../../src/adapters/codex.ts";
import type { AgentAdapter } from "../../src/adapters/contract.ts";
import type { AgentId, SessionKey, SessionRecord } from "../../src/core/model.ts";
import { defaultStorePath, parseStore } from "../../src/core/store.ts";
import { Engine, newCoordinator } from "../../src/runtime/engine.ts";
import { codex, jsonl, uuidV7 } from "../adapters/synthetic.ts";
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
  const codexFake = fakeAdapter("codex");
  const adapters: Record<AgentId, AgentAdapter> = { claude, codex: codexFake };
  const co = newCoordinator();
  const engine = new Engine({ host: sim, ports, id: "leader", adapters, coordinator: co });
  const agent = sim.addTerminal({ agent: "claude", status: "idle" });
  claude.state.sessions.set(agent.address, "s1");
  return { sim, ports, engine, claude, adapters, co, agent };
}

/** Ticks the leader every 5 s for `ms`. */
async function ticks(sim: Sim, engine: Engine, ms: number): Promise<void> {
  for (let t = 0; t < ms; t += 5_000) {
    await engine.tick();
    await sim.advance(5_000);
  }
  await engine.tick();
}

describe("/exit typed by the person", () => {
  it("leaves the shell: Claude's status still showing for a round is not a kill", async () => {
    const { sim, ports, engine, agent } = world();
    await engine.tick();
    // The agent is gone and the shell's title is back; Herdr clears the status a round later.
    sim.killAgent(agent.address);
    await engine.tick();
    await sim.advance(5_000);
    const term = sim.terms.get(agent.address);
    assert.ok(term, "the terminal is still there a round later");
    term.status = null;
    term.app = null;
    await ticks(sim, engine, 15_000);
    assert.equal(stored(ports)[KEY], undefined, "the session is let go");
    assert.equal(sim.terms.get(agent.address)?.state, "live", "the shell is still there");
    assert.ok(
      sim.paneList.some((p) => p.terminal === agent.address),
      "in its own pane",
    );
    assert.ok(!sim.paneList.some((p) => p.mod === "suspender"), "no strip took its place");
  });

  it("leaves nothing behind that would take the next agent in that shell for a killed one", async () => {
    const { sim, engine, claude, agent } = world();
    await engine.tick();
    sim.killAgent(agent.address);
    await engine.tick();
    await sim.advance(5_000);
    const term = sim.term(agent.address);
    term.status = null;
    term.app = null;
    await ticks(sim, engine, 15_000);
    assert.equal(engine.record(KEY), null);
    // A new claude in the same shell, another conversation, quiet at its prompt.
    claude.state.sessions.set(agent.address, "s5");
    await sim.hc(["keys", agent.address, "c", "l", "a", "u", "d", "e", "enter"]);
    await ticks(sim, engine, 30_000);
    assert.equal(engine.record("claude:s5")?.state, "running");
  });

  it("is not taken for a kill by a look sooner than the status takes to go out", async () => {
    const { sim, ports, engine, agent } = world();
    await engine.tick();
    sim.killAgent(agent.address);
    await engine.tick();
    // Another round a second later (a second window's leader, say): the status still shows.
    await sim.advance(1_000);
    await engine.tick();
    assert.equal(stored(ports)[KEY]?.state, "running");
    const term = sim.terms.get(agent.address);
    assert.ok(term);
    term.status = null;
    term.app = null;
    await ticks(sim, engine, 15_000);
    assert.equal(stored(ports)[KEY], undefined);
    assert.equal(sim.terms.get(agent.address)?.state, "live");
  });
});

describe("a draft in the agent's prompt at Sleep", () => {
  it("is cleared first: the agent gets exactly its exit command", async () => {
    const { sim, ports, engine, agent } = world();
    await engine.tick();
    const term = sim.term(agent.address);
    await sim.hc(["keys", agent.address, "d", "r", "a", "f", "t"]);
    await engine.sleep(KEY);
    assert.deepEqual(term.submitted, ["/exit"]);
    assert.equal(stored(ports)[KEY]?.state, "asleep");
    assert.equal(stored(ports)[KEY]?.forced, false, "it left by itself, nothing was killed");
  });
});

describe("a session id a shell would run", () => {
  it("is never typed into the shell at Resume", async () => {
    const { sim, ports, engine, claude, agent } = world();
    const key: SessionKey = "claude:x & calc";
    claude.state.sessions.set(agent.address, "x & calc");
    await engine.tick();
    await engine.sleep(key);
    assert.equal(stored(ports)[key]?.state, "asleep");
    await engine.resume(key);
    assert.deepEqual(
      sim.typed.filter((x) => x.line.includes("calc")),
      [],
    );
    assert.equal(stored(ports)[key]?.state, "error");
    assert.equal(stored(ports)[key]?.error, "reason.badId");
  });
});

describe("Sleep pressed on two tabs within a second", () => {
  function twoTabs() {
    const w = world();
    w.sim.addTab("tb2");
    const other = w.sim.addTerminal({ agent: "claude", status: "idle", tab: "tb2" });
    w.claude.state.sessions.set(other.address, "s2");
    return { ...w, other };
  }

  it("sleeps both", async () => {
    const { sim, ports, engine, agent, other } = twoTabs();
    await engine.tick();
    sim.focus = { pane: agent.pane, terminal: agent.address };
    const first = engine.toggleFocused();
    sim.focus = { pane: other.pane, terminal: other.address };
    const second = engine.toggleFocused();
    await Promise.all([first, second]);
    assert.equal(stored(ports)[KEY]?.state, "asleep");
    assert.equal(stored(ports)["claude:s2"]?.state, "asleep");
  });

  it("but one press that every shown copy gets is still one action", async () => {
    const { sim, ports, engine, adapters, co, agent } = twoTabs();
    await engine.tick();
    const copy = new Engine({ host: sim, ports, id: "copy", adapters, coordinator: co });
    const term = sim.term(agent.address);
    sim.focus = { pane: agent.pane, terminal: agent.address };
    await Promise.all([engine.toggleFocused(), copy.toggleFocused()]);
    assert.equal(stored(ports)[KEY]?.state, "asleep");
    assert.deepEqual(term.submitted, ["/exit"], "one exit command");
    assert.equal(sim.commands.filter((c) => c.command === "pane.split").length, 1, "one strip");
  });
});

describe("a Codex whose session is not known yet", () => {
  const CWD = "C:\\work\\cx";

  let worlds = 0;

  function idleCodex() {
    const sim = new Sim();
    // Each world a day apart: the adapter remembers terminals by address and creation time.
    sim.now += ++worlds * 86_400_000;
    const ports = sim.ports();
    const engine = new Engine({
      host: sim,
      ports,
      id: "leader",
      adapters: { claude: fakeAdapter("claude"), codex: codexAdapter },
    });
    const cx = sim.addTerminal({ agent: "codex", status: "idle", cwd: CWD, tab: TAB });
    const term = sim.term(cx.address);
    // On Windows the foreground is the shell the codex runs under.
    term.foreground = { pid: term.pid ?? 0, argv: ["pwsh.exe"], name: "pwsh.exe" };
    return { sim, ports, engine, cx };
  }

  it("costs no process while nothing changes", async () => {
    const { sim, engine } = idleCodex();
    await engine.tick();
    const firstLook = sim.execCalls.length;
    assert.ok(firstLook >= 1, "the first look asks the process table");
    await ticks(sim, engine, 300_000);
    assert.equal(sim.execCalls.length, firstLook, "five idle minutes: no process");
    assert.equal(engine.records().length, 0);
  });

  it("is found by its rollout as soon as it appears, still without a process", async () => {
    const { sim, ports, engine, cx } = idleCodex();
    await engine.tick();
    const firstLook = sim.execCalls.length;
    await ticks(sim, engine, 60_000);
    const id = uuidV7(sim.now, "c0dec");
    const d = new Date(sim.now);
    const pad = (n: number): string => String(n).padStart(2, "0");
    const day = `${d.getFullYear()}\\${pad(d.getMonth() + 1)}\\${pad(d.getDate())}`;
    ports.files.set(
      `C:\\Users\\tester\\.codex\\sessions\\${day}\\rollout-2027-01-15T08-00-00-${id}.jsonl`,
      jsonl(codex.meta(id, CWD, d.toISOString())),
    );
    await ticks(sim, engine, 10_000);
    assert.equal(engine.record(`codex:${id}`)?.terminal, cx.address);
    assert.equal(sim.execCalls.length, firstLook);
  });

  it("is asked the process table again when its terminal changes", async () => {
    const { sim, engine, cx } = idleCodex();
    await engine.tick();
    const firstLook = sim.execCalls.length;
    await ticks(sim, engine, 30_000);
    sim.term(cx.address).title = "codex resume";
    await ticks(sim, engine, 60_000);
    assert.ok(sim.execCalls.length > firstLook, `${firstLook} ${sim.execCalls.length}`);
  });
});
