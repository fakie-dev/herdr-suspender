import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  buildLivingLayout,
  LAYOUT_NAME,
  needsRebuild,
  sessionsShown,
  sessionsToggle,
  type TabsMode,
} from "../src/core/layout.ts";
import { PILL_PEEK } from "../src/core/scale.ts";

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

function build(source: unknown = main(), version = "0.1.14", tabs?: TabsMode): LayoutNode {
  const out = buildLivingLayout(source, version, tabs);
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

  it("puts the Sessions button left of the tabs block, clear of the window buttons the tab bar ends with", () => {
    const layout = build();
    const toggle = byId(layout, "suspender-toggle");
    const tabs = byId(layout, "tabs");
    assert.ok(toggle && tabs);
    const siblings = parentOf(layout, toggle)?.children ?? [];
    assert.equal(siblings.indexOf(toggle), siblings.indexOf(tabs) - 1);
    assert.equal(siblings[0], toggle);
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
        // As wide as the framed pill is tall: the moon's button is square (scale.test.ts).
        peek: PILL_PEEK,
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

describe("buildLivingLayout with the live copy of the tab bar (clone)", () => {
  const clone = (source: unknown = main()): LayoutNode => build(source, "0.1.14", "clone");

  it("shows the copy in the tabs block, which keeps everything else it had", () => {
    const tabs = byId(clone(), "tabs");
    const shipped = byId(main() as LayoutNode, "tabs");
    assert.ok(tabs && shipped);
    assert.deepEqual(tabs.content, { mod: "suspender-tabs" });
    assert.deepEqual({ ...tabs, content: null }, { ...shipped, content: null });
  });

  it("makes Sessions the side panel's third child, after Files and Changes", () => {
    const body = byId(clone(), "panel-body");
    assert.equal(body?.type, "stack");
    assert.deepEqual(
      body?.children?.map((n) => n.id),
      ["files", "changes", "suspender"],
    );
    assert.deepEqual(body?.children?.[2], {
      id: "suspender",
      type: "block",
      content: { mod: "suspender", props: { role: "panel" } },
    });
  });

  it("has no button block and no column of its own, but keeps the Sleep pill", () => {
    const layout = clone();
    for (const id of ["suspender-toggle", "suspender-topbar", "suspender-panel"]) {
      assert.equal(byId(layout, id), undefined, id);
    }
    assert.deepEqual(
      ((tabBlock(layout)?.floating ?? []) as { id: string }[]).map((f) => f.id),
      ["suspender-pill"],
    );
  });

  it("records the mode and the generator it was built by", () => {
    const generated = clone().suspender_generated as { tabs?: unknown; generator?: unknown };
    assert.equal(generated.tabs, "clone");
    // 5: the Sleep pill peeks 38 px, a square button (was 30).
    assert.equal(generated.generator, 5);
    assert.equal((build().suspender_generated as { tabs?: unknown }).tabs, "builtin");
  });

  it("reports a reason when there is no side panel stack to add Sessions to", () => {
    const source = main() as LayoutNode;
    const panel = byId(source, "panel");
    assert.ok(panel?.children);
    panel.children = [{ id: "files", type: "block", content: { mod: "files" } }];
    const out = buildLivingLayout(source, "0.1.14", "clone");
    assert.equal(out.ok, false);
    assert.match(out.ok ? "" : out.reason, /panel-body/);
  });

  it("keeps every shipped node and adds only Sessions", () => {
    const shippedIds = nodes(main() as LayoutNode).map((n) => n.id);
    const added = nodes(clone())
      .map((n) => n.id)
      .filter((id) => !shippedIds.includes(id));
    assert.deepEqual(added, ["suspender"]);
  });
});

describe("sessionsShown", () => {
  /** The live tree as `layout()` gives it: `panel` shown or hidden, `panel-body` on one child. */
  const live = (layout: LayoutNode, shown: boolean, active: string): LayoutNode => {
    const copy = JSON.parse(JSON.stringify(layout)) as LayoutNode;
    const panel = byId(copy, "panel");
    const body = byId(copy, "panel-body");
    assert.ok(panel && body);
    panel.hidden = !shown;
    body.active = active;
    return copy;
  };

  it("with the copy: open while the side panel shows Sessions, and only then", () => {
    const layout = build(main(), "0.1.14", "clone");
    assert.equal(sessionsShown(live(layout, true, "suspender")), true);
    assert.equal(sessionsShown(live(layout, false, "suspender")), false, "the panel is closed");
    assert.equal(sessionsShown(live(layout, true, "files")), false, "Files is on top");
    assert.equal(sessionsShown(live(layout, true, "changes")), false, "Changes is on top");
  });

  it("with Herdr's own tab bar: open while our column shows, whatever the side panel does", () => {
    const layout = build();
    assert.equal(sessionsShown(live(layout, true, "suspender")), false);
    const column = byId(layout, "suspender-panel");
    assert.ok(column);
    column.hidden = false;
    assert.equal(sessionsShown(live(layout, false, "files")), true);
  });

  it("is false for no layout at all", () => {
    assert.equal(sessionsShown(null), false);
  });
});

describe("sessionsToggle (the suspender.panel command)", () => {
  const live = (layout: LayoutNode, shown: boolean, active: string): LayoutNode => {
    const copy = JSON.parse(JSON.stringify(layout)) as LayoutNode;
    const panel = byId(copy, "panel");
    const body = byId(copy, "panel-body");
    assert.ok(panel && body);
    panel.hidden = !shown;
    body.active = active;
    return copy;
  };
  const withCopy = build(main(), "0.1.14", "clone");

  it("with the copy, opens the side panel on Sessions, as the tab bar's button does", () => {
    const open = [
      { command: "layout.select", args: { stack: "panel-body", child: "suspender" } },
      { command: "layout.show", args: { id: "panel" } },
    ];
    assert.deepEqual(sessionsToggle(live(withCopy, false, "files")), open);
    assert.deepEqual(sessionsToggle(live(withCopy, true, "changes")), open, "Changes on top: switch to Sessions");
  });

  it("with the copy, closes the side panel while it shows Sessions", () => {
    assert.deepEqual(sessionsToggle(live(withCopy, true, "suspender")), [
      { command: "layout.hide", args: { id: "panel" } },
    ]);
  });

  it("with Herdr's own tab bar, toggles our column", () => {
    assert.deepEqual(sessionsToggle(build()), [{ command: "layout.toggle", args: { id: "suspender-panel" } }]);
  });

  it("does nothing in a layout without Sessions", () => {
    assert.deepEqual(sessionsToggle(main()), []);
    assert.deepEqual(sessionsToggle(null), []);
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
    assert.deepEqual(
      parentOf(layout, toggle)?.children?.map((n) => n.id),
      ["suspender-toggle", "tabs"],
      "left of the tabs there too",
    );
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

  it("is true for a layout made by generator 1, which put the button left of the tabs", () => {
    const current = build();
    (current.suspender_generated as { generator: number }).generator = 1;
    assert.equal(needsRebuild(main(), "0.1.14", current), true);
  });

  it("is true for a layout made by generator 2, which put the button after the window buttons", () => {
    const current = build();
    (current.suspender_generated as { generator: number }).generator = 2;
    assert.equal(needsRebuild(main(), "0.1.14", current), true);
  });

  it("is true when the tab bar mode changed, either way, and false when it did not", () => {
    const withCopy = build(main(), "0.1.14", "clone");
    const withShipped = build(main(), "0.1.14", "builtin");
    assert.equal(needsRebuild(main(), "0.1.14", withCopy, "builtin"), true, "the copy broke: back to the shipped bar");
    assert.equal(needsRebuild(main(), "0.1.14", withShipped, "clone"), true, "the copy works again");
    assert.equal(needsRebuild(main(), "0.1.14", withCopy, "clone"), false);
    assert.equal(needsRebuild(main(), "0.1.14", withShipped, "builtin"), false);
  });

  it("is true for a layout made by an older generator from the same main.json", () => {
    const current = build();
    (current.suspender_generated as { generator: number }).generator = 0;
    assert.equal(needsRebuild(main(), "0.1.14", current), true);
  });
});
