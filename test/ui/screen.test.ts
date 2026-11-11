// The last screen on a sleeping tab is laid out on the terminal's own cell
// grid. The expected numbers are measured on Herdr 0.1.15 (herdr-app shot of a
// live terminal printing rows of full blocks), not taken from the code:
//
//   JetBrains Mono 14 -> 8 x 18 px     JetBrains Mono 16 -> 10 x 21
//   JetBrains Mono 11 -> 7 x 15        Consolas 16       -> 9 x 19
//   Cascadia Mono 13  -> 8 x 15        Geist Mono 15     -> 9 x 20
//   JetBrains Mono 14 at zoom 1.1 -> 9 x 20 device px
//
// and with terminal_padding [14, 12] the first cell of a 702 px tall pane sat
// 14 px in and 18 px down (12 + half of the 12 px left under the last row).

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cellWidth, mixColor, screenGrid, screenLook, screenMarks } from "../../src/ui/format.ts";

const look = (over: Record<string, unknown> = {}) =>
  screenLook({ font_family: "JetBrains Mono", font_size: 14, zoom: 1, terminal_padding: [14, 12], ...over });

describe("terminal cell", () => {
  it("is the cell Herdr's terminal draws, for the fonts measured", () => {
    const cases: [string, number, number, number][] = [
      ["JetBrains Mono", 14, 8, 18],
      ["JetBrains Mono", 16, 10, 21],
      ["JetBrains Mono", 11, 7, 15],
      ["Consolas", 16, 9, 19],
      ["Cascadia Mono", 13, 8, 15],
      ["Geist Mono", 15, 9, 20],
    ];
    for (const [font, size, w, h] of cases) {
      const l = look({ font_family: font, font_size: size });
      assert.deepEqual([l.cellW, l.cellH], [w, h], `${font} ${size}`);
    }
  });

  it("rounds in device pixels under zoom", () => {
    const l = look({ zoom: 1.1 });
    assert.ok(Math.abs(l.cellW * 1.1 - 9) < 1e-9, `cellW ${l.cellW}`);
    assert.ok(Math.abs(l.cellH * 1.1 - 20) < 1e-9, `cellH ${l.cellH}`);
  });

  it("keeps glyphs at the terminal's size and sizes runs so one character is one cell", () => {
    const l = look();
    assert.equal(l.glyph, 14);
    assert.equal(l.font, "JetBrains Mono");
    // JetBrains Mono advances 0.6 em: 8 px cells need runs at 13.33 px.
    assert.ok(Math.abs(l.run * 0.6 - 8) < 1e-9, `run ${l.run}`);
  });

  it("draws light lines as thick as the terminal does (measured: JetBrains Mono 14, 24, 30, 40)", () => {
    assert.deepEqual(
      [14, 24, 30, 40].map((size) => look({ font_size: size }).stroke),
      [1, 2, 2, 3],
    );
  });

  it("takes the padding from terminal_padding: [horizontal, vertical]", () => {
    const l = look();
    assert.deepEqual([l.padX, l.padY], [14, 12]);
  });
});

describe("screen grid in a pane", () => {
  it("fits whole rows and centres what is left under the last one, as the terminal does", () => {
    // 702 px: 678 inside the padding = 37 rows of 18 and 12 px left; 6 go on top.
    assert.deepEqual(screenGrid(702, look()), { rows: 37, top: 18 });
    // JetBrains Mono 11 (15 px rows): 45 rows, 3 px left, 1 on top.
    assert.deepEqual(screenGrid(702, look({ font_size: 11 })), { rows: 45, top: 13 });
  });

  it("before the pane has a size, assumes a screenful from the top padding", () => {
    assert.deepEqual(screenGrid(0, look()), { rows: 30, top: 12 });
  });
});

describe("character width", () => {
  it("counts CJK and emoji as two cells, marks as none, the rest as one", () => {
    assert.equal(cellWidth("a".codePointAt(0) ?? 0), 1);
    assert.equal(cellWidth("Ж".codePointAt(0) ?? 0), 1);
    assert.equal(cellWidth("│".codePointAt(0) ?? 0), 1);
    assert.equal(cellWidth("水".codePointAt(0) ?? 0), 2);
    assert.equal(cellWidth("語".codePointAt(0) ?? 0), 2);
    assert.equal(cellWidth("한".codePointAt(0) ?? 0), 2);
    assert.equal(cellWidth("🤖".codePointAt(0) ?? 0), 2);
    assert.equal(cellWidth("🔄".codePointAt(0) ?? 0), 2);
    assert.equal(cellWidth(0x0301), 0);
    assert.equal(cellWidth(0x200d), 0);
    assert.equal(cellWidth(0xfe0f), 0);
  });
});

