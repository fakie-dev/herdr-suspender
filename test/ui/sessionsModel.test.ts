import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildLivingLayout } from "../../src/core/layout.ts";
import { modPx, windowPx } from "../../src/core/scale.ts";
import { t } from "../../src/i18n/index.ts";
import {
  fitRow,
  formatMb,
  groupSessions,
  isSleeping,
  MemoryPolicy,
  memoryFreedText,
  panelShown,
  pillAgent,
  popupFacts,
  popupHeight,
  popupPosition,
  rowMemory,
  sleepingCount,
  TITLE_LINE_PX,
  TITLE_MAX_LINES,
  wrapLines,
} from "../../src/ui/sessionsModel.ts";
import { HOME, rec } from "./helpers.ts";

/** 6 px per character: the widths in the comments below are this, plus the icons. */
const six = (text: string): number => text.length * 6;
/** Zoom 1: window px and the mod's px are the same (other zooms: scale.test.ts). */
const ONE = { zoom: 1 };

describe("sleeping count (the N of 'Sessions · N')", () => {
  it("counts every state that has a sleeping tab, and no running one", () => {
    const states = [
      "asleep",
      "interrupted",
      "waking",
      "elsewhere",
      "missing",
      "error",
      "running",
      "working",
      "confirming",
      "stopping",
    ] as const;
    const records = states.map((s, i) => rec(`s${i}`, s));
    assert.equal(sleepingCount(records), 6);
    assert.deepEqual(
      states.filter((s) => isSleeping(s)),
      ["asleep", "interrupted", "waking", "elsewhere", "missing", "error"],
    );
  });
});

describe("groupSessions", () => {
  const spaces = [
    { id: "spB", name: "api-gateway" },
    { id: "spA", name: "landing" },
  ];

  it("follows the order of the spaces; the ones Herdr no longer has go last", () => {
    const groups = groupSessions(
      [
        rec("u", "asleep", { spaceId: "spGone" }),
        rec("a", "running", { spaceId: "spA" }),
        rec("b", "running", { spaceId: "spB" }),
      ],
      spaces,
    );
    assert.deepEqual(
      groups.map((g) => g.name),
      ["api-gateway", "landing", t("panel.unknownSpace")],
    );
  });

  it("puts running before asleep before interrupted inside a space", () => {
    const [group] = groupSessions(
      [
        rec("i1", "interrupted", { spaceId: "spB" }),
        rec("s1", "asleep", { spaceId: "spB" }),
        rec("r1", "working", { spaceId: "spB" }),
        rec("w1", "waking", { spaceId: "spB" }),
        rec("e1", "error", { spaceId: "spB" }),
        rec("r2", "running", { spaceId: "spB" }),
      ],
      spaces,
    );
    // Running (r1 r2), then asleep or waking (s1 w1), then interrupted or failed (e1 i1).
    assert.deepEqual(
      group?.rows.map((r) => r.sessionId),
      ["r1", "r2", "s1", "w1", "e1", "i1"],
    );
  });

  it("sorts equals by title, then by key, and keeps untitled last", () => {
    const [group] = groupSessions(
      [
        rec("k3", "asleep", { spaceId: "spB" }),
        rec("k2", "asleep", { spaceId: "spB", info: { title: "beta" } }),
        rec("k1", "asleep", { spaceId: "spB", info: { title: "alpha" } }),
      ],
      spaces,
    );
    assert.deepEqual(
      group?.rows.map((r) => r.sessionId),
      ["k1", "k2", "k3"],
    );
  });

  it("lists what 'Resume all in project' would wake: asleep and interrupted, in row order", () => {
    const [group] = groupSessions(
      [
        rec("a", "asleep", { spaceId: "spB" }),
        rec("r", "running", { spaceId: "spB" }),
        rec("i", "interrupted", { spaceId: "spB" }),
        rec("m", "missing", { spaceId: "spB" }),
      ],
      spaces,
    );
    assert.deepEqual(group?.resumable, ["claude:a", "claude:i"]);
  });

  it("makes no group for a space without sessions", () => {
    assert.deepEqual(groupSessions([], spaces), []);
  });
});

