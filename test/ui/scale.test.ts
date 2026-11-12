// The UI at every zoom: what Herdr reports is in window px, what the mod draws
// is in its own px times the zoom (core/scale.ts). Numbers marked "live" were
// read in a test Herdr 0.1.15 at zoom 2: the Sessions panel reported 736 px,
// a row's mouse event put it at 2458,361 (716 x 103), the window 3200 x 2000.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  modPx,
  PILL_EDGE_PAD,
  PILL_GAP,
  PILL_ICON,
  PILL_PEEK,
  pillButton,
  scaleOf,
  toMod,
  windowPx,
  ZOOM_MAX,
  ZOOM_MIN,
} from "../../src/core/scale.ts";
import { fitStrip, screenGrid, screenLook } from "../../src/ui/format.ts";
import {
  fitRow,
  popupFacts,
  popupHeight,
  popupPosition,
  popupSize,
  ROW_BADGE_CHROME_PX,
  ROW_CHROME_PX,
  ROW_ITEM_GAP,
  ROW_MEM_GAP_PX,
  ROW_MEM_ICON_PX,
  ROW_SMALL_TEXT,
  ROW_TEXT,
} from "../../src/ui/sessionsModel.ts";
import { textWidth, uiMeasure } from "../../src/ui/textWidth.ts";
import { HOME, rec } from "./helpers.ts";

const w = windowPx;
const rect = (left: number, top: number, width: number, height: number) => ({
  left: w(left),
  top: w(top),
  width: w(width),
  height: w(height),
});
const popup = { width: modPx(344), height: modPx(326) };

describe("scaleOf: the zoom Herdr applies, from settings()", () => {
  it("reads zoom", () => {
    assert.deepEqual(scaleOf({ zoom: 2, ui_font_size: 13 }), { zoom: 2 });
    assert.deepEqual(scaleOf({ zoom: 1.1 }), { zoom: 1.1 });
  });
  it("is zoom 1 when settings say nothing usable", () => {
    for (const s of [null, undefined, {}, { zoom: "2" }, { zoom: 0 }, { zoom: -1 }, { zoom: Number.NaN }]) {
      assert.deepEqual(scaleOf(s), { zoom: 1 });
    }
  });
  it("keeps to Herdr's range, 0.5 to 3", () => {
    assert.deepEqual(scaleOf({ zoom: 9 }), { zoom: 3 });
    assert.deepEqual(scaleOf({ zoom: 0.1 }), { zoom: 0.5 });
  });
  it("does not change with the UI font size: the mod names every text size in px", () => {
    for (const ui of [10, 13, 20]) {
      assert.deepEqual(scaleOf({ zoom: 1.5, ui_font_size: ui }), { zoom: 1.5 });
    }
  });
});

describe("bug: the popup at zoom 2 stood 344 px into its own row", () => {
  // Live: row 2458,361 716x103 in a 3200x2000 window; the popup is 344 x 326 of the
  // mod's px, so 688 x 652 in the window. Left of the row with an 8 px (16 window px)
  // gap: x = 2458 - 16 - 688 = 1754; 6 px (12) above the row's top: y = 349.
  it("stands left of its row, 8 px of the mod's away, at 6 px above the row's top", () => {
    const at = popupPosition(rect(2458, 361, 716, 103), "row", popup, { width: w(3200), height: w(2000) }, { zoom: 2 });
    assert.deepEqual(at, { x: 1754, y: 349 });
  });
});

describe("bug: at zoom 2 a row of the Sessions list cut its folder chip instead of moving it to +N", () => {
  // Live: "Retry failed Stripe webhooks with backoff" in a panel 368 px of the mod's wide,
  // which reports 736 at zoom 2. The mod draws the row at the same size of its own px at
  // every zoom, so the row must keep the same items: at zoom 1 some of them go to +N.
  const webhooks = rec("9e2d4a71-5c3b-4e8f-a6d2-1b7c8f0e3a95", "asleep", {
    info: {
      branch: "fix/webhook-retries",
      model: "claude-opus-5-5",
      cwd: `${HOME}\\dev\\billing-svc`,
      repoRoot: `${HOME}\\dev\\billing-svc`,
    },
  });
  const six = (text: string): number => text.length * 6;
  const keys = (reported: number, zoom: number) => {
    const r = fitRow(webhooks, w(reported), "486 MB", "\\", six, { zoom });
    return { shown: r.segs.map((s) => s.key), hidden: r.hidden };
  };

  it("keeps at zoom 2 exactly what it keeps at zoom 1, where the folder and the id went to +N", () => {
    const one = keys(368, 1);
    assert.ok(one.hidden >= 2 && !one.shown.includes("folder"), JSON.stringify(one));
    assert.deepEqual(keys(736, 2), one);
  });
});

