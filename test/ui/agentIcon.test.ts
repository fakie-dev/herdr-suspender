// The agent's icon in a Sessions row and in the popup's header (user: «может быть
// в панели получится использовать иконки агентов? Ведь сам Herdr использует
// иконки во вкладках, я бы хотел так же сделать в моей боковой панели вместо
// квадратиков с буквами»). Drawn as Herdr's Agents list draws `program.icon`:
// `image()` for a picture, `svg()` in the text colour for a one-colour glyph.
// Read from stand-in elements that remember every call (test/standIns.ts).

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { AsyncContext } from "gpui-kit";
import { claudeAdapter } from "../../src/adapters/claude.ts";
import type { SessionKey } from "../../src/core/model.ts";
import { defaultStorePath, emptyStore, serializeStore } from "../../src/core/store.ts";
import { Engine } from "../../src/runtime/engine.ts";
import { fakeAdapter, Sim, TAB } from "../runtime/sim.ts";
import { useStandIns } from "../standIns.ts";
import { HOME, rec } from "./helpers.ts";

const home = mkdtempSync(join(tmpdir(), "suspender-icon-"));
after(() => rmSync(home, { recursive: true, force: true }));
useStandIns({ appHome: join(home, ".config", "herdr-app"), home, readsHang: false, record: true });
const { PopupView } = await import("../../src/ui/popup.ts");
const { PanelView } = await import("../../src/ui/panel.ts");
const { agentMark, palette } = await import("../../src/ui/kit.ts");
const { ROW_TITLE_PX } = await import("../../src/ui/sessionsModel.ts");
const { AGENT_ICON } = await import("../../src/core/scale.ts");

interface Drawn {
  kind: string;
  arg?: unknown;
  calls: unknown[][];
  kids: unknown[];
}
const isDrawn = (x: unknown): x is Drawn => typeof x === "object" && x !== null && "calls" in x && "kids" in x;
const called = (el: Drawn, name: string): unknown[][] => el.calls.filter((c) => c[0] === name);
const has = (el: Drawn, name: string, ...args: unknown[]): boolean =>
  called(el, name).some((c) => args.every((a, i) => c[i + 1] === a));
function* walk(el: unknown): Generator<Drawn> {
  if (isDrawn(el)) {
    yield el;
    for (const kid of el.kids) {
      yield* walk(kid);
    }
  }
}
const byId = (root: unknown, id: string): Drawn | undefined => [...walk(root)].find((el) => has(el, "id", id));
const parentOf = (root: unknown, kid: Drawn): Drawn | undefined => [...walk(root)].find((el) => el.kids.includes(kid));
const texts = (el: Drawn): string[] => [...walk(el)].flatMap((x) => x.kids.filter((k) => typeof k === "string"));
const letterTile = (root: unknown): Drawn | undefined =>
  [...walk(root)].find((el) => has(el, "rounded", 4) && (el.kids.includes("C") || el.kids.includes("X")));
const drawnIcon = (root: unknown, path: string): Drawn | undefined =>
  [...walk(root)].find((el) => (el.kind === "image" || el.kind === "svg") && el.arg === path);

const FOREGROUND = "#cdd6f4";
const MUTED = "#a6adc8";
const g = globalThis as Record<string, unknown>;
g["suspenderTheme"] = { foreground: FOREGROUND, muted: MUTED, raised: "#313244", border: "#45475a" };

const program = (key: string, icon: string | null, tint: boolean) => ({
  key,
  name: key,
  icon,
  tint,
  tile: "#1c1d21",
  color: "#ffffff",
  shell: false,
  agent: true,
  run: [key],
  installed: true,
});
// Claude Code as Herdr 0.1.15 ships it (a picture); Codex as a one-colour glyph, as
// a programs.json may make it: both kinds in one table.
const TABLE = [program("claude", "icons/claude.svg", false), program("codex", "my-icons/codex.svg", true)];

/** How many times knownAgents() was asked; it answers with `answer`. */
let asked = 0;
let answer: () => Promise<unknown> = () => Promise.resolve(TABLE);
g["suspenderKnownAgents"] = () => {
  asked += 1;
  return answer();
};