describe("memory", () => {
  it("formats MB under a thousand and GB above, one decimal", () => {
    assert.equal(formatMb(780), "780 MB");
    assert.equal(formatMb(999), "999 MB");
    assert.equal(formatMb(1000), "1.0 GB");
    assert.equal(formatMb(2100), "2.1 GB");
  });

  it("sums only what sleeping sessions freed for the header", () => {
    const records = [
      rec("a", "asleep", { memFreedMb: 780 }),
      rec("b", "interrupted", { memFreedMb: 910 }),
      rec("c", "asleep", { memFreedMb: 410 }),
      // A stale figure from an earlier sleep of a session that runs again.
      rec("d", "running", { memFreedMb: 500 }),
      rec("e", "asleep"),
    ];
    assert.equal(memoryFreedText(records), "2.1 GB memory freed");
  });

  it("says nothing when nothing is known to be freed", () => {
    assert.equal(memoryFreedText([rec("a", "asleep"), rec("b", "running", { memFreedMb: 500 })]), null);
    assert.equal(memoryFreedText([]), null);
  });

  it("shows freed for sleepers and used for runners, and nothing without a figure", () => {
    assert.deepEqual(rowMemory(rec("a", "asleep", { memFreedMb: 780 }), null), { kind: "freed", text: "780 MB" });
    assert.deepEqual(rowMemory(rec("b", "running"), 640), { kind: "used", text: "640 MB" });
    assert.equal(rowMemory(rec("c", "asleep"), 640), null);
    assert.equal(rowMemory(rec("d", "working"), null), null);
    // A running session ignores the stale freed figure.
    assert.equal(rowMemory(rec("e", "running", { memFreedMb: 500 }), null), null);
  });
});

