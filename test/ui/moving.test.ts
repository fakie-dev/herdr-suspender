// A state that is not settled is drawn with the native spinner (`.spin`, no
// timer): "checking" (a running record the engine has not confirmed in this
// run), falling asleep and waking. A settled state draws none, so nothing
// animates while nothing is under way. Read from stand-in elements
// (test/standIns.ts, `record`).

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { AsyncContext } from "gpui-kit";
import type { SessionKey, SessionState } from "../../src/core/model.ts";
import { defaultStorePath, emptyStore, serializeStore } from "../../src/core/store.ts";
import { Engine, newCoordinator } from "../../src/runtime/engine.ts";
import { fakeAdapter, Sim, TAB } from "../runtime/sim.ts";
import { useStandIns } from "../standIns.ts";
import { rec } from "./helpers.ts";

const home = mkdtempSync(join(tmpdir(), "suspender-moving-"));
after(() => rmSync(home, { recursive: true, force: true }));
useStandIns({ appHome: join(home, ".config", "herdr-app"), home, readsHang: false, record: true });
const { PanelView } = await import("../../src/ui/panel.ts");
const { PopupView } = await import("../../src/ui/popup.ts");
const { SleepPane } = await import("../../src/ui/sleepPane.ts");

interface Drawn {
  kind: string;
  arg?: unknown;
  calls: unknown[][];
  kids: unknown[];
}
const isDrawn = (x: unknown): x is Drawn => typeof x === "object" && x !== null && "calls" in x && "kids" in x;
const has = (el: Drawn, name: string, ...args: unknown[]): boolean =>
  el.calls.some((c) => c[0] === name && args.every((a, i) => c[i + 1] === a));
function* walk(el: unknown): Generator<Drawn> {
  if (isDrawn(el)) {
    yield el;
    for (const kid of el.kids) {
      yield* walk(kid);
    }
  }
}
const byId = (root: unknown, id: string): Drawn | undefined => [...walk(root)].find((el) => has(el, "id", id));
const texts = (el: unknown): string[] => [...walk(el)].flatMap((x) => x.kids.filter((k) => typeof k === "string"));
/** Spinners drawn under `el`: the spinner icon, turned natively. */
const spinners = (el: unknown): Drawn[] =>
  [...walk(el)].filter((x) => x.kind === "svg" && String(x.arg).endsWith("spinner.svg") && has(x, "spin"));

const ID = "0f0e0d0c-0b0a-4908-8706-050403020100";
const KEY: SessionKey = `claude:${ID}`;
const cx = { spawn: () => undefined, notify: () => undefined } as unknown as AsyncContext;

/** One session in `state`; `confirmed`: the engine has confirmed it in this run. */
async function world(state: SessionState, confirmed = false) {
  const sim = new Sim();
  const ports = sim.ports();
  const pane = sim.addModPane(TAB, { role: "sleep", key: KEY });
  const file = emptyStore();
  file.sessions[KEY] = rec(ID, state, {
    key: KEY,
    pane: state === "running" ? null : pane,
    terminal: state === "running" ? "t1" : null,
    sleptAtMs: sim.now,
    info: { title: "Synthetic session" },
  });
  ports.files.set(defaultStorePath(ports), serializeStore(file));
  const coordinator = newCoordinator();
  if (confirmed) {
    coordinator.confirmed.add(KEY);
  }
  const adapters = { claude: fakeAdapter("claude"), codex: fakeAdapter("codex") };
  const engine = new Engine({ host: sim, ports, id: "copy", adapters, coordinator });
  await engine.load();
  return { sim, ports, engine };
}

/** Gives a view the size Herdr reports for its root, then draws it again. */
function sized(view: { render(cx: AsyncContext): unknown }, width: number, height: number): unknown {
  const first = view.render(cx);
  assert.ok(isDrawn(first));
  const onSize = first.calls.find((c) => c[0] === "on_size_change")?.[1];
  (onSize as (size: { width: number; height: number }, cx: AsyncContext) => void)({ width, height }, cx);
  return view.render(cx);
}

function panelRow(w: Awaited<ReturnType<typeof world>>): Drawn {
  const root = new PanelView({ engine: w.engine, host: w.sim, ports: w.ports, mode: "panel", overlay: null }).render(
    cx,
  );
  const row = byId(root, `row-${KEY}`);
  assert.ok(row !== undefined, "the session's row");
  return row;
}

describe("a Sessions row", () => {
  it("a running record not confirmed yet says checking, with a spinner and no Sleep button", async () => {
    const row = panelRow(await world("running"));
    assert.ok(texts(row).includes("checking"));
    assert.ok(!texts(row).includes("running"));
    assert.equal(spinners(row).length, 1);
    assert.equal(byId(row, `row-action-${KEY}`), undefined, "nothing to press while it is not known");
  });

  it("a confirmed running session says running, with no spinner and its Sleep button", async () => {
    const row = panelRow(await world("running", true));
    assert.ok(texts(row).includes("running"));
    assert.deepEqual(spinners(row), []);
    assert.ok(byId(row, `row-action-${KEY}`) !== undefined);
  });

  it("falling asleep and waking spin; asleep and interrupted do not", async () => {
    assert.equal(spinners(panelRow(await world("stopping"))).length, 1);
    assert.equal(spinners(panelRow(await world("waking"))).length, 1);
    assert.deepEqual(spinners(panelRow(await world("asleep"))), []);
    assert.deepEqual(spinners(panelRow(await world("interrupted"))), []);
  });
});

describe("the popup's state", () => {
  it("says checking with a spinner while the session is not confirmed, and running without one after", async () => {
    const before = await world("running");
    const drawn = new PopupView(before.engine, before.ports, KEY, null, null).render(cx);
    assert.ok(texts(drawn).includes("checking"));
    assert.equal(spinners(drawn).length, 1);

    const after = await world("running", true);
    const settled = new PopupView(after.engine, after.ports, KEY, null, null).render(cx);
    assert.ok(texts(settled).includes("running"));
    assert.deepEqual(spinners(settled), []);
  });
});

describe("the sleeping pane's status", () => {
  it("falling asleep spins beside Stopping…; asleep does not", async () => {
    const stopping = await world("stopping");
    const drawn = sized(new SleepPane(stopping.engine, stopping.sim, stopping.ports, KEY), 900, 600);
    assert.ok(texts(drawn).some((x) => x.includes("Stopping")));
    assert.equal(spinners(drawn).length, 1);

    const asleep = await world("asleep");
    assert.deepEqual(spinners(sized(new SleepPane(asleep.engine, asleep.sim, asleep.ports, KEY), 900, 600)), []);
  });
});
