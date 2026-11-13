// A transcript of 1 to 64 MiB was read whole, and that read failed in Herdr
// without a trace: its runtime stops a script that runs between 0.5 and 0.7 s
// without a pause (measured on 0.1.15: a 500 ms busy loop ran, a 700 ms one
// never came back, nor did parsing a 27 MB transcript in one go; 8 MiB took
// 265 ms, the same 27 MB in 1 MiB pieces with a 1 ms sleep between them
// 944 ms, its longest piece 36 ms; a microtask between pieces is no pause).
// The task just ended, and the session kept no info at all. So a transcript
// is parsed in pieces with a pause between (`Ports.breathe`), and a whole
// read that is refused or comes back cut gives way to the two ends.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { claudeAdapter } from "../../src/adapters/claude.ts";
import { codexAdapter } from "../../src/adapters/codex.ts";
import { PIECE_CHARS, readTranscript } from "../../src/adapters/common.ts";
import { fakePorts } from "../fakePorts.ts";
import { claude, codex, jsonl, uuidV7 } from "./synthetic.ts";

const SID = "11111111-2222-4333-8444-555555555555";
const CWD = "/home/tester/dev/app";
const TRANSCRIPT = `/home/tester/.claude/projects/-home-tester-dev-app/${SID}.jsonl`;
const WHOLE_MAX = 64 * 1024 * 1024;

/**
 * About 6 MB: a first request, then replies each written as two records with
 * the same message id (one per content block, as Claude Code does), with
 * noise between, and a last reply.
 */
function transcript(): { text: string; replies: number } {
  const records: object[] = [claude.prompt("Synthetic first request"), claude.aiTitle("Synthetic title")];
  const replies = 120;
  for (let i = 0; i < replies; i++) {
    records.push(claude.noise(50_000));
    const usage = { input: 1000, output: 10 };
    records.push(claude.reply(`Synthetic reply ${i}`, { id: `m${i}`, usage }));
    records.push(claude.reply(`Synthetic reply ${i}, its second block`, { id: `m${i}`, usage }));
  }
  records.push(claude.reply("Synthetic last reply", { id: "last", usage: { input: 5000, output: 7 } }));
  return { text: jsonl(...records), replies: replies + 1 };
}

function ports(text: string) {
  const p = fakePorts();
  p.wholeMax = WHOLE_MAX;
  p.files.set(TRANSCRIPT, text);
  let pauses = 0;
  p.breathe = async () => {
    pauses++;
  };
  return { p, pauses: () => pauses };
}

describe("a transcript of a few MB, read whole", () => {
  it("is parsed in pieces with a pause between them, and counts the same as in one go", async () => {
    const { text, replies } = transcript();
    const { p, pauses } = ports(text);
    const info = await claudeAdapter.snapshot(SID, CWD, p);
    // Counting the bytes read pauses between its pieces, and so does parsing them.
    const pieces = Math.ceil(text.length / PIECE_CHARS);
    assert.ok(pauses() >= pieces - 1 + (pieces - 2), `${pauses()} pauses for ${pieces} pieces`);
    assert.equal(info.messages, replies + 1, "a reply split over two pieces is counted once");
    assert.equal(info.firstPrompt, "Synthetic first request");
    assert.equal(info.lastReply, "Synthetic last reply");
    assert.equal(info.title, "Synthetic title");
    assert.equal(info.transcriptSize, Buffer.byteLength(text));
  });

  it("counts and bills a reply once though its two records fall in two pieces", async () => {
    // A reply of two records (one per content block) whose first line crosses the piece boundary.
    const usage = { input: 1000, output: 10 };
    const first = jsonl(claude.prompt("Synthetic first request"));
    const pair = jsonl(
      claude.reply("Synthetic split reply", { id: "split", usage }),
      claude.reply("Synthetic split reply, second block", { id: "split", usage }),
    );
    const firstLine = pair.slice(0, pair.indexOf("\n") + 1).length;
    const noiseFor = (n: number): string => jsonl(claude.noise(n));
    const target = PIECE_CHARS - Math.floor(firstLine / 2) - first.length;
    let noise = noiseFor(target);
    noise = noiseFor(target - (noise.length - target));
    const last = jsonl(claude.reply("Synthetic last reply", { id: "last", usage: { input: 5000, output: 7 } }));
    const text = first + noise + pair + last;
    assert.ok(text.indexOf(pair) < PIECE_CHARS && text.indexOf(pair) + firstLine > PIECE_CHARS, "the pair crosses");
    const info = await claudeAdapter.snapshot(SID, CWD, ports(text).p);
    assert.equal(info.messages, 3, "the request, the split reply once, the last reply");
    assert.equal(info.tokensText?.split(" ")[0], "↑6k");
  });

  it("a whole read that is refused gives way to the two ends: the session still has its info", async () => {
    const { text } = transcript();
    const { p } = ports(text);
    p.readText = async () => null;
    const info = await claudeAdapter.snapshot(SID, CWD, p);
    assert.equal(info.firstPrompt, "Synthetic first request");
    assert.equal(info.lastReply, "Synthetic last reply");
    assert.equal(info.model, "claude-synthetic-1");
    assert.equal(info.transcriptSize, Buffer.byteLength(text));
    assert.equal(info.messages, null, "from the ends no count is exact");
  });

  it("a whole read that comes back cut (Herdr's 1 MiB text read) is not taken for the whole", async () => {
    const { text } = transcript();
    const { p } = ports(text);
    p.readText = async (path) => (p.files.get(path) ?? "").slice(0, 1024 * 1024);
    const info = await claudeAdapter.snapshot(SID, CWD, p);
    assert.equal(info.lastReply, "Synthetic last reply", "the end of the file, not of the first MiB");
    assert.equal(info.messages, null);
  });

  it("Codex: a rollout of a few MB is parsed in pieces too", async () => {
    const NOW = 1_800_000_000_000;
    const id = uuidV7(NOW - 60_000, "c");
    const d = new Date(NOW - 60_000);
    const pad = (n: number): string => String(n).padStart(2, "0");
    const path = `/home/tester/.codex/sessions/${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}/rollout-x-${id}.jsonl`;
    const records: object[] = [codex.meta(id, CWD, d.toISOString()), codex.user("Parse the export")];
    for (let i = 0; i < 100; i++) {
      records.push(codex.assistant(`Step ${i} ${"y".repeat(50_000)}`));
    }
    records.push(codex.assistant("Done."));
    const p = fakePorts({ now: NOW });
    p.wholeMax = WHOLE_MAX;
    p.files.set(path, jsonl(...records));
    let pauses = 0;
    p.breathe = async () => {
      pauses++;
    };
    const info = await codexAdapter.snapshot(id, CWD, p);
    const pieces = Math.ceil((p.files.get(path)?.length ?? 0) / PIECE_CHARS);
    assert.ok(pauses >= pieces - 1 + (pieces - 2), `${pauses} pauses for ${pieces} pieces`);
    assert.equal(info.lastReply, "Done.");
    assert.equal(info.messages, 102);
  });
});

describe("the read itself pauses too", () => {
  it("counting a whole read's bytes is done a piece at a time, with a pause between", async () => {
    const { text } = transcript();
    const { p, pauses } = ports(text);
    const read = await readTranscript(TRANSCRIPT, p);
    assert.equal(read.kind, "whole");
    assert.ok(pauses() >= 5, `${pauses()} pauses`);
  });
});
