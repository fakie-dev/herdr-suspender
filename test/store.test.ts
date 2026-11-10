import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SessionRecord, StoreFile } from "../src/core/model.ts";
import { defaultStorePath, readStore, updateStore } from "../src/core/store.ts";
import { fakePorts } from "./fakePorts.ts";

const PATH = "/home/tester/.config/herdr-app/suspender/sessions.json";

function record(sessionId: string, state: SessionRecord["state"] = "asleep"): SessionRecord {
  return {
    key: `claude:${sessionId}`,
    agent: "claude",
    sessionId,
    cwd: "/home/tester/dev/app",
    state,
    spaceId: "sp1",
    tabId: "tb1",
    terminal: null,
    pane: "p1",
    info: {
      title: "Synthetic session",
      firstPrompt: null,
      lastReply: null,
      messages: 3,
      branch: "main",
      model: null,
      cwd: "/home/tester/dev/app",
      repoRoot: "/home/tester/dev/app",
      sessionId,
      contextPct: null,
      contextText: null,
      tokensText: null,
      transcriptMtimeMs: null,
      transcriptSize: null,
    },
    lastScreen: null,
    sleptAtMs: 1_800_000_000_000,
    memFreedMb: 700,
    forced: false,
    error: null,
  };
}

const fileOf = (text: string | undefined): StoreFile => JSON.parse(text ?? "null") as StoreFile;

describe("store", () => {
  it("lives in the app folder, outside mods/, so reinstalling the mod keeps it", () => {
    assert.equal(defaultStorePath(fakePorts()), PATH);
    assert.equal(
      defaultStorePath(fakePorts({ sep: "\\", home: "C:\\Users\\tester" })),
      "C:\\Users\\tester\\.config\\herdr-app\\suspender\\sessions.json",
    );
  });

  it("reads a missing file as an empty store", async () => {
    assert.deepEqual(await readStore(fakePorts(), PATH), { version: 1, sessions: {} });
  });

  it("reads an empty or broken file as an empty store", async () => {
    const ports = fakePorts();
    ports.files.set(PATH, "");
    assert.deepEqual(await readStore(ports, PATH), { version: 1, sessions: {} });
    ports.files.set(PATH, "{ not json");
    assert.deepEqual(await readStore(ports, PATH), { version: 1, sessions: {} });
    ports.files.set(PATH, JSON.stringify({ version: 7, sessions: { x: 1 } }));
    assert.deepEqual(await readStore(ports, PATH), { version: 1, sessions: {} });
  });

  it("reads back what was written", async () => {
    const ports = fakePorts();
    const one = record("s-1");
    ports.files.set(PATH, JSON.stringify({ version: 1, sessions: { [one.key]: one } }));
    assert.deepEqual(await readStore(ports, PATH), { version: 1, sessions: { [one.key]: one } });
  });

  it("creates the file with expected = null (it must not exist yet)", async () => {
    const ports = fakePorts();
    const one = record("s-1");
    await updateStore(ports, PATH, (file) => {
      file.sessions[one.key] = one;
    });
    assert.deepEqual(
      ports.writes.map((w) => [w.expected, w.ok]),
      [[null, true]],
    );
    assert.deepEqual(fileOf(ports.files.get(PATH)).sessions, { [one.key]: one });
  });

  it("writes with the text it read as expected", async () => {
    const ports = fakePorts();
    const before = JSON.stringify({ version: 1, sessions: {} });
    ports.files.set(PATH, before);
    await updateStore(ports, PATH, (file) => {
      file.sessions["claude:s-2"] = record("s-2");
    });
    assert.equal(ports.writes[0]?.expected, before);
  });

  it("on a version conflict reads again and applies the change to the newer file", async () => {
    const ports = fakePorts();
    const theirs = record("theirs");
    const ours = record("ours");
    ports.files.set(PATH, JSON.stringify({ version: 1, sessions: {} }));
    let raced = false;
    ports.beforeWrite = (path) => {
      if (!raced) {
        raced = true; // another copy of the mod writes between our read and our write
        ports.files.set(path, JSON.stringify({ version: 1, sessions: { [theirs.key]: theirs } }));
      }
    };
    const result = await updateStore(ports, PATH, (file) => {
      file.sessions[ours.key] = ours;
    });
    assert.deepEqual(
      ports.writes.map((w) => w.ok),
      [false, true],
    );
    const saved = fileOf(ports.files.get(PATH));
    assert.deepEqual(Object.keys(saved.sessions).sort(), [ours.key, theirs.key].sort());
    assert.deepEqual(result, saved);
  });

  it("gives up with an error after a few conflicts in a row, without losing the other writer's data", async () => {
    const ports = fakePorts();
    let n = 0;
    ports.beforeWrite = (path) => {
      n++;
      ports.files.set(path, JSON.stringify({ version: 1, sessions: { [`claude:other-${n}`]: record(`other-${n}`) } }));
    };
    await assert.rejects(
      updateStore(ports, PATH, (file) => {
        file.sessions["claude:ours"] = record("ours");
      }),
      /conflict/,
    );
    assert.equal(ports.writes.length, 5);
    assert.ok(ports.writes.every((w) => !w.ok));
    assert.deepEqual(Object.keys(fileOf(ports.files.get(PATH)).sessions), ["claude:other-5"]);
  });

  it("removes a record (forget) and keeps the others", async () => {
    const ports = fakePorts();
    const a = record("a");
    const b = record("b");
    ports.files.set(PATH, JSON.stringify({ version: 1, sessions: { [a.key]: a, [b.key]: b } }));
    await updateStore(ports, PATH, (file) => {
      delete file.sessions[a.key];
    });
    assert.deepEqual(Object.keys(fileOf(ports.files.get(PATH)).sessions), [b.key]);
  });
});