describe("the last screen of a sleeping tab at zoom 2", () => {
  // The pane reports its height in window px. JetBrains Mono 14 at zoom 2 draws 37 device
  // px rows (round(28 x 1.32)), 18.5 of the mod's px. A pane 702 px of the mod's tall
  // (1404 reported) holds (702 - 2 x 12) / 18.5 = 36 rows, as the terminal it replaced did;
  // the 12 px left under them are shared, so the first row is at 12 + 6.
  it("fits the rows the terminal had, not twice as many", () => {
    const look = screenLook({ font_family: "JetBrains Mono", font_size: 14, zoom: 2, terminal_padding: [14, 12] });
    assert.deepEqual(screenGrid(w(1404), look), { rows: 36, top: 18 });
  });
});

describe("the strip of a sleeping tab at zoom 2", () => {
  // Live: the sleeping tab "cold start" at zoom 2 reported 1874 px; its strip showed the
  // title cut to "…insets…" and every item, because the room was taken as 1874 of the
  // mod's px. Drawn at the same size of its own px, it must keep what it keeps at zoom 1.
  const cold = rec("2a6d9f4e-3c81-4b7a-9e05-f4b2c8d1a796", "asleep", {
    info: {
      title: "Fix cold-start crash on Android 15 when edge-to-edge insets load early",
      branch: "fix/android15-cold-start",
      model: "claude-opus-5-5",
      cwd: `${HOME}\\dev\\mobile-app`,
      repoRoot: `${HOME}\\dev\\mobile-app`,
    },
  });
  const resume = [{ action: "resume", label: "Resume" }];

  it("keeps at zoom 2 what it keeps at zoom 1, where the folder went to +1", () => {
    const one = fitStrip(cold.info, resume, w(937), "\\", { zoom: 1 });
    assert.ok(one.hidden >= 1 && one.title, JSON.stringify(one));
    assert.deepEqual(fitStrip(cold.info, resume, w(1874), "\\", { zoom: 2 }), one);
  });
});

describe("text widths: Geist as Herdr draws it (measured on screen at zoom 1)", () => {
  // herdr-app shot of the Sessions panel at zoom 1: the model "claude-sonnet-4-5-20250929"
  // at 11.5 px spans 165 px, the branch "fix/flaky-che…ut-tests" 120 px; a popup title
  // "Перевести авторизацию портала на", semibold 13.5 px, 246 px.
  const near = (got: number, want: number) => assert.ok(Math.abs(got - want) <= want * 0.02, `${got} vs ${want}`);
  it("matches the drawn widths within 2 %", () => {
    near(textWidth("claude-sonnet-4-5-20250929", 11.5), 165);
    near(textWidth("fix/flaky-che…ut-tests", 11.5), 120);
    near(textWidth("Перевести авторизацию портала на", 13.5, "semibold"), 246);
  });
  it("guesses wide for characters Geist does not have", () => {
    assert.equal(textWidth("漢字", 10), 20);
  });
});

