import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { claudeAdapter } from "../../src/adapters/claude.ts";
import { emptyInfo } from "../../src/adapters/common.ts";
import { fakePorts } from "../fakePorts.ts";
import { bigClaudeTranscript, claude, claudePidFile, jsonl, metered, ok, scriptExec, terminal } from "./synthetic.ts";

const HOME = "/home/tester";
const CWD = "/home/tester/dev/app";
const PROJECT = `${HOME}/.claude/projects/-home-tester-dev-app`;
const SID = "11111111-2222-4333-8444-555555555555";
const TRANSCRIPT = `${PROJECT}/${SID}.jsonl`;
const SESSIONS = `${HOME}/.claude/sessions`;
/** The most Herdr's `fs.readFile` reads (measured on 0.1.15: a bigger file is refused). */
const HERDR_WHOLE_MAX = 64 * 1024 * 1024;
const A_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const OLD_ID = "aaaaaaaa-0000-4000-8000-000000000002";
const OTHER_ID = "aaaaaaaa-0000-4000-8000-000000000003";
const FIRST_ID = "aaaaaaaa-0000-4000-8000-000000000004";
const SECOND_ID = "aaaaaaaa-0000-4000-8000-000000000005";
const ANOTHER_ID = "aaaaaaaa-0000-4000-8000-000000000006";

describe("claude: matches", () => {
  it("knows Claude Code by its reported app or its process name", () => {
    assert.ok(claudeAdapter.matches(terminal({ app: "claude-code" })));
    assert.ok(
      claudeAdapter.matches(terminal({ foreground: { pid: 5, argv: ["C:\\bin\\claude.exe"], name: "claude.exe" } })),
    );
    assert.ok(!claudeAdapter.matches(terminal({ app: "codex" })));
    assert.ok(!claudeAdapter.matches(terminal({ foreground: { pid: 5, argv: ["pwsh.exe"], name: "pwsh.exe" } })));
  });
});

describe("claude: discoverSession", () => {
  it("reads the session id from the pid file of the foreground process", async () => {
    const p = fakePorts();
    p.files.set(`${SESSIONS}/4242.json`, claudePidFile({ pid: 4242, sessionId: SID, cwd: CWD, startedAt: 1 }));
    const t = terminal({ foreground: { pid: 4242, argv: ["claude"], name: "claude" } });
    assert.equal(await claudeAdapter.discoverSession(t, p), SID);
    assert.equal(p.execCalls.length, 0);
  });

  it("matches by folder and start time when the shell is in the foreground", async () => {
    const p = fakePorts();
    const t = terminal({ createdMs: 1_000_000, foreground: { pid: 100, argv: ["bash"], name: "bash" } });
    p.files.set(`${SESSIONS}/201.json`, claudePidFile({ pid: 201, sessionId: A_ID, cwd: CWD, startedAt: 1_000_500 }));
    // Same folder but started before this terminal existed: not ours.
    p.files.set(`${SESSIONS}/202.json`, claudePidFile({ pid: 202, sessionId: OLD_ID, cwd: CWD, startedAt: 900_000 }));
    // Started later, other folder.
    p.files.set(
      `${SESSIONS}/203.json`,
      claudePidFile({ pid: 203, sessionId: OTHER_ID, cwd: `${HOME}/dev/x`, startedAt: 1_000_600 }),
    );
    p.files.set(`${SESSIONS}/203.abc.key`, "not json");
    assert.equal(await claudeAdapter.discoverSession(t, p), A_ID);
    assert.equal(p.execCalls.length, 0, "no process query when the files settle it");
  });

  it("tells two sessions in one folder apart by the process tree", async () => {
    const p = scriptExec(fakePorts({ sep: "\\" }), () =>
      ok("201\t100\t1000500\tclaude.exe\tclaude\r\n202\t300\t1000600\tclaude.exe\tclaude\r\n"),
    );
    const cwd = "C:\\Users\\tester\\dev\\app";
    const sessions = "C:\\Users\\tester\\.claude\\sessions";
    p.files.set(`${sessions}\\201.json`, claudePidFile({ pid: 201, sessionId: FIRST_ID, cwd, startedAt: 1_000_500 }));
    p.files.set(`${sessions}\\202.json`, claudePidFile({ pid: 202, sessionId: SECOND_ID, cwd, startedAt: 1_000_600 }));
    const shell = (pid: number) =>
      terminal({ cwd, createdMs: 1_000_000, foreground: { pid, argv: [], name: "pwsh.exe" } });
    assert.equal(await claudeAdapter.discoverSession(shell(100), p), FIRST_ID);
    assert.equal(await claudeAdapter.discoverSession(shell(300), p), SECOND_ID);
    assert.equal(await claudeAdapter.discoverSession(shell(999), p), null, "neither is a child: no guess");
  });

  it("is null when nothing matches", async () => {
    assert.equal(await claudeAdapter.discoverSession(terminal(), fakePorts()), null);
  });

  it("takes only a session id that is a UUID: anything else would be typed into a shell at Resume", async () => {
    const p = fakePorts();
    p.files.set(`${SESSIONS}/4242.json`, claudePidFile({ pid: 4242, sessionId: "x & calc", cwd: CWD, startedAt: 1 }));
    const own = terminal({ foreground: { pid: 4242, argv: ["claude"], name: "claude" } });
    assert.equal(await claudeAdapter.discoverSession(own, p), null);
    const shell = terminal({ createdMs: 0, foreground: { pid: 100, argv: ["bash"], name: "bash" } });
    assert.equal(await claudeAdapter.discoverSession(shell, p), null);
  });
});

