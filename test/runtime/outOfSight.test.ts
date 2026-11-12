// Sleep stops the agent out of sight (ADR 9): from the moment our pane is in
// the terminal's slot, the agent's pane is gone (`terminal.park`), and the stop
// steps go to the hidden terminal by its address. Before, the sleeping panel and
// the live agent stood side by side for seconds while the agent was stopped.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentAdapter } from "../../src/adapters/contract.ts";
import type { AgentId, SessionKey } from "../../src/core/model.ts";
import { Engine, newCoordinator } from "../../src/runtime/engine.ts";
import { fakeAdapter, Sim, TAB } from "./sim.ts";

const KEY: SessionKey = "claude:s1";

/** An agent between two shells in one row (only then does a slot that moves show). */
function world(opts: { status?: string; direct?: boolean } = {}) {
  const sim = new Sim();
  const ports = sim.ports();
  const claude = fakeAdapter("claude");
  const codex = fakeAdapter("codex");
  const adapters: Record<AgentId, AgentAdapter> = { claude, codex };
  const co = newCoordinator();
  const engine = new Engine({ host: sim, ports, id: "leader", adapters, coordinator: co });
  sim.addTerminal({ agent: null, first: true });
  const agent = sim.addTerminal({
    agent: "claude",
    status: opts.status ?? "idle",
    ...(opts.direct ? { direct: true } : {}),
  });
  sim.addTerminal({ agent: null });
  claude.state.sessions.set(agent.address, "s1");
  return { sim, ports, engine, claude, codex, co, agent };
}

type Look = "untouched" | "final" | "both" | "other";

/**
 * What the tab looks like each time the flow gives Herdr a chance to draw
 * (an `hc` call, a wait, a store write): as before Sleep, as after it (our
 * pane alone in the agent's slot, every size as before), or something else.
 */
function watch(w: ReturnType<typeof world>): { looks: { at: string; look: Look }[]; now: () => Look } {
  const { sim, ports, agent } = w;
  const slot = sim.row().indexOf(agent.pane);
  const sizes = sim.layout().map((p) => p.size);
  const now = (): Look => {
    const agentShown = sim.paneList.some((p) => p.terminal === agent.address);
    const ours = sim.paneList.filter((p) => p.tab === TAB && p.mod === "suspender");
    if (agentShown) {
      return ours.length === 0 ? "untouched" : "both";
    }
    const same =
      ours.length === 1 &&
      sim.row().indexOf(ours[0]?.pane ?? "") === slot &&
      JSON.stringify(sim.layout().map((p) => p.size)) === JSON.stringify(sizes);
    return same ? "final" : "other";
  };
  const looks: { at: string; look: Look }[] = [];
  const hc = sim.hc.bind(sim);
  sim.hc = async (args) => {
    looks.push({ at: `hc ${args.join(" ")}`, look: now() });
    return hc(args);
  };
  const wait = sim.sleep.bind(sim);
  sim.sleep = async (ms) => {
    looks.push({ at: `wait ${ms}`, look: now() });
    return wait(ms);
  };
  const write = ports.writeText.bind(ports);
  ports.writeText = async (path, text, expected) => {
    looks.push({ at: "store write", look: now() });
    return write(path, text, expected);
  };
  return { looks, now };
}

/** The looks from the first change on: every one must be the final look. */
const afterTouched = (looks: { at: string; look: Look }[]) =>
  looks.slice(looks.findIndex((l) => l.look !== "untouched"));

/** Live terminals without a pane: an agent or a shell left running out of sight. */
const hiddenAlive = (sim: Sim): string[] =>
  [...sim.terms.values()]
    .filter((t) => t.state === "live" && !sim.paneList.some((p) => p.terminal === t.address))
    .map((t) => t.address);

const keysTo = (sim: Sim, address: string): string[][] =>
  sim.hcCalls.filter((c) => c[0] === "keys" && c[1] === address).map((c) => c.slice(2));

