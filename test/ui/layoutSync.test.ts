import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { beforeEach, describe, it } from "node:test";
import { buildLivingLayout } from "../../src/core/layout.ts";
import { t } from "../../src/i18n/index.ts";
import { syncLayout } from "../../src/runtime/layoutSync.ts";
import { type FakePorts, fakePorts } from "../fakePorts.ts";

// A verbatim copy of Herdr 0.1.14's shipped layouts/main.json.
const MAIN_TEXT = readFileSync(new URL("../fixtures/main-0.1.14.json", import.meta.url), "utf8");

interface Node {
  id?: string;
  size?: { px?: number };
  content?: { mod?: string; tab?: string };
  floating?: { id: string }[];
  children?: Node[];
  cloned_from?: { name: string; version: string };
  suspender_generated?: { from: string; generator: number };
  [field: string]: unknown;
}
const nodes = (n: Node): Node[] => [n, ...(n.children ?? []).flatMap(nodes)];
const byId = (root: Node, id: string): Node | undefined => nodes(root).find((n) => n.id === id);

/** "A newer Herdr": main.json with the tab bar taller and a new block, as an update might ship. */
function newerMain(): string {
  const main = JSON.parse(MAIN_TEXT) as Node;
  const tabs = byId(main, "tabs");
  assert.ok(tabs?.size);
  tabs.size = { px: 34 };
  const root = main.children ?? [];
  root.push({ id: "news", type: "block", content: { mod: "news" } } as Node);
  return `${JSON.stringify(main, null, 2)}\n`;
}

/** "A Herdr that renamed its tab bar": the insertion has nothing to stand next to. */
function renamedMain(): string {
  const main = JSON.parse(MAIN_TEXT) as Node;
  const tabs = byId(main, "tabs");
  assert.ok(tabs?.content);
  tabs.id = "tab-strip";
  tabs.content = { mod: "tab-strip" };
  return `${JSON.stringify(main, null, 2)}\n`;
}

const sha = (text: string): string => createHash("sha256").update(text).digest("hex");
const hashOf = (mainText: string): string => sha(JSON.stringify(JSON.parse(mainText)));

describe("syncLayout", () => {
  const appHome = "/home/tester/.config/herdr-app";
  const mainPath = `${appHome}/layouts/main.json`;
  const livingPath = `${appHome}/layouts/suspender.json`;
  let ports: FakePorts;
  let toasts: string[];
  let warned: Set<string>;
  const sync = (version = "0.1.14") =>
    syncLayout({ ports, appHome, herdrVersion: version, toast: (text) => toasts.push(text), warned });

  /** The living layout the mod would have built from `mainText` earlier. */
  const living = (mainText: string, version: string): string => {
    const built = buildLivingLayout(JSON.parse(mainText), version);
    assert.ok(built.ok);
    return `${JSON.stringify(built.layout, null, 2)}\n`;
  };

  beforeEach(() => {
    ports = fakePorts();
    toasts = [];
    warned = new Set();
    ports.files.set(mainPath, MAIN_TEXT);
  });

  it("builds the layout when there is none yet", async () => {
    assert.equal(await sync(), "rebuilt");
    const written = JSON.parse(ports.files.get(livingPath) ?? "null") as Node;
    assert.equal(written.suspender_generated?.from, hashOf(MAIN_TEXT));
    assert.ok(byId(written, "suspender-toggle"));
    assert.ok(byId(written, "suspender-panel"));
    assert.equal(toasts.length, 0);
  });

  it("writes nothing when the living layout is already built from this main.json", async () => {
    ports.files.set(livingPath, living(MAIN_TEXT, "0.1.14"));
    assert.equal(await sync(), "fresh");
    assert.deepEqual(ports.writes, []);
  });

  it("rebuilds from the new main.json when Herdr updated it (a new version's fixture)", async () => {
    ports.files.set(livingPath, living(MAIN_TEXT, "0.1.14"));
    ports.files.set(mainPath, newerMain());
    assert.equal(await sync("0.1.15"), "rebuilt");
    const written = JSON.parse(ports.files.get(livingPath) ?? "null") as Node;
    assert.equal(written.suspender_generated?.from, hashOf(newerMain()));
    assert.equal(written.cloned_from?.version, "0.1.15");
    // The update's own change (a taller tab bar, which the topbar now carries) is in, and our insertions still stand.
    assert.equal(byId(written, "suspender-topbar")?.size?.px, 34);
    assert.ok(byId(written, "news"));
    assert.ok(byId(written, "suspender-toggle"));
    assert.ok(byId(written, "suspender-panel"));
    assert.ok(
      byId(written, "suspender-pill") ?? nodes(written).some((n) => n.floating?.some((f) => f.id === "suspender-pill")),
    );
    assert.equal(toasts.length, 0);
  });

  it("rebuilds when only the Herdr version changed and main.json did not", async () => {
    ports.files.set(livingPath, living(MAIN_TEXT, "0.1.14"));
    assert.equal(await sync("0.1.15"), "rebuilt");
    const written = JSON.parse(ports.files.get(livingPath) ?? "null") as Node;
    assert.equal(written.cloned_from?.version, "0.1.15");
  });

  it("keeps the last working file and says so once when the insertion does not fit", async () => {
    const before = living(MAIN_TEXT, "0.1.14");
    ports.files.set(livingPath, before);
    ports.files.set(mainPath, renamedMain());
    assert.equal(await sync("0.1.15"), "kept");
    assert.equal(ports.files.get(livingPath), before);
    assert.deepEqual(ports.writes, []);
    assert.deepEqual(toasts, [t("notice.layoutOutdated", { version: "0.1.15" })]);
    // Another copy shows up and looks at the same main.json: no second toast.
    assert.equal(await sync("0.1.15"), "kept");
    assert.equal(toasts.length, 1);
  });

  it("says it again for a later Herdr that still does not fit", async () => {
    ports.files.set(mainPath, renamedMain());
    await sync("0.1.15");
    await sync("0.1.16");
    assert.equal(toasts.length, 2);
    assert.equal(ports.files.has(livingPath), false);
  });

  it("gives up quietly when another copy writes the file first", async () => {
    ports.files.set(livingPath, living(MAIN_TEXT, "0.1.14"));
    ports.files.set(mainPath, newerMain());
    ports.beforeWrite = (path) => {
      ports.files.set(path, '{"someone":"else"}');
    };
    assert.equal(await sync("0.1.15"), "kept");
    assert.equal(ports.files.get(livingPath), '{"someone":"else"}');
    assert.equal(toasts.length, 0);
  });

  it("does nothing without a readable main.json", async () => {
    ports.files.delete(mainPath);
    assert.equal(await sync(), "no-main");
    ports.files.set(mainPath, "{ not json");
    assert.equal(await sync(), "no-main");
    assert.deepEqual(ports.writes, []);
    assert.equal(toasts.length, 0);
  });

  it("rebuilds a living layout that is not valid JSON", async () => {
    ports.files.set(livingPath, "garbage");
    assert.equal(await sync(), "rebuilt");
    assert.doesNotThrow(() => JSON.parse(ports.files.get(livingPath) ?? ""));
  });
});
