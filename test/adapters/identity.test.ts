// What the adapters take as proof that a session is a terminal's, or open
// somewhere: only the processes, never a folder. And the forms the agents
// take as processes: Claude Code installed with npm on Windows runs as
// node.exe (its pid file names node), and a Codex just put to sleep wrote its
// rollout on the way out.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { claudeAdapter } from "../../src/adapters/claude.ts";
import { codexAdapter } from "../../src/adapters/codex.ts";
import { fakePorts } from "../fakePorts.ts";
import { claudePidFile, codex, jsonl, metered, ok, scriptExec, terminal, uuidV7 } from "./synthetic.ts";

const SID = "11111111-2222-4333-8444-555555555555";
const NPM_CLAUDE =
  '"C:\\Program Files\\nodejs\\node.exe" C:\\Users\\tester\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js';

describe("Claude Code: a session is a terminal's only through its processes", () => {
  it("without the terminal's process in front, the one new session in its folder is not taken", async () => {
    const p = fakePorts();
    const cwd = "/home/tester/dev/app";
    p.files.set(
      "/home/tester/.claude/sessions/4242.json",
      claudePidFile({ pid: 4242, sessionId: SID, cwd, startedAt: 2_000 }),
    );
    const t = terminal({ cwd, createdMs: 1_000, foreground: null });
    assert.equal(await claudeAdapter.discoverSession(t, p), null);
  });
});

describe("Claude Code installed with npm (node.exe runs it on Windows)", () => {
  const sessions = "C:\\Users\\tester\\.claude\\sessions";
  const cwd = "C:\\Users\\tester\\dev\\app";

  it("is found under its shell though its process is node.exe", async () => {
    const p = scriptExec(fakePorts({ sep: "\\" }), () => ok(`201\t100\t1000500\tnode.exe\t${NPM_CLAUDE}\r\n`));
    p.files.set(`${sessions}\\201.json`, claudePidFile({ pid: 201, sessionId: SID, cwd, startedAt: 1_000_500 }));
    const t = terminal({ cwd, createdMs: 1_000_000, foreground: { pid: 100, argv: [], name: "pwsh.exe" } });
    assert.equal(await claudeAdapter.discoverSession(t, p), SID);
  });

  it("an npm Claude that holds the session shows it open elsewhere; another node program does not", async () => {
    const run = (commandLine: string) =>
      scriptExec(fakePorts({ sep: "\\" }), (cmd) =>
        /tasklist/i.test(cmd)
          ? ok('"node.exe","201","Console","1","90 000 K"\r\n"System","4","Services","0","100 K"\r\n')
          : ok(`201\t1\t1000500\tnode.exe\t${commandLine}\r\n`),
      );
    const held = run(NPM_CLAUDE);
    held.files.set(`${sessions}\\201.json`, claudePidFile({ pid: 201, sessionId: SID, cwd, startedAt: 1 }));
    assert.deepEqual(await claudeAdapter.openElsewhere(SID, held), { open: true, where: "pid 201" });
    const reused = run('"C:\\Program Files\\nodejs\\node.exe" server.js');
    reused.files.set(`${sessions}\\201.json`, claudePidFile({ pid: 201, sessionId: SID, cwd, startedAt: 1 }));
    assert.deepEqual(await claudeAdapter.openElsewhere(SID, reused), { open: false });
  });

  it("is known as Claude Code by its command line", () => {
    const fg = { pid: 201, argv: NPM_CLAUDE.split(" "), name: "node.exe" };
    assert.ok(claudeAdapter.matches(terminal({ foreground: fg })));
    assert.ok(!claudeAdapter.matches(terminal({ foreground: { pid: 7, argv: ["node", "server.js"], name: "node" } })));
  });
});

describe("Codex: its own last write is not someone else's", () => {
  const NOW = 1_800_000_000_000;
  const ID = uuidV7(NOW - 3_600_000, "q");
  const pad = (n: number): string => String(n).padStart(2, "0");
  const d = new Date(NOW - 3_600_000);
  const PATH = `/home/tester/.codex/sessions/${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}/rollout-x-${ID}.jsonl`;

  it("a rollout last written before the session went to sleep (its /quit) is not a sign it is open", async () => {
    const p = scriptExec(fakePorts({ now: NOW }), () => ok("  1     0    10:00 init\n"));
    p.files.set(PATH, jsonl(codex.meta(ID, "/home/tester/dev/x", d.toISOString())));
    const meter = metered(p);
    meter.mtimes.set(PATH, NOW - 4_000); // /quit wrote it; the sleep ended a second later
    assert.deepEqual(await codexAdapter.openElsewhere(ID, p, undefined, NOW - 3_000), { open: false });
    // A write after the sleep is someone's.
    assert.equal((await codexAdapter.openElsewhere(ID, p, undefined, NOW - 5_000)).open, true);
  });
});
