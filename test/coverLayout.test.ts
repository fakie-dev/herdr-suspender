// The cover: the living layout puts the tab block in a stack with a Suspender
// block beside it. Showing that block for a moment hides the work area while
// a Sleep or a Resume rearranges the tab's panes, so the split Herdr makes to
// place a pane never shows (person: «при нажатии sleep на время появляется
// split и потом заменяется заснувшей вкладкой, можем ли мы это исправить?»).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  buildLivingLayout,
  COVER_ID,
  coverPlace,
  GENERATOR_VERSION,
  type TabsMode,
  WORK_ID,
} from "../src/core/layout.ts";

const MAIN_TEXT = readFileSync(new URL("./fixtures/main-0.1.14.json", import.meta.url), "utf8");

interface Node {
  id?: string;
  type?: string;
  active?: string;
  size?: unknown;
  content?: { mod?: string; tab?: string; props?: Record<string, unknown> };
  floating?: unknown[];
  children?: Node[];
}
const nodes = (n: Node): Node[] => [n, ...(n.children ?? []).flatMap(nodes)];

function build(tabs: TabsMode, edit: (main: Node) => void = () => undefined): Node {
  const main = JSON.parse(MAIN_TEXT) as Node;
  edit(main);
  const out = buildLivingLayout(main, "0.1.16", tabs);
  assert.ok(out.ok, out.ok ? "" : out.reason);
  return out.layout as Node;
}

describe("the cover in the living layout", () => {
  for (const tabs of ["clone", "builtin"] as const) {
    it(`puts the tab block in a stack with the cover, the tab block shown (${tabs})`, () => {
      const layout = build(tabs);
      const stack = nodes(layout).find((n) => n.id === WORK_ID);
      assert.ok(stack !== undefined);
      assert.equal(stack.type, "stack");
      const [tab, cover] = stack.children ?? [];
      assert.equal(tab?.content?.tab, "active");
      assert.equal(stack.active, tab?.id);
      assert.deepEqual(cover, { id: COVER_ID, type: "block", content: { mod: "suspender", props: { role: "cover" } } });
      // The Sleep pill still floats over the tab block.
      assert.ok((tab?.floating ?? []).length > 0);
    });
  }

  it("gives the stack the tab block's place in its row: its size and limits", () => {
    const layout = build("clone", (main) => {
      const tab = nodes(main).find((n) => n.content?.tab === "active");
      assert.ok(tab);
      tab.size = { weight: 3 };
    });
    const stack = nodes(layout).find((n) => n.id === WORK_ID);
    assert.deepEqual(stack?.size, { weight: 3 });
    assert.equal(stack?.children?.[0]?.size, undefined, "the tab block fills the stack");
  });

  it("is a change of the generator, so living layouts are rebuilt with it", () => {
    assert.ok(GENERATOR_VERSION >= 6);
  });

  it("a tab block without an id gets no cover: nothing could select it again", () => {
    const layout = build("clone", (main) => {
      const tab = nodes(main).find((n) => n.content?.tab === "active");
      assert.ok(tab);
      delete tab.id;
    });
    assert.equal(
      nodes(layout).find((n) => n.id === WORK_ID),
      undefined,
    );
  });
});

describe("coverPlace in a live layout", () => {
  it("names the stack, the tab block, the cover and which one shows", () => {
    const layout = build("clone");
    const tab = nodes(layout).find((n) => n.content?.tab === "active")?.id;
    assert.deepEqual(coverPlace(layout), { stack: WORK_ID, tab, cover: COVER_ID, active: tab });
    const covered = JSON.parse(JSON.stringify(layout)) as Node;
    const stack = nodes(covered).find((n) => n.id === WORK_ID);
    assert.ok(stack);
    stack.active = COVER_ID;
    assert.equal(coverPlace(covered)?.active, COVER_ID);
  });

  it("is null for a layout without it (the mod alone, another layout)", () => {
    assert.equal(coverPlace(JSON.parse(MAIN_TEXT)), null);
    assert.equal(coverPlace(null), null);
  });
});
