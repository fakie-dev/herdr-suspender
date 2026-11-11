// Every size: what the mod draws is whole, or visibly shortened ("…", "+N", an
// icon with its label in a tooltip), never cut through by the edge of its box.
// Widths are Geist's advances (ui/textWidth.ts, checked against the screen).

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TOGGLE_WIDTH_PX } from "../../src/core/layout.ts";
import { windowPx } from "../../src/core/scale.ts";
import {
  fitStrip,
  STRIP_GAP,
  STRIP_MOON_PX,
  STRIP_PAD_LEFT,
  STRIP_PAD_RIGHT,
  stripButtonWidth,
} from "../../src/ui/format.ts";
import {
  FACT_GAP_PX,
  FACT_ROW_PX,
  popupFacts,
  popupHeight,
  popupSize,
  QUOTE_MAX_LINES,
  QUOTE_TEXT,
  QUOTE_TEXT_PX,
  toggleWidth,
} from "../../src/ui/sessionsModel.ts";
import { textWidth, uiMeasure } from "../../src/ui/textWidth.ts";
import { HOME, rec } from "./helpers.ts";

const w = windowPx;

describe('"Sessions · N" in the layout without the tab bar copy', () => {
  it("fits its block for every N from 0 to 99", () => {
    for (let n = 0; n <= 99; n++) {
      const need = toggleWidth(n, uiMeasure);
      assert.ok(need <= TOGGLE_WIDTH_PX, `N ${n}: ${need.toFixed(1)} px in a ${TOGGLE_WIDTH_PX} px block`);
    }
  });
});

describe("the strip's buttons at any width of the sleeping pane", () => {
  const info = rec("2a6d9f4e-3c81-4b7a-9e05-f4b2c8d1a796", "asleep", {
    info: {
      title: "Fix cold-start crash on Android 15",
      branch: "fix/android15-cold-start",
      model: "claude-opus-5-5",
      cwd: `${HOME}devmobile-app`,
      repoRoot: `${HOME}devmobile-app`,
    },
  }).info;
  const sets = [
    [{ action: "resume", label: "Resume" }],
    [
      { action: "startNew", label: "Start new" },
      { action: "forget", label: "Forget" },
    ],
  ];

  it("draw their labels whole, or fold to icons, never past the pane's edge (from 100 px)", () => {
    for (const actions of sets) {
      for (let width = 100; width <= 1400; width += 2) {
        const fit = fitStrip(info, actions, w(width), "\\", { zoom: 1 });
        const icons = fit.buttons === "icon";
        const buttons = actions.reduce(
          (sum, a, i) => sum + STRIP_GAP + stripButtonWidth(a, i === 0, uiMeasure, icons ? "icon" : "label"),
          0,
        );
        // The moon and the gap after it (to the info line, which can be 0 px wide).
        const moon = fit.moon === false ? 0 : STRIP_MOON_PX + STRIP_GAP;
        const drawn = STRIP_PAD_LEFT + STRIP_PAD_RIGHT + moon + buttons;
        assert.ok(drawn <= width, `${actions.length} button(s) at ${width}: ${drawn.toFixed(1)} drawn`);
      }
    }
  });

  it("keep their labels while there is room for them", () => {
    const fit = fitStrip(info, sets[0] ?? [], w(400), "\\", { zoom: 1 });
    assert.equal(fit.buttons, "label");
    assert.equal(fit.moon, true);
  });
});

