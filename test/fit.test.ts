// A fixed-width "font": 7 px per character, so the separator " · " is 21 px
// and the badge " +N" is 21 px. Widths in the comments are worked out by hand.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fitSegments, type Segment } from "../src/core/fit.ts";

const measure = (text: string): number => text.length * 7;

const TITLE = "Move auth to refresh tokens"; // 27 chars = 189 px
const branch: Segment = { key: "branch", text: "feat/refresh", priority: 1 }; // 84 px
const model: Segment = { key: "model", text: "Opus 5.5", priority: 2 }; // 56 px
const folder: Segment = { key: "folder", text: "api-gateway", priority: 3 }; // 77 px
const SEGS = [branch, model, folder]; // with separators: 105 + 77 + 98 = 280 px

describe("fitSegments", () => {
  it("shows everything when the line is wide enough", () => {
    // 189 + 280 = 469 <= 500
    assert.deepEqual(fitSegments(TITLE, SEGS, 500, measure), {
      title: true,
      shown: ["branch", "model", "folder"],
      hidden: 0,
    });
  });

  it("drops the least important item first so the title keeps at least half the line", () => {
    // 400 - 280 = 120 for the title: cut and under half -> drop folder;
    // 400 - (182 + 21 badge) = 197 >= 189: the title fits whole.
    assert.deepEqual(fitSegments(TITLE, SEGS, 400, measure), {
      title: true,
      shown: ["branch", "model"],
      hidden: 1,
    });
  });

  it("stops dropping once the title has half the line, even if it is still cut", () => {
    // 300: drop folder (97 < 150), drop model (300 - 126 = 174 >= 150) -> stop.
    assert.deepEqual(fitSegments(TITLE, SEGS, 300, measure), {
      title: true,
      shown: ["branch"],
      hidden: 2,
    });
  });

  it("without a title drops items until the rest fits", () => {
    // 84 + 77 + 98 = 259 > 150; 84 + 77 + 21 = 182 > 150; 84 + 21 = 105 <= 150.
    assert.deepEqual(fitSegments(null, SEGS, 150, measure), {
      title: false,
      shown: ["branch"],
      hidden: 2,
    });
  });

  it("drops by priority, not by position, and keeps the display order", () => {
    const segs: Segment[] = [
      { key: "folder", text: "api-gateway", priority: 1 }, // 77
      { key: "branch", text: "feat/refresh", priority: 3 }, // 21 + 84
      { key: "model", text: "Opus 5.5", priority: 2 }, // 21 + 56
    ];
    // 259 > 200 -> drop branch (p3): 77 + 77 + 21 = 175 <= 200.
    assert.deepEqual(fitSegments(null, segs, 200, measure), {
      title: false,
      shown: ["folder", "model"],
      hidden: 1,
    });
  });

  it("can drop every item, and hides the title when not even an ellipsis fits", () => {
    assert.deepEqual(fitSegments(TITLE, SEGS, 100, measure), { title: true, shown: [], hidden: 3 });
    assert.deepEqual(fitSegments(TITLE, SEGS, 10, measure), { title: false, shown: [], hidden: 3 });
  });

  it("treats an empty title as no title", () => {
    assert.deepEqual(fitSegments("", [branch], 500, measure), { title: false, shown: ["branch"], hidden: 0 });
  });
});
