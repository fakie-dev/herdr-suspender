// A wake goes from the sleeping pane straight to the agent in the same slot.
// Herdr adopts the woken terminal by splitting the tab's last pane (src/window.rs:
// model.split(&target, Row)) and lists the new pane in panes() only after its
// next update; the engine then swaps it into the slot and closes the sleeping
// pane. Before, it looked for the pane every 250 ms and wrote the store twice
// before the swap and the close: the tab showed the agent at half its slot beside
// the sleeping pane for up to 0.8 s (measured with shots), and Claude Code drew
// its banner at that width.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentAdapter } from "../../src/adapters/contract.ts";
import type { AgentId, SessionKey } from "../../src/core/model.ts";
import { Engine, newCoordinator } from "../../src/runtime/engine.ts";
import type { FakePorts } from "../fakePorts.ts";
import { fakeAdapter, Sim, TAB } from "./sim.ts";

const KEY: SessionKey = "claude:s1";
const FRAME = 16;

async function asleep(opts: { lone: boolean }) {
  const sim = new Sim();
  const ports = sim.ports();
  const claude = fakeAdapter("claude");
  const adapters: Record<AgentId, AgentAdapter> = { claude, codex: fakeAdapter("codex") };
  const engine = new Engine({ host: sim, ports, id: "leader", adapters, coordinator: newCoordinator() });
  if (!opts.lone) {
    sim.addTerminal({ agent: null, first: true });
  }
  const agent = sim.addTerminal({ agent: "claude" });
  if (!opts.lone) {
    sim.addTerminal({ agent: null });
  }
  claude.state.sessions.set(agent.address, "s1");
  await engine.tick();
  await engine.sleep(KEY);
  assert.equal(engine.record(KEY)?.state, "asleep");
  return { sim, ports, engine };
}

/**
 * Each time the flow lets Herdr draw (an hc call, a wait, a store write) while
 * the woken agent and the sleeping pane are both in the tab: that is a split
 * the person sees.
 */
function splitsSeen(sim: Sim, ports: FakePorts, sleepPane: string): { at: string; ms: number }[] {
  const seen: { at: string; ms: number }[] = [];
  const both = (): boolean =>
    sim.paneList.some((p) => p.pane === sleepPane) &&
    sim.paneList.some((p) => p.tab === TAB && p.terminal !== null && sim.terms.get(p.terminal)?.agent === "claude");
  const hc = sim.hc.bind(sim);
  sim.hc = async (args) => {
    if (both()) {
      seen.push({ at: `hc ${args[0]}`, ms: sim.now });
    }
    return hc(args);
  };
  const wait = sim.sleep.bind(sim);
  sim.sleep = async (ms) => {
    if (both()) {
      seen.push({ at: `wait ${ms}`, ms: sim.now });
    }
    return wait(ms);
  };
  const write = ports.writeText.bind(ports);
  ports.writeText = async (path, text, expected) => {
    if (both()) {
      seen.push({ at: "store write", ms: sim.now });
    }
    return write(path, text, expected);
  };
  return seen;
}

for (const lone of [true, false]) {
  describe(`a wake ${lone ? "of the only pane of its tab" : "between two other panes"}`, () => {
    it("shows the agent beside the sleeping pane for no more than a frame, and nothing is awaited then", async () => {
      const { sim, ports, engine } = await asleep({ lone });
      const sleepPane = engine.record(KEY)?.pane ?? "";
      const slot = sim.row().indexOf(sleepPane);
      const sizes = sim.layout().map((p) => p.size);
      const seen = splitsSeen(sim, ports, sleepPane);
      let closedAt = Number.POSITIVE_INFINITY;
      const run = sim.run.bind(sim);
      sim.run = (command, args) => {
        if (command === "pane.close" && args["pane"] === sleepPane) {
          closedAt = sim.now;
        }
        run(command, args);
      };

      await engine.resume(KEY);

      assert.equal(engine.record(KEY)?.state, "running");
      // The one wait the flow may spend with both in the tab is the frame in which it looks for the new pane.
      assert.ok(
        seen.every((s) => s.at === `wait ${FRAME}`) && seen.length <= 1,
        `seen while split: ${JSON.stringify(seen)}`,
      );
      const shownAt = sim.adoptedAt.at(-1) ?? Number.NEGATIVE_INFINITY;
      assert.ok(closedAt - shownAt <= FRAME, `the split showed for ${closedAt - shownAt} ms`);
      const woken = engine.record(KEY)?.terminal ?? "";
      const pane = sim.paneList.find((p) => p.terminal === woken)?.pane ?? "";
      assert.equal(sim.row().indexOf(pane), slot, "the agent is in the sleeping pane's slot");
      assert.deepEqual(
        sim.layout().map((p) => p.size),
        sizes,
        "at its size, every other pane as it was",
      );
      assert.equal(sim.pane(sleepPane), undefined, "the sleeping pane is gone");
    });
  });
}
