// A click on a Sessions row goes to the session's tab as Herdr shows it at
// that moment: the sleeping pane's tab (moved to another space by a mod that
// groups spaces, say), or the running terminal's. Never to an id from the
// record alone: "tab.select failed: no such tab". With no tab left, it says so.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { AsyncContext } from "gpui-kit";
import type { SessionKey } from "../../src/core/model.ts";
import { defaultStorePath, emptyStore, serializeStore } from "../../src/core/store.ts";
import { Engine, newCoordinator } from "../../src/runtime/engine.ts";
import { fakeAdapter, Sim, TAB } from "../runtime/sim.ts";
import { useStandIns } from "../standIns.ts";
import { rec } from "./helpers.ts";

const home = mkdtempSync(join(tmpdir(), "suspender-rowclick-"));
after(() => rmSync(home, { recursive: true, force: true }));
useStandIns({ appHome: join(home, ".config", "herdr-app"), home, readsHang: false, record: true });
const { PanelView } = await import("../../src/ui/panel.ts");

interface Drawn {
  kind: string;
  calls: unknown[][];
  kids: unknown[];
}
const isDrawn = (x: unknown): x is Drawn => typeof x === "object" && x !== null && "calls" in x && "kids" in x;
function* walk(el: unknown): Generator<Drawn> {
  if (isDrawn(el)) {
    yield el;
    for (const kid of el.kids) {
      yield* walk(kid);
    }
  }
}

const ID = "0f0e0d0c-0b0a-4908-8706-050403020100";
const KEY: SessionKey = `claude:${ID}`;
const cx = { spawn: () => undefined, notify: () => undefined } as unknown as AsyncContext;

/** Clicks the session's row as the person would. */
function click(sim: Sim, engine: Engine, ports: ReturnType<Sim["ports"]>): void {
  const root = new PanelView({ engine, host: sim, ports, mode: "panel", overlay: null }).render(cx);
  const row = [...walk(root)].find((el) => el.calls.some((c) => c[0] === "id" && c[1] === `row-${KEY}`));
  assert.ok(row !== undefined, "the session's row");
  const handler = row.calls.find((c) => c[0] === "on_click")?.[1];
  assert.equal(typeof handler, "function");
  (handler as (e: unknown, cx: unknown) => void)({}, cx);
}

async function world(over: { pane: boolean; spaceId: string; tabId: string }) {
  const sim = new Sim();
  const ports = sim.ports();
  sim.addTab("tb7", "sp7");
  const pane = over.pane ? sim.addModPane("tb7", { role: "sleep", key: KEY }) : null;
  const file = emptyStore();
  file.sessions[KEY] = rec(ID, "asleep", { key: KEY, pane, spaceId: over.spaceId, tabId: over.tabId });
  ports.files.set(defaultStorePath(ports), serializeStore(file));
  const adapters = { claude: fakeAdapter("claude"), codex: fakeAdapter("codex") };
  const engine = new Engine({ host: sim, ports, id: "copy", adapters, coordinator: newCoordinator() });
  await engine.load();
  return { sim, ports, engine };
}

const selects = (sim: Sim) =>
  sim.commands.filter((c) => c.command === "tab.select" || c.command === "space.select").map((c) => c.args["id"]);

describe("a click on a Sessions row", () => {
  it("goes to the tab its sleeping pane is in now, not the one the record last said", async () => {
    // The record still says sp1/tb1; the pane is in tb7 of sp7 (a grouping mod moved it).
    const w = await world({ pane: true, spaceId: "sp1", tabId: TAB });
    click(w.sim, w.engine, w.ports);
    assert.deepEqual(selects(w.sim), ["sp7", "tb7"]);
  });

  it("a running session goes to its terminal's tab", async () => {
    const w = await world({ pane: false, spaceId: "sp1", tabId: TAB });
    const term = w.sim.addTerminal({ agent: "claude", tab: "tb7", space: "sp7" });
    const file = emptyStore();
    file.sessions[KEY] = rec(ID, "running", { key: KEY, terminal: term.address, spaceId: "sp1", tabId: TAB });
    w.ports.files.set(defaultStorePath(w.ports), serializeStore(file));
    w.sim.setShared("suspender.rev", "edited");
    await w.engine.load();
    click(w.sim, w.engine, w.ports);
    assert.deepEqual(selects(w.sim), ["sp7", "tb7"]);
  });

  it("with no tab left, selects nothing and says the tab is gone", async () => {
    const w = await world({ pane: false, spaceId: "sp-gone", tabId: "tb-gone" });
    click(w.sim, w.engine, w.ports);
    assert.deepEqual(selects(w.sim), []);
    assert.equal(w.sim.notices.length, 1);
    assert.match(w.sim.notices[0]?.text ?? "", /tab is gone/);
  });
});
