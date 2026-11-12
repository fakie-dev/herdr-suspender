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
const { openPopup } = await import("../../src/ui/popup.ts");
const { STRIP_TEXT, STRIP_STATUS_INDENT, STRIP_STATUS_TEXT, statusWidth } = await import("../../src/ui/format.ts");
const { uiMeasure } = await import("../../src/ui/textWidth.ts");
const { windowPx } = await import("../../src/core/scale.ts");
const { FACT_ROW_PX } = await import("../../src/ui/sessionsModel.ts");

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

describe("the popup in a window too short for all its fact rows", () => {
  const factRows = (root: Drawn): Drawn[] =>
    [...walk(root)].filter((el) => el.kind === "h_flex" && has(el, "h", FACT_ROW_PX) && has(el, "gap", 12));

  it("draws as many fact rows as it was given, from the top", async () => {
    const { engine, ports, cx } = await world();
    const all = factRows(new PopupView(engine, ports, KEY, null, null).render(cx) as unknown as Drawn);
    assert.ok(all.length >= 4, `the fixture has fact rows: ${all.length}`);
    const two = factRows(new PopupView(engine, ports, KEY, null, null, 2).render(cx) as unknown as Drawn);
    assert.equal(two.length, 2);
    assert.deepEqual(texts(two[0] as unknown as Drawn), texts(all[0] as unknown as Drawn));
    assert.equal(factRows(new PopupView(engine, ports, KEY, null, null, 0).render(cx) as unknown as Drawn).length, 0);
  });

  it("opens its overlay with the row count popupSize chose, for the window to draw", () => {
    const opened: Array<{ props?: { rows?: unknown; key?: unknown }; width?: unknown; height?: unknown }> = [];
    (globalThis as { suspenderOverlays?: unknown }).suspenderOverlays = opened;
    try {
      const at = { x: 10, y: 20 } as unknown as Parameters<typeof openPopup>[1];
      const id = openPopup({ key: KEY, usedMb: null } as unknown as Parameters<typeof openPopup>[0], at, {
        width: 344,
        height: 200,
        rows: 3,
      } as unknown as Parameters<typeof openPopup>[2]);
      assert.equal(typeof id, "string");
      assert.equal(opened.length, 1);
      assert.equal(opened[0]?.props?.rows, 3);
      assert.equal(opened[0]?.props?.key, KEY);
      assert.equal(opened[0]?.height, 200);
    } finally {
      (globalThis as { suspenderOverlays?: unknown }).suspenderOverlays = undefined;
    }
  });
});

describe("running sessions' rows in a shown panel (finding 5 of the blind review)", () => {
  it("say what a running session uses the way Sleep counts what it frees (user: «1.5 GB freed?»)", async () => {
    const { sim, ports } = await world();
    const agent = sim.addTerminal({ agent: "claude" });
    const running = rec("r1", "running", { key: "claude:r1" as SessionKey, terminal: agent.address });
    const engine = { records: () => [running], refreshRunning: async () => undefined } as unknown as Engine;
    const panel = new PanelView({ engine, host: sim, ports, mode: "window", overlay: null });
    let measured: Promise<unknown> = Promise.resolve();
    const cx = {
      spawn: (task: (cx: AsyncContext) => Promise<unknown>) => {
        measured = task(cx);
      },
      notify: () => undefined,
    } as unknown as AsyncContext;
    panel.tick(cx);
    await measured;
    // The sim's private working sets: 40 MB the shell, 200 MB the agent (its tasklist says 10 MB each).
    // With the terminal it was measured in (a woken session runs in a new one: usedNow).
    assert.deepEqual(
      (panel as unknown as { used: Map<SessionKey, { terminal: string; mb: number }> }).used.get(
        "claude:r1" as SessionKey,
      ),
      { terminal: agent.address, mb: 240 },
    );
  });

  it("have their facts read when the panel shows, then at most every 30 s", async () => {
    const { sim, ports } = await world();
    let reads = 0;
    const engine = {
      records: () => [],
      refreshRunning: async () => {
        reads++;
      },
    } as unknown as Engine;
    const panel = new PanelView({ engine, host: sim, ports, mode: "window", overlay: null });
    const cx = {
      spawn: (task: (cx: AsyncContext) => Promise<unknown>) => {
        void task(cx);
      },
      notify: () => undefined,
    } as unknown as AsyncContext;
    panel.tick(cx);
    await Promise.resolve();
    assert.equal(reads, 1, "read when shown");
    await sim.advance(5_000);
    panel.tick(cx);
    assert.equal(reads, 1, "not every round");
    await sim.advance(30_000);
    panel.tick(cx);
    assert.equal(reads, 2, "again after 30 s");
  });
});

