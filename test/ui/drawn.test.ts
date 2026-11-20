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
const { CoverView } = await import("../../src/ui/cover.ts");
const { COVER_KEY } = await import("../../src/runtime/engine.ts");
const { openPopup } = await import("../../src/ui/popup.ts");
const { STRIP_TEXT, STRIP_STATUS_INDENT, STRIP_STATUS_TEXT, STRIP_HEIGHT_ESTIMATE, statusWidth } = await import(
  "../../src/ui/format.ts"
);
const { uiMeasure } = await import("../../src/ui/textWidth.ts");
const { windowPx } = await import("../../src/core/scale.ts");
const { FACT_ROW_PX } = await import("../../src/ui/sessionsModel.ts");
const { FOOTER_LINK_GAP, LINE_GAP } = await import("../../src/ui/updateLine.ts");

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

async function world(lastScreen: string | null = null, restore = false) {
  const sim = new Sim();
  const ports = sim.ports();
  const pane = sim.addModPane(TAB, { role: "sleep", key: KEY });
  const file = emptyStore();
  file.sessions[KEY] = rec(ID, restore ? "interrupted" : "asleep", {
    ...(restore ? { restore: true } : {}),
    key: KEY,
    cwd: CWD,
    pane,
    spaceId: "sp1",
    sleptAtMs: sim.now,
    memFreedMb: 611,
    lastScreen,
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

describe("the last screen on a sleeping tab (Herdr 0.1.16 settings)", () => {
  it("draws the text in the terminal's weight and each character in its cell when the cells are wider", async () => {
    const { engine, sim, ports, cx } = await world("ab");
    const g = globalThis as Record<string, unknown>;
    g["suspenderSettings"] = {
      zoom: 1,
      font_family: "JetBrains Mono",
      font_size: 14,
      font_weight: 300,
      terminal_cell_width: 1.5,
    };
    try {
      const root = sized(new SleepPane(engine, sim, ports, KEY), cx, 900, 600);
      const glyphs = [...walk(root)].filter((el) => el.kids.length === 1 && (el.kids[0] === "a" || el.kids[0] === "b"));
      assert.equal(glyphs.length, 2, "one element per character, not a run");
      for (const el of glyphs) {
        assert.ok(has(el, "font_weight", 300), "the terminal's weight");
      }
      // 12 px cells, the glyph 2 px into each (Herdr's glyph_x).
      assert.deepEqual(
        glyphs.map((el) => called(el, "left")[0]?.[1]),
        [2, 14],
      );
      // On macOS, CoreText's placement: the unrounded 1.8 px.
      const mac = { ...ports, platform: "macos" as const };
      const onMac = sized(new SleepPane(engine, sim, mac, KEY), cx, 900, 600);
      const at = [...walk(onMac)]
        .filter((el) => el.kids.length === 1 && el.kids[0] === "a")
        .map((el) => called(el, "left")[0]?.[1] as number);
      assert.equal(at.length, 1);
      assert.ok(Math.abs((at[0] ?? 0) - 1.8) < 1e-9, `${at[0]}`);
    } finally {
      delete g["suspenderSettings"];
    }
  });
});

describe("the last screen of a sleeping tab and its strip", () => {
  it("draws the screen's last rows above the strip, where an agent's status line is", async () => {
    // A screen as tall as the pane: 40 rows, the last one a status line.
    const lines = Array.from({ length: 39 }, (_, i) => `row ${i + 1}`);
    lines.push("STATUS LINE");
    const { engine, sim, ports, cx } = await world(lines.join(String.fromCharCode(10)));
    const root = sized(new SleepPane(engine, sim, ports, KEY), cx, 900, 702);
    const status = [...walk(root)].find((el) => el.kids.includes("STATUS LINE"));
    assert.ok(status !== undefined, "the status line is drawn");
    const top = called(status, "top")[0]?.[1] as number;
    const strip = byId(root, "strip");
    assert.ok(strip !== undefined);
    // Rows are placed from the screen's top (12 px padding plus what is left over): the status line ends
    // above the strip's top, which is the pane's height less the strip's.
    const screenTop = [...walk(root)]
      .map((el) => called(el, "top")[0]?.[1])
      .find((v) => typeof v === "number" && v > 0) as number;
    assert.ok(screenTop + top + 18 <= 702 - STRIP_HEIGHT_ESTIMATE, `${screenTop} + ${top} + 18`);
  });

  it("follows the strip's own height once it reports it (a status that wraps to two lines)", async () => {
    const lines = Array.from({ length: 39 }, (_, i) => `row ${i + 1}`);
    lines.push("STATUS LINE");
    const { engine, sim, ports, cx } = await world(lines.join(String.fromCharCode(10)));
    const pane = new SleepPane(engine, sim, ports, KEY);
    const first = sized(pane, cx, 900, 702);
    const report = called(byId(first, "strip") as Drawn, "on_size_change")[0]?.[1];
    assert.equal(typeof report, "function", "the strip reports its size");
    (report as (size: { width: number; height: number }, cx: AsyncContext) => void)({ width: 900, height: 120 }, cx);
    const root = sized(pane, cx, 900, 702);
    const status = [...walk(root)].find((el) => el.kids.includes("STATUS LINE"));
    assert.ok(status !== undefined);
    const top = called(status, "top")[0]?.[1] as number;
    const screenTop = [...walk(root)]
      .map((el) => called(el, "top")[0]?.[1])
      .find((v) => typeof v === "number" && v > 0) as number;
    assert.ok(screenTop + top + 18 <= 702 - 120, `${screenTop} + ${top} + 18`);
  });
});

describe("a sleeping pane whose session is up a moment before the agent takes its slot", () => {
  it("still shows the wake, not a strip without its line", async () => {
    const { engine, sim, ports, cx } = await world("first row");
    const pane = new SleepPane(engine, sim, ports, KEY);
    const before = sized(pane, cx, 900, 600);
    const rows = texts(before).filter((x) => x.startsWith("first"));
    // The record goes to running when the agent is up, before showWoken swaps it in.
    const rec = engine.record(KEY);
    assert.ok(rec);
    (rec as { state: string }).state = "running";
    const after = sized(pane, cx, 900, 600);
    assert.ok(
      texts(byId(after, "strip") as Drawn).some((x) => x === "Ready" || x === "Starting"),
      texts(after).join(" | "),
    );
    assert.deepEqual(
      texts(after).filter((x) => x.startsWith("first")),
      rows,
    );
  });
});

describe("the cover over the work area (Sleep and Resume behind it)", () => {
  it("draws the session's sleeping pane in the tab's frame: border, header and the strip", async () => {
    const { engine, sim, ports, cx } = await world("first row");
    sim.coverLayout();
    const g = globalThis as Record<string, unknown>;
    g["suspenderTheme"] = { accent: "#89b4fa", border: "#45475a", background: "#1e1e2e", foreground: "#cdd6f4" };
    try {
      const shown = { ...engine.record(KEY), state: "stopping" };
      sim.setShared(COVER_KEY, { key: KEY, rec: shown, at: sim.now });
      const root = sized(new CoverView(engine, sim, ports), cx, 900, 702);
      const frame = byId(root, "cover-frame");
      assert.ok(frame !== undefined);
      assert.ok(has(frame, "rounded", 10));
      assert.ok(has(frame, "border", 1));
      assert.ok(has(frame, "border_color", "#89b4fa"), "the focused pane's border");
      const header = byId(root, "cover-header");
      assert.ok(header !== undefined && has(header, "h", 30));
      assert.ok(texts(header).includes("suspender"), "the title Herdr gives a mod pane");
      assert.ok(byId(root, "strip") !== undefined, "the sleeping pane's strip");
      assert.ok(
        texts(root).some((x) => x.includes("first row")),
        "its last screen",
      );
      assert.ok(texts(root).includes("Stopping…"), texts(root).join(" | "));
    } finally {
      delete g["suspenderTheme"];
    }
  });

  it("hands the size it drew at to the sleeping pane, whose first frame then has the same rows", async () => {
    const lines = Array.from({ length: 50 }, (_, i) => `row ${i + 1}`);
    const { engine, sim, ports, cx } = await world(lines.join(String.fromCharCode(10)));
    sim.coverLayout();
    sim.setShared(COVER_KEY, { key: KEY, rec: engine.record(KEY), at: sim.now });
    const covered = sized(new CoverView(engine, sim, ports), cx, 900, 702);
    const first = (root: unknown): string | undefined =>
      [...walk(root)].flatMap((el) => el.kids).find((k): k is string => typeof k === "string" && k.startsWith("row "));
    // A new sleeping pane, drawn once before Herdr reports its size.
    const pane = new SleepPane(engine, sim, ports, KEY).render(cx);
    assert.equal(first(pane), first(covered));
  });

  it("draws the wake at the step it was at when it went up, though the engine has cleared it since", async () => {
    const { engine, sim, ports, cx } = await world("first row");
    sim.coverLayout();
    const g = globalThis as Record<string, unknown>;
    g["suspenderTheme"] = { foreground: "#ffffff", muted: "#888888", dim: "#444444" };
    try {
      const shown = { ...engine.record(KEY), state: "waking" };
      sim.setShared(COVER_KEY, { key: KEY, rec: shown, step: "ready", at: sim.now });
      const root = sized(new CoverView(engine, sim, ports), cx, 900, 702);
      const ready = [...walk(root)].find((el) => el.kids.includes("Ready"));
      assert.ok(ready !== undefined && has(ready, "text_color", "#ffffff"), "Ready is the step under way");
    } finally {
      delete g["suspenderTheme"];
    }
  });

  it("draws nothing of a session when no flow holds it", async () => {
    const { engine, sim, ports, cx } = await world("first row");
    sim.coverLayout();
    const root = sized(new CoverView(engine, sim, ports), cx, 900, 702);
    assert.equal(byId(root, "strip"), undefined);
  });
});

describe("a session waiting in the restore line after a restart", () => {
  it("its sleeping tab says so, with no button to press", async () => {
    const { engine, sim, ports, cx } = await world(null, true);
    const root = sized(new SleepPane(engine, sim, ports, KEY), cx, 900, 600);
    const strip = byId(root, "strip");
    assert.ok(strip !== undefined);
    assert.ok(
      texts(strip).some((x) => x.startsWith("Resumes after the restart by itself · 1 of 1")),
      texts(strip).join(" | "),
    );
    assert.equal([...walk(strip)].filter((el) => called(el, "on_click").length > 0).length, 0, "nothing to press");
  });

  it("Sessions says how far the line is, and its row has no Resume", async () => {
    const { engine, sim, ports, cx } = await world(null, true);
    const root = sized(new PanelView({ engine, host: sim, ports, mode: "panel", overlay: null }), cx, 368, 900);
    const line = byId(root, "restore-line");
    assert.ok(line !== undefined, "the line's banner");
    assert.ok(texts(line).includes("Resuming after the restart · 1 of 1"), texts(line).join(" | "));
    assert.equal(byId(root, `row-action-${KEY}`), undefined);
    assert.ok(texts(root).includes("in line"));
  });

  it("Sessions has no banner when no line is running", async () => {
    const { engine, sim, ports, cx } = await world();
    const root = sized(new PanelView({ engine, host: sim, ports, mode: "panel", overlay: null }), cx, 368, 900);
    assert.equal(byId(root, "restore-line"), undefined);
    assert.ok(byId(root, `row-action-${KEY}`) !== undefined, "an asleep row keeps its Resume");
  });
});

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
    const { PILL_EDGE_PAD, PILL_GAP, PILL_HEIGHT, PILL_ICON } = await import("../../src/core/scale.ts");
    const { sim, engine, cx } = await world();
    const agent = sim.addTerminal({ agent: "claude" });
    sim.focus = { pane: agent.pane, terminal: agent.address };
    const root = new PillView(engine, sim).render(cx);
    const pill = byId(root, "sleep-pill");
    assert.ok(pill, "an agent in focus: the pill is drawn");
    assert.ok(has(pill, "h", PILL_HEIGHT), "its height");
    assert.ok(has(pill, "pr", PILL_EDGE_PAD), "the padding on the moon's side");
    assert.ok(has(pill, "gap", PILL_GAP), "the gap that keeps the label out of the peek");
    assert.ok(
      [...walk(pill)].some((el) => has(el, "size", PILL_ICON)),
      "the moon",
    );
  });

  // Herdr opens the drawer while the pointer is on it and closes it when the pointer leaves. A
  // drawer that draws nothing under the pointer (its agent just went to sleep from it) is never
  // left, so it came back open the next time an agent was in focus and stayed open.
  it("keeps its row under the pointer when its agent leaves focus, and only then draws nothing", async () => {
    const { PillView } = await import("../../src/ui/pill.ts");
    const { sim, engine, cx } = await world();
    const agent = sim.addTerminal({ agent: "claude" });
    sim.focus = { pane: agent.pane, terminal: agent.address };
    let hovered = true;
    const view = new PillView(engine, sim, () => hovered);
    assert.ok(byId(view.render(cx), "sleep-pill"), "an agent in focus");
    sim.focus = { pane: "p-sleeping", terminal: null };
    assert.ok(byId(view.render(cx), "sleep-pill"), "the pointer is still on it: the same row");
    hovered = false;
    assert.equal(byId(view.render(cx), "sleep-pill"), undefined, "the pointer left: nothing");
  });

  it("draws nothing when no agent is in focus and it was not showing one", async () => {
    const { PillView } = await import("../../src/ui/pill.ts");
    const { sim, engine, cx } = await world();
    sim.focus = { pane: "p-none", terminal: null };
    assert.equal(byId(new PillView(engine, sim, () => true).render(cx), "sleep-pill"), undefined);
  });
});

