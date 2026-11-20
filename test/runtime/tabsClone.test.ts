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
  patchPane,
  patchTabs,
  TABS_CHECK_STALE_MS,
  type TabsCloneDeps,
  type TabsOutcome,
  tabsKeeper,
} from "../../src/runtime/tabsClone.ts";
import { type FakePorts, fakePorts } from "../fakePorts.ts";

const fixture = (name: string): string => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8");
const SHIPPED = {
  "0.1.14": fixture("tabs-main-0.1.14.js"),
  "0.1.15": fixture("tabs-main-0.1.15.js"),
  "0.1.16": fixture("tabs-main-0.1.16.js"),
};
const sha = (text: string): string => createHash("sha256").update(text).digest("hex");

// The patch as the ticket words it, character for character.
const ENABLED_BEFORE = 'const enabled = shared("workspace.panels") ?? ["files", "changes"];';
const ENABLED_AFTER = 'const enabled = [...(shared("workspace.panels") ?? ["files", "changes"]), "suspender"];';
const BUTTONS = ".when(w?.buttons,";
const SESSIONS =
  '.child(panelButton("suspender", String(shared("suspender.tabLabel") ?? "Sessions"), "mods/suspender/icons/moon.svg"))';
// The sleeping agent's icon (ADR 19): only where the shipped file names a tab's program this way.
const PROGRAM_BEFORE = "const program = lead?.program;";
const PROGRAM_AFTER =
  'const program = (lead?.mod === "suspender" ? shared("suspender.tabIcons")?.[lead.tab] : null) ?? lead?.program;';
/** Herdr releases whose tab bar takes a tab's icon from `const program = lead?.program;`. */
const NAMES_PROGRAM = new Set(["0.1.16"]);
const mark = (text: string): string => `// suspender-tabs: from tabs/main.js sha256=${sha(text)} patch=2`;

const count = (text: string, needle: string): number => text.split(needle).length - 1;