describe("fitRow: whole items go, +N counts them", () => {
  // Widths at 6 px per character. Chrome around a row: 54 px; memory "910 MB" reserves
  // 36 + 15 (its icon) + 8 (gap) = 59 px; branch and folder carry a 16 px icon; a separator
  // is "·" with 6 px either side, 18 px; the badge is its 6 px gap, 14 px of padding and
  // border, and "+N" (12), 32 px.
  const long = rec("c41b07e2-9f13-4d8a-b2c5-77e0a1d93f52", "asleep", {
    info: {
      branch: "feature/PORTAL-412-oauth-device-flow-for-tv",
      model: "Opus 5.5",
      cwd: `${HOME}\\Documents\\dev\\clients\\northwind-portal\\apps\\web\\src\\auth`,
      repoRoot: `${HOME}\\Documents\\dev\\clients\\northwind-portal`,
      sessionId: "c41b07e2-9f13-4d8a-b2c5-77e0a1d93f52",
    },
  });
  // branch "feature/PORTAL-412…" 19 ch = 114 + 16 = 130; model 48; folder "northwind-portal\…\auth"
  // 23 ch = 138 + 16 = 154; id "#c41b07e2" 54. All four: 130+48+154+54 + 3*18 = 440.
  const short = rec("8d65845f-73cb-4be6-aa62-4ab2279d0de0", "asleep", {
    info: { branch: "feat/refresh", model: "Opus 5.5", cwd: `${HOME}\\dev\\api-gateway` },
  });
  // branch 12 ch = 72 + 16 = 88; model 48; folder "api-gateway" 11 ch = 66 + 16 = 82; id 54.

  const keys = (rowRec: typeof long, width: number): { shown: string[]; hidden: number } => {
    const r = fitRow(rowRec, windowPx(width), "910 MB", "\\", six, ONE);
    return { shown: r.segs.map((s) => s.key), hidden: r.hidden };
  };

  it("at 360 px keeps branch and model of a long session (room 247, 228 needed with the badge)", () => {
    assert.deepEqual(keys(long, 360), { shown: ["branch", "model"], hidden: 2 });
  });
  it("at 300 px keeps only the branch (room 187: branch and model need 228)", () => {
    assert.deepEqual(keys(long, 300), { shown: ["branch"], hidden: 3 });
  });
  it("at 230 px keeps nothing but +4 (room 117: the branch with the badge needs 162)", () => {
    assert.deepEqual(keys(long, 230), { shown: [], hidden: 4 });
  });
  it("a short session at 360 px: id and folder go (room 247, 286 with the folder)", () => {
    assert.deepEqual(keys(short, 360), { shown: ["branch", "model"], hidden: 2 });
  });
  it("a short session at 300 px: the same two (room 187, 186 needed)", () => {
    assert.deepEqual(keys(short, 300), { shown: ["branch", "model"], hidden: 2 });
  });
  it("a short session at 230 px: nothing but +4 (room 117, the branch and its badge need 120)", () => {
    assert.deepEqual(keys(short, 230), { shown: [], hidden: 4 });
  });

  it("gives the whole width to the items when there is no memory figure", () => {
    // 360 - 54 = 306 and all four need 326: the id goes, and the other three with "+1" need 286.
    const r = fitRow(short, windowPx(360), null, "\\", six, ONE);
    assert.deepEqual(
      r.segs.map((s) => s.key),
      ["branch", "model", "folder"],
    );
    assert.equal(r.hidden, 1);
  });

  it("shows the id as # and its first 8 characters, the folder from the repository root", () => {
    const r = fitRow(long, windowPx(2000), "910 MB", "\\", six, ONE);
    assert.deepEqual(
      r.segs.map((s) => s.text),
      ["feature/PORTAL-412…", "Opus 5.5", "northwind-portal\\…\\auth", "#c41b07e2"],
    );
    assert.equal(r.hidden, 0);
  });

  it("leaves out an item the agent does not store", () => {
    const bare = rec("abcdef012345", "asleep", { info: { cwd: `${HOME}\\dev\\x`, repoRoot: null } });
    const r = fitRow(bare, windowPx(2000), null, "\\", six, ONE);
    assert.deepEqual(
      r.segs.map((s) => s.key),
      ["folder", "id"],
    );
  });
});