describe("the agent's tile beside the title (user: «иконка агента должна быть напротив заголовка»)", () => {
  // Centred on the title's line, not on a size picked for one font: the tile sits
  // in a box as tall as the title's row, both centre their content, and both
  // start at the top of the row. The UI font's own metrics (ascent, descent, line
  // height) then move the title's glyphs, never where the line's middle is.
  const parentOf = (root: unknown, kid: Drawn): Drawn | undefined =>
    [...walk(root)].find((el) => el.kids.includes(kid));
  const tileIn = (root: unknown): Drawn | undefined =>
    [...walk(root)].find((el) => has(el, "rounded", 4) && el.kids.includes("C"));

  it("in a Sessions row: a box as tall as the title's row, centred, both at the row's top", async () => {
    const { ROW_TITLE_PX } = await import("../../src/ui/sessionsModel.ts");
    const { engine, sim, ports, cx } = await world();
    const root = new PanelView({ engine, host: sim, ports, mode: "window", overlay: null }).render(cx);
    const row = byId(root, `row-${KEY}`);
    assert.ok(row, "the row");
    assert.ok(has(row, "items_start"), "the row's children start at its top");
    const tile = tileIn(row);
    assert.ok(tile, "the tile");
    const box = parentOf(row, tile);
    assert.ok(box !== undefined && box !== row, "the tile has a box of its own");
    assert.ok(row.kids.includes(box), "the box is the row's first column");
    assert.ok(has(box, "h", ROW_TITLE_PX), "as tall as the title's row");
    assert.ok(has(box, "items_center"), "the tile centred in it");
    const title = [...walk(row)].find((el) => has(el, "text_size", 12.5) && has(el, "truncate"));
    assert.ok(title, "the title");
    const titleRow = parentOf(row, title);
    assert.ok(titleRow, "the title's row");
    assert.ok(has(titleRow, "h", ROW_TITLE_PX), "the title's row has that height");
    assert.ok(has(titleRow, "items_center"), "the title centred in it");
    const column = parentOf(row, titleRow);
    assert.ok(column !== undefined && row.kids.includes(column), "beside the tile's box");
    assert.equal(column.kids[0], titleRow, "the title's row is the first line");
    for (const el of [column, titleRow, box]) {
      for (const side of ["p", "py", "pt", "m", "my", "mt"]) {
        assert.equal(called(el, side).length, 0, `nothing above its top: ${side}`);
      }
    }
  });

  it("in the popup: the tile and the agent's name centred in one row", async () => {
    const { engine, ports, cx } = await world();
    const root = new PopupView(engine, ports, KEY, null, null).render(cx);
    const tile = tileIn(root);
    assert.ok(tile, "the tile");
    const header = parentOf(root, tile);
    assert.ok(header, "the header");
    assert.ok(has(header, "items_center"), "centred across the header");
    assert.ok(texts(header).includes("Claude Code"), "the name beside it");
  });
});