function smallTranscript(): string {
  return jsonl(
    claude.prompt("<command-name>/model</command-name>"),
    claude.prompt("Synthetic meta", { meta: true }),
    claude.prompt("Synthetic note from a subagent", { origin: "peer" }),
    claude.prompt("Add a health check endpoint", { origin: "human", branch: "feature/ABC-12-health" }),
    claude.aiTitle("Health check endpoint"),
    claude.toolUse({ model: "claude-synthetic-1" }),
    claude.toolResult(),
    claude.reply("Added GET /health.", {
      id: "m1",
      usage: { input: 10, cacheRead: 41_990, cacheCreate: 0, output: 300 },
      branch: "feature/ABC-12-health",
    }),
    claude.reply("Synthetic", { model: "<synthetic>" }),
    claude.promptBlocks("Now add a test", { branch: "feature/ABC-12-health" }),
    claude.reply("Test added, 3 passing.", {
      id: "m2",
      usage: { input: 5, cacheRead: 52_000, cacheCreate: 1000, output: 700 },
      branch: "feature/ABC-12-health",
    }),
  );
}

describe("claude: snapshot", () => {
  it("collects the popup fields from a small transcript", async () => {
    const p = fakePorts();
    const text = smallTranscript();
    p.files.set(TRANSCRIPT, text);
    const info = await claudeAdapter.snapshot(SID, CWD, p);
    assert.equal(info.title, "Health check endpoint");
    assert.equal(info.firstPrompt, "Add a health check endpoint");
    assert.equal(info.lastReply, "Test added, 3 passing.");
    // Prompts written by a person (2) + assistant messages with text (2).
    assert.equal(info.messages, 4);
    assert.equal(info.branch, "feature/ABC-12-health");
    assert.equal(info.model, "claude-synthetic-1");
    assert.equal(info.sessionId, SID);
    assert.equal(info.cwd, CWD);
    // Last turn: 5 + 52000 + 1000 = 53005 tokens in context; window unknown below 200k.
    assert.equal(info.contextText, "53k");
    assert.equal(info.contextPct, null);
    // Input 10 + 41990 + 5 + 52000 + 1000 = 95005; output 1000.
    assert.equal(info.tokensText, "↑95k ↓1k");
    assert.equal(info.transcriptSize, text.length);
    assert.equal(typeof info.transcriptMtimeMs, "number");
  });

  it("prefers the title the user gave over the generated one", async () => {
    const p = fakePorts();
    p.files.set(TRANSCRIPT, jsonl(claude.customTitle("My name"), claude.aiTitle("Generated"), claude.prompt("Hi")));
    assert.equal((await claudeAdapter.snapshot(SID, CWD, p)).title, "My name");
  });

  it("gives a percentage once the context shows the 1M window", async () => {
    const p = fakePorts();
    p.files.set(TRANSCRIPT, jsonl(claude.reply("ok", { usage: { input: 0, cacheRead: 640_000, output: 1 } })));
    const info = await claudeAdapter.snapshot(SID, CWD, p);
    assert.equal(info.contextPct, 64);
    assert.equal(info.contextText, "640k / 1M");
  });

  it("gives a percentage for a model named as 1M-window, below 200k too", async () => {
    const p = fakePorts();
    p.files.set(
      TRANSCRIPT,
      jsonl(
        claude.reply("ok", { model: "claude-synthetic-1[1m]", usage: { input: 0, cacheRead: 100_000, output: 1 } }),
      ),
    );
    const info = await claudeAdapter.snapshot(SID, CWD, p);
    assert.equal(info.contextPct, 10);
    assert.equal(info.contextText, "100k / 1M");
  });

  it("leaves what the transcript lacks as null, not 0 or empty", async () => {
    const p = fakePorts();
    p.files.set(TRANSCRIPT, jsonl(claude.noise(10)));
    const info = await claudeAdapter.snapshot(SID, CWD, p);
    for (const key of [
      "title",
      "firstPrompt",
      "lastReply",
      "model",
      "contextPct",
      "contextText",
      "tokensText",
    ] as const) {
      assert.equal(info[key], null, key);
    }
    assert.equal(info.messages, 0, "the whole file was read: zero is a count");
  });

  it("falls back to the live session's name for the title", async () => {
    const p = fakePorts();
    p.files.set(TRANSCRIPT, jsonl(claude.prompt("Hi")));
    p.files.set(
      `${SESSIONS}/77.json`,
      claudePidFile({ pid: 77, sessionId: SID, cwd: CWD, startedAt: 1, name: "fix-ci" }),
    );
    assert.equal((await claudeAdapter.snapshot(SID, CWD, p)).title, "fix-ci");
  });

  // How fast these run is measured by `pnpm bench` (claude.bench.ts), not here:
  // a wall-clock limit in the full run fails whenever the machine is busy.
  it("counts a 50 MB transcript exactly, with one whole read, when whole reads go that far (Herdr: 64 MiB)", async () => {
    const p = fakePorts();
    const meter = metered(p);
    p.wholeMax = HERDR_WHOLE_MAX;
    const { text, fillers } = bigClaudeTranscript();
    p.files.set(TRANSCRIPT, text);
    const info = await claudeAdapter.snapshot(SID, CWD, p);
    assert.equal(meter.bytes, text.length, "one read of the file, not two");
    // 1 request + one reply per filler + the last reply.
    assert.equal(info.messages, fillers + 2);
    // Input: 1 per filler + 300001 last; output: 1 per filler + 5.
    assert.equal(info.tokensText, `↑${Math.round((fillers + 300_001) / 1000)}k ↓${Math.round((fillers + 5) / 1000)}k`);
    assert.equal(info.firstPrompt, "Synthetic first request");
    assert.equal(info.title, "Late title");
    assert.equal(info.contextPct, 30);
  });

  it("reads a 50 MB transcript from its ends when reads can be partial: under 2 MB, never whole", async () => {
    const p = fakePorts();
    const meter = metered(p);
    p.files.set(TRANSCRIPT, bigClaudeTranscript().text);
    const info = await claudeAdapter.snapshot(SID, CWD, p);
    assert.ok(meter.bytes < 2 * 1024 * 1024, `read ${meter.bytes} bytes`);
    assert.equal(meter.whole, 0, "never reads the transcript whole");
    assert.equal(info.firstPrompt, "Synthetic first request");
    assert.equal(info.title, "Late title");
    assert.equal(info.lastReply, "Synthetic last answer");
    assert.equal(info.model, "claude-synthetic-2");
    assert.equal(info.branch, "release/1.2");
    assert.equal(info.contextPct, 30);
    assert.equal(info.messages, null, "not counted: most of the file was not read");
    assert.equal(info.tokensText, null);
  });

  it("reads only the new bytes when the transcript grew, and nothing when it did not", async () => {
    const p = fakePorts();
    const meter = metered(p);
    const first = smallTranscript();
    p.files.set(TRANSCRIPT, first);
    const before = await claudeAdapter.snapshot(SID, CWD, p);

    meter.bytes = 0;
    const same = await claudeAdapter.snapshot(SID, CWD, p, before);
    assert.equal(meter.bytes, 0);
    assert.deepEqual(same, before);

    const added = jsonl(claude.prompt("And a third thing", { origin: "human" }), claude.reply("Done third."));
    p.files.set(TRANSCRIPT, first + added);
    meter.mtimes.set(TRANSCRIPT, 1_800_000_100_000);
    const after = await claudeAdapter.snapshot(SID, CWD, p, before);
    assert.equal(meter.bytes, added.length);
    assert.equal(after.messages, 6);
    assert.equal(after.lastReply, "Done third.");
    assert.equal(after.firstPrompt, "Add a health check endpoint");
    assert.equal(after.title, "Health check endpoint");
    assert.equal(after.transcriptSize, (first + added).length);
    assert.equal(after.transcriptMtimeMs, 1_800_000_100_000);
  });

  it("does not count a half-written last line twice", async () => {
    const p = fakePorts();
    const done = smallTranscript();
    const line = jsonl(claude.reply("Late reply"));
    p.files.set(TRANSCRIPT, done + line.slice(0, 20));
    const partial = await claudeAdapter.snapshot(SID, CWD, p);
    assert.equal(partial.messages, 4);
    p.files.set(TRANSCRIPT, done + line);
    const whole = await claudeAdapter.snapshot(SID, CWD, p, partial);
    assert.equal(whole.messages, 5);
    assert.equal(whole.lastReply, "Late reply");
  });

  it("takes a read that came back empty for no read, not for an empty transcript", async () => {
    // What Herdr gave for a transcript over 64 MiB: the file is there, its bytes are not.
    const p = fakePorts();
    p.wholeMax = HERDR_WHOLE_MAX;
    p.files.set(TRANSCRIPT, smallTranscript());
    p.readText = async () => null;
    p.readHead = async () => null;
    p.readTail = async () => null;
    const info = await claudeAdapter.snapshot(SID, CWD, p);
    assert.equal(info.transcriptSize, null, "nothing was read, so the next look reads it again");
    assert.equal(info.messages, null, "not a count of zero");
  });

  it("takes a failed read of new bytes for no read: it keeps what it knew and reads them next time", async () => {
    const p = fakePorts();
    const meter = metered(p);
    const first = smallTranscript();
    p.files.set(TRANSCRIPT, first);
    const before = await claudeAdapter.snapshot(SID, CWD, p);
    p.files.set(TRANSCRIPT, first + jsonl(claude.prompt("And a third thing", { origin: "human" })));
    meter.mtimes.set(TRANSCRIPT, 1_800_000_100_000);
    p.readTail = async () => null;
    const after = await claudeAdapter.snapshot(SID, CWD, p, before);
    assert.equal(after.messages, 4, "what it knew");
    assert.equal(after.transcriptSize, null, "not the size of bytes it did not see");
  });

  it("takes a failed read of a long transcript's tail for no read", async () => {
    const p = fakePorts();
    metered(p);
    p.wholeMax = 8 * 1024 * 1024;
    p.files.set(TRANSCRIPT, bigClaudeTranscript().text);
    p.readTail = async () => null;
    const info = await claudeAdapter.snapshot(SID, CWD, p);
    assert.equal(info.transcriptSize, null);
    assert.equal(info.contextText, null);
  });

  it("reads a transcript past the whole-read limit from its ends (Herdr refuses a whole read past 64 MiB)", async () => {
    const p = fakePorts();
    const meter = metered(p);
    p.wholeMax = 8 * 1024 * 1024;
    p.files.set(TRANSCRIPT, bigClaudeTranscript().text);
    const info = await claudeAdapter.snapshot(SID, CWD, p);
    assert.equal(meter.whole, 0, "never whole");
    assert.equal(info.contextPct, 30);
    assert.equal(info.lastReply, "Synthetic last answer");
  });

  it("reads afresh a running session whose earlier read came back empty (0.1.2 kept such a read)", async () => {
    const p = fakePorts();
    const first = smallTranscript();
    const added = jsonl(claude.prompt("And a third thing", { origin: "human" }), claude.reply("Done third."));
    p.files.set(TRANSCRIPT, first + added);
    // As 0.1.2 stored it: the size of the file, and nothing from it.
    const empty = { ...emptyInfo(SID, CWD), messages: 0, transcriptSize: first.length, transcriptMtimeMs: 1 };
    const info = await claudeAdapter.snapshot(SID, CWD, p, empty);
    assert.equal(info.messages, 6);
    assert.equal(info.firstPrompt, "Add a health check endpoint");
    assert.equal(info.contextText, "53k");
  });
});