describe("every zoom: the popup by its row, the items whole or in +N", () => {
  // The UI font size is not an axis here: the mod names every text size in px, so it
  // cannot move anything (scaleOf ignores it; drawn.test.ts holds the roots to it).
  const ZOOMS = [0.8, 1, 1.1, 1.5, 2];
  const WINDOWS = [
    { width: 1600, height: 1000 },
    { width: 3200, height: 2000 },
    { width: 900, height: 700 },
  ];
  const PANEL = 368;
  const sessions = [
    rec("9e2d4a71-5c3b-4e8f-a6d2-1b7c8f0e3a95", "asleep", {
      memFreedMb: 486,
      info: {
        title: "Retry failed Stripe webhooks with backoff",
        branch: "fix/webhook-retries",
        model: "claude-opus-5-5",
        contextPct: 29,
        contextText: "286k / 1M",
        cwd: `${HOME}\\dev\\billing-svc`,
        repoRoot: `${HOME}\\dev\\billing-svc`,
      },
    }),
    rec("c47a8e13-2f6d-4b90-8e15-6d3a9c2b7f40", "interrupted", {
      info: {
        title: "Migrate invoices table to Postgres 16",
        branch: "chore/pg16-invoices",
        model: "claude-sonnet-4-5-20250929",
        contextText: "68k",
        cwd: `${HOME}\\dev\\billing-svc\\db\\migrations`,
        repoRoot: `${HOME}\\dev\\billing-svc`,
      },
    }),
    rec("2a6d9f4e-3c81-4b7a-9e05-f4b2c8d1a796", "asleep", {
      memFreedMb: 611,
      info: {
        title: "Fix cold-start crash on Android 15 when edge-to-edge insets load early",
        branch: "fix/android15-cold-start",
        model: "claude-opus-5-5",
        cwd: `${HOME}\\dev\\mobile-app`,
        repoRoot: `${HOME}\\dev\\mobile-app`,
      },
    }),
    rec("8d65845f-73cb-4be6-aa62-4ab2279d0de0", "asleep", {
      info: { branch: "feat/refresh", model: "Opus 5.5", cwd: `${HOME}\\dev\\api-gateway` },
    }),
  ];

  /** What the second line of a row draws, in the mod's px: items, separators, the badge. */
  const drawnRow = (fit: { segs: { text: string; extra?: number }[]; hidden: number }): number => {
    const items = fit.segs.reduce((sum, s) => sum + textWidth(s.text, ROW_TEXT) + (s.extra ?? 0), 0);
    const seps = Math.max(0, fit.segs.length - 1) * (2 * ROW_ITEM_GAP + textWidth("·", ROW_TEXT));
    const badge = fit.hidden > 0 ? ROW_ITEM_GAP + ROW_BADGE_CHROME_PX + textWidth(`+${fit.hidden}`, ROW_SMALL_TEXT) : 0;
    return items + seps + badge;
  };

  for (const zoom of ZOOMS) {
    const scale = scaleOf({ zoom });
    const z = (px: number): number => px * zoom;
    for (const win of WINDOWS) {
      const name = `zoom ${zoom}, window ${win.width}x${win.height}`;
      const viewport = { width: w(win.width), height: w(win.height) };
      it(`${name}: the row's popup`, () => {
        // The panel at the window's right edge (8 px margin), a row 4 px inside it, 200 px down.
        const panelLeft = win.width - z(PANEL + 8);
        const row = rect(panelLeft + z(4), z(200), z(PANEL - 8), z(53));
        const size = { width: modPx(344), height: modPx(326) };
        const at = popupPosition(row, "row", size, viewport, scale);
        assert.ok(at.x >= 0 && at.x + z(344) <= win.width + 1e-9, `inside, x ${at.x}`);
        assert.ok(at.y >= 0 && at.y + z(326) <= win.height + 1e-9, `inside, y ${at.y}`);
        if (row.left - z(8) - z(344) >= z(8)) {
          // Room on the left: right beside the row, 8 px of the mod's away, level with it.
          assert.ok(Math.abs(at.x + z(344) + z(8) - row.left) < 1e-9, `beside, x ${at.x}`);
        }
        if (row.top - z(6) + z(326) + z(8) <= win.height) {
          // Room below: level with the row, 6 px above its top; otherwise as low as the window lets it.
          assert.ok(Math.abs(at.y - (row.top - z(6))) < 1e-9, `level, y ${at.y}`);
        } else {
          assert.ok(Math.abs(at.y + z(326) + z(8) - win.height) < 1e-9, `lowest, y ${at.y}`);
        }
      });
      it(`${name}: the strip's popup`, () => {
        const strip = rect(z(280), win.height - z(70), win.width - z(280 + PANEL + 16), z(62));
        const size = { width: modPx(344), height: modPx(326) };
        const at = popupPosition(strip, "strip", size, viewport, scale);
        assert.ok(at.x >= 0 && at.x + z(344) <= win.width + 1e-9, `inside, x ${at.x}`);
        assert.ok(at.y >= 0 && at.y + z(326) <= win.height + 1e-9, `inside, y ${at.y}`);
        if (strip.top - z(8) - z(326) >= z(8)) {
          assert.ok(at.y + z(326) + z(8) <= strip.top + 1e-9, `above the strip, y ${at.y}`);
        }
      });
    }
    it(`zoom ${zoom}: a row's items, separators and badge fit what the row leaves them, and match zoom 1`, () => {
      for (const s of sessions) {
        const mem = s.memFreedMb === null ? null : `${s.memFreedMb} MB`;
        for (const panel of [200, 260, PANEL, 520]) {
          const here = fitRow(s, w(z(panel)), mem, "\\", uiMeasure, scale);
          assert.deepEqual(here, fitRow(s, w(panel), mem, "\\", uiMeasure, { zoom: 1 }));
          const memory = mem === null ? 0 : textWidth(mem, ROW_SMALL_TEXT) + ROW_MEM_ICON_PX + ROW_MEM_GAP_PX;
          const room = toMod(scale, w(z(panel))) - ROW_CHROME_PX - memory;
          assert.ok(drawnRow(here) <= room + 1e-9, `${panel}: ${drawnRow(here)} drawn in ${room}`);
        }
      }
    });
    it(`zoom ${zoom}: a strip keeps what it keeps at zoom 1`, () => {
      for (const s of sessions) {
        for (const pane of [600, 937, 1400]) {
          const actions = [{ action: "resume", label: "Resume" }];
          assert.deepEqual(
            fitStrip(s.info, actions, w(z(pane)), "\\", scale),
            fitStrip(s.info, actions, w(pane), "\\", { zoom: 1 }),
          );
        }
      }
    });
    it(`zoom ${zoom}: the last screen's rows fit the pane`, () => {
      const look = screenLook({ font_family: "JetBrains Mono", font_size: 14, zoom, terminal_padding: [14, 12] });
      for (const height of [400, 702, 1200]) {
        const grid = screenGrid(w(z(height)), look);
        const inside = height - 2 * look.padY;
        assert.ok(grid.rows * look.cellH <= inside + 1e-9, `${height}: ${grid.rows} rows fit`);
        assert.ok((grid.rows + 1) * look.cellH > inside, `${height}: no room for one more`);
        assert.ok(grid.top >= look.padY && grid.top + grid.rows * look.cellH <= height - look.padY + 1e-9);
      }
    });
  }
});