describe("the popup's context line", () => {
  const bars = (root: unknown): Drawn[] => [...walk(root)].filter((el) => has(el, "h", 4) && has(el, "rounded", 2));

  it("draws the fill's bar when the window is known", async () => {
    const { engine, ports, cx } = await world();
    const info = engine.record(KEY)?.info;
    assert.ok(info);
    Object.assign(info, { contextPct: 5, contextText: "53k / 1M" });
    const root = new PopupView(engine, ports, KEY, null, null).render(cx);
    assert.ok(texts(root as unknown as Drawn).includes("Context 5%"));
    assert.ok(bars(root).length > 0);
  });

  it("says the tokens in use, without a bar, when it is not", async () => {
    const { engine, ports, cx } = await world();
    const info = engine.record(KEY)?.info;
    assert.ok(info);
    Object.assign(info, { contextPct: null, contextText: "53k" });
    const root = new PopupView(engine, ports, KEY, null, null).render(cx);
    assert.ok(texts(root as unknown as Drawn).includes("53k in use"));
    assert.equal(bars(root).length, 0);
  });
});

describe("the strip's status line in a narrow pane (finding 6 of the blind review)", () => {
  // Zoom 1.6, a narrow pane: "Asleep since 0…" — cut in the middle of the time;
  // live at 1.6 a wrapping div broke the words themselves ("Up / da / te / d").
  const statusLine = (root: unknown): Drawn | undefined =>
    [...walk(root)].find((el) => has(el, "pl", STRIP_STATUS_INDENT) && has(el, "text_size", STRIP_STATUS_TEXT));
  const wholeWords = (drawn: string[], full: string): void => {
    const words = full.split(/\s+/);
    drawn
      .join(" ")
      .replace(/…$/, "")
      .split(/\s+/)
      .filter((w) => w !== "")
      .forEach((w, i) => {
        assert.equal(w, words[i], `word ${i} is whole`);
      });
  };

  it("is whole words on at most two lines, the last ending in … when shortened", async () => {
    const { engine, sim, ports, cx } = await world();
    const full = texts(statusLine(sized(new SleepPane(engine, sim, ports, KEY), cx, 900, 600)) as Drawn).join(" ");
    assert.match(full, /^Asleep since/);
    for (const width of [100, 120, 140, 160, 200]) {
      const line = statusLine(sized(new SleepPane(engine, sim, ports, KEY), cx, width, 600));
      assert.ok(line !== undefined, `${width}: the status line`);
      const drawn = texts(line);
      assert.ok(drawn.length >= 1 && drawn.length <= 2, `${width}: ${drawn.length} lines`);
      wholeWords(drawn, full);
      const room = statusWidth(windowPx(width), { zoom: 1 });
      for (const text of drawn) {
        assert.ok(uiMeasure(text, STRIP_STATUS_TEXT) <= room, `${width}: "${text}" fits ${room} px`);
      }
      assert.ok(![...walk(line)].some((el) => has(el, "truncate")), `${width}: no cut by the edge`);
    }
  });

  it("the wake's steps where they fit, else the current one in whole words", async () => {
    const { engine, sim, ports, cx } = await world();
    const rec = engine.record(KEY);
    assert.ok(rec);
    rec.state = "waking";
    const wide = texts(statusLine(sized(new SleepPane(engine, sim, ports, KEY), cx, 900, 600)) as Drawn);
    assert.ok(wide.length >= 3, `the steps: ${wide.join(" | ")}`);
    const narrow = texts(statusLine(sized(new SleepPane(engine, sim, ports, KEY), cx, 120, 600)) as Drawn);
    assert.ok(narrow.length >= 1 && narrow.length <= 2, narrow.join(" | "));
    wholeWords(narrow, wide.find((s) => narrow[0]?.startsWith(s.split(" ")[0] ?? "")) ?? "");
  });
});

describe("the Sleep pill", () => {
  it("draws its row at the sizes that make the moon's button square (core/scale.ts)", async () => {
    const { PillView } = await import("../../src/ui/pill.ts");
    const { PILL_EDGE_PAD, PILL_HEIGHT, PILL_ICON } = await import("../../src/core/scale.ts");
    const { sim, engine, cx } = await world();
    const agent = sim.addTerminal({ agent: "claude" });
    sim.focus = { pane: agent.pane, terminal: agent.address };
    const root = new PillView(engine, sim).render(cx);
    const pill = byId(root, "sleep-pill");
    assert.ok(pill, "an agent in focus: the pill is drawn");
    assert.ok(has(pill, "h", PILL_HEIGHT), "its height");
    assert.ok(has(pill, "pr", PILL_EDGE_PAD), "the padding on the moon's side");
    assert.ok(
      [...walk(pill)].some((el) => has(el, "size", PILL_ICON)),
      "the moon",
    );
  });
});