describe("patchTabs", () => {
  for (const [version, source] of Object.entries(SHIPPED)) {
    it(`patches Herdr ${version}'s tab bar: the fingerprint first, then the shipped file with its changes`, () => {
      const out = patchTabs(source, sha(source));
      assert.ok(out !== null);
      const [first, ...rest] = out.split("\n");
      assert.equal(first, mark(source));
      const body = rest.join("\n");
      assert.equal(count(body, ENABLED_AFTER), 1);
      assert.equal(count(body, ENABLED_BEFORE), 0);
      assert.equal(count(body, SESSIONS), 1);
      const icon = NAMES_PROGRAM.has(version);
      assert.equal(count(body, PROGRAM_AFTER), icon ? 1 : 0);
      assert.equal(count(body, PROGRAM_BEFORE), icon ? 0 : count(source, PROGRAM_BEFORE));
      // Undo the changes: what is left is the shipped file, byte for byte (its mods/tabs/ paths too).
      const undone = body
        .replace(ENABLED_AFTER, ENABLED_BEFORE)
        .replace(PROGRAM_AFTER, PROGRAM_BEFORE)
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

  it("still patches a tab bar that names a tab's program another way, without the icon", () => {
    const source = SHIPPED["0.1.16"].replace(PROGRAM_BEFORE, "const program = lead && lead.program;");
    const out = patchTabs(source, sha(source));
    assert.ok(out !== null);
    assert.equal(count(out, SESSIONS), 1);
    assert.equal(count(out, PROGRAM_AFTER), 0);
  });

  it("leaves the icon out, and patches the rest, when its anchor is there twice or the change is already there", () => {
    for (const extra of [PROGRAM_BEFORE, PROGRAM_AFTER]) {
      const source = `${SHIPPED["0.1.16"]}\n// ${extra}\n`;
      const out = patchTabs(source, sha(source));
      assert.ok(out !== null, extra);
      assert.equal(count(out, SESSIONS), 1);
      assert.equal(count(out, PROGRAM_BEFORE), count(source, PROGRAM_BEFORE), "nothing replaced");
    }
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

  describe("with the pane header copy (ADR 20)", () => {
    const paneCopy = `${appHome}/mods/suspender-pane/main.js`;
    const living = (): { header?: unknown; mod?: unknown } => {
      const layout = JSON.parse(ports.files.get(livingPath) ?? "{}") as {
        suspender_generated?: { header?: unknown };
        children?: unknown[];
      };
      const text = JSON.stringify(layout);
      return {
        header: layout.suspender_generated?.header,
        mod: text.includes('"mod":"suspender-pane"') ? "suspender-pane" : text.includes('"mod":"pane"') ? "pane" : null,
      };
    };
    const withPane = (): typeof keep =>
      tabsKeeper({
        ports,
        appHome,
        cloneMod: () => {
          ports.files.set(`${appHome}/mods/suspender-tabs/main.js`, source);
          ports.files.set(`${appHome}/mods/suspender-tabs/mod.json`, '{ "cloned_from": { "name": "tabs" } }');
        },
        clonePane: () => {
          ports.files.set(paneCopy, PANE);
          ports.files.set(`${appHome}/mods/suspender-pane/mod.json`, '{ "cloned_from": { "name": "pane" } }');
        },
        herdrVersion: () => "0.1.15",
        warned: new Set(),
        now: () => now,
      });

    beforeEach(() => {
      ports.files.set(`${appHome}/mods/pane/main.js`, PANE);
      ports.files.set(`${appHome}/mods/pane/mod.json`, '{ "place": "none", "title": "Pane header" }');
    });

    it("makes the copy, checks it, and draws every pane's header with it", async () => {
      const out = await withPane()(noSleep, toast);
      assert.equal(out.mode, "clone");
      assert.ok(ports.files.get(paneCopy)?.startsWith(paneMark(PANE)), "the patched copy");
      assert.deepEqual(living(), { header: "clone", mod: "suspender-pane" });
      assert.equal(checks, 2, "the tab bar's copy and the header's, each checked once");
      assert.deepEqual(toasts, []);
    });

    it("a failed check of the header keeps Herdr's own header, quietly, and the tab bar's copy", async () => {
      checkResult = async () => ({ code: 0, stdout: "ok", stderr: "" });
      const exec = ports.exec;
      ports.exec = async (cmd, args, opts) =>
        args.some((a) => a.includes("suspender-pane")) ? { code: 1, stdout: "", stderr: "bad" } : exec(cmd, args, opts);
      const out = await withPane()(noSleep, toast);
      assert.equal(out.mode, "clone");
      assert.deepEqual(living(), { header: "builtin", mod: "pane" });
      assert.equal(ports.files.get(paneCopy), undefined, "nothing written under mods/");
      assert.deepEqual(toasts, []);
    });
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

// The live copy of Herdr's pane header (ADR 20): the pane it draws goes through `sleeping`, which
// gives our sleeping pane its agent's name, icon and folder from shared("suspender.paneHeads").
const PANE = fixture("pane-main-0.1.16.js");
const ME_BEFORE = "const p = this.me();";
const ME_AFTER = "const p = sleeping(this.me());";
const PANE_IMPORT = 'import { shared as suspenderShared } from "herdr";';
const paneMark = (text: string): string => `// suspender-pane: from pane/main.js sha256=${sha(text)} patch=1`;

describe("patchPane", () => {
  it("patches Herdr 0.1.16's pane header: the fingerprint, the pane through `sleeping`, the helper at the end", () => {
    const out = patchPane(PANE, sha(PANE));
    assert.ok(out !== null);
    const [first, ...rest] = out.split("\n");
    assert.equal(first, paneMark(PANE));
    const body = rest.join("\n");
    assert.equal(count(body, ME_AFTER), 1);
    assert.equal(count(body, ME_BEFORE), 0);
    assert.equal(count(body, PANE_IMPORT), 1);
    assert.equal(count(body, "function sleeping("), 1);
    // Undo: what is left is the shipped file, byte for byte.
    const helper = body.indexOf("\n// suspender-pane:");
    assert.ok(helper > 0);
    assert.equal(body.slice(0, helper).replace(ME_AFTER, ME_BEFORE).trimEnd(), PANE.trimEnd());
  });

  it("patches a shipped file with Windows line endings the same way", () => {
    const crlf = PANE.replace(/\n/g, "\r\n");
    const out = patchPane(crlf, sha(crlf));
    assert.ok(out !== null);
    assert.equal(count(out, ME_AFTER), 1);
    assert.equal(count(out, PANE_IMPORT), 1);
  });

  it("refuses when its anchor is missing or there twice, or the helper is already there", () => {
    assert.equal(patchPane(PANE.replace(ME_BEFORE, "const p = this.find();"), "x"), null);
    assert.equal(patchPane(`${PANE}\n// ${ME_BEFORE}\n`, "x"), null);
    assert.equal(patchPane(`${PANE}\nfunction sleeping(p) { return p; }\n`, "x"), null);
  });
});

describe("the sleeping agent in the copy of the pane header", () => {
  // The helper the patch adds, run on its own with Herdr's shared() faked.
  const sleeping = (pane: unknown, heads: unknown): unknown => {
    const out = patchPane(PANE, "x") ?? "";
    const fn = out.slice(out.indexOf("function sleeping("));
    const make = new Function("suspenderShared", `${fn}\nreturn sleeping;`);
    return make((key: string) => (key === "suspender.paneHeads" ? heads : null))(pane);
  };
  const HEAD = { key: "claude", name: "Claude Code", icon: "icons/claude.svg", tint: false, cwd: "C:\\work\\repo" };

  it("gives our sleeping pane its agent's name, icon and folder, as Herdr's header draws an agent's", () => {
    const shown = sleeping({ pane: "p1", mod: "suspender", tab: "tb1", title: "suspender" }, { p1: HEAD }) as {
      cwd: unknown;
      program: { name: unknown; icon: unknown; tint: unknown; agent: unknown; key: unknown };
    };
    assert.equal(shown.cwd, HEAD.cwd);
    assert.equal(shown.program.name, "Claude Code");
    assert.equal(shown.program.icon, HEAD.icon);
    assert.equal(shown.program.tint, false);
    assert.equal(shown.program.agent, true, "the header names an agent by its program");
    assert.equal(shown.program.key, "claude");
  });

  it("leaves a terminal, another mod's pane, and a pane with nothing published as they are", () => {
    const term = { pane: "p1", terminal: "t1", tab: "tb1", program: { name: "pwsh", shell: true } };
    assert.equal(sleeping(term, { p1: HEAD }), term);
    const files = { pane: "p1", mod: "files", tab: "tb1" };
    assert.equal(sleeping(files, { p1: HEAD }), files);
    const ours = { pane: "p2", mod: "suspender", tab: "tb1" };
    assert.equal(sleeping(ours, { p1: HEAD }), ours);
    assert.equal(sleeping(ours, null), ours);
    assert.equal(sleeping(undefined, { p1: HEAD }), undefined);
  });
});

describe("the sleeping agent's icon in the copy of the tab bar", () => {
  // The changed line, run on its own: `lead` is the pane the tab bar picked for a tab, `shared` Herdr's.
  const pick = (lead: unknown, icons: unknown): unknown =>
    new Function("lead", "shared", `${PROGRAM_AFTER} return program;`)(lead, (key: string) =>
      key === "suspender.tabIcons" ? icons : null,
    );
  const ICON = { icon: "icons/claude.svg", tint: false };
  const SHELL = { key: "shell", icon: "icons/shell.svg", tint: true, agent: false };

  it("draws the published icon on a tab whose pane is ours", () => {
    assert.deepEqual(pick({ pane: "p1", mod: "suspender", tab: "tb1" }, { tb1: ICON }), ICON);
  });

  it("keeps a terminal's own program, whatever is published for its tab", () => {
    assert.deepEqual(pick({ pane: "p1", terminal: "t1", tab: "tb1", program: SHELL }, { tb1: ICON }), SHELL);
  });

  it("draws nothing new for another mod's pane, a tab with nothing published, or before anything is", () => {
    assert.equal(pick({ pane: "p1", mod: "files", tab: "tb1" }, { tb1: ICON }), undefined);
    assert.equal(pick({ pane: "p1", mod: "suspender", tab: "tb2" }, { tb1: ICON }), undefined);
    assert.equal(pick({ pane: "p1", mod: "suspender", tab: "tb1" }, null), undefined);
    assert.equal(pick(undefined, { tb1: ICON }), undefined);
  });
});
