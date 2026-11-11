// What the views draw, read from stand-in elements that remember every call
// (test/standIns.ts, `record`). These hold the parts of "nothing is cut
// through" that live in the drawing, not in the arithmetic:
// - the popup's and the sleeping pane's roots name their text size, so Herdr's
//   UI font size cannot reflow what the mod measured;
// - the last item of a row or a strip gives way with "…" when the UI font is
//   wider than the widths the mod counted;
// - a strip too narrow for its button labels draws their icons, labels in tooltips.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { AsyncContext } from "gpui-kit";
import { claudeAdapter } from "../../src/adapters/claude.ts";
import type { SessionKey } from "../../src/core/model.ts";
import { defaultStorePath, emptyStore, serializeStore } from "../../src/core/store.ts";
import { Engine } from "../../src/runtime/engine.ts";
import { fakeAdapter, Sim, TAB } from "../runtime/sim.ts";
import { useStandIns } from "../standIns.ts";
import { HOME, rec } from "./helpers.ts";

const home = mkdtempSync(join(tmpdir(), "suspender-drawn-"));
after(() => rmSync(home, { recursive: true, force: true }));
useStandIns({ appHome: join(home, ".config", "herdr-app"), home, readsHang: false, record: true });
const { SleepPane } = await import("../../src/ui/sleepPane.ts");
const { PopupView } = await import("../../src/ui/popup.ts");
const { PanelView } = await import("../../src/ui/panel.ts");
const { STRIP_TEXT } = await import("../../src/ui/format.ts");

interface Drawn {
  kind: string;
  arg?: unknown;
  calls: unknown[][];
  kids: unknown[];
}

const isDrawn = (x: unknown): x is Drawn => typeof x === "object" && x !== null && "calls" in x && "kids" in x;
const called = (el: Drawn, name: string): unknown[][] => el.calls.filter((c) => c[0] === name);
const has = (el: Drawn, name: string, ...args: unknown[]): boolean =>
  called(el, name).some((c) => args.every((a, i) => c[i + 1] === a));
function* walk(el: unknown): Generator<Drawn> {
  if (isDrawn(el)) {
    yield el;
    for (const kid of el.kids) {
      yield* walk(kid);
    }
  }
}
const byId = (root: unknown, id: string): Drawn | undefined => [...walk(root)].find((el) => has(el, "id", id));
const texts = (el: Drawn): string[] => [...walk(el)].flatMap((x) => x.kids.filter((k) => typeof k === "string"));

const ID = "0f0e0d0c-0b0a-4908-8706-050403020100";
const KEY: SessionKey = `claude:${ID}`;
const CWD = `${HOME}\\dev\\mobile-app`;

async function world() {
  const sim = new Sim();
  const ports = sim.ports();
  const pane = sim.addModPane(TAB, { role: "sleep", key: KEY });
  const file = emptyStore();
  file.sessions[KEY] = rec(ID, "asleep", {
    key: KEY,
    cwd: CWD,
    pane,
    spaceId: "sp1",
    sleptAtMs: sim.now,
    memFreedMb: 611,
    info: {
      title: "Fix cold-start crash on Android 15 when edge-to-edge insets load early",
      firstPrompt: "Why does the app crash on cold start?",
      lastReply: "Insets are read too early.",
      branch: "fix/android15-cold-start",
      model: "claude-opus-5-5",
      cwd: CWD,
      repoRoot: CWD,
      messages: 6,
    },
  });
  ports.files.set(defaultStorePath(ports), serializeStore(file));
  const engine = new Engine({
    host: sim,
    ports,
    id: "copy",
    adapters: { claude: claudeAdapter, codex: fakeAdapter("codex") },
  });
  await engine.load();
  const cx = {
    spawn: () => undefined,
    notify: () => undefined,
  } as unknown as AsyncContext;
  return { sim, ports, engine, cx };
}

