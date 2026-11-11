// How fast a snapshot of a 50 MB transcript is: `pnpm bench`, on its own,
// never inside `pnpm check`. A wall-clock limit there fails whenever the machine
// is busy (every test file runs at once, memory runs short, a CI box is
// shared): 0.46 s alone, 6 to 9 s in a full run on a machine short of memory.
// What the code reads is checked deterministically in claude.test.ts.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { claudeAdapter } from "../../src/adapters/claude.ts";
import type { SessionInfo } from "../../src/core/model.ts";
import { fakePorts } from "../fakePorts.ts";
import { bigClaudeTranscript } from "./synthetic.ts";

const CWD = "/home/tester/dev/app";
const SID = "11111111-2222-4333-8444-555555555555";
const TRANSCRIPT = `/home/tester/.claude/projects/-home-tester-dev-app/${SID}.jsonl`;
const LIMIT_MS = 200;

/** The fastest of up to `tries` snapshots, each reading the file from scratch (the first also compiles the parser). */
async function fastest(run: () => Promise<SessionInfo>, tries = 5): Promise<number> {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < tries && best >= LIMIT_MS; i++) {
    const started = performance.now();
    await run();
    best = Math.min(best, performance.now() - started);
  }
  return best;
}

describe("claude: snapshot speed of a 50 MB transcript", () => {
  it(`counts it whole in under ${LIMIT_MS} ms (Herdr's reads are whole, D01)`, async () => {
    const p = fakePorts();
    p.wholeReads = true;
    p.files.set(TRANSCRIPT, bigClaudeTranscript().text);
    const ms = await fastest(() => claudeAdapter.snapshot(SID, CWD, p));
    assert.ok(ms < LIMIT_MS, `took ${ms.toFixed(0)} ms at best`);
  });

  it(`reads its ends in under ${LIMIT_MS} ms when reads can be partial`, async () => {
    const p = fakePorts();
    p.files.set(TRANSCRIPT, bigClaudeTranscript().text);
    const ms = await fastest(() => claudeAdapter.snapshot(SID, CWD, p));
    assert.ok(ms < LIMIT_MS, `took ${ms.toFixed(0)} ms at best`);
  });
});