describe("claude: the context window", () => {
  const at = async (model: string, tokens: number) => {
    const p = fakePorts();
    p.files.set(TRANSCRIPT, jsonl(claude.reply("ok", { model, usage: { input: 0, cacheRead: tokens, output: 1 } })));
    const info = await claudeAdapter.snapshot(SID, CWD, p);
    return { pct: info.contextPct, text: info.contextText };
  };

  it("gives Opus 5.5 a percentage of its 1M window below 200k too (its id has no [1m])", async () => {
    assert.deepEqual(await at("claude-opus-5-5", 68_000), { pct: 7, text: "68k / 1M" });
  });

  it("knows the window from the generation: 1M from the 5 models on, 200k for Haiku 4.5", async () => {
    assert.deepEqual(await at("claude-sonnet-5-5", 100_000), { pct: 10, text: "100k / 1M" });
    assert.deepEqual(await at("claude-opus-5", 100_000), { pct: 10, text: "100k / 1M" });
    assert.deepEqual(await at("claude-haiku-5-5", 100_000), { pct: 10, text: "100k / 1M" });
    assert.deepEqual(await at("claude-fable-5-2", 100_000), { pct: 10, text: "100k / 1M" });
    assert.deepEqual(await at("claude-haiku-4-5-20251001", 70_000), { pct: 35, text: "70k / 200k" });
  });

  it("keeps 'in use' where the window depends on a setting the transcript does not keep (4.x: 200k or 1M)", async () => {
    for (const model of ["claude-sonnet-4-5-20250929", "claude-opus-4-6", "claude-synthetic-1", "claude-3-5-haiku"]) {
      assert.deepEqual(await at(model, 70_000), { pct: null, text: "70k" }, model);
    }
  });

  // Seen on the user's machine after installing the fix: two running sessions kept "68k" from a
  // record 0.1.2 wrote, because their transcripts did not change and an unchanged read keeps it.
  it("recomputes a record saved without the window once the model gives it, though the transcript is unchanged", async () => {
    const p = fakePorts();
    metered(p);
    p.files.set(
      TRANSCRIPT,
      jsonl(claude.reply("ok", { model: "claude-opus-5-5", usage: { input: 0, cacheRead: 68_000, output: 1 } })),
    );
    const fresh = await claudeAdapter.snapshot(SID, CWD, p);
    const old = { ...fresh, contextPct: null, contextText: "68k" };
    const again = await claudeAdapter.snapshot(SID, CWD, p, old);
    assert.deepEqual([again.contextPct, again.contextText], [7, "68k / 1M"]);
  });

  it("keeps an unchanged record whose window is still unknown as it is (no re-read)", async () => {
    const p = fakePorts();
    const meter = metered(p);
    p.files.set(
      TRANSCRIPT,
      jsonl(
        claude.reply("ok", { model: "claude-sonnet-4-5-20250929", usage: { input: 0, cacheRead: 70_000, output: 1 } }),
      ),
    );
    const first = await claudeAdapter.snapshot(SID, CWD, p);
    const bytes = meter.bytes;
    const again = await claudeAdapter.snapshot(SID, CWD, p, first);
    assert.deepEqual([again.contextPct, again.contextText], [null, "70k"]);
    assert.equal(meter.bytes, bytes, "no read for an unchanged file whose window cannot be known");
  });

  it("keeps the model's window on a grown read that brings no model", async () => {
    const p = fakePorts();
    const meter = metered(p);
    const first = jsonl(
      claude.reply("ok", { model: "claude-opus-5-5", usage: { input: 0, cacheRead: 50_000, output: 1 } }),
    );
    p.files.set(TRANSCRIPT, first);
    const before = await claudeAdapter.snapshot(SID, CWD, p);
    p.files.set(TRANSCRIPT, first + jsonl(claude.prompt("more", { origin: "human" })));
    meter.mtimes.set(TRANSCRIPT, 1_800_000_100_000);
    const after = await claudeAdapter.snapshot(SID, CWD, p, before);
    assert.deepEqual([after.contextPct, after.contextText], [5, "50k / 1M"]);
  });
});