describe("a window too short for the popup", () => {
  // 500 window px at zoom 2 hold 250 px of the mod's, 234 inside the 8 px edges: fact rows go.
  it("gets a popup no taller than the window, and a full one when it fits", () => {
    const r = rec("2a6d9f4e-3c81-4b7a-9e05-f4b2c8d1a796", "asleep", {
      memFreedMb: 611,
      info: {
        title: "Cold start",
        firstPrompt: "Why?",
        lastReply: "Because.",
        branch: "fix/x",
        model: "m",
        messages: 4,
      },
    });
    const facts = popupFacts(r, { agentName: "Claude Code", home: HOME, sep: "\\", now: 0, usedMb: null });
    const short = popupSize(facts, { width: w(900), height: w(500) }, { zoom: 2 });
    assert.ok(short.height <= 234 && short.rows < facts.rows.length, JSON.stringify(short));
    assert.equal(short.width, 344);
    const tall = popupSize(facts, { width: w(3200), height: w(2000) }, { zoom: 2 });
    assert.equal(tall.height, popupHeight(facts));
    assert.ok(popupHeight(facts) > 234);
  });
});

describe("the moon of the Sleep pill (user: «кнопка-иконка месяца … квадратная, а не прямоугольная»)", () => {
  // At zoom 1.2 it was 38 x 48 window px: a 30 px peek beside a 28 px row in Herdr's 5 px frame.
  it("is a square button at every zoom (ui_font_size and the pane's size do not touch it)", () => {
    for (let zoom = ZOOM_MIN; zoom <= ZOOM_MAX; zoom += 0.1) {
      const button = pillButton(scaleOf({ zoom }));
      assert.ok(
        Math.abs(button.width - button.height) < 1e-9,
        `zoom ${zoom.toFixed(1)}: ${button.width} x ${button.height}`,
      );
    }
  });

  it("has the moon in the middle of what peeks", () => {
    assert.equal(PILL_EDGE_PAD * 2 + PILL_ICON, PILL_PEEK);
  });

  // User: «виден кусочек надписи который скрыт за кнопкой». The label starts after the moon's
  // padding, the moon and the gap; all of that must cover the peek, or the label's first
  // letters show at rest.
  it("keeps the label out of what peeks", () => {
    assert.ok(
      PILL_EDGE_PAD + PILL_ICON + PILL_GAP >= PILL_PEEK,
      `${PILL_EDGE_PAD} + ${PILL_ICON} + ${PILL_GAP} < ${PILL_PEEK}`,
    );
  });
});
