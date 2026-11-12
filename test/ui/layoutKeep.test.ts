// The living layout is rebuilt from Herdr's main.json when main.json or
// Herdr's version changes. A block whose mod the person replaced in
// suspender.json (the spaces sidebar swapped for a folders mod, say) keeps
// that mod across the rebuild, matched by its id. Suspender's own blocks are
// rebuilt as always. A block main.json no longer has is dropped, and the
// person is told once.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { beforeEach, describe, it } from "node:test";
import { buildLivingLayout, type TabsMode } from "../../src/core/layout.ts";
import { syncLayout } from "../../src/runtime/layoutSync.ts";
import { type FakePorts, fakePorts } from "../fakePorts.ts";

const MAIN_TEXT = readFileSync(new URL("../fixtures/main-0.1.14.json", import.meta.url), "utf8");

interface Node {
  id?: string;
  type?: string;
  content?: { mod?: string; props?: Record<string, unknown>; tab?: string };
  children?: Node[];
  suspender_generated?: Record<string, unknown>;
  [field: string]: unknown;
}
const nodes = (n: Node): Node[] => [n, ...(n.children ?? []).flatMap(nodes)];
const byId = (root: Node, id: string): Node | undefined => nodes(root).find((n) => n.id === id);
const text = (layout: unknown): string => `${JSON.stringify(layout, null, 2)}\n`;

/** main.json changed by `edit` (a Herdr update). */
function mainWith(edit: (main: Node) => void): string {
  const main = JSON.parse(MAIN_TEXT) as Node;
  edit(main);
  return text(main);
}

const FOLDERS = { mod: "herdr-folders", props: { group: "by-folder" } };

