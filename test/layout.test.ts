import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { buildLivingLayout, LAYOUT_NAME, needsRebuild } from "../src/core/layout.ts";

// A verbatim copy of Herdr 0.1.14's shipped layouts/main.json.
const MAIN_TEXT = readFileSync(new URL("./fixtures/main-0.1.14.json", import.meta.url), "utf8");
const main = (): Record<string, unknown> => JSON.parse(MAIN_TEXT) as Record<string, unknown>;

interface LayoutNode {
  id?: string;
  type?: string;
  hidden?: boolean;
  size?: unknown;
  content?: { mod?: string; tab?: string; props?: Record<string, unknown> };
  floating?: unknown[];
  children?: LayoutNode[];
  [field: string]: unknown;
}

function nodes(root: LayoutNode): LayoutNode[] {
  return [root, ...(root.children ?? []).flatMap(nodes)];
}
const byId = (root: LayoutNode, id: string): LayoutNode | undefined => nodes(root).find((n) => n.id === id);
const parentOf = (root: LayoutNode, node: LayoutNode): LayoutNode | undefined =>
  nodes(root).find((n) => n.children?.includes(node));
const tabBlock = (root: LayoutNode): LayoutNode | undefined => nodes(root).find((n) => n.content?.tab === "active");

function build(source: unknown = main(), version = "0.1.14"): LayoutNode {
  const out = buildLivingLayout(source, version);
  assert.ok(out.ok, out.ok ? "" : out.reason);
  return out.layout as LayoutNode;
}

describe("buildLivingLayout from the real main.json", () => {
  it("is named suspender", () => {
    assert.equal(LAYOUT_NAME, "suspender");
  });

  it("puts the Sessions button in a row right beside the tabs block", () => {
    const layout = build();
    const toggle = byId(layout, "suspender-toggle");
    const tabs = byId(layout, "tabs");
    assert.ok(toggle && tabs);
    assert.deepEqual(toggle.content, { mod: "suspender", props: { role: "toggle" } });
    assert.ok(typeof (toggle.size as { px?: unknown }).px === "number");
    const row = parentOf(layout, toggle);
    assert.equal(row?.type, "row");
    assert.equal(parentOf(layout, tabs), row);
    const siblings = row?.children ?? [];
    assert.equal(Math.abs(siblings.indexOf(toggle) - siblings.indexOf(tabs)), 1);
  });

  it("keeps the shipped tabs block as it was, only sized to share the row", () => {
    const tabs = byId(build(), "tabs");
    assert.deepEqual(tabs?.content, { mod: "tabs" });
    assert.equal(tabs?.window_drag, true);
  });

  it("adds a hidden Sessions column to the right of the work area", () => {
    const layout = build();
    const panel = byId(layout, "suspender-panel");
    const tab = tabBlock(layout);
    assert.ok(panel && tab);
    assert.equal(panel.hidden, true);
    assert.deepEqual(panel.content, { mod: "suspender", props: { role: "panel" } });
    const row = parentOf(layout, panel);
    assert.equal(row?.type, "row");
    const siblings = row?.children ?? [];
    assert.ok(siblings.includes(tab), "in the same row as the tab block");
    assert.ok(siblings.indexOf(panel) > siblings.indexOf(tab), "right of the tab block");
    assert.equal(siblings.at(-1), panel, "rightmost, after the shipped Files/Changes panel");
  });

  it("floats the Sleep pill over the tab block, a drawer at the bottom right", () => {
    const tab = tabBlock(build());
    assert.deepEqual(tab?.floating, [
      {
        id: "suspender-pill",
        content: { mod: "suspender", props: { role: "pill" } },
        edge: "right",
        align: "end",
        peek: 30,
      },
    ]);
  });

  it("records what it was made from: cloned_from and the hash of main.json", () => {
    const layout = build();
    assert.deepEqual(layout.cloned_from, { name: "main", version: "0.1.14" });
    const expected = createHash("sha256")
      .update(JSON.stringify(JSON.parse(MAIN_TEXT)))
      .digest("hex");
    assert.equal((layout.suspender_generated as { from?: unknown }).from, expected);
    assert.deepEqual(Object.keys(layout).slice(0, 3), ["id", "type", "cloned_from"]);
  });

  it("keeps every shipped node and does not change its input", () => {
    const source = main();
    const layout = build(source);
    assert.deepEqual(source, main());
    const shippedIds = nodes(main() as LayoutNode).map((n) => n.id);
    const ids = nodes(layout).map((n) => n.id);
    for (const id of shippedIds) {
      assert.ok(ids.includes(id), `${id} kept`);
    }
    const added = ids.filter((id) => !shippedIds.includes(id));
    assert.deepEqual(added.sort(), ["suspender-panel", "suspender-toggle", "suspender-topbar"]);
  });
});

