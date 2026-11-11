// The live copy of Herdr's tab bar (`mods/suspender-tabs/`): Herdr's shipped
// tabs/main.js with one patch, rebuilt when the shipped file changes, refused
// when the patch does not fit. The shipped files below are verbatim copies of
// two Herdr releases' mods/tabs/main.js.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { beforeEach, describe, it } from "node:test";
import type { ExecResult } from "../../src/platform/ports.ts";
import { ensureTabsClone, patchTabs, type TabsCloneDeps } from "../../src/runtime/tabsClone.ts";
import { type FakePorts, fakePorts } from "../fakePorts.ts";

const fixture = (name: string): string => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8");
const SHIPPED = { "0.1.14": fixture("tabs-main-0.1.14.js"), "0.1.15": fixture("tabs-main-0.1.15.js") };
const sha = (text: string): string => createHash("sha256").update(text).digest("hex");

// The patch as the ticket words it, character for character.
const ENABLED_BEFORE = 'const enabled = shared("workspace.panels") ?? ["files", "changes"];';
const ENABLED_AFTER = 'const enabled = [...(shared("workspace.panels") ?? ["files", "changes"]), "suspender"];';
const BUTTONS = ".when(w?.buttons,";
const SESSIONS =
  '.child(panelButton("suspender", String(shared("suspender.tabLabel") ?? "Sessions"), "mods/suspender/icons/moon.svg"))';
const mark = (text: string): string => `// suspender-tabs: from tabs/main.js sha256=${sha(text)} patch=1`;

const count = (text: string, needle: string): number => text.split(needle).length - 1;