describe("the popup's first prompt and last reply", () => {
  const long =
    "Plan the move of the invoices table to the Postgres 16 cluster with no downtime, keep the old primary " +
    "as a fallback for a week, and write down every step so the on-call engineer can roll it back alone.";
  const column = QUOTE_TEXT_PX;
  const facts = popupFacts(
    rec("c47a8e13-2f6d-4b90-8e15-6d3a9c2b7f40", "asleep", {
      info: { firstPrompt: long, lastReply: "Short reply." },
    }),
    { agentName: "Claude Code", home: HOME, sep: "\\", now: 0, usedMb: null },
  );

  it("take two lines of the column at most, the second ending in … when the text goes on", () => {
    const lines = facts.promptLines;
    // Two, written out: the popup's height is built for two lines, so 3 must not pass.
    assert.equal(lines.length, 2);
    assert.equal(QUOTE_MAX_LINES, 2);
    for (const line of lines) {
      assert.ok(textWidth(line, QUOTE_TEXT) <= QUOTE_TEXT_PX, `"${line}" in ${QUOTE_TEXT_PX} px`);
    }
    assert.ok(lines.at(-1)?.endsWith("…"));
  });

  it("keep a margin for the width table, which runs ~1 % narrow: no line is filled to the edge", () => {
    const column = QUOTE_TEXT_PX;
    for (const line of facts.promptLines) {
      assert.ok(
        textWidth(line, QUOTE_TEXT) <= column / 1.02,
        `"${line}": ${textWidth(line, QUOTE_TEXT)} of ${column} px`,
      );
    }
  });

  it("a text whose first line would reach the edge still ends its first line without …", () => {
    // Words are added until the line stands between 98 % and 100 % of the column: the
    // old wrap kept it there, and a font 1 % wider than the table cut it with "…".
    const words = long.split(" ");
    let edge = "";
    for (let start = 0; start < words.length && edge === ""; start++) {
      let tried = "";
      for (const word of words.slice(start)) {
        tried = tried === "" ? word : `${tried} ${word}`;
        const width = textWidth(tried, QUOTE_TEXT);
        if (width > column) {
          break;
        }
        if (width > column * 0.98) {
          edge = tried;
          break;
        }
      }
    }
    assert.ok(textWidth(edge, QUOTE_TEXT) > column * 0.98, "the fixture reaches the edge");
    const text = `${edge} ${words.slice(0, 5).join(" ")}`;
    const lines = popupFacts(rec("c47a8e13-2f6d-4b90-8e15-6d3a9c2b7f41", "asleep", { info: { firstPrompt: text } }), {
      agentName: "Claude Code",
      home: HOME,
      sep: "\\",
      now: 0,
      usedMb: null,
    }).promptLines;
    assert.equal(lines.length, 2);
    assert.ok(!lines[0]?.endsWith("…"));
    assert.ok(textWidth(lines[0] ?? "", QUOTE_TEXT) <= column / 1.02);
    assert.ok(!lines[1]?.endsWith("…"), "the whole text still fits in two lines");
  });

  it("show a short text whole, without …", () => {
    assert.deepEqual(facts.replyLines, ["Short reply."]);
  });
});

describe("the popup in a window too short for it", () => {
  const facts = popupFacts(
    rec("9e2d4a71-5c3b-4e8f-a6d2-1b7c8f0e3a95", "asleep", {
      memFreedMb: 486,
      info: { title: "Retry webhooks", branch: "fix/webhook-retries", model: "claude-opus-5-5", messages: 4 },
    }),
    { agentName: "Claude Code", home: HOME, sep: "\\", now: 0, usedMb: null },
  );
  const withRows = (n: number): number => popupHeight({ ...facts, rows: facts.rows.slice(0, n) });

  it("drops whole fact rows from the bottom: each row is drawn whole or not at all", () => {
    const full = popupHeight(facts);
    for (let room = full; room >= withRows(0); room -= 1) {
      // A window that holds `room` px of the mod's for the popup (8 px kept at either edge).
      const size = popupSize(facts, { width: w(1600), height: w(room + 16) }, { zoom: 1 });
      assert.ok(size.rows >= 0 && size.rows <= facts.rows.length);
      assert.equal(size.height, withRows(size.rows), `room ${room}`);
      assert.ok(size.height <= room, `room ${room}: ${size.height}`);
      if (size.rows < facts.rows.length) {
        assert.ok(withRows(size.rows + 1) > room, `room ${room}: one more row would have fit`);
      }
    }
    assert.equal(withRows(1) - withRows(0), FACT_ROW_PX);
    assert.equal(withRows(2) - withRows(1), FACT_ROW_PX + FACT_GAP_PX);
  });
});