type Mark = ReturnType<typeof screenMarks>[number];
const texts = (marks: Mark[]) => marks.filter((m) => m.kind === "text").map((m) => [m.x, m.y, m.text, m.size]);
const fills = (marks: Mark[]) => marks.filter((m) => m.kind === "fill").map((m) => [m.x, m.y, m.w, m.h, m.shade]);

describe("screen marks", () => {
  const l = look();
  const run = l.run;

  it("puts a run of plain text in one piece at its cell", () => {
    assert.deepEqual(texts(screenMarks(["  Claude Code v2"], l)), [[16, 0, "Claude Code v2", run]]);
  });

  it("places what follows a wide character two cells on", () => {
    // "│ 日本語 │": the closing bar is in cell 9 (1 + 1 + 3 x 2 + 1 + 1 - 1).
    const marks = screenMarks(["ab 水c"], l);
    assert.deepEqual(texts(marks), [
      [0, 0, "ab", run],
      [24, 0, "水", 14],
      [40, 0, "c", run],
    ]);
    const bar = screenMarks(["│ 日本語 │"], l).filter((m) => m.kind === "fill");
    assert.deepEqual(
      bar.map((m) => m.x),
      [4, 9 * 8 + 4],
    );
  });

  it("draws lines through the middle of their cells, joined end to end", () => {
    // Row 1: "┌──┬" → the corner's right and lower halves, one rule over both
    // dashes, and the tee's full rule and lower half.
    const marks = fills(screenMarks(["", "┌──┬"], l));
    assert.deepEqual(marks, [
      [4, 27, 4, 1, 1],
      [4, 27, 1, 9, 1],
      [8, 27, 16, 1, 1],
      [24, 27, 8, 1, 1],
      [28, 27, 1, 9, 1],
    ]);
    // A vertical bar runs the full row, so rows join without a gap.
    assert.deepEqual(fills(screenMarks(["│"], l)), [[4, 0, 1, 18, 1]]);
  });

  it("fills blocks and quadrants to the pixel, as the terminal does", () => {
    // From the Claude Code logo: "▐▛██" on row 0.
    assert.deepEqual(fills(screenMarks(["▐▛██"], l)), [
      [4, 0, 4, 18, 1],
      [8, 0, 4, 9, 1],
      [12, 0, 4, 9, 1],
      [8, 9, 4, 9, 1],
      [16, 0, 16, 18, 1],
    ]);
    assert.deepEqual(fills(screenMarks(["▀▄▒"], l)), [
      [0, 0, 8, 9, 1],
      [8, 9, 8, 9, 1],
      [16, 0, 8, 18, 0.5],
    ]);
  });

  it("draws rounded corners as quarter arcs between the cell's middles", () => {
    const arcs = screenMarks(["╭╮", "╰╯"], l).filter((m) => m.kind === "arc");
    assert.deepEqual(
      arcs.map((m) => [m.corner, m.x, m.y, m.w, m.h]),
      [
        ["tl", 4, 9, 4, 9],
        ["tr", 8, 9, 5, 9],
        ["bl", 4, 18, 4, 10],
        ["br", 8, 18, 5, 10],
      ],
    );
  });

  it("leaves blank cells and trailing spaces out", () => {
    assert.deepEqual(screenMarks(["   ", ""], l), []);
    assert.deepEqual(texts(screenMarks(["a   b  "], l)), [[0, 0, "a   b", run]]);
  });

  it("keeps a combining mark with its letter", () => {
    assert.deepEqual(texts(screenMarks(["éx"], l)), [[0, 0, "éx", run]]);
  });
});

describe("dimmed colour", () => {
  it("mixes the foreground into the background", () => {
    assert.equal(mixColor("#000000", "#ffffff", 0.3), "#4d4d4d");
    assert.equal(mixColor("#1e1e2e", "#cdd6f4", 0), "#1e1e2e");
    assert.equal(mixColor("#1e1e2e", "#cdd6f4", 1), "#cdd6f4");
  });
});
