// The key `suspender.panel` (Ctrl+Shift+S in the suspender layout): Herdr hands
// one press to every shown copy of the mod, and the copies must open or close
// Sessions once per press, however quickly the presses come.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, beforeEach, describe, it } from "node:test";
import { buildLivingLayout } from "../src/core/layout.ts";
import { loadMod } from "./standIns.ts";

interface Node {
  id?: string;
  hidden?: boolean;
  active?: string;
  children?: Node[];
}
const nodes = (n: Node): Node[] => [n, ...(n.children ?? []).flatMap(nodes)];
const byId = (root: Node, id: string): Node => {
  const hit = nodes(root).find((n) => n.id === id);
  assert.ok(hit, id);
  return hit;
};

/** The window as the mod sees it: the suspender layout on the tab bar copy, its side panel closed. */
function windowWithCopy(): { tree: Node; commands: string[] } {
  const main: unknown = JSON.parse(readFileSync(new URL("./fixtures/main-0.1.14.json", import.meta.url), "utf8"));
  const built = buildLivingLayout(main, "0.1.14", "clone");
  assert.ok(built.ok);
  const tree = built.layout as Node;
  byId(tree, "panel").hidden = true;
  return { tree, commands: [] };
}

const sessionsOpen = (tree: Node): boolean =>
  byId(tree, "panel").hidden !== true && byId(tree, "panel-body").active === "suspender";

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("suspender.panel, delivered to every shown copy", () => {
  let togglePanel: (copy: string) => void;
  let win: { tree: Node; commands: string[] };
  let cleanup: () => void = () => undefined;

  before(async () => {
    const mod = await loadMod({ readsHang: false });
    cleanup = mod.cleanup;
    const main = (await import(new URL("../src/main.ts", import.meta.url).href)) as {
      togglePanel: (copy: string) => void;
    };
    togglePanel = main.togglePanel;
  });
  after(() => cleanup());

  beforeEach(async () => {
    // Far enough from the last test's presses that none of them is still being handed out.
    await wait(300);
    win = windowWithCopy();
    (globalThis as { suspenderWindow?: unknown }).suspenderWindow = {
      layout: () => JSON.parse(JSON.stringify(win.tree)),
      run: (name: string, args: { id?: string; stack?: string; child?: string }) => {
        win.commands.push(name);
        if (name === "layout.show" && args.id) {
          byId(win.tree, args.id).hidden = false;
        } else if (name === "layout.hide" && args.id) {
          byId(win.tree, args.id).hidden = true;
        } else if (name === "layout.select" && args.stack && args.child) {
          byId(win.tree, args.stack).active = args.child;
        }
      },
    };
  });

  /** One press of the key: Herdr gives it to each shown copy. */
  const press = (copies: string[]): void => {
    for (const copy of copies) {
      togglePanel(copy);
    }
  };

  it("one press reaching three copies opens Sessions once", () => {
    press(["pill", "panel", "sleep-1"]);
    assert.equal(sessionsOpen(win.tree), true);
    assert.deepEqual(win.commands, ["layout.select", "layout.show"]);
  });

  it("two real presses within 300 ms open and then close", async () => {
    press(["pill", "panel"]);
    assert.equal(sessionsOpen(win.tree), true, "the first press opens");
    await wait(250);
    press(["panel", "pill"]);
    assert.equal(sessionsOpen(win.tree), false, "the second press closes");
    assert.deepEqual(win.commands, ["layout.select", "layout.show", "layout.hide"]);
  });

  it("a press that reaches only copies shown since the last one still acts", async () => {
    press(["pill", "panel"]);
    // Another tab: its pill and a sleeping pane are new copies; the old ones are no longer shown.
    await wait(300);
    press(["pill-2", "sleep-2"]);
    assert.equal(sessionsOpen(win.tree), false);
    assert.deepEqual(win.commands, ["layout.select", "layout.show", "layout.hide"]);
  });

  it("two presses back to back (no time between them) are still two", () => {
    press(["pill", "panel"]);
    press(["pill", "panel"]);
    assert.equal(sessionsOpen(win.tree), false);
    assert.deepEqual(win.commands, ["layout.select", "layout.show", "layout.hide"]);
  });
});
