import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { codexAdapter } from "../../src/adapters/codex.ts";
import { fakePorts } from "../fakePorts.ts";
import { codex, jsonl, metered, ok, scriptExec, terminal, uuidV7 } from "./synthetic.ts";

const HOME = "/home/tester";
const CWD = "/home/tester/dev/parser";
const NOW = 1_800_000_000_000;
const SESSIONS = `${HOME}/.codex/sessions`;

const pad = (n: number): string => String(n).padStart(2, "0");
/** Where Codex files a rollout: the local date of its start, as Codex does. */
function rolloutPath(id: string, ms: number): string {
  const d = new Date(ms);
  const day = `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
  return `${SESSIONS}/${day}/rollout-${stamp}-${id}.jsonl`;
}

function addRollout(files: Map<string, string>, ms: number, tail: string, cwd: string, body = ""): string {
  const id = uuidV7(ms, tail);
  files.set(rolloutPath(id, ms), jsonl(codex.meta(id, cwd, new Date(ms).toISOString())) + body);
  return id;
}

describe("codex: matches", () => {
  it("knows Codex by its reported app or its process name", () => {
    assert.ok(codexAdapter.matches(terminal({ app: "codex" })));
    assert.ok(codexAdapter.matches(terminal({ foreground: { pid: 1, argv: ["codex"], name: "codex.exe" } })));
    assert.ok(!codexAdapter.matches(terminal({ app: "claude-code" })));
  });
});

describe("codex: discoverSession", () => {
  it("takes the id from `codex resume <id>` when the argv shows it", async () => {
    const id = uuidV7(NOW - 5000, "abc");
    const t = terminal({ foreground: { pid: 9, argv: ["codex", "resume", id], name: "codex" } });
    const p = fakePorts({ now: NOW });
    assert.equal(await codexAdapter.discoverSession(t, p), id);
  });

  it("never takes a rollout for its folder alone: one new rollout in the terminal's folder is not enough", async () => {
    // The only new rollout in the shell's folder, and no codex under the shell to have made it:
    // it is some other terminal's (another space, a script), never this one's.
    const p = fakePorts({ now: NOW });
    const created = NOW - 60_000;
    addRollout(p.files, created + 4_000, "1", CWD);
    const t = terminal({ cwd: CWD, createdMs: created, foreground: { pid: 100, argv: ["bash"], name: "bash" } });
    assert.equal(await codexAdapter.discoverSession(t, p), null);
  });

  it("a shell that still says X while its codex runs in Y: takes its own rollout, not a later one made in X elsewhere", async () => {
    // Tab A's shell reports X; A ran `cd Y; codex` (codex 101). Codex 201 in another space started later, in X.
    const p = scriptExec(fakePorts({ now: NOW }), () =>
      ok(
        "  100     1    02:00 bash\n  101   100    01:00 codex\n  200     1    05:00 bash\n  201   200    00:30 codex\n",
      ),
    );
    const own = addRollout(p.files, NOW - 59_000, "a", `${HOME}/dev/y`);
    addRollout(p.files, NOW - 29_000, "b", CWD);
    const a = terminal({ cwd: CWD, createdMs: NOW - 120_000, foreground: { pid: 100, argv: [], name: "bash" } });
    assert.equal(await codexAdapter.discoverSession(a, p), own);
  });

  it("a /new made by an older codex elsewhere is not credited to the codex that started last", async () => {
    // B's codex (201) started 8 minutes ago, ours (101) 30 s ago; B's /new 10 s ago is B's.
    const p = scriptExec(fakePorts({ now: NOW }), () =>
      ok(
        "  100     1    05:00 bash\n  101   100    00:30 codex\n  200     1    09:00 bash\n  201   200    08:00 codex\n",
      ),
    );
    const own = addRollout(p.files, NOW - 29_000, "a", CWD);
    addRollout(p.files, NOW - 10_000, "b", CWD);
    const a = terminal({ cwd: CWD, createdMs: NOW - 300_000, foreground: { pid: 100, argv: [], name: "bash" } });
    assert.equal(await codexAdapter.discoverSession(a, p), own);
  });

  it("a rollout two live codexes could have made is nobody's: the id stays as it was", async () => {
    // Both codexes run since before the rollout, which came long after either started (a /new).
    const p = scriptExec(fakePorts({ now: NOW }), () =>
      ok(
        "  100     1    05:00 bash\n  101   100    04:00 codex\n  200     1    09:00 bash\n  201   200    08:00 codex\n",
      ),
    );
    addRollout(p.files, NOW - 10_000, "b", CWD);
    const a = terminal({ cwd: CWD, createdMs: NOW - 300_000, foreground: { pid: 100, argv: [], name: "bash" } });
    assert.equal(await codexAdapter.discoverSession(a, p), null);
  });

  it("without the terminal's shell (no foreground), nothing is taken, however new the rollout", async () => {
    const p = fakePorts({ now: NOW });
    addRollout(p.files, NOW - 5_000, "c", CWD);
    const a = terminal({ cwd: CWD, createdMs: NOW - 60_000, foreground: null });
    assert.equal(await codexAdapter.discoverSession(a, p), null);
    assert.equal(p.execCalls.length, 0, "and no process is asked: there is nothing of its own to ask about");
  });

  it("a Codex started through npm (node with the native codex under it) is one Codex, not two", async () => {
    const p = scriptExec(fakePorts({ now: NOW }), () =>
      ok(
        "  100     1    05:00 bash\n  101   100    01:00 node /usr/lib/node_modules/@openai/codex/bin/codex.js\n  102   101    00:59 codex\n  200     1    09:00 bash\n  201   200    08:00 codex\n",
      ),
    );
    const own = addRollout(p.files, NOW - 59_000, "a", CWD);
    const a = terminal({ cwd: CWD, createdMs: NOW - 300_000, foreground: { pid: 100, argv: [], name: "bash" } });
    assert.equal(await codexAdapter.discoverSession(a, p), own);
  });

  it("a Codex that started after a rollout cannot have made it", async () => {
    // Ours (101) since 5 minutes, its /new 100 s ago; another Codex (201) started 30 s ago.
    const p = scriptExec(fakePorts({ now: NOW }), () =>
      ok(
        "  100     1    06:00 bash\n  101   100    05:00 codex\n  200     1    01:00 bash\n  201   200    00:30 codex\n",
      ),
    );
    const own = addRollout(p.files, NOW - 100_000, "a", CWD);
    const a = terminal({ cwd: CWD, createdMs: NOW - 360_000, foreground: { pid: 100, argv: [], name: "bash" } });
    assert.equal(await codexAdapter.discoverSession(a, p), own);
  });

  it("tells two new rollouts in one folder apart by the codex process under this shell", async () => {
    const created = NOW - 60_000;
    // The codex under shell 100 started 30 s ago; another terminal's codex started 50 s ago.
    const p = scriptExec(fakePorts({ now: NOW }), () =>
      ok(
        "  100     1    01:00 bash\n  101   100    00:30 codex\n  200     1    01:00 bash\n  201   200    00:50 codex\n",
      ),
    );
    const theirs = addRollout(p.files, NOW - 49_000, "a", CWD);
    const ours = addRollout(p.files, NOW - 29_000, "b", CWD);
    const shell = (pid: number) =>
      terminal({ cwd: CWD, createdMs: created, foreground: { pid, argv: [], name: "bash" } });
    assert.equal(await codexAdapter.discoverSession(shell(100), p), ours);
    assert.equal(await codexAdapter.discoverSession(shell(200), p), theirs);
  });

  it("after /new, takes the newest rollout of the codex under this shell, not its first", async () => {
    const created = NOW - 120_000;
    // One codex under shell 100, started a minute ago; it made a rollout then, and another on /new.
    const p = scriptExec(fakePorts({ now: NOW }), () => ok("  100     1    02:00 bash\n  101   100    01:00 codex\n"));
    addRollout(p.files, NOW - 59_000, "a", CWD);
    const now = addRollout(p.files, NOW - 10_000, "b", CWD);
    const t = terminal({ cwd: CWD, createdMs: created, foreground: { pid: 100, argv: [], name: "bash" } });
    assert.equal(await codexAdapter.discoverSession(t, p), now);
  });

  it("walks a big process table once, not once per process", async () => {
    // A busy machine: 4000 other processes, and our codex under shell 100.
    const lines = ["  100     1    02:00 bash", "  101   100    01:00 codex"];
    for (let pid = 1000; pid < 5000; pid++) {
      lines.push(`  ${pid}   ${pid % 7 === 0 ? 1 : pid - 1}    01:00 node`);
    }
    const p = scriptExec(fakePorts({ now: NOW }), () => ok(`${lines.join("\n")}\n`));
    addRollout(p.files, NOW - 90_000, "a", CWD); // before our codex started: an earlier one's
    const ours = addRollout(p.files, NOW - 30_000, "b", CWD);
    const t = terminal({ cwd: CWD, createdMs: NOW - 120_000, foreground: { pid: 100, argv: [], name: "bash" } });
    // The fastest of five: one slow run says only that the machine was busy (every
    // test file runs at once); a walk per process is slow every time.
    let best = Number.POSITIVE_INFINITY;
    for (let i = 0; i < 5 && best >= 250; i++) {
      const started = performance.now();
      assert.equal(await codexAdapter.discoverSession(t, p), ours);
      best = Math.min(best, performance.now() - started);
    }
    assert.ok(best < 250, `took ${best.toFixed(0)} ms at best`);
  });

  it("is null when there is no rollout yet", async () => {
    const t = terminal({ cwd: CWD, createdMs: NOW - 1000, foreground: { pid: 1, argv: ["bash"], name: "bash" } });
    assert.equal(await codexAdapter.discoverSession(t, fakePorts({ now: NOW })), null);
  });
});

function richBody(): string {
  return jsonl(
    codex.developer("Synthetic developer note"),
    codex.user("<environment_context>synthetic</environment_context>"),
    codex.user("# AGENTS.md instructions for /x\nsynthetic"),
    codex.turn("gpt-synthetic-5"),
    codex.user("Parse the CSV export"),
    codex.assistant("Reading the file."),
    codex.tokens({ input: 300_000, output: 20_000, lastTotal: 60_000, window: 256_000 }),
    codex.user("Also skip empty rows"),
    codex.assistant("Done: empty rows skipped."),
    codex.tokens({ input: 640_000, output: 41_000, lastTotal: 105_000, window: 256_000 }),
  );
}

describe("codex: snapshot", () => {
  it("collects the popup fields from the rollout, the session index and git", async () => {
    const p = fakePorts({ now: NOW });
    const id = addRollout(p.files, NOW - 100_000, "r", CWD, richBody());
    p.files.set(
      `${HOME}/.codex/session_index.jsonl`,
      jsonl(
        { id, thread_name: "Old name", updated_at: "2027-01-01T00:00:00Z" },
        { id: "someone-else", thread_name: "Other", updated_at: "2027-01-01T00:00:00Z" },
        { id, thread_name: "CSV parser", updated_at: "2027-01-02T00:00:00Z" },
      ),
    );
    p.files.set(`${HOME}/dev/parser/.git/HEAD`, "ref: refs/heads/feature/PARSE-7-csv\n");
    const info = await codexAdapter.snapshot(id, CWD, p);
    assert.equal(info.title, "CSV parser");
    assert.equal(info.firstPrompt, "Parse the CSV export");
    assert.equal(info.lastReply, "Done: empty rows skipped.");
    assert.equal(info.messages, 4);
    assert.equal(info.model, "gpt-synthetic-5");
    assert.equal(info.branch, "feature/PARSE-7-csv");
    assert.equal(info.repoRoot, `${HOME}/dev/parser`);
    // 105000 / 256000 = 41 %.
    assert.equal(info.contextPct, 41);
    assert.equal(info.contextText, "105k / 256k");
    assert.equal(info.tokensText, "↑640k ↓41k");
  });

  it("leaves what the rollout lacks as null", async () => {
    const p = fakePorts({ now: NOW });
    const id = addRollout(p.files, NOW - 100_000, "e", CWD);
    const info = await codexAdapter.snapshot(id, CWD, p);
    for (const key of [
      "title",
      "firstPrompt",
      "lastReply",
      "model",
      "branch",
      "repoRoot",
      "contextPct",
      "contextText",
      "tokensText",
    ] as const) {
      assert.equal(info[key], null, key);
    }
  });

  it("reads only appended bytes next time", async () => {
    const p = fakePorts({ now: NOW });
    const meter = metered(p);
    const id = addRollout(p.files, NOW - 100_000, "g", CWD, richBody());
    const path = rolloutPath(id, NOW - 100_000);
    const before = await codexAdapter.snapshot(id, CWD, p);
    const added = jsonl(codex.user("One more"), codex.assistant("Sure."));
    p.files.set(path, (p.files.get(path) ?? "") + added);
    meter.mtimes.set(path, NOW + 1000);
    meter.bytes = 0;
    const after = await codexAdapter.snapshot(id, CWD, p, before);
    assert.equal(meter.bytes - (p.files.get(`${HOME}/.codex/session_index.jsonl`)?.length ?? 0), added.length);
    assert.equal(after.messages, 6);
    assert.equal(after.lastReply, "Sure.");
    assert.equal(after.firstPrompt, "Parse the CSV export");
    assert.equal(after.tokensText, "↑640k ↓41k");
  });
});

describe("codex: transcriptExists", () => {
  it("is false once the rollout is deleted, and finds archived rollouts", async () => {
    const p = fakePorts({ now: NOW });
    const id = addRollout(p.files, NOW - 100_000, "x", CWD);
    assert.equal(await codexAdapter.transcriptExists(id, CWD, p), true);
    p.files.delete(rolloutPath(id, NOW - 100_000));
    assert.equal(await codexAdapter.transcriptExists(id, CWD, p), false);
    p.files.set(`${HOME}/.codex/archived_sessions/rollout-2027-01-01T00-00-00-${id}.jsonl`, "{}\n");
    assert.equal(await codexAdapter.transcriptExists(id, CWD, p), true);
  });
});

describe("codex: openElsewhere", () => {
  const ID = uuidV7(NOW - 3_600_000, "o");
  const withRollout = (p: ReturnType<typeof fakePorts>) => {
    p.files.set(rolloutPath(ID, NOW - 3_600_000), jsonl(codex.meta(ID, CWD, "2027-01-01T00:00:00Z")));
    const meter = metered(p);
    meter.mtimes.set(rolloutPath(ID, NOW - 3_600_000), NOW - 3_600_000);
    return meter;
  };

  it("is open while a process has the id in its command line", async () => {
    const p = scriptExec(fakePorts({ now: NOW }), () => ok(`  500     1    10:00 codex resume ${ID}\n`));
    withRollout(p);
    assert.deepEqual(await codexAdapter.openElsewhere(ID, p), { open: true, where: "pid 500" });
  });

  it("is open while the rollout is being written", async () => {
    const p = scriptExec(fakePorts({ now: NOW }), () => ok("  1     0    10:00 init\n"));
    const meter = withRollout(p);
    meter.mtimes.set(rolloutPath(ID, NOW - 3_600_000), NOW - 2_000);
    assert.equal((await codexAdapter.openElsewhere(ID, p)).open, true);
  });

  it("is closed when nothing runs it and the file is quiet", async () => {
    const p = scriptExec(fakePorts({ now: NOW }), () =>
      ok("  1     0    10:00 init\n  7   1   01:00 codex resume 0000\n"),
    );
    withRollout(p);
    assert.deepEqual(await codexAdapter.openElsewhere(ID, p), { open: false });
  });

  it("does not count the process in our own terminal", async () => {
    const p = scriptExec(fakePorts({ now: NOW }), () =>
      ok(`  400     1    10:00 bash\n  500   400    10:00 codex resume ${ID}\n`),
    );
    p.hc = async (args) => {
      p.hcCalls.push(args);
      return ok(JSON.stringify({ pid: 400, foreground: { pid: 400 } }));
    };
    withRollout(p);
    assert.deepEqual(await codexAdapter.openElsewhere(ID, p, "t3"), { open: false });
  });
});

describe("codex: stopping and starting", () => {
  it("quits with /quit and resumes by id", () => {
    assert.deepEqual(codexAdapter.stopSteps().slice(0, 2), [{ key: "ctrl+c" }, { send: "/quit" }]);
    assert.equal(codexAdapter.displayName, "Codex");
  });

  // Codex shows its "Update available" screen before it loads anything, and the
  // session behind it is neither shown nor found until someone answers. The mod's
  // own starts turn the check off for that run only; config.toml is not touched.
  it("resumes by id with the update check off for that run", () => {
    const id = uuidV7(NOW, "abc");
    assert.deepEqual(codexAdapter.resumeArgv(id, CWD), [
      "codex",
      "-c",
      "check_for_update_on_startup=false",
      "resume",
      id,
    ]);
  });

  it("starts a new session with the update check off as well", () => {
    assert.deepEqual(codexAdapter.newArgv(CWD), ["codex", "-c", "check_for_update_on_startup=false"]);
  });

  it("still finds the id of a session it resumed this way", async () => {
    const id = uuidV7(NOW - 5000, "abc");
    const argv = codexAdapter.resumeArgv(id, CWD);
    const t = terminal({ foreground: { pid: 9, argv, name: "codex" } });
    assert.equal(await codexAdapter.discoverSession(t, fakePorts({ now: NOW })), id);
  });
});