describe("buildLivingLayout finds blocks by id and mod, not by position", () => {
  it("finds the tabs block by its id when its mod has another name", () => {
    const source = main() as LayoutNode;
    const tabs = byId(source, "tabs");
    assert.ok(tabs);
    tabs.content = { mod: "tab-bar" };
    const toggle = byId(build(source), "suspender-toggle");
    assert.ok(toggle);
  });

  it("works with the sidebar on the right and a tabs block under another id", () => {
    const source = main() as LayoutNode;
    source.children?.reverse();
    const tabs = byId(source, "tabs");
    assert.ok(tabs);
    tabs.id = "top-tabs";
    const layout = build(source);
    const toggle = byId(layout, "suspender-toggle");
    assert.ok(toggle);
    assert.ok(parentOf(layout, toggle)?.children?.some((n) => n.id === "top-tabs"));
  });

  it("does not wrap a tabs block that already sits in a row", () => {
    const source = main() as LayoutNode;
    const work = byId(source, "work");
    const tabs = byId(source, "tabs");
    assert.ok(work?.children && tabs);
    work.children[0] = { id: "bar", type: "row", size: { px: 42 }, children: [{ ...tabs, size: { weight: 1 } }] };
    const layout = build(source);
    const toggle = byId(layout, "suspender-toggle");
    assert.ok(toggle);
    assert.equal(parentOf(layout, toggle)?.id, "bar");
    assert.equal(byId(layout, "suspender-topbar"), undefined);
  });

  it("keeps floating blocks that are already on the tab block", () => {
    const source = main() as LayoutNode;
    const tab = tabBlock(source);
    assert.ok(tab);
    tab.floating = [{ id: "board", content: { mod: "board" }, edge: "left", align: "center", peek: 52 }];
    const floating = tabBlock(build(source))?.floating as { id: string }[];
    assert.deepEqual(
      floating.map((f) => f.id),
      ["board", "suspender-pill"],
    );
  });
});

describe("buildLivingLayout on a main.json it cannot use", () => {
  it("reports a reason instead of throwing when there is no tabs block", () => {
    const source = main() as LayoutNode;
    const work = byId(source, "work");
    assert.ok(work?.children);
    work.children = work.children.filter((n) => n.id !== "tabs");
    const out = buildLivingLayout(source, "0.1.14");
    assert.equal(out.ok, false);
    assert.match(out.ok ? "" : out.reason, /tabs/);
  });

  it("reports a reason when there is no tab block", () => {
    const source = main() as LayoutNode;
    const tab = tabBlock(source);
    assert.ok(tab);
    tab.content = { mod: "something-else" };
    const out = buildLivingLayout(source, "0.1.14");
    assert.equal(out.ok, false);
    assert.match(out.ok ? "" : out.reason, /tab/);
  });

  it("reports a reason for things that are not a layout at all", () => {
    for (const junk of [null, "main", 42, [], {}, { id: "root", type: "row", children: "x" }]) {
      const out = buildLivingLayout(junk, "0.1.14");
      assert.equal(out.ok, false, JSON.stringify(junk));
    }
  });
});

describe("needsRebuild", () => {
  it("is true when there is no living layout yet", () => {
    assert.equal(needsRebuild(main(), "0.1.14", null), true);
  });

  it("is false for the layout built from this very main.json", () => {
    assert.equal(needsRebuild(main(), "0.1.14", build()), false);
  });

  it("is true when main.json changed", () => {
    const changed = main() as LayoutNode;
    const tabs = byId(changed, "tabs");
    assert.ok(tabs);
    tabs.size = { px: 44 };
    assert.equal(needsRebuild(changed, "0.1.14", build()), true);
  });

  it("is true when Herdr's version changed", () => {
    assert.equal(needsRebuild(main(), "0.1.15", build()), true);
  });

  it("is true for a suspender layout that has no generator record", () => {
    const current = build();
    delete current.suspender_generated;
    assert.equal(needsRebuild(main(), "0.1.14", current), true);
  });

  it("is true for a layout made by an older generator from the same main.json", () => {
    const current = build();
    (current.suspender_generated as { generator: number }).generator = 0;
    assert.equal(needsRebuild(main(), "0.1.14", current), true);
  });
});
