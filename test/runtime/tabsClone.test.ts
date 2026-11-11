// The live copy of Herdr's tab bar (`mods/suspender-tabs/`): Herdr's shipped
// tabs/main.js with one patch, rebuilt when the shipped file changes, refused
// when the patch does not fit. The shipped files below are verbatim copies of
// two Herdr releases' mods/tabs/main.js.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { beforeEach, describe, it } from "node:test";
import { t } from "../../src/i18n/index.ts";
import type { ExecResult } from "../../src/platform/ports.ts";
import {
  CHECK_TIMEOUT_MS,
  ensureTabsClone,
  patchTabs,
  TABS_CHECK_STALE_MS,
  type TabsCloneDeps,
  type TabsOutcome,
  tabsKeeper,
} from "../../src/runtime/tabsClone.ts";
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

  it("makes both changes when the shipped file defines `enabled` below the window buttons", () => {
    // A tabs/main.js that moved `const enabled` after `.when(w?.buttons,`: the panel list must still get Sessions.
    const source = `${SHIPPED["0.1.15"].replace(ENABLED_BEFORE, "")}\nfunction later() {\n  ${ENABLED_BEFORE}\n}\n`;
    assert.ok(source.indexOf(BUTTONS) < source.indexOf(ENABLED_BEFORE));
    const out = patchTabs(source, sha(source));
    assert.ok(out !== null);
    assert.equal(count(out, ENABLED_AFTER), 1, "the panel list gets Sessions");
    assert.equal(count(out, ENABLED_BEFORE), 0);
    assert.equal(count(out, SESSIONS), 1);
  });

  it("refuses a shipped file that already carries one of the changes (they would not each happen once)", () => {
    const source = SHIPPED["0.1.15"];
    assert.equal(patchTabs(`${source}\n// ${ENABLED_AFTER}\n`, "x"), null);
    assert.equal(patchTabs(`${source}\n// ${SESSIONS}\n`, "x"), null);
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
  /** Where the new text is checked before it goes live: the mod's own folder, outside mods/. */
  const candidateDir = `${appHome}/suspender/tabs-check/suspender-tabs`;
  const liveWrites = () => ports.writes.filter((w) => w.path.startsWith(`${appHome}/mods/`));
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
    assert.deepEqual(checks, [["check", candidateDir]]);
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
    assert.deepEqual(liveWrites(), []);
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
    assert.deepEqual(liveWrites(), []);
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
    assert.deepEqual(liveWrites(), []);
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
    assert.deepEqual(liveWrites(), []);
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
        if (path === clonePath) {
          ports.files.set(path, want());
        }
      };
      const out = await ensureTabsClone(deps);
      assert.equal(out.mode, "clone");
      assert.equal(liveWrites().length, 1);
      assert.equal(liveWrites()[0]?.ok, false);
      assert.equal(ports.files.get(clonePath), want());
    });

    it("another copy wrote something else first: read again and write over it", async () => {
      ports.files.set(clonePath, want(SHIPPED["0.1.14"]));
      ports.files.set(cloneJson, CLONED_JSON);
      let raced = false;
      ports.beforeWrite = (path) => {
        if (path === clonePath && !raced) {
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
        if (path === clonePath) {
          ports.files.set(path, `${mark(`other-${++n}`)}\n`);
        }
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

    it("checks the new text in a folder outside mods/ while the live copy still holds the old one", async () => {
      const old = want(SHIPPED["0.1.14"]);
      ports.files.set(clonePath, old);
      ports.files.set(cloneJson, CLONED_JSON);
      let seen: { checked: string | undefined; live: string | undefined } | null = null;
      checkResult = async () => {
        const dir = checks.at(-1)?.[1] ?? "";
        seen = { checked: ports.files.get(`${dir}/main.js`), live: ports.files.get(clonePath) };
        return { code: 0, stdout: "ok", stderr: "" };
      };
      const out = await ensureTabsClone(deps);
      assert.equal(out.mode, "clone");
      assert.equal(checks[0]?.[1], candidateDir, "checked outside mods/");
      assert.deepEqual(
        seen,
        { checked: want(), live: old },
        "the check saw the new text; the live copy was the old one",
      );
      assert.equal(ports.files.get(clonePath), want(), "written once the check passed");
    });

    it("a failing check of a rebuild leaves the live copy as it was", async () => {
      // The layout is already on the copy (every Herdr update): Herdr would show whatever lands in mods/.
      const old = want(SHIPPED["0.1.14"]);
      ports.files.set(clonePath, old);
      ports.files.set(cloneJson, CLONED_JSON);
      checkResult = async () => ({ code: 1, stdout: "", stderr: "SyntaxError: Unexpected token" });
      assert.deepEqual(await ensureTabsClone(deps), { mode: "builtin", why: "check-failed" });
      assert.equal(ports.files.get(clonePath), old);
      assert.deepEqual(liveWrites(), []);
    });

    it("a failing check makes no copy at all on a clean install", async () => {
      checkResult = async () => ({ code: 1, stdout: "", stderr: "SyntaxError: Unexpected token" });
      assert.deepEqual(await ensureTabsClone(deps), { mode: "builtin", why: "check-failed" });
      assert.equal(clones, 0);
      assert.equal(ports.files.has(clonePath), false);
    });

    it("a check that cannot run falls back too", async () => {
      checkResult = async () => {
        throw new Error("program not found");
      };
      assert.deepEqual(await ensureTabsClone(deps), { mode: "builtin", why: "check-failed" });
    });
  });
});