describe("patchTabs", () => {
  for (const [version, source] of Object.entries(SHIPPED)) {
    it(`patches Herdr ${version}'s tab bar: the fingerprint first, then the shipped file with two changes`, () => {
      const out = patchTabs(source, sha(source));
      assert.ok(out !== null);
      const [first, ...rest] = out.split("\n");
      assert.equal(first, mark(source));
      const body = rest.join("\n");
      assert.equal(count(body, ENABLED_AFTER), 1);
      assert.equal(count(body, ENABLED_BEFORE), 0);
      assert.equal(count(body, SESSIONS), 1);
      // Undo the two changes: what is left is the shipped file, byte for byte (its mods/tabs/ paths too).
      const undone = body
        .replace(ENABLED_AFTER, ENABLED_BEFORE)
        .replace(/\.child\(panelButton\("suspender"[^\n]*\n\s*/, "");
      assert.equal(undone, source);
    });

    it(`puts Sessions after Changes and before the window buttons in Herdr ${version}`, () => {
      const out = patchTabs(source, sha(source)) ?? "";
      const changes = out.indexOf('panelButton("changes"');
      const sessions = out.indexOf(SESSIONS);
      const buttons = out.indexOf(BUTTONS);
      assert.ok(changes > 0 && changes < sessions && sessions < buttons, `${changes} < ${sessions} < ${buttons}`);
    });
  }

  it("patches a shipped file with Windows line endings the same way", () => {
    const crlf = SHIPPED["0.1.14"].replace(/\n/g, "\r\n");
    const out = patchTabs(crlf, sha(crlf));
    assert.ok(out !== null);
    assert.equal(count(out, ENABLED_AFTER), 1);
    assert.equal(count(out, SESSIONS), 1);
  });

  it("refuses when an anchor is missing", () => {
    const source = SHIPPED["0.1.15"];
    assert.equal(patchTabs(source.replace(BUTTONS, ".when(w?.controls,"), "x"), null);
    assert.equal(patchTabs(source.replace(ENABLED_BEFORE, "const enabled = ['files'];"), "x"), null);
  });

  it("refuses when an anchor is there twice", () => {
    const source = SHIPPED["0.1.15"];
    assert.equal(patchTabs(`${source}\n// ${BUTTONS}\n`, "x"), null);
    assert.equal(patchTabs(`${source}\n// ${ENABLED_BEFORE}\n`, "x"), null);
  });
});

describe("ensureTabsClone", () => {
  const appHome = "/home/tester/.config/herdr-app";
  const shippedPath = `${appHome}/mods/tabs/main.js`;
  const cloneDir = `${appHome}/mods/suspender-tabs`;
  const clonePath = `${cloneDir}/main.js`;
  const cloneJson = `${cloneDir}/mod.json`;
  const CLONED_JSON =
    '{\n  "place": "none",\n  "title": "Tabs",\n  "cloned_from": { "name": "tabs", "version": "0.1.15" }\n}';
  const source = SHIPPED["0.1.15"];
  const want = (text = source): string => patchTabs(text, sha(text)) ?? "";

  let ports: FakePorts;
  let clones: number;
  let slept: number;
  /** What mod.clone does here: Herdr copies the shipped folder (the default: at once). */
  let onClone: () => void;
  let checks: string[][];
  let checkResult: () => Promise<ExecResult>;
  let deps: TabsCloneDeps;

  beforeEach(() => {
    ports = fakePorts();
    ports.files.set(shippedPath, source);
    clones = 0;
    slept = 0;
    checks = [];
    onClone = () => {
      ports.files.set(clonePath, ports.files.get(shippedPath) ?? "");
      ports.files.set(cloneJson, CLONED_JSON);
    };
    checkResult = async () => ({ code: 0, stdout: "ok", stderr: "" });
    ports.exec = async (cmd, args) => {
      ports.execCalls.push({ cmd, args });
      if (cmd === "herdr-app" && args[0] === "check") {
        checks.push(args);
        return checkResult();
      }
      return { code: 127, stdout: "", stderr: "fake: no processes" };
    };
    deps = {
      ports,
      appHome,
      cloneMod: () => {
        clones++;
        onClone();
      },
      sleep: async (ms) => {
        slept += ms;
      },
    };
  });

  it("makes the copy with mod.clone, writes the patch over it, checks it, and says clone", async () => {
    const out = await ensureTabsClone(deps);
    assert.equal(out.mode, "clone");
    assert.equal(clones, 1);
    assert.equal(ports.files.get(clonePath), want());
    assert.deepEqual(checks, [["check", cloneDir]]);
  });

  it("waits for mod.clone to land before writing", async () => {
    let polls = 0;
    onClone = () => undefined;
    const realRead = ports.readText;
    ports.readText = async (path) => {
      if (path === clonePath && ++polls === 3) {
        ports.files.set(clonePath, source);
        ports.files.set(cloneJson, CLONED_JSON);
      }
      return realRead(path);
    };
    const out = await ensureTabsClone(deps);
    assert.equal(out.mode, "clone");
    assert.equal(ports.files.get(clonePath), want());
    assert.ok(slept > 0);
  });

  it("writes nothing when the copy is already the patch of this shipped file", async () => {
    ports.files.set(clonePath, want());
    ports.files.set(cloneJson, CLONED_JSON);
    const out = await ensureTabsClone(deps);
    assert.equal(out.mode, "clone");
    assert.equal(clones, 0);
    assert.deepEqual(ports.writes, []);
    assert.equal(checks.length, 1, "the copy is still checked");
  });

  it("rebuilds the copy when Herdr's tab bar changed (another sha)", async () => {
    // Made under 0.1.14; Herdr has since updated, and mods/tabs/main.js is 0.1.15's.
    ports.files.set(clonePath, want(SHIPPED["0.1.14"]));
    ports.files.set(cloneJson, CLONED_JSON);
    const out = await ensureTabsClone(deps);
    assert.equal(out.mode, "clone");
    assert.equal(clones, 0);
    assert.equal(ports.files.get(clonePath), want());
    assert.equal(ports.files.get(clonePath)?.split("\n")[0], mark(source));
  });

  it("falls back to the shipped tab bar when the patch does not fit, and leaves everything alone", async () => {
    ports.files.set(shippedPath, source.replace(BUTTONS, ".when(w?.controls,"));
    const out = await ensureTabsClone(deps);
    assert.deepEqual(out, { mode: "builtin", why: "anchors" });
    assert.equal(clones, 0);
    assert.deepEqual(ports.writes, []);
    assert.deepEqual(checks, []);
  });

  it("falls back when there is no shipped tab bar to copy", async () => {
    ports.files.delete(shippedPath);
    assert.deepEqual(await ensureTabsClone(deps), { mode: "builtin", why: "no-tabs" });
    assert.equal(clones, 0);
  });

  it("falls back when mod.clone makes nothing within its wait", async () => {
    onClone = () => undefined;
    const out = await ensureTabsClone(deps);
    assert.deepEqual(out, { mode: "builtin", why: "clone-failed" });
    assert.ok(slept >= 5_000, `waited ${slept} ms`);
    assert.deepEqual(ports.writes, []);
  });

  it("falls back when mod.clone throws", async () => {
    deps.cloneMod = () => {
      throw new Error("no such command");
    };
    assert.deepEqual(await ensureTabsClone(deps), { mode: "builtin", why: "clone-failed" });
  });

  it("never overwrites a suspender-tabs that is someone else's mod", async () => {
    ports.files.set(clonePath, "export default class Mine {}\n");
    ports.files.set(cloneJson, '{ "place": "none" }');
    const out = await ensureTabsClone(deps);
    assert.deepEqual(out, { mode: "builtin", why: "foreign" });
    assert.equal(ports.files.get(clonePath), "export default class Mine {}\n");
    assert.deepEqual(ports.writes, []);
  });

  it("takes over a plain clone of tabs (one this mod made before it could patch it)", async () => {
    ports.files.set(clonePath, SHIPPED["0.1.14"]);
    ports.files.set(cloneJson, CLONED_JSON);
    const out = await ensureTabsClone(deps);
    assert.equal(out.mode, "clone");
    assert.equal(ports.files.get(clonePath), want());
  });

  describe("the write race between copies of the mod", () => {
    it("another copy wrote the same patch first: the refused write is not a failure", async () => {
      ports.files.set(clonePath, want(SHIPPED["0.1.14"]));
      ports.files.set(cloneJson, CLONED_JSON);
      ports.beforeWrite = (path) => {
        ports.files.set(path, want());
      };
      const out = await ensureTabsClone(deps);
      assert.equal(out.mode, "clone");
      assert.equal(ports.writes.length, 1);
      assert.equal(ports.writes[0]?.ok, false);
      assert.equal(ports.files.get(clonePath), want());
    });

    it("another copy wrote something else first: read again and write over it", async () => {
      ports.files.set(clonePath, want(SHIPPED["0.1.14"]));
      ports.files.set(cloneJson, CLONED_JSON);
      let raced = false;
      ports.beforeWrite = (path) => {
        if (!raced) {
          raced = true;
          ports.files.set(path, `${mark("older")}\n// an older build's patch\n`);
        }
      };
      const out = await ensureTabsClone(deps);
      assert.equal(out.mode, "clone");
      assert.equal(ports.files.get(clonePath), want());
    });

    it("a write refused every time falls back", async () => {
      ports.files.set(clonePath, want(SHIPPED["0.1.14"]));
      ports.files.set(cloneJson, CLONED_JSON);
      let n = 0;
      ports.beforeWrite = (path) => {
        ports.files.set(path, `${mark(`other-${++n}`)}\n`);
      };
      assert.deepEqual(await ensureTabsClone(deps), { mode: "builtin", why: "write-refused" });
    });
  });

  describe("herdr-app check of the copy before the layout uses it", () => {
    it("a failing check falls back", async () => {
      checkResult = async () => ({ code: 1, stdout: "", stderr: "SyntaxError: Unexpected token" });
      assert.deepEqual(await ensureTabsClone(deps), { mode: "builtin", why: "check-failed" });
      assert.equal(checks.length, 1);
    });

    it("a check that cannot run falls back too", async () => {
      checkResult = async () => {
        throw new Error("program not found");
      };
      assert.deepEqual(await ensureTabsClone(deps), { mode: "builtin", why: "check-failed" });
    });
  });
});