const CLAUDE_ID = "0f0e0d0c-0b0a-4908-8706-050403020100";
const CODEX_ID = "1f1e1d1c-1b1a-4918-8716-151413121110";
const CLAUDE_KEY: SessionKey = `claude:${CLAUDE_ID}`;
const CODEX_KEY: SessionKey = `codex:${CODEX_ID}`;
const CWD = `${HOME}\\dev\\mobile-app`;

/** Two sleeping sessions, no agent running anywhere (no pane to take a program from). */
async function world() {
  const sim = new Sim();
  const ports = sim.ports();
  const file = emptyStore();
  for (const [key, id, agent] of [
    [CLAUDE_KEY, CLAUDE_ID, "claude"],
    [CODEX_KEY, CODEX_ID, "codex"],
  ] as const) {
    file.sessions[key] = rec(id, "asleep", {
      key,
      agent,
      cwd: CWD,
      pane: sim.addModPane(TAB, { role: "sleep", key }),
      spaceId: "sp1",
      sleptAtMs: sim.now,
      info: { title: `Fix the ${agent} session`, cwd: CWD, repoRoot: CWD, model: "claude-opus-5-5" },
    });
  }
  ports.files.set(defaultStorePath(ports), serializeStore(file));
  const engine = new Engine({
    host: sim,
    ports,
    id: "copy",
    adapters: { claude: claudeAdapter, codex: fakeAdapter("codex") },
  });
  await engine.load();
  return { sim, ports, engine };
}

