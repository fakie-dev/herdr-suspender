// The sleeping tab while it stays on screen: what changed in the conversation
// is read when the tab is shown, not by watching it. Here the strip of a
// sleeping Claude session is on screen while the conversation keeps being
// written to (the same session open in another window, say): a folder watch
// would wake on every write, and each read starts a process on Windows (D01).

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
import { claude, jsonl } from "../adapters/synthetic.ts";
import { fakeAdapter, Sim, TAB } from "../runtime/sim.ts";
import { useStandIns } from "../standIns.ts";
import { rec } from "./helpers.ts";

const home = mkdtempSync(join(tmpdir(), "suspender-pane-"));
after(() => rmSync(home, { recursive: true, force: true }));
useStandIns({ appHome: join(home, ".config", "herdr-app"), home, readsHang: false });
const { SleepPane } = await import("../../src/ui/sleepPane.ts");

const ID = "0f0e0d0c-0b0a-4908-8706-050403020100";
const KEY: SessionKey = `claude:${ID}`;
const CWD = "C:\\work\\repo";
const TRANSCRIPT = `C:\\Users\\tester\\.claude\\projects\\C--work-repo\\${ID}.jsonl`;

async function settle(rounds = 500): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function strip() {
  const sim = new Sim();
  const ports = sim.ports();
  // On Herdr every stat is a process (D01): count it as one.
  const stat = ports.stat;
  ports.stat = async (path) => {
    sim.execCalls.push({ cmd: "stat", args: [path] });
    return stat(path);
  };
  // A folder watch wakes on any write below its folder.
  const watchers: { dir: string; wake: (names: string[]) => void }[] = [];
  ports.watch = (dir) =>
    new Promise((wake) => {
      watchers.push({ dir, wake });
    });
  /** Writes a file and wakes the watches of its folder. */
  const put = (path: string, text: string): void => {
    ports.files.set(path, text);
    const name = path.split("\\").pop() ?? path;
    for (const w of watchers.splice(0)) {
      if (path.startsWith(w.dir)) {
        w.wake([name]);
      } else {
        watchers.push(w);
      }
    }
  };
  const write = (text: string): void => put(TRANSCRIPT, (ports.files.get(TRANSCRIPT) ?? "") + text);
  write(jsonl(claude.prompt("Synthetic first prompt"), claude.reply("Synthetic reply", { id: "m1" })));

  const pane = sim.addModPane(TAB, { role: "sleep", key: KEY });
  const file = emptyStore();
  // As the sleep left it: the conversation as it was then (two messages).
  const size = new TextEncoder().encode(ports.files.get(TRANSCRIPT) ?? "").length;
  const at = (await stat(TRANSCRIPT))?.mtimeMs ?? null;
  file.sessions[KEY] = rec(ID, "asleep", {
    key: KEY,
    cwd: CWD,
    pane,
    sleptAtMs: sim.now,
    info: { cwd: CWD, messages: 2, transcriptSize: size, transcriptMtimeMs: at },
  });
  ports.files.set(defaultStorePath(ports), serializeStore(file));

  const engine = new Engine({
    host: sim,
    ports,
    id: "copy",
    adapters: { claude: claudeAdapter, codex: fakeAdapter("codex") },
  });
  const view = new SleepPane(engine, sim, ports, KEY);
  const cx = {
    spawn: (task: (cx: AsyncContext) => Promise<unknown>) => {
      void task(cx);
    },
    notify: () => undefined,
    sleep: (ms: number) => sim.sleep(ms),
  } as unknown as AsyncContext;
  return { sim, ports, engine, view, cx, write, put };
}

/** A Claude Code running `sessionId` in another tab, as its session file says (Claude writes it as it starts). */
function openInAnotherTab(sim: Sim, put: (path: string, text: string) => void, sessionId: string): void {
  sim.addTab("tb-other");
  const other = sim.addTerminal({ agent: "claude", tab: "tb-other" });
  const pid = sim.term(other.address).agentPid ?? 0;
  put(
    `C:\\Users\\tester\\.claude\\sessions\\${pid}.json`,
    JSON.stringify({ pid, sessionId, cwd: CWD, startedAt: sim.now }),
  );
}

describe("a sleeping tab whose session is opened elsewhere (finding 2 of the blind review)", () => {
  it("says so and blocks Resume as soon as Claude's sessions folder changes, without a round", async () => {
    const { sim, engine, view, cx, put } = await strip();
    await engine.load();
    view.tick(cx);
    await settle();
    assert.equal(engine.record(KEY)?.state, "asleep");
    openInAnotherTab(sim, put, ID);
    await settle();
    assert.equal(engine.record(KEY)?.state, "elsewhere");
  });

  it("says so when shown, if it was opened while nothing watched", async () => {
    const { sim, ports, engine, view, cx } = await strip();
    await engine.load();
    // Written without waking any watch: only the show can find it.
    openInAnotherTab(sim, (path, text) => ports.files.set(path, text), ID);
    view.tick(cx);
    await settle();
    assert.equal(engine.record(KEY)?.state, "elsewhere");
  });

  it("stays asleep when another session is opened", async () => {
    const { sim, engine, view, cx, put } = await strip();
    await engine.load();
    view.tick(cx);
    await settle();
    openInAnotherTab(sim, put, "1a1b1c1d-2e2f-4a4b-8c8d-9e9f0a0b0c0d");
    await settle();
    assert.equal(engine.record(KEY)?.state, "asleep");
  });
});

describe("a sleeping tab left on screen", () => {
  it("reads the conversation once when shown, and not again however much is written to it", async () => {
    const { sim, engine, view, cx, write } = await strip();
    await engine.load();
    view.tick(cx);
    await settle();
    const shown = sim.execCalls.length;
    assert.ok(shown >= 1, "the show reads it");

    for (let round = 0; round < 12; round++) {
      write(jsonl(claude.prompt(`Synthetic prompt ${round}`), claude.reply("Synthetic", { id: `r${round}` })));
      view.tick(cx);
      await sim.advance(5_000);
      await settle();
    }
    assert.equal(sim.execCalls.length, shown, "a minute on screen: no process");
  });

  it("shows what was added (+N) the next time it is shown", async () => {
    const { sim, engine, view, cx, write } = await strip();
    await engine.load();
    view.tick(cx);
    await settle();
    assert.equal(engine.freshness(KEY), null);
    write(jsonl(claude.prompt("Synthetic later prompt"), claude.reply("Synthetic", { id: "m2" })));
    const tab = sim.tabList.find((x) => x.id === TAB);
    assert.ok(tab);
    tab.active = false;
    view.tick(cx);
    tab.active = true;
    view.tick(cx);
    await settle();
    assert.equal(engine.freshness(KEY)?.added, 2);
  });
});