describe("popupFacts: the order of the approved mockup, no data no item", () => {
  const at = new Date(2026, 10, 10, 14, 20).getTime();
  const now = new Date(2026, 10, 10, 18, 0).getTime();
  const base = { agentName: "Claude Code", home: HOME, sep: "\\" as const, now };
  const full = rec("c41b07e2-9f13-4d8a-b2c5-77e0a1d93f52", "asleep", {
    sleptAtMs: at,
    memFreedMb: 910,
    info: {
      title: "OAuth device flow",
      firstPrompt: "Need device flow login",
      lastReply: "Endpoints are ready",
      messages: 112,
      branch: "feature/PORTAL-412-oauth-device-flow-for-tv",
      model: "Opus 5.5",
      cwd: `${HOME}\\Documents\\dev\\clients\\northwind-portal\\apps\\web\\src\\auth`,
      repoRoot: `${HOME}\\Documents\\dev\\clients\\northwind-portal`,
      sessionId: "c41b07e2-9f13-4d8a-b2c5-77e0a1d93f52",
      contextPct: 64,
      contextText: "640k / 1M",
      tokensText: "↑4.8M ↓310k",
    },
  });

  it("lists title, prompt, reply, context, tokens, then branch, model, messages, memory, folder, session", () => {
    const f = popupFacts(full, { ...base, usedMb: null });
    assert.equal(f.agentName, "Claude Code");
    assert.equal(f.state, "asleep · 14:20");
    assert.equal(f.tone, "sleep");
    assert.equal(f.title, "OAuth device flow");
    assert.equal(f.prompt, "Need device flow login");
    assert.equal(f.reply, "Endpoints are ready");
    assert.deepEqual(f.context, { pct: 64, label: "Context 64%", detail: "640k / 1M" });
    assert.equal(f.tokens, "↑4.8M ↓310k");
    assert.deepEqual(
      f.rows.map((r) => r.id),
      ["branch", "model", "messages", "memory", "folder", "session"],
    );
  });

  it("shortens the folder from ~ and the id to start…end, and copies them whole", () => {
    const rows = popupFacts(full, { ...base, usedMb: null }).rows;
    const folder = rows.find((r) => r.id === "folder");
    const session = rows.find((r) => r.id === "session");
    assert.equal(folder?.value, "~\\…\\northwind-portal\\apps\\web\\src\\auth");
    assert.equal(folder?.copy, full.info.cwd);
    assert.equal(session?.value, "c41b07e2…3f52");
    assert.equal(session?.copy, "c41b07e2-9f13-4d8a-b2c5-77e0a1d93f52");
    const branch = rows.find((r) => r.id === "branch");
    assert.ok(branch?.value.startsWith("feature/PORTAL-412…"));
    assert.ok((branch?.value.length ?? 99) <= 34);
    assert.equal(branch?.copy, undefined);
  });

  it("says freed for a sleeper and uses for a runner", () => {
    const freed = popupFacts(full, { ...base, usedMb: null }).rows.find((r) => r.id === "memory");
    assert.deepEqual([freed?.label, freed?.value], ["Freed", "~910 MB"]);
    const running = rec("r", "working", { info: { title: "x" } });
    const used = popupFacts(running, { ...base, usedMb: 640 }).rows.find((r) => r.id === "memory");
    assert.deepEqual([used?.label, used?.value], ["Uses", "640 MB"]);
  });

  it("hides what the agent does not keep instead of showing 0", () => {
    const bare = popupFacts(rec("abcdef0123456789", "asleep", { sleptAtMs: at }), { ...base, usedMb: null });
    assert.equal(bare.title, null);
    assert.equal(bare.prompt, null);
    assert.equal(bare.reply, null);
    assert.equal(bare.context, null);
    assert.equal(bare.tokens, null);
    assert.deepEqual(
      bare.rows.map((r) => r.id),
      ["folder", "session"],
    );
  });

  it("shows the tokens in use, without a bar, when the window (and so the fill) is unknown", () => {
    // Blind review: "contextPct: null, хотя contextText: "53k" записано" — and the popup had no context at all.
    const f = popupFacts(rec("x", "asleep", { info: { contextText: "53k" } }), { ...base, usedMb: null });
    assert.deepEqual(f.context, { pct: null, label: "Context", detail: "53k in use" });
    const known = popupFacts(rec("y", "asleep", { info: { contextText: "53k / 1M", contextPct: 5 } }), {
      ...base,
      usedMb: null,
    });
    assert.ok(popupHeight(f) < popupHeight(known), "no bar: a line shorter than with one");
    assert.ok(popupHeight(f) > popupHeight(popupFacts(rec("z", "asleep"), { ...base, usedMb: null })));
  });

  it("marks interrupted as a warning and a running agent without a time", () => {
    const i = popupFacts(rec("i", "interrupted", { sleptAtMs: at }), { ...base, usedMb: null });
    assert.deepEqual([i.state, i.tone], ["interrupted · 14:20", "warn"]);
    const w = popupFacts(rec("w", "working"), { ...base, usedMb: null });
    assert.deepEqual([w.state, w.tone], ["working", "live"]);
    const g = popupFacts(rec("g", "missing"), { ...base, usedMb: null });
    assert.equal(g.tone, "error");
  });
});

