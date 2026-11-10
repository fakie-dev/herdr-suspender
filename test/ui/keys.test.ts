import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { LAYOUT_NAME, PANEL_ID } from "../../src/core/layout.ts";

const keys = JSON.parse(readFileSync(new URL("../../keys.json", import.meta.url), "utf8")) as Record<
  string,
  Record<string, unknown>
>;

describe("keys.json snippet", () => {
  it("opens Sessions on ctrl-shift-s: a window anywhere, the panel in the suspender layout", () => {
    assert.equal(keys["global"]?.["ctrl-shift-s"], "mod.open:suspender");
    assert.deepEqual(keys[`layout:${LAYOUT_NAME}`]?.["ctrl-shift-s"], {
      command: "layout.toggle",
      args: { id: PANEL_ID },
    });
  });

  it("sleeps or resumes the agent in focus on alt-shift-s", () => {
    assert.equal(keys["global"]?.["alt-shift-s"], "suspender.toggle-focused");
  });

  it("binds nothing else, and no plain ctrl+letter a program needs", () => {
    const bound = Object.entries(keys).flatMap(([section, map]) => Object.keys(map).map((key) => `${section}:${key}`));
    assert.deepEqual(bound.sort(), ["global:alt-shift-s", "global:ctrl-shift-s", `layout:${LAYOUT_NAME}:ctrl-shift-s`]);
  });
});