/** Gives a view the size Herdr reports for its root, then draws it again. */
function sized(view: { render(cx: AsyncContext): unknown }, cx: AsyncContext, width: number, height: number): Drawn {
  const first = view.render(cx);
  assert.ok(isDrawn(first));
  const onSize = called(first, "on_size_change")[0]?.[1];
  assert.equal(typeof onSize, "function", "the root reports its size");
  (onSize as (size: { width: number; height: number }, cx: AsyncContext) => void)({ width, height }, cx);
  const again = view.render(cx);
  assert.ok(isDrawn(again));
  return again;
}

describe("the roots name their text size", () => {
  it("the popup's root", async () => {
    const { engine, ports, cx } = await world();
    const root = new PopupView(engine, ports, KEY, null, null).render(cx);
    assert.ok(isDrawn(root));
    assert.ok(has(root, "text_size", 12), JSON.stringify(called(root, "text_size")));
  });

  it("the sleeping pane's root", async () => {
    const { engine, sim, ports, cx } = await world();
    const root = new SleepPane(engine, sim, ports, KEY).render(cx);
    assert.ok(isDrawn(root));
    assert.ok(has(root, "text_size", STRIP_TEXT), JSON.stringify(called(root, "text_size")));
  });
});

describe("the last item of a line gives way with …", () => {
  const lastGivesWay = (line: Drawn): void => {
    // The line's items: groups (an icon and a text) between separators.
    const items = line.kids.filter((k): k is Drawn => isDrawn(k) && k.kind === "h_flex");
    assert.ok(items.length >= 1, "the line has items");
    items.forEach((item, i) => {
      const last = i === items.length - 1;
      assert.equal(has(item, "flex_none"), !last, `item ${i}: flex_none`);
      if (last) {
        assert.ok(has(item, "flex_shrink", 1) && has(item, "min_w", 0), "the last item can shrink");
        const text = item.kids.find((k): k is Drawn => isDrawn(k) && k.kind === "div");
        assert.ok(text !== undefined && has(text, "truncate"), "its text ends in …");
      }
    });
  };

  it("in a row of the Sessions list", async () => {
    const { engine, sim, ports, cx } = await world();
    (globalThis as { suspenderSpaces?: unknown }).suspenderSpaces = [{ id: "sp1", name: "mobile-app", machine: null }];
    const panel = new PanelView({ engine, host: sim, ports, mode: "panel", overlay: null });
    const root = sized(panel, cx, 368, 900);
    const line = [...walk(root)].find(
      (el) => has(el, "whitespace_nowrap") && has(el, "overflow_hidden") && has(el, "flex_1"),
    );
    assert.ok(line !== undefined, "the row's second line");
    lastGivesWay(line);
  });

  it("in the strip of a sleeping pane", async () => {
    const { engine, sim, ports, cx } = await world();
    const root = sized(new SleepPane(engine, sim, ports, KEY), cx, 900, 600);
    const line = [...walk(root)].find(
      (el) => has(el, "whitespace_nowrap") && has(el, "overflow_hidden") && has(el, "flex_1"),
    );
    assert.ok(line !== undefined, "the strip's info line");
    lastGivesWay(line);
  });
});

describe("the strip's button in a narrow pane", () => {
  it("draws its label where it fits", async () => {
    const { engine, sim, ports, cx } = await world();
    const root = sized(new SleepPane(engine, sim, ports, KEY), cx, 900, 600);
    const button = byId(root, "strip-resume");
    assert.ok(button !== undefined);
    assert.ok(texts(button).includes("Resume"));
  });

  it("folds to its icon, the label in a tooltip, where the label would not fit", async () => {
    const { engine, sim, ports, cx } = await world();
    const root = sized(new SleepPane(engine, sim, ports, KEY), cx, 130, 600);
    const button = byId(root, "strip-resume");
    assert.ok(button !== undefined);
    assert.deepEqual(texts(button), []);
    assert.ok(has(button, "tooltip", "Resume"));
    assert.ok([...walk(button)].some((el) => el.kind === "svg" && String(el.arg).endsWith("play.svg")));
  });
});