describe("tabsKeeper (what the shown copies of one window ask)", () => {
  const appHome = "/home/tester/.config/herdr-app";
  const MAIN_TEXT = fixture("main-0.1.14.json");
  const source = SHIPPED["0.1.15"];
  const livingPath = `${appHome}/layouts/suspender.json`;
  const noSleep = async (): Promise<void> => undefined;
  const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

  let ports: FakePorts;
  let now: number;
  let toasts: string[];
  let checks: number;
  let checkResult: () => Promise<ExecResult>;
  let keep: ReturnType<typeof tabsKeeper>;
  const toast = (text: string): void => {
    toasts.push(text);
  };

  beforeEach(() => {
    ports = fakePorts();
    ports.files.set(`${appHome}/mods/tabs/main.js`, source);
    ports.files.set(`${appHome}/mods/tabs/mod.json`, '{ "place": "none", "title": "Tabs" }');
    ports.files.set(`${appHome}/layouts/main.json`, MAIN_TEXT);
    now = 1_800_000_000_000;
    toasts = [];
    checks = 0;
    checkResult = async () => ({ code: 0, stdout: "ok", stderr: "" });
    ports.exec = async (cmd, args) => {
      ports.execCalls.push({ cmd, args });
      if (cmd === "herdr-app" && args[0] === "check") {
        checks++;
        return checkResult();
      }
      return { code: 127, stdout: "", stderr: "fake: no processes" };
    };
    keep = tabsKeeper({
      ports,
      appHome,
      cloneMod: () => {
        ports.files.set(`${appHome}/mods/suspender-tabs/main.js`, source);
        ports.files.set(`${appHome}/mods/suspender-tabs/mod.json`, '{ "cloned_from": { "name": "tabs" } }');
      },
      herdrVersion: () => "0.1.15",
      warned: new Set(),
      now: () => now,
    });
  });

  const layoutTabs = (): unknown =>
    (JSON.parse(ports.files.get(livingPath) ?? "{}") as { suspender_generated?: { tabs?: unknown } })
      .suspender_generated?.tabs;

  it("a failed check: exactly one toast for every copy, and the layout on Herdr's own tab bar", async () => {
    checkResult = async () => ({ code: 1, stdout: "", stderr: "SyntaxError: Unexpected token" });
    const outs = await Promise.all([keep(noSleep, toast), keep(noSleep, toast), keep(noSleep, toast)]);
    assert.deepEqual(
      outs.map((o) => o.mode),
      ["builtin", "builtin", "builtin"],
    );
    assert.deepEqual(toasts, [t("notice.tabsFallback")]);
    assert.equal(layoutTabs(), "builtin");
    assert.equal(checks, 1, "one check for the whole window");
  });

  it("a passing check: no toast, and the layout on the copy", async () => {
    const out = await keep(noSleep, toast);
    assert.equal(out.mode, "clone");
    assert.deepEqual(toasts, []);
    assert.equal(layoutTabs(), "clone");
  });

  it("another copy of the mod wrote the same candidate first: still a pass, no toast", async () => {
    const candidateMain = `${appHome}/suspender/tabs-check/suspender-tabs/main.js`;
    const patched = patchTabs(source, sha(source));
    const write = ports.writeText;
    // As Herdr's port does: no `expected` means "what is there now", read before the write lands.
    ports.writeText = async (path, text, expected) =>
      write(path, text, expected === undefined ? (ports.files.get(path) ?? null) : expected);
    ports.beforeWrite = (path) => {
      if (path === candidateMain && patched !== null) {
        ports.files.set(path, patched);
      }
    };
    const out = await keep(noSleep, toast);
    assert.ok(
      ports.writes.some((w) => w.path === candidateMain && !w.ok),
      "the candidate write was refused",
    );
    assert.equal(out.mode, "clone");
    assert.deepEqual(toasts, []);
    assert.equal(layoutTabs(), "clone");
  });

  describe("a check that hangs", () => {
    let first: Promise<TabsOutcome> | null = null;
    beforeEach(() => {
      checkResult = () => new Promise<ExecResult>(() => undefined);
    });

    it("is not started again while it may still run (within its own timeout)", async () => {
      first = keep(noSleep, toast);
      await tick();
      assert.equal(checks, 1);
      now += TABS_CHECK_STALE_MS + 1_000;
      void keep(noSleep, toast);
      await tick();
      assert.equal(checks, 1, "no second herdr-app check beside the first");
      assert.ok(first);
    });

    it("is started again once the first one's timeout has passed", async () => {
      first = keep(noSleep, toast);
      await tick();
      now += CHECK_TIMEOUT_MS + TABS_CHECK_STALE_MS + 1_000;
      void keep(noSleep, toast);
      await tick();
      assert.equal(checks, 2);
      assert.ok(first);
    });
  });
});
