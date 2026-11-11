// What the live check of the first build found (ticket 09): each case as the
// simulated Herdr can play it, seen failing before its fix.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentAdapter } from "../../src/adapters/contract.ts";
import type { AgentId, SessionKey, SessionRecord } from "../../src/core/model.ts";
import { defaultStorePath, parseStore } from "../../src/core/store.ts";
import { Engine, newCoordinator } from "../../src/runtime/engine.ts";
import type { FakePorts } from "../fakePorts.ts";
import { fakeAdapter, Sim } from "./sim.ts";

const KEY: SessionKey = "claude:s1";

function stored(ports: FakePorts): Record<string, SessionRecord> {
  return parseStore(ports.files.get(defaultStorePath(ports)) ?? null).sessions;
}

const hcOf = (sim: Sim, sub: string): string[][] => sim.hcCalls.filter((c) => c[0] === sub);

/** Lets every pending promise and timer chain run (nothing here waits on real time). */
async function settle(until: () => boolean, rounds = 2_000): Promise<void> {
  for (let i = 0; i < rounds && !until(); i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function world(opts: { status?: string } = {}) {
  const sim = new Sim();
  const ports = sim.ports();
  const claude = fakeAdapter("claude");
  const codex = fakeAdapter("codex");
  const adapters: Record<AgentId, AgentAdapter> = { claude, codex };
  const co = newCoordinator();
  const engine = new Engine({ host: sim, ports, id: "leader", adapters, coordinator: co });
  const agent = sim.addTerminal({ agent: "claude", status: opts.status ?? "idle" });
  claude.state.sessions.set(agent.address, "s1");
  return { sim, ports, engine, claude, codex, adapters, co, agent };
}

/** Ticks the leader every 5 s for `ms`. */
async function ticks(sim: Sim, engine: Engine, ms: number): Promise<void> {
  for (let t = 0; t < ms; t += 5_000) {
    await engine.tick();
    await sim.advance(5_000);
  }
  await engine.tick();
}

/**
 * Another copy of the same window starts Sleep and is closed half-way: its
 * last await never comes back (Herdr ends a closed copy's tasks at their next
 * await). Here its snapshot never answers, so it stops right after the record
 * says "asleep", before the record gets its time, its facts and loses its terminal.
 */
async function sleepInterrupted() {
  const w = world();
  await w.engine.tick();
  const closing = new Engine({
    host: w.sim,
    ports: w.ports,
    id: "closing",
    adapters: { claude: { ...w.claude, snapshot: () => new Promise(() => undefined) }, codex: w.codex },
    coordinator: w.co,
  });
  void closing.sleep(KEY);
  await settle(() => stored(w.ports)[KEY]?.state === "asleep" && w.sim.paneList.some((p) => p.mod === "suspender"));
  return w;
}

describe("1: a sleep its copy did not finish", () => {
  it("is finished by the leader, and its Resume is not held forever", async () => {
    const { sim, ports, engine } = await sleepInterrupted();
    // What the live check saw: asleep, no facts, no time, the terminal still attached.
    const half = stored(ports)[KEY];
    assert.equal(half?.state, "asleep");
    assert.equal(half?.sleptAtMs, null);
    assert.notEqual(half?.terminal, null);

    await ticks(sim, engine, 60_000);

    const rec = stored(ports)[KEY];
    assert.equal(rec?.state, "asleep");
    assert.equal(rec?.terminal, null, "the terminal is let go");
    assert.equal(typeof rec?.sleptAtMs, "number", "it has its time");
    assert.equal(rec?.info.title, "title of s1", "and its facts");
    assert.equal(engine.busy(KEY), false, "Resume can be pressed");
    assert.equal(await engine.resume(KEY), "running");
  });

  it("a copy at work longer than the hold lasts (a wake that times out after 30 s) keeps holding it", async () => {
    const { sim, ports, engine, co, claude, codex } = world();
    await engine.tick();
    await engine.sleep(KEY);
    sim.adopts = false; // the new terminal never shows: the wake waits its full 30 s
    const held: boolean[] = [];
    const host = new Proxy(sim, {
      get(target, name, receiver) {
        if (name === "sleep") {
          return async (ms: number) => {
            held.push(engine.busy(KEY));
            await target.sleep(ms);
          };
        }
        const value: unknown = Reflect.get(target, name, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const waking = new Engine({ host, ports, id: "waking", adapters: { claude, codex }, coordinator: co });
    assert.equal(await waking.resume(KEY), "error");
    assert.ok(held.length > 100);
    assert.ok(
      held.every((h) => h),
      "the other copies saw it held all along",
    );
  });

  it("is left alone while the copy carrying it out is still at work", async () => {
    const { sim, ports, engine } = await sleepInterrupted();
    await ticks(sim, engine, 10_000);
    assert.equal(engine.busy(KEY), true);
    assert.notEqual(stored(ports)[KEY]?.terminal, null);
  });
});

describe("4: closing the tab of a sleep its copy did not finish", () => {
  it("removes the record", async () => {
    const { sim, ports, engine } = await sleepInterrupted();
    const pane = sim.paneList.find((p) => p.mod === "suspender")?.pane ?? "";
    sim.removePane(pane);
    await ticks(sim, engine, 90_000);
    assert.equal(stored(ports)[KEY], undefined);
  });
});

describe("2: open elsewhere", () => {
  it("stays open elsewhere when one look says closed but the next says open (the other copy is alive)", async () => {
    const { sim, engine, claude, adapters } = world();
    await engine.tick();
    await engine.sleep(KEY);
    claude.state.elsewhere.set("s1", "pid 4242");
    await engine.resume(KEY);
    assert.equal(engine.record(KEY)?.state, "elsewhere");
    // A look in the middle of the other copy rewriting its session file, or a process list that failed.
    let looks = 0;
    adapters.claude = {
      ...claude,
      openElsewhere: async () => (++looks === 1 ? { open: false } : { open: true, where: "pid 4242" }),
    };
    await engine.recheckElsewhere(KEY);
    assert.equal(engine.record(KEY)?.state, "elsewhere");
    assert.equal(hcOf(sim, "run").length, 0);
  });

  it("goes back to asleep once the other copy is really closed", async () => {
    const { engine, claude } = world();
    await engine.tick();
    await engine.sleep(KEY);
    claude.state.elsewhere.set("s1", "pid 4242");
    await engine.resume(KEY);
    claude.state.elsewhere.delete("s1");
    await engine.recheckElsewhere(KEY);
    assert.equal(engine.record(KEY)?.state, "asleep");
  });
});

describe("5: updated after sleep, while the strip stays on screen", () => {
  it("is read again when the other copy closes", async () => {
    const { engine, claude } = world();
    await engine.tick();
    await engine.sleep(KEY);
    await engine.refreshOnShow(KEY);
    claude.state.elsewhere.set("s1", "pid 4242");
    await engine.resume(KEY);
    // Work in the other copy, then it is closed there.
    claude.state.info.set("s1", { messages: 16, transcriptMtimeMs: 1_700_000_900_000, transcriptSize: 3000 });
    claude.state.elsewhere.delete("s1");
    await engine.recheckElsewhere(KEY);
    assert.deepEqual(engine.freshness(KEY), { atMs: 1_700_000_900_000, added: 6 });
  });

  it("is read again when the transcript changes, without showing the tab again", async () => {
    const { engine, claude } = world();
    await engine.tick();
    await engine.sleep(KEY);
    await engine.refreshOnShow(KEY);
    assert.equal(engine.freshness(KEY), null);
    let changed: () => void = () => undefined;
    claude.watchTranscript = () =>
      new Promise<void>((resolve) => {
        changed = resolve;
      });
    const following = engine.followTranscript(KEY);
    claude.state.info.set("s1", { messages: 12, transcriptMtimeMs: 1_700_000_500_000, transcriptSize: 1500 });
    changed();
    assert.equal(await following, true);
    assert.deepEqual(engine.freshness(KEY), { atMs: 1_700_000_500_000, added: 2 });
  });
});

describe("6: an agent killed hard (taskkill /F, a crash)", () => {
  it("makes its tab interrupted, with nothing started", async () => {
    const { sim, ports, engine, agent } = world();
    await engine.tick();
    sim.killAgent(agent.address);
    // Herdr still says "claude-code idle": only the title went back to the shell's.
    assert.equal(sim.term(agent.address).status, "idle");
    await ticks(sim, engine, 10_000);
    const rec = stored(ports)[KEY];
    assert.equal(rec?.state, "interrupted");
    assert.ok(rec?.pane && sim.pane(rec.pane), "a strip with Resume where the terminal was");
    assert.equal(hcOf(sim, "run").length, 0);
  });

  it("is not suspected while the agent lives, and a title change costs one look", async () => {
    const { sim, ports, engine, agent } = world();
    await engine.tick();
    const listed = sim.execCalls.length;
    await ticks(sim, engine, 20_000);
    assert.equal(sim.execCalls.length, listed, "nothing changed: no process started");
    sim.term(agent.address).title = "Renamed conversation";
    await ticks(sim, engine, 20_000);
    assert.equal(sim.execCalls.length, listed + 1, "one look at the processes");
    assert.equal(stored(ports)[KEY]?.state, "running");
  });
});

describe("7: Codex /new next to an unbound Codex in the same folder", () => {
  it("does not move a record onto the session of a Codex that has none yet", async () => {
    const { sim, engine, codex } = world();
    const a = sim.addTerminal({ agent: "codex", status: "working", cwd: "C:\\work\\cx" });
    codex.state.sessions.set(a.address, "cA");
    await engine.tick();
    assert.equal(engine.record("codex:cA")?.terminal, a.address);
    // Codex B starts in the same folder; its rollout is the newest there, it is not bound yet.
    sim.addTerminal({ agent: "codex", status: "working", cwd: "C:\\work\\cx" });
    codex.state.sessions.set(a.address, "cB"); // A's look "since last time" finds B's rollout
    sim.setStatus(a.address, "idle");
    await engine.tick();
    assert.equal(engine.record("codex:cA")?.terminal, a.address);
    assert.equal(engine.record("codex:cB"), null);
  });
});

describe("8: two copies move the same session at once", () => {
  it("the leader's late move does not undo a Sleep the other copy started", async () => {
    const { sim, ports, engine, claude, codex, agent } = world({ status: "working" });
    await engine.tick();
    // The leader's look at the session answers late; the other window's copy is quick.
    let answer: (id: string) => void = () => undefined;
    const slow: AgentAdapter = {
      ...claude,
      discoverSession: () =>
        new Promise<string>((resolve) => {
          answer = resolve;
        }),
    };
    const leader = new Engine({ host: sim, ports, id: "leader", adapters: { claude: slow, codex } });
    await leader.load();
    // The other copy's waits hold until the leader is done: its sleep is in "stopping" meanwhile.
    let go: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      go = resolve;
    });
    const host = new Proxy(sim, {
      get(target, name, receiver) {
        if (name === "sleep") {
          return async (ms: number) => {
            await held;
            await target.sleep(ms);
          };
        }
        const value: unknown = Reflect.get(target, name, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const other = new Engine({ host, ports, id: "other", adapters: { claude, codex } });
    claude.state.sessions.set(agent.address, "s9"); // the person ran /clear
    sim.setStatus(agent.address, "idle");
    const leading = leader.tick(); // its turn ended: it looks the session up again
    const sleeping = other.sleep(KEY);
    await settle(() => stored(ports)["claude:s9"]?.state === "stopping");
    answer("s9");
    await leading;
    go();
    assert.equal(stored(ports)["claude:s9"]?.state, "stopping", "the sleep goes on");
    await sleeping;
    assert.equal(stored(ports)["claude:s9"]?.state, "asleep");
    assert.equal(stored(ports)[KEY], undefined);
  });
});

describe("8: a move onto a session that is already there", () => {
  /** The leader's turn-end look finds `s9` for the agent's terminal; the store is edited first by `before`. */
  async function lateLook(before: (file: { sessions: Record<string, SessionRecord> }) => void) {
    const { sim, ports, engine, claude, agent } = world({ status: "working" });
    await engine.tick();
    const path = defaultStorePath(ports);
    const file = parseStore(ports.files.get(path) ?? null);
    before(file);
    ports.files.set(path, JSON.stringify(file));
    claude.state.sessions.set(agent.address, "s9");
    sim.setStatus(agent.address, "idle");
    await engine.tick(); // another copy's write: the leader reads the file again first
    return { ports, agent };
  }

  it("does not undo another copy's sleep of it on the same terminal", async () => {
    const { ports } = await lateLook((file) => {
      const s1 = file.sessions[KEY];
      assert.ok(s1);
      file.sessions["claude:s9"] = { ...s1, key: "claude:s9", sessionId: "s9", state: "stopping" };
    });
    assert.equal(stored(ports)["claude:s9"]?.state, "stopping");
  });

  it("makes no record when the old one went while it looked (another copy let it go)", async () => {
    const { sim, ports, engine, claude, codex, agent } = world({ status: "working" });
    await engine.tick();
    let answer: (id: string) => void = () => undefined;
    const slow: AgentAdapter = {
      ...claude,
      discoverSession: () =>
        new Promise<string>((resolve) => {
          answer = resolve;
        }),
    };
    const leader = new Engine({ host: sim, ports, id: "leader", adapters: { claude: slow, codex } });
    await leader.load();
    sim.setStatus(agent.address, "idle");
    const leading = leader.tick();
    await settle(() => false, 50);
    const path = defaultStorePath(ports);
    const file = parseStore(ports.files.get(path) ?? null);
    delete file.sessions[KEY];
    ports.files.set(path, JSON.stringify(file));
    answer("s9");
    await leading;
    assert.equal(stored(ports)["claude:s9"], undefined);
  });
});

describe("9: a silent agent that left", () => {
  it("is not taken for silent once its process is gone", async () => {
    const w = world();
    await w.engine.tick();
    await w.engine.sleep(KEY);
    w.sim.reportAfterMs = null; // it never reports (Codex at its update question)
    await w.engine.resume(KEY);
    const address = w.engine.record(KEY)?.terminal ?? "";
    // It is closed without a word; the shell is back.
    await w.sim.hc(["keys", address, "/", "e", "x", "i", "t", "enter"]);
    await ticks(w.sim, w.engine, 20_000);
    assert.equal(w.engine.record(KEY), null, "the session is let go, as after /exit");
    assert.equal(w.sim.term(address).labels["suspender.state"], "exited");
  });
});

describe("10: a new agent in the shell the last one left", () => {
  it("is looked up by its own process, not the one that left", async () => {
    const { sim, engine, claude, agent } = world();
    await engine.tick();
    await sim.hc(["keys", agent.address, "/", "e", "x", "i", "t", "enter"]);
    await ticks(sim, engine, 10_000);
    assert.equal(engine.record(KEY), null);
    // A new claude in the same shell, another conversation.
    claude.state.sessions.set(agent.address, "s5");
    await sim.hc(["keys", agent.address, "c", "l", "a", "u", "d", "e", "enter"]);
    await ticks(sim, engine, 15_000);
    assert.equal(engine.record("claude:s5")?.terminal, agent.address);
    sim.setStatus(agent.address, "working");
    await engine.tick();
    sim.setStatus(agent.address, "idle");
    await engine.tick();
    assert.equal(claude.state.views.at(-1)?.foreground?.pid, sim.term(agent.address).agentPid);
  });
});
