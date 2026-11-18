// Sleep and Resume behind the cover (core/layout.ts insertCover): while the
// tab's panes are rearranged, the work area shows the cover, which draws the
// sleeping tab as it will look. The person: «при нажатии sleep на время
// появляется split и потом заменяется заснувшей вкладкой, можем ли мы это
// исправить?». Measured on Herdr 0.1.16: the split is listed about 66 ms after
// it is asked for, and until then it is on screen.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentAdapter } from "../../src/adapters/contract.ts";
import { COVER_ID } from "../../src/core/layout.ts";
import type { AgentId, SessionKey } from "../../src/core/model.ts";
import { COVER_KEY, Engine, newCoordinator, settleCover } from "../../src/runtime/engine.ts";
import { fakeAdapter, Sim, TAB } from "./sim.ts";

const KEY: SessionKey = "claude:s1";

function world(opts: { cover?: boolean } = {}) {
  const sim = new Sim();
  if (opts.cover !== false) {
    sim.coverLayout();
  }
  const ports = sim.ports();
  const claude = fakeAdapter("claude");
  const adapters: Record<AgentId, AgentAdapter> = { claude, codex: fakeAdapter("codex") };
  const engine = new Engine({ host: sim, ports, id: "leader", adapters, coordinator: newCoordinator() });
  const agent = sim.addTerminal({ agent: "claude" });
  claude.state.sessions.set(agent.address, "s1");
  return { sim, engine, agent };
}

/** The commands in order, with what the work area showed when each was run. */
function watch(sim: Sim): { command: string; covered: boolean }[] {
  const seen: { command: string; covered: boolean }[] = [];
  const run = sim.run.bind(sim);
  sim.run = (command: string, args: Record<string, unknown>) => {
    seen.push({ command, covered: sim.workShows() === COVER_ID });
    run(command, args);
  };
  return seen;
}

const index = (seen: { command: string }[], command: string): number => seen.findIndex((s) => s.command === command);

describe("a Sleep behind the cover", () => {
  it("covers the work area before the split, and the cover goes once the sleeping pane stands alone in the tab", async () => {
    const { sim, engine } = world();
    await engine.tick();
    const seen = watch(sim);
    await engine.sleep(KEY);
    assert.equal(engine.record(KEY)?.state, "asleep");
    for (const command of ["pane.split", "pane.swap", "terminal.park"]) {
      const at = seen.find((s) => s.command === command);
      assert.equal(at?.covered, true, `${command} behind the cover`);
    }
    // Not with the park: measured on Herdr 0.1.16, the park lands a frame or two later, and a cover put
    // away with it showed the split again. The cover's copy puts it away when Herdr shows the result.
    assert.equal(sim.workShows(), COVER_ID);
    assert.deepEqual((sim.shared(COVER_KEY) as { tab?: string; alone?: unknown } | null)?.alone, null);
    assert.equal(settleCover(sim, sim.now), true);
    assert.equal(sim.workShows(), "main");
    assert.equal(sim.shared(COVER_KEY), null);
  });

  it("tells the cover what to draw: the session as its sleeping pane shows it", async () => {
    const { sim, engine } = world();
    await engine.tick();
    let drawn: unknown = null;
    const run = sim.run.bind(sim);
    sim.run = (command: string, args: Record<string, unknown>) => {
      if (command === "pane.split") {
        drawn = sim.shared(COVER_KEY);
      }
      run(command, args);
    };
    await engine.sleep(KEY);
    const said = drawn as { key?: string; rec?: { state?: string; lastScreen?: unknown } } | null;
    assert.equal(said?.key, KEY);
    assert.equal(said?.rec?.state, "stopping");
  });

  it("is not used in a tab with other panes: it would hide them", async () => {
    const { sim, engine } = world();
    sim.addTerminal({ agent: null });
    await engine.tick();
    const seen = watch(sim);
    await engine.sleep(KEY);
    assert.equal(engine.record(KEY)?.state, "asleep");
    assert.equal(index(seen, "layout.select"), -1);
  });

  it("is not used for a tab that is not on screen", async () => {
    const { sim, engine } = world();
    sim.addTab("tb2");
    sim.select("tb2");
    await engine.tick();
    const seen = watch(sim);
    await engine.sleep(KEY);
    assert.equal(index(seen, "layout.select"), -1);
    assert.equal(sim.shownTab(), "tb2");
  });

  it("is put away when the sleeping pane never shows (Herdr too busy to list it): the agent stops in view", async () => {
    const { sim, engine } = world();
    await engine.tick();
    // Listed only after every wait for it (PANE_WAIT_MS and more).
    sim.modPaneDelays = [7_000];
    await engine.sleep(KEY);
    assert.equal(sim.workShows(), "main");
    assert.equal(sim.shared(COVER_KEY), null);
  });

  it("is not raised over a cover another flow holds, and that flow's cover is left to it", async () => {
    const { sim, engine } = world();
    await engine.tick();
    sim.selectWork(COVER_ID);
    sim.setShared(COVER_KEY, { key: "claude:other", rec: null, at: sim.now });
    const seen = watch(sim);
    await engine.sleep(KEY);
    assert.equal(engine.record(KEY)?.state, "asleep");
    assert.equal(index(seen, "layout.select"), -1);
    assert.deepEqual((sim.shared(COVER_KEY) as { key?: string } | null)?.key, "claude:other");
  });

  it("is not used without the Suspender layout: the split shows, as before", async () => {
    const { sim, engine } = world({ cover: false });
    await engine.tick();
    const seen = watch(sim);
    await engine.sleep(KEY);
    assert.equal(engine.record(KEY)?.state, "asleep");
    assert.equal(index(seen, "layout.select"), -1);
  });
});