describe("a block whose mod the person replaced survives a rebuild", () => {
  const appHome = "/home/tester/.config/herdr-app";
  const mainPath = `${appHome}/layouts/main.json`;
  const livingPath = `${appHome}/layouts/suspender.json`;
  let ports: FakePorts;
  let toasts: string[];
  let warned: Set<string>;
  const sync = (version: string, tabs?: TabsMode) =>
    syncLayout({
      ports,
      appHome,
      herdrVersion: version,
      toast: (t) => toasts.push(t),
      warned,
      ...(tabs ? { tabs } : {}),
    });
  const written = (): Node => JSON.parse(ports.files.get(livingPath) ?? "null") as Node;

  /** The layout the mod built from `mainText`, then edited by the person. */
  function personEdited(mainText: string, edit: (layout: Node) => void, tabs: TabsMode = "builtin"): string {
    const built = buildLivingLayout(JSON.parse(mainText), "0.1.14", tabs);
    assert.ok(built.ok);
    const layout = built.layout as Node;
    edit(layout);
    return text(layout);
  }
  const swapSpaces = (layout: Node): void => {
    const spaces = byId(layout, "spaces");
    assert.ok(spaces);
    spaces.content = { ...FOLDERS };
  };

  beforeEach(() => {
    ports = fakePorts();
    toasts = [];
    warned = new Set();
    ports.files.set(mainPath, MAIN_TEXT);
  });

  it("a Herdr update rebuilds the layout and the spaces block keeps the person's mod and props", async () => {
    ports.files.set(livingPath, personEdited(MAIN_TEXT, swapSpaces));
    const newer = mainWith((main) => {
      main.children?.push({ id: "news", type: "block", content: { mod: "news" } });
    });
    ports.files.set(mainPath, newer);

    assert.equal(await sync("0.1.15"), "rebuilt");

    assert.deepEqual(byId(written(), "spaces")?.content, FOLDERS);
    assert.ok(byId(written(), "news"), "Herdr's own change is in");
    assert.ok(byId(written(), "suspender-toggle"), "and ours");
    assert.deepEqual(toasts, []);
  });

  it("only the Herdr version changed: the same", async () => {
    ports.files.set(livingPath, personEdited(MAIN_TEXT, swapSpaces));
    assert.equal(await sync("0.1.15"), "rebuilt");
    assert.deepEqual(byId(written(), "spaces")?.content, FOLDERS);
  });

  it("a block Herdr itself changed, which the person did not touch, takes Herdr's new mod", async () => {
    ports.files.set(livingPath, personEdited(MAIN_TEXT, swapSpaces));
    ports.files.set(
      mainPath,
      mainWith((main) => {
        const agents = byId(main, "agents");
        assert.ok(agents);
        agents.content = { mod: "agents-next" };
      }),
    );
    await sync("0.1.15");
    assert.equal(byId(written(), "agents")?.content?.mod, "agents-next");
    assert.deepEqual(byId(written(), "spaces")?.content, FOLDERS);
  });

  it("a layout built before this was recorded: a mod that differs from main.json's is the person's", async () => {
    const old = JSON.parse(personEdited(MAIN_TEXT, swapSpaces)) as Node;
    delete old.suspender_generated?.["base"];
    ports.files.set(livingPath, text(old));
    await sync("0.1.15");
    assert.deepEqual(byId(written(), "spaces")?.content, FOLDERS);
  });

  it("Suspender's own blocks are rebuilt as always, never carried over", async () => {
    // Built with the live copy of the tab bar; now the copy cannot be used.
    ports.files.set(livingPath, personEdited(MAIN_TEXT, swapSpaces, "clone"));
    await sync("0.1.14", "builtin");
    assert.equal(byId(written(), "tabs")?.content?.mod, "tabs", "Herdr's tab bar, not the copy");
    assert.equal(byId(written(), "suspender"), undefined, "no Sessions child from the clone layout");
    assert.deepEqual(byId(written(), "spaces")?.content, FOLDERS);
  });

  it("a block main.json no longer has is dropped, and the person is told once which", async () => {
    ports.files.set(livingPath, personEdited(MAIN_TEXT, swapSpaces));
    const gone = mainWith((main) => {
      const spaces = byId(main, "spaces");
      assert.ok(spaces);
      spaces.id = "spaces-v2";
    });
    ports.files.set(mainPath, gone);

    assert.equal(await sync("0.1.15"), "rebuilt");
    assert.equal(byId(written(), "spaces"), undefined);
    assert.equal(byId(written(), "spaces-v2")?.content?.mod, "spaces", "no placement is invented");
    assert.equal(toasts.length, 1);
    assert.match(toasts[0] ?? "", /herdr-folders/);
    assert.match(toasts[0] ?? "", /spaces/);

    // The next build no longer has the person's block to lose: nothing more is said.
    ports.files.set(
      mainPath,
      mainWith((main) => main.children?.push({ id: "x", type: "block" })),
    );
    await sync("0.1.16");
    assert.equal(toasts.length, 1);
  });

  it("an edit saved while the layout is being rebuilt is the one kept", async () => {
    ports.files.set(livingPath, personEdited(MAIN_TEXT, swapSpaces));
    let edited = false;
    ports.beforeWrite = (path) => {
      if (!edited) {
        edited = true;
        // The person saves another change in between: the conditional write is refused.
        ports.files.set(
          path,
          personEdited(MAIN_TEXT, (layout) => {
            const spaces = byId(layout, "spaces");
            assert.ok(spaces);
            spaces.content = { mod: "herdr-folders-2" };
          }),
        );
      }
    };
    assert.equal(await sync("0.1.15"), "rebuilt");
    assert.deepEqual(byId(written(), "spaces")?.content, { mod: "herdr-folders-2" });
  });

  it("a change to the tabs block does not replace the live copy of the tab bar", async () => {
    ports.files.set(
      livingPath,
      personEdited(
        MAIN_TEXT,
        (layout) => {
          const tabs = byId(layout, "tabs");
          assert.ok(tabs);
          tabs.content = { mod: "my-tabs" };
        },
        "clone",
      ),
    );
    await sync("0.1.15", "clone");
    assert.equal(byId(written(), "tabs")?.content?.mod, "suspender-tabs");
  });

  it("a block the person added (main.json never had it) is neither carried nor reported lost", async () => {
    ports.files.set(
      livingPath,
      personEdited(MAIN_TEXT, (layout) => {
        layout.children?.push({ id: "my-block", type: "block", content: { mod: "notes" } });
      }),
    );
    await sync("0.1.15");
    assert.equal(byId(written(), "my-block"), undefined);
    assert.deepEqual(toasts, []);
  });

  it("a layout nobody changed is rebuilt exactly as before", async () => {
    const built = buildLivingLayout(JSON.parse(MAIN_TEXT), "0.1.15", "builtin");
    assert.ok(built.ok);
    ports.files.set(
      livingPath,
      personEdited(MAIN_TEXT, () => undefined),
    );
    await sync("0.1.15");
    assert.deepEqual(written(), built.layout);
  });
});