describe("sleep stops the agent out of sight", () => {
  it("the tab never shows the sleeping pane and the live agent side by side", async () => {
    const w = world();
    await w.engine.tick();
    const { looks, now } = watch(w);

    await w.engine.sleep(KEY);

    assert.equal(w.engine.record(KEY)?.state, "asleep");
    assert.equal(now(), "final");
    const changed = afterTouched(looks);
    assert.ok(changed.length > 0);
    assert.deepEqual(
      changed.filter((l) => l.look !== "final"),
      [],
      "from the first change on, the tab looks as it will after the sleep",
    );
  });

  it("the stop steps go to the hidden terminal, and they work there", async () => {
    const w = world();
    await w.engine.tick();
    const { looks } = watch(w);

    await w.engine.sleep(KEY);

    const firstKey = looks.find((l) => l.at.startsWith(`hc keys ${w.agent.address}`));
    assert.equal(firstKey?.look, "final", "the agent is out of sight before the first stop key");
    assert.deepEqual(w.sim.parked, [w.agent.address]);
    assert.deepEqual(keysTo(w.sim, w.agent.address), [["esc"], ["ctrl+c"], ["/", "e", "x", "i", "t", "enter"]]);
    const rec = w.engine.record(KEY);
    assert.equal(rec?.forced, false, "it left on its exit command");
    assert.equal(rec?.terminal, null);
  });

  it("the shell the agent ran in does not stay running out of sight", async () => {
    const w = world();
    await w.engine.tick();
    await w.engine.sleep(KEY);
    assert.deepEqual(hiddenAlive(w.sim), []);
    assert.equal(w.sim.terms.has(w.agent.address), false, "the finished terminal is removed (hc rm)");
  });

  it("an agent that is the terminal's own program: out of sight too, and gone after", async () => {
    const w = world({ direct: true });
    await w.engine.tick();
    const { looks, now } = watch(w);
    await w.engine.sleep(KEY);
    assert.equal(now(), "final");
    assert.deepEqual(
      afterTouched(looks).filter((l) => l.look !== "final"),
      [],
    );
    assert.deepEqual(hiddenAlive(w.sim), []);
    assert.equal(w.sim.terms.has(w.agent.address), false);
  });

  it("a working agent the person interrupts: Esc and the wait for idle reach it while hidden", async () => {
    const w = world({ status: "working" });
    await w.engine.tick();
    const { looks } = watch(w);
    await w.engine.sleep(KEY);
    assert.equal(w.engine.record(KEY)?.state, "confirming");
    assert.deepEqual(
      looks.filter((l) => l.look !== "untouched"),
      [],
      "nothing changes while the question is open",
    );

    await w.engine.choose(KEY, "interruptAndSleep");

    assert.equal(w.engine.record(KEY)?.state, "asleep");
    assert.equal(w.engine.record(KEY)?.forced, false, "it went idle and left on /exit");
    assert.deepEqual(
      afterTouched(looks).filter((l) => l.look !== "final"),
      [],
    );
  });

  it("an agent that ignores the exit is killed after 10 s without coming back into view", async () => {
    const w = world();
    w.sim.exitsOnStop = false;
    await w.engine.tick();
    const { looks, now } = watch(w);
    const started = w.sim.now;

    await w.engine.sleep(KEY);

    const rec = w.engine.record(KEY);
    assert.equal(rec?.state, "asleep");
    assert.equal(rec?.forced, true);
    assert.ok(w.sim.now - started >= 10_000, "it waited the 10 s first");
    assert.equal(now(), "final");
    assert.deepEqual(
      afterTouched(looks).filter((l) => l.look !== "final"),
      [],
    );
    assert.deepEqual(hiddenAlive(w.sim), []);
    assert.equal(w.sim.terms.has(w.agent.address), false);
  });

  it("when Herdr fails to take the pane away, the sleep ends as before: pane closed, slot kept", async () => {
    const w = world();
    w.sim.parks = false;
    await w.engine.tick();
    const { now } = watch(w);

    await w.engine.sleep(KEY);

    const rec = w.engine.record(KEY);
    assert.equal(rec?.state, "asleep");
    assert.equal(rec?.terminal, null);
    assert.equal(now(), "final", "our pane alone in the slot, every size as before");
    assert.deepEqual(hiddenAlive(w.sim), []);
    assert.equal(w.sim.terms.has(w.agent.address), false);
  });

  it("our pane that Herdr lists a frame after the split is taken a frame later, not a poll later", async () => {
    // Measured in Herdr 0.1.15: panes() lists a mod's split pane only after the window's next
    // update. Until the park, the agent is squeezed to half its slot beside our pane.
    const w = world();
    w.sim.modPaneDelays = [16];
    await w.engine.tick();
    const at = new Map<string, number>();
    const run = w.sim.run.bind(w.sim);
    w.sim.run = (command, args) => {
      if (!at.has(command)) {
        at.set(command, w.sim.now);
      }
      run(command, args);
    };

    await w.engine.sleep(KEY);

    const split = at.get("pane.split");
    const park = at.get("terminal.park");
    assert.ok(split !== undefined && park !== undefined);
    assert.ok(park - split <= 2 * 16, `split and park ${park - split} ms apart: no more than two frames`);
  });

  it("while our pane has not shown, the agent is not taken out of its slot", async () => {
    const w = world();
    // A busy window: the sleeping pane shows only after the flow stopped waiting for it.
    w.sim.modPaneDelays = [20_000];
    await w.engine.tick();
    const { looks } = watch(w);

    await w.engine.sleep(KEY);

    const firstKey = looks.find((l) => l.at.startsWith(`hc keys ${w.agent.address}`));
    assert.equal(firstKey?.look, "untouched", "a hole in the tab would be worse than the agent in view");
    assert.deepEqual(w.sim.parked, []);
    assert.equal(w.engine.record(KEY)?.state, "asleep", "the session is still kept");
  });

  it("a copy closed half-way through the stop: the leader still ends the hidden agent and keeps the session", async () => {
    const w = world();
    await w.engine.tick();
    // Herdr ends a closed copy's tasks at their next await: this copy's first wait never returns.
    const stuck = new Proxy(w.sim, {
      get(target, name, receiver) {
        if (name === "sleep") {
          return () => new Promise<void>(() => undefined);
        }
        const value: unknown = Reflect.get(target, name, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const closing = new Engine({
      host: stuck,
      ports: w.ports,
      id: "closing",
      adapters: { claude: w.claude, codex: w.codex },
      coordinator: w.co,
    });
    void closing.sleep(KEY);
    for (let i = 0; i < 2_000 && !w.sim.hcCalls.some((c) => c[0] === "keys" && c.includes("enter")); i++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.ok(
      w.sim.hcCalls.some((c) => c[0] === "keys" && c.includes("enter")),
      "the stop got as far as /exit",
    );
    assert.equal(
      w.sim.paneList.some((p) => p.terminal === w.agent.address),
      false,
      "the agent is out of sight while nobody carries the stop on",
    );

    for (let t = 0; t <= 100_000; t += 5_000) {
      await w.engine.tick();
      await w.sim.advance(5_000);
    }

    const rec = w.engine.record(KEY);
    assert.equal(rec?.state, "asleep", "the session record is kept");
    assert.equal(rec?.terminal, null);
    assert.ok(rec?.pane && w.sim.pane(rec.pane), "its sleeping pane is there");
    assert.deepEqual(hiddenAlive(w.sim), [], "nothing is left running out of sight");
  });
});