describe("popup size and place", () => {
  const base = { agentName: "Claude Code", home: HOME, sep: "\\" as const, now: 0, usedMb: null };
  const rich = rec("c41b07e2-9f13-4d8a-b2c5-77e0a1d93f52", "asleep", {
    memFreedMb: 900,
    info: {
      title: "t",
      firstPrompt: "p",
      lastReply: "r",
      messages: 3,
      branch: "main",
      model: "m",
      contextPct: 10,
      contextText: "1k / 1M",
      tokensText: "x",
    },
  });
  const height = (r: typeof rich): number => popupHeight(popupFacts(r, base));

  it("grows with every block it shows", () => {
    const full = height(rich);
    for (const without of [
      { firstPrompt: null },
      { lastReply: null },
      { contextPct: null },
      { tokensText: null },
      { branch: null },
      { model: null },
      { messages: null },
      { title: null },
    ]) {
      const less = height({ ...rich, info: { ...rich.info, ...without } });
      assert.ok(less < full, `${Object.keys(without)[0]}: ${less} < ${full}`);
    }
    assert.ok(height({ ...rich, memFreedMb: null }) < full);
  });

  // At zoom 1 window px and the mod's px are the same (zoom: test/ui/scale.test.ts).
  const one = { zoom: 1 };
  const viewport = { width: windowPx(1280), height: windowPx(800) };
  const size = { width: modPx(344), height: modPx(420) };
  const box = (left: number, top: number, width: number, height: number) => ({
    left: windowPx(left),
    top: windowPx(top),
    width: windowPx(width),
    height: windowPx(height),
  });

  it("puts the popup left of a list row, so it never covers the Sessions panel", () => {
    const row = box(960, 300, 300, 48);
    const p = popupPosition(row, "row", size, viewport, one);
    assert.deepEqual(p, { x: 608, y: 294 });
    assert.ok(p.x + size.width <= row.left);
  });

  it("keeps the popup inside the window vertically", () => {
    const row = box(960, 700, 300, 48);
    assert.equal(popupPosition(row, "row", size, viewport, one).y, 800 - 420 - 8);
  });

  it("goes to the right of the row when there is no room on the left (Sessions in a window)", () => {
    const row = box(100, 300, 300, 48);
    assert.deepEqual(popupPosition(row, "row", size, viewport, one), { x: 408, y: 294 });
  });

  it("sits above the strip, near its right end", () => {
    const strip = box(300, 700, 760, 46);
    assert.deepEqual(popupPosition(strip, "strip", size, viewport, one), { x: 596, y: 272 });
  });

  it("does not leave the window above the strip either", () => {
    const strip = box(300, 200, 760, 46);
    assert.equal(popupPosition(strip, "strip", size, viewport, one).y, 8);
  });
});

describe("MemoryPolicy: measure only while the panel is open, at most every 30 s", () => {
  it("never measures a hidden panel", () => {
    const p = new MemoryPolicy(30_000);
    assert.equal(p.due(0, false), false);
    assert.equal(p.due(1_000_000, false), false);
  });

  it("measures at once when the panel is first shown, then waits 30 s", () => {
    const p = new MemoryPolicy(30_000);
    assert.equal(p.due(1_000, true), true);
    assert.equal(p.due(1_000 + 29_999, true), false);
    assert.equal(p.due(1_000 + 30_000, true), true);
    assert.equal(p.due(1_000 + 30_001, true), false);
  });

  it("does not measure again just because the panel was closed and opened", () => {
    const p = new MemoryPolicy(30_000);
    assert.equal(p.due(0, true), true);
    assert.equal(p.due(5_000, false), false);
    assert.equal(p.due(10_000, true), false);
  });
});

describe("panelShown", () => {
  const main = {
    id: "root",
    type: "row",
    children: [
      {
        id: "work",
        type: "column",
        children: [
          { id: "tabs", type: "block", content: { mod: "tabs" } },
          { id: "body", type: "row", children: [{ id: "main", type: "block", content: { tab: "active" } }] },
        ],
      },
    ],
  };
  const built = buildLivingLayout(main, "9.9.9");
  assert.ok(built.ok);
  const layout = built.ok ? built.layout : null;

  it("is false while the hidden column is hidden", () => {
    assert.equal(panelShown(layout, "suspender-panel"), false);
  });

  it("is true once the column is shown, and false for a layout without it", () => {
    const shown = JSON.parse(JSON.stringify(layout).replace('"hidden":true', '"hidden":false'));
    assert.equal(panelShown(shown, "suspender-panel"), true);
    assert.equal(panelShown(main, "suspender-panel"), false);
    assert.equal(panelShown(null, "suspender-panel"), false);
  });
});