const { World, LIVE } = await import("../update/world.ts");
const { Updater, STARTUP_DELAY_MS } = await import("../../src/runtime/updater.ts");

describe("the update line and the switch in Sessions", () => {
  async function withRelease() {
    const w = new World();
    w.install(LIVE, "0.1.2");
    w.publish("0.1.3");
    const updates = new Updater(w.deps("0.1.2"));
    await updates.load();
    w.now += STARTUP_DELAY_MS;
    await updates.tick();
    return { w, updates };
  }

  it("draws the release with its two buttons, labelled, and the switch on", async () => {
    const { engine, sim, ports, cx } = await world();
    const { updates } = await withRelease();
    const root = sized(
      new PanelView({ engine, host: sim, ports, mode: "panel", overlay: null, updates }),
      cx,
      368,
      900,
    );
    const line = byId(root, "update-line");
    assert.ok(line !== undefined, "the line is drawn");
    assert.ok(texts(line).includes("Suspender 0.1.3 is out"));
    for (const [id, label] of [
      ["update-whatsNew", "What's new"],
      ["update-update", "Update"],
    ] as const) {
      const button = byId(root, id);
      assert.ok(button !== undefined && texts(button).includes(label), id);
    }
    const footer = byId(root, "update-footer");
    assert.ok(footer !== undefined);
    assert.ok(texts(footer).includes("Suspender 0.1.2"));
    assert.ok(texts(footer).includes("Check for updates"));
  });

  it("folds the buttons to icons with their labels in tooltips on a narrow panel", async () => {
    const { engine, sim, ports, cx } = await world();
    const { updates } = await withRelease();
    const root = sized(
      new PanelView({ engine, host: sim, ports, mode: "panel", overlay: null, updates }),
      cx,
      150,
      900,
    );
    const button = byId(root, "update-update");
    assert.ok(button !== undefined);
    assert.ok(!texts(button).includes("Update"), "no label");
    assert.ok(has(button, "tooltip", "Update"));
    assert.ok(
      [...walk(button)].some((el) => el.kind === "svg"),
      "its icon",
    );
  });

  it("draws neither without an updater, and no line when nothing is newer", async () => {
    const { engine, sim, ports, cx } = await world();
    const bare = sized(new PanelView({ engine, host: sim, ports, mode: "panel", overlay: null }), cx, 368, 900);
    assert.equal(byId(bare, "update-line"), undefined);
    assert.equal(byId(bare, "update-footer"), undefined);
    const w = new World();
    w.install(LIVE, "0.1.2");
    const updates = new Updater(w.deps("0.1.2"));
    await updates.load();
    const root = sized(
      new PanelView({ engine, host: sim, ports, mode: "panel", overlay: null, updates }),
      cx,
      368,
      900,
    );
    assert.equal(byId(root, "update-line"), undefined);
    assert.ok(byId(root, "update-footer") !== undefined);
  });

  it("has Check now beside the version, and says what it found there", async () => {
    const { engine, sim, ports, cx } = await world();
    const w = new World();
    w.install(LIVE, "0.1.2");
    w.publish("0.1.2");
    const updates = new Updater(w.deps("0.1.2"));
    await updates.load();
    const draw = (width: number) =>
      sized(new PanelView({ engine, host: sim, ports, mode: "panel", overlay: null, updates }), cx, width, 900);
    const button = byId(draw(368), "update-check-now");
    assert.ok(button !== undefined && texts(button).includes("Check now"));
    assert.ok(called(button, "on_click").length > 0, "it can be pressed");
    await updates.checkNow();
    const done = byId(draw(368), "update-check-now");
    assert.ok(done !== undefined && texts(done).includes("Up to date"));
    assert.equal(called(done, "on_click").length, 0, "nothing to press while it reports");
    // Narrow: its icon, the words in a tooltip.
    const narrow = byId(draw(110), "update-check-now");
    assert.ok(narrow !== undefined && !texts(narrow).includes("Up to date"));
    assert.ok(has(narrow, "tooltip", "Up to date"));
  });

  it("draws Check now grey like the version beside it, set apart from the switch", async () => {
    const { engine, sim, ports, cx } = await world();
    const w = new World();
    w.install(LIVE, "0.1.2");
    w.publish("0.1.2");
    const updates = new Updater(w.deps("0.1.2"));
    await updates.load();
    const g = globalThis as Record<string, unknown>;
    const before = g["suspenderTheme"];
    g["suspenderTheme"] = { dim: "#6c7086", accent: "#89b4fa", border: "#45475a" };
    try {
      const root = sized(
        new PanelView({ engine, host: sim, ports, mode: "panel", overlay: null, updates }),
        cx,
        368,
        900,
      );
      const link = byId(root, "update-check-now");
      assert.ok(link !== undefined);
      assert.ok(has(link, "text_color", "#6c7086"), "the words are the footer's grey");
      assert.ok(!has(link, "text_color", "#89b4fa"), "not the accent");
      assert.ok(has(link, "mr", FOOTER_LINK_GAP - LINE_GAP), "a wider gap before the switch");
    } finally {
      g["suspenderTheme"] = before;
    }
  });
});