describe("a Resume behind the cover", () => {
  it("covers the work area before Herdr adopts the agent, and shows it again with the agent in the slot", async () => {
    const { sim, engine } = world();
    await engine.tick();
    await engine.sleep(KEY);
    // The cover's copy puts the sleep's cover away within frames.
    settleCover(sim, sim.now);
    const seen = watch(sim);
    const labels: boolean[] = [];
    const hc = sim.hc.bind(sim);
    sim.hc = (args: string[]) => {
      if (args[0] === "label" && args.some((a) => a.startsWith("herdr.tab="))) {
        labels.push(sim.workShows() === COVER_ID);
      }
      return hc(args);
    };
    await engine.resume(KEY);
    assert.equal(engine.record(KEY)?.state, "running");
    assert.deepEqual(labels, [true], "adopted behind the cover");
    const swap = seen.find((s) => s.command === "pane.swap");
    assert.equal(swap?.covered, true);
    // The flow does not put it away (its copy may be the sleeping pane, which the close ends): the cover's
    // copy does, once the agent stands alone in the tab.
    const address = engine.record(KEY)?.terminal;
    assert.equal((sim.shared(COVER_KEY) as { alone?: unknown } | null)?.alone, address);
    assert.equal(sim.workShows(), COVER_ID);
    assert.equal(settleCover(sim, sim.now), true);
    assert.equal(sim.workShows(), "main");
    assert.equal(sim.shared(COVER_KEY), null);
  });

  it("says the session is waking while it covers, though the record already says running", async () => {
    const { sim, engine } = world();
    await engine.tick();
    await engine.sleep(KEY);
    // The cover's copy puts the sleep's cover away within frames.
    settleCover(sim, sim.now);
    let drawn: unknown = null;
    const hc = sim.hc.bind(sim);
    sim.hc = (args: string[]) => {
      if (args[0] === "label" && args.some((a) => a.startsWith("herdr.tab="))) {
        drawn = sim.shared(COVER_KEY);
      }
      return hc(args);
    };
    await engine.resume(KEY);
    assert.equal((drawn as { rec?: { state?: string } } | null)?.rec?.state, "waking");
  });
});

describe("a Resume Herdr does not show", () => {
  it("puts the cover away with the error and Retry on the sleeping pane", async () => {
    const { sim, engine } = world();
    await engine.tick();
    await engine.sleep(KEY);
    // The cover's copy puts the sleep's cover away within frames.
    settleCover(sim, sim.now);
    sim.adopts = false;
    await engine.resume(KEY);
    assert.equal(engine.record(KEY)?.state, "error");
    assert.equal(sim.workShows(), "main");
    assert.equal(sim.shared(COVER_KEY), null);
  });
});

describe("a cover left up", () => {
  it("is put away by the next round when no Sleep or Resume holds it (Herdr restarted with it up)", async () => {
    const { sim, engine } = world();
    sim.selectWork(COVER_ID);
    await engine.tick();
    assert.equal(sim.workShows(), "main");
  });

  it("stays while its flow is not through: the tab does not hold only what the flow leaves there", async () => {
    const { sim, engine } = world();
    // Waiting for a mod pane alone in TAB, which still shows the agent's terminal.
    sim.selectWork(COVER_ID);
    sim.setShared(COVER_KEY, { key: KEY, rec: null, at: sim.now, tab: TAB, alone: null });
    await engine.tick();
    assert.equal(sim.workShows(), COVER_ID);
    assert.equal(settleCover(sim, sim.now), false);
    // Waiting for that terminal: through.
    const terminal = sim.paneList.find((p) => p.tab === TAB)?.terminal ?? null;
    sim.setShared(COVER_KEY, { key: KEY, rec: null, at: sim.now, tab: TAB, alone: terminal });
    assert.equal(settleCover(sim, sim.now), true);
    assert.equal(sim.workShows(), "main");
  });

  it("is waited for when just raised: the hold comes before Herdr shows the cover", async () => {
    const { sim } = world();
    sim.setShared(COVER_KEY, { key: KEY, rec: null, at: sim.now, tab: TAB, alone: null });
    // The tabs still show: the select has not landed yet.
    assert.equal(settleCover(sim, sim.now), false);
    assert.notEqual(sim.shared(COVER_KEY), null);
    // A hold that never got its cover is dropped in time.
    assert.equal(settleCover(sim, sim.now + 5_000), true);
    assert.equal(sim.shared(COVER_KEY), null);
    // Nothing held, nothing up: nothing to do.
    assert.equal(settleCover(sim, sim.now), true);
  });

  it("is put away when held too long: a flow that never got through does not hide the tabs", async () => {
    const { sim } = world();
    sim.selectWork(COVER_ID);
    sim.setShared(COVER_KEY, { key: KEY, rec: null, at: sim.now, tab: TAB, alone: null });
    assert.equal(settleCover(sim, sim.now + 4_000), false);
    assert.equal(settleCover(sim, sim.now + 5_000), true);
    assert.equal(sim.workShows(), "main");
  });

  it("with two panes in the tab, the split is still there: not through", async () => {
    const { sim } = world();
    // After the swap and before the park: our pane first in the slot, the agent beside it.
    const ours = sim.addModPane(TAB, { role: "sleep", key: KEY });
    sim.paneList.sort((a, b) => (a.pane === ours ? -1 : b.pane === ours ? 1 : 0));
    sim.selectWork(COVER_ID);
    sim.setShared(COVER_KEY, { key: KEY, rec: null, at: sim.now, tab: TAB, alone: null });
    assert.equal(settleCover(sim, sim.now), false);
  });
});