describe("pillAgent: the agent the pill offers to sleep", () => {
  const detect = (t: { state: string }): "claude" | null => (t.state === "live" ? "claude" : null);

  it("is the agent of the focused terminal", () => {
    assert.equal(pillAgent({ state: "live" }, detect), "claude");
  });
  it("is nothing without a focused terminal, or when the terminal is not an agent", () => {
    assert.equal(pillAgent(null, detect), null);
    assert.equal(
      pillAgent({ state: "live" }, () => null),
      null,
    );
  });
  it("is nothing for a terminal that is no longer live, even if it looks like an agent", () => {
    assert.equal(
      pillAgent({ state: "finished" }, () => "claude"),
      null,
    );
  });
});

describe("the session's name in the popup (user: the name is often cut off horizontally)", () => {
  // Fixed width per character, so the lines are known by hand.
  const seven = (text: string): number => [...text].length * 7;

  it("wraps at spaces into lines that fit, keeping every word", () => {
    // 70 px = 10 characters a line.
    assert.deepEqual(wrapLines("Fix the login page fast", 70, 3, seven), ["Fix the", "login page", "fast"]);
  });

  it("breaks a word longer than a line inside the word", () => {
    assert.deepEqual(wrapLines("abcdefghijklmnop", 70, 3, seven), ["abcdefghij", "klmnop"]);
  });

  it("ends with an ellipsis only past the last line it may use", () => {
    const lines = wrapLines("one two three four five six seven eight", 70, 2, seven);
    assert.equal(lines.length, 2);
    assert.equal(lines[0], "one two");
    const last = lines[1] ?? "";
    assert.ok(last.endsWith("…"), last);
    assert.ok(seven(last) <= 70, last);
    assert.deepEqual(wrapLines("short", 70, 2, seven), ["short"]);
  });

  const base = { agentName: "Claude Code", home: HOME, sep: "\\" as const, now: 0, usedMb: null };
  // A 77-character name, in the 344 px popup: one line used to show, the second cut through.
  const long = "Перевести авторизацию портала на refresh-токены и device flow для телевизоров";
  const named = (title: string) => popupFacts(rec("n", "asleep", { info: { title } }), base);

  it("shows a long name whole, on up to three lines, and makes the popup taller by those lines", () => {
    const f = named(long);
    assert.ok(f.titleLines.length > 1 && f.titleLines.length <= TITLE_MAX_LINES, f.titleLines.join(" | "));
    assert.equal(f.titleLines.join(" "), long);
    assert.equal(f.titleCut, false);
    assert.equal(popupHeight(f) - popupHeight(named("Short name")), (f.titleLines.length - 1) * TITLE_LINE_PX);
  });

  it("counts the 3 px between fact rows, so the last row (Session) is not cut off", () => {
    // Live: with a three-line name the Session row went under the popup's edge,
    // 12 px short for six rows. A row is 18 px, and 3 px lie between rows.
    const withMemory = popupFacts(rec("n", "asleep", { memFreedMb: 900, info: { title: "x" } }), base);
    const without = popupFacts(rec("n", "asleep", { memFreedMb: null, info: { title: "x" } }), base);
    assert.equal(withMemory.rows.length, without.rows.length + 1);
    assert.equal(popupHeight(withMemory) - popupHeight(without), 18 + 3);
  });

  it("cuts only a name longer than three lines, and keeps the whole name for the tooltip", () => {
    // The live test session's name, 109 characters: four lines' worth.
    const huge = `${long}, с ретраями и понятными ошибками`;
    const f = named(huge);
    assert.equal(f.titleLines.length, TITLE_MAX_LINES);
    assert.ok(f.titleLines.at(-1)?.endsWith("…"));
    assert.equal(f.titleCut, true);
    assert.equal(f.title, huge);
  });
});