/** A context whose spawned tasks run at once; `settle` waits for them, `notified` counts redraws asked. */
function context() {
  const tasks: Promise<unknown>[] = [];
  let notified = 0;
  const cx = {
    notify: () => {
      notified += 1;
    },
    spawn: (body: (task: AsyncContext) => unknown) => {
      tasks.push(Promise.resolve(body(cx as unknown as AsyncContext)));
    },
  };
  return {
    cx: cx as unknown as AsyncContext,
    settle: async () => {
      // At most a second: a task that never ends fails the assertions after it, not the run.
      await Promise.race([Promise.all(tasks), new Promise((resolve) => setTimeout(resolve, 1000))]);
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    notified: () => notified,
  };
}

const panelOf = async () => {
  const { sim, ports, engine } = await world();
  return { engine, ports, view: new PanelView({ engine, host: sim, ports, mode: "window", overlay: null }) };
};

describe("agentMark: what is drawn for what Herdr's table says", () => {
  const color = (): ReturnType<typeof palette> => palette();

  it("a picture with image(), as big as the tile was", () => {
    const el = agentMark("claude", { icon: "icons/claude.svg", tint: false }, color());
    assert.ok(isDrawn(el));
    assert.equal(el.kind, "image");
    assert.equal(el.arg, "icons/claude.svg", "Herdr's path as given");
    assert.ok(has(el, "w", AGENT_ICON) && has(el, "h", AGENT_ICON), JSON.stringify(el.calls));
    assert.ok(has(el, "flex_none"), "it does not shrink");
  });

  it("a one-colour glyph with svg() in the text colour, as Herdr's Agents list does", () => {
    const el = agentMark("codex", { icon: "icons/codex.svg", tint: true }, color());
    assert.ok(isDrawn(el));
    assert.equal(el.kind, "svg");
    assert.equal(el.arg, "icons/codex.svg");
    assert.ok(has(el, "size", AGENT_ICON), JSON.stringify(el.calls));
    assert.ok(has(el, "text_color", FOREGROUND), JSON.stringify(called(el, "text_color")));
    assert.ok(has(el, "flex_none"));
  });

  it("the letter tile when no icon is known, C for Claude Code and X for Codex", () => {
    for (const [agent, letter] of [
      ["claude", "C"],
      ["codex", "X"],
    ] as const) {
      const el = agentMark(agent, null, color());
      assert.ok(isDrawn(el));
      assert.ok(el.kids.includes(letter), `${agent}: ${JSON.stringify(el.kids)}`);
      assert.ok(has(el, "size", AGENT_ICON), "as big as an icon");
    }
  });

  it("the size is the mod's own px at zoom 2 too (Herdr multiplies it)", () => {
    g["suspenderSettings"] = { zoom: 2 };
    try {
      const el = agentMark("claude", { icon: "icons/claude.svg", tint: false }, color());
      assert.ok(isDrawn(el) && has(el, "w", 16) && has(el, "h", 16), JSON.stringify(isDrawn(el) && el.calls));
    } finally {
      delete g["suspenderSettings"];
    }
  });
});

describe("the icon in Sessions and in the popup", () => {
  // One module, one table: these run in order, and the first one is the only
  // one that sees the table before it answers.
  it("a letter until Herdr's table answers; one knownAgents() for any number of draws; then each agent's icon", async () => {
    let answerNow: (table: unknown) => void = () => undefined;
    answer = () => new Promise((resolve) => (answerNow = resolve));
    const { view } = await panelOf();
    const { cx, settle, notified } = context();
    // Codex runs in another tab: its pane's program gives the icon until the table answers.
    g["suspenderPanes"] = [{ pane: "p9", tab: "tb9", program: program("codex", "icons/codex.svg", false) }];
    const first = view.render(cx);
    const before = byId(first, `row-${CLAUDE_KEY}`);
    assert.ok(before && letterTile(before), "Claude Code: the letter tile while the table is not known");
    const live = byId(first, `row-${CODEX_KEY}`);
    assert.ok(live && drawnIcon(live, "icons/codex.svg")?.kind === "image", "Codex: the live pane's icon");
    view.render(cx);
    assert.equal(asked, 1, "asked once, not on every draw");
    answerNow(TABLE);
    await settle();
    assert.ok(notified() >= 1, "the copy that asked redraws");
    const root = view.render(cx);
    view.render(cx);
    assert.equal(asked, 1, "not asked again once it answered");

    const claudeRow = byId(root, `row-${CLAUDE_KEY}`);
    assert.ok(claudeRow, "Claude Code's row");
    const claude = drawnIcon(claudeRow, "icons/claude.svg");
    assert.ok(claude, "Claude Code's picture, for a session with no pane");
    assert.equal(claude.kind, "image");
    assert.equal(letterTile(claudeRow), undefined, "no letter beside it");

    const codexRow = byId(root, `row-${CODEX_KEY}`);
    assert.ok(codexRow, "Codex's row");
    const codex = drawnIcon(codexRow, "my-icons/codex.svg");
    assert.ok(codex, "Codex's glyph");
    assert.equal(codex.kind, "svg");
    assert.ok(has(codex, "text_color", FOREGROUND));
    assert.equal(drawnIcon(codexRow, "icons/codex.svg"), undefined, "the table wins over the pane");
    delete g["suspenderPanes"];
  });

  it("in a row the icon stays centred on the title's line (660a6fd): a box that tall, first in the row", async () => {
    const { view } = await panelOf();
    const { cx, settle } = context();
    view.render(cx);
    await settle();
    const row = byId(view.render(cx), `row-${CLAUDE_KEY}`);
    assert.ok(row);
    const pic = drawnIcon(row, "icons/claude.svg");
    assert.ok(pic, "the icon");
    const box = parentOf(row, pic);
    assert.ok(box !== undefined && box !== row, "a box of its own");
    assert.equal(row.kids[0], box, "the row's first column");
    assert.ok(has(box, "h", ROW_TITLE_PX), "as tall as the title's row");
    assert.ok(has(box, "items_center"), "centred in it");
    assert.ok(AGENT_ICON <= ROW_TITLE_PX, "it fits the title's line");
  });

  it("in the popup's header: the icon and the agent's name centred in one row", async () => {
    const { engine, ports } = await world();
    const { cx, settle } = context();
    new PopupView(engine, ports, CLAUDE_KEY, null, null).render(cx);
    await settle();
    const root = new PopupView(engine, ports, CLAUDE_KEY, null, null).render(cx);
    const pic = drawnIcon(root, "icons/claude.svg");
    assert.ok(pic, "the icon");
    assert.equal(letterTile(root), undefined, "no letter");
    const header = parentOf(root, pic);
    assert.ok(header, "the header");
    assert.ok(has(header, "items_center"), "centred across the header");
    assert.ok(texts(header).includes("Claude Code"), "the name beside it");
  });
});