describe("claude: transcriptExists", () => {
  it("is false once the transcript is deleted, and finds it in another project folder", async () => {
    const p = fakePorts();
    p.files.set(TRANSCRIPT, smallTranscript());
    assert.equal(await claudeAdapter.transcriptExists(SID, CWD, p), true);
    p.files.delete(TRANSCRIPT);
    assert.equal(await claudeAdapter.transcriptExists(SID, CWD, p), false);
    p.files.set(`${HOME}/.claude/projects/-home-tester-dev-app-long-1a2b3c/${SID}.jsonl`, smallTranscript());
    assert.equal(await claudeAdapter.transcriptExists(SID, CWD, p), true);
  });
});

describe("claude: openElsewhere", () => {
  it("is open while a live claude process holds the session", async () => {
    const p = scriptExec(fakePorts(), () => ok("  301 400000 claude\n"));
    p.files.set(`${SESSIONS}/301.json`, claudePidFile({ pid: 301, sessionId: SID, cwd: CWD, startedAt: 1 }));
    p.files.set(`${SESSIONS}/302.json`, claudePidFile({ pid: 302, sessionId: ANOTHER_ID, cwd: CWD, startedAt: 1 }));
    assert.deepEqual(await claudeAdapter.openElsewhere(SID, p), { open: true, where: "pid 301" });
  });

  it("is closed for a file left by a crash or a reused pid", async () => {
    const dead = scriptExec(fakePorts(), () => ok(""));
    dead.files.set(`${SESSIONS}/301.json`, claudePidFile({ pid: 301, sessionId: SID, cwd: CWD, startedAt: 1 }));
    assert.deepEqual(await claudeAdapter.openElsewhere(SID, dead), { open: false });
    const reused = scriptExec(fakePorts(), () => ok("  301 1000 vim\n"));
    reused.files.set(`${SESSIONS}/301.json`, claudePidFile({ pid: 301, sessionId: SID, cwd: CWD, startedAt: 1 }));
    assert.deepEqual(await claudeAdapter.openElsewhere(SID, reused), { open: false });
  });

  it("says open, unsure, when the process list could not be taken (not closed: a second copy is worse)", async () => {
    const p = fakePorts();
    p.exec = async () => {
      throw new Error("timed out");
    };
    p.files.set(`${SESSIONS}/301.json`, claudePidFile({ pid: 301, sessionId: SID, cwd: CWD, startedAt: 1 }));
    assert.deepEqual(await claudeAdapter.openElsewhere(SID, p), { open: true, unsure: true });
  });

  it("starts no process when no file names the session", async () => {
    const p = fakePorts();
    assert.deepEqual(await claudeAdapter.openElsewhere(SID, p), { open: false });
    assert.equal(p.execCalls.length, 0);
  });

  it("does not count our own terminal", async () => {
    const p = scriptExec(fakePorts(), () => ok("  301 400000 claude\n"));
    p.hc = async (args) => {
      p.hcCalls.push(args);
      return ok(
        JSON.stringify({ address: "t9", pid: 301, foreground: { pid: 301, argv: ["claude"], name: "claude" } }),
      );
    };
    p.files.set(`${SESSIONS}/301.json`, claudePidFile({ pid: 301, sessionId: SID, cwd: CWD, startedAt: 1 }));
    assert.deepEqual(await claudeAdapter.openElsewhere(SID, p, "t9"), { open: false });
    assert.deepEqual(p.hcCalls[0], ["get", "t9", "--json"]);
  });

  it("watches the sessions folder for changes", async () => {
    const p = fakePorts();
    const watched: string[] = [];
    p.watch = async (dir) => {
      watched.push(dir);
      return [dir];
    };
    await claudeAdapter.watchOpenness?.(p);
    assert.deepEqual(watched, [SESSIONS]);
  });
});

describe("claude: stopping and starting", () => {
  it("interrupts, waits for idle, empties the prompt, then exits", () => {
    const steps = claudeAdapter.stopSteps();
    assert.deepEqual(steps[0], { key: "esc" });
    assert.ok("waitIdleMs" in (steps[1] ?? {}));
    assert.deepEqual(steps[2], { key: "ctrl+c" });
    assert.deepEqual(steps[3], { send: "/exit" });
  });

  it("resumes by id and starts fresh with plain claude", () => {
    assert.deepEqual(claudeAdapter.resumeArgv(SID, CWD), ["claude", "--resume", SID]);
    assert.deepEqual(claudeAdapter.newArgv(CWD), ["claude"]);
    assert.equal(claudeAdapter.displayName, "Claude Code");
  });
});
