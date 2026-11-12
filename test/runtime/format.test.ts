import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { emptyInfo } from "../../src/adapters/common.ts";
import type { SessionRecord } from "../../src/core/model.ts";
import { clock, screenLines, stripActions, stripSegments, stripStatus, wakeSteps } from "../../src/ui/format.ts";

const at = (h: number, m: number, day = 10): number => new Date(2026, 10, day, h, m).getTime();
const NOW = at(18, 0);

function rec(over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    key: "claude:s1",
    agent: "claude",
    sessionId: "s1",
    cwd: "C:\\work\\repo\\src",
    state: "asleep",
    spaceId: "sp1",
    tabId: "tb1",
    terminal: null,
    pane: "p1",
    info: {
      ...emptyInfo("s1", "C:\\work\\repo\\src"),
      title: "Fix the login",
      branch: "feature/PORTAL-412-oauth-device-flow",
      model: "opus",
      repoRoot: "C:\\work\\repo",
    },
    lastScreen: null,
    sleptAtMs: at(14, 5),
    memFreedMb: 700,
    forced: false,
    error: null,
    ...over,
  };
}

const opts = { now: NOW, agentName: "Claude Code", progress: null, fresh: null };

describe("strip status line", () => {
  it("asleep: since when", () => {
    assert.equal(stripStatus(rec(), opts), "Asleep since 14:05");
  });

  it("an earlier day shows the date", () => {
    assert.equal(stripStatus(rec({ sleptAtMs: at(9, 30, 8) }), opts), "Asleep since 2026-11-08 09:30");
  });

  it("interrupted by a restart", () => {
    assert.equal(stripStatus(rec({ state: "interrupted" }), opts), "Interrupted by restart · 14:05");
  });

  it("stopped forcefully says the conversation is kept", () => {
    assert.equal(
      stripStatus(rec({ forced: true }), opts),
      "Asleep since 14:05 · Stopped forcefully, conversation kept",
    );
  });

  it("work done elsewhere while asleep", () => {
    assert.equal(
      stripStatus(rec(), { ...opts, fresh: { atMs: at(15, 20), added: 3 } }),
      "Asleep since 14:05 · Updated after sleep · 15:20 · +3 messages",
    );
  });

  it("open elsewhere, gone from disk", () => {
    assert.equal(
      stripStatus(rec({ state: "elsewhere" }), opts),
      "This session is open elsewhere — close it there to resume here",
    );
    assert.equal(stripStatus(rec({ state: "missing" }), opts), "Conversation no longer exists on disk");
  });

  it("a failed start names the agent and the reason", () => {
    assert.equal(
      stripStatus(rec({ state: "error", error: "reason.timeout" }), opts),
      "Couldn't start Claude Code: no answer within 30 seconds",
    );
  });

  it("stopping", () => {
    assert.equal(stripStatus(rec({ state: "stopping" }), opts), "Stopping…");
  });
});

describe("wake steps", () => {
  it("found session → starting → ready, the current one marked", () => {
    assert.deepEqual(wakeSteps("starting"), [
      { label: "Found session", state: "done" },
      { label: "Starting", state: "now" },
      { label: "Ready", state: "todo" },
    ]);
    assert.deepEqual(
      wakeSteps(null).map((s) => s.state),
      ["now", "todo", "todo"],
    );
  });
});

describe("strip buttons", () => {
  it("Resume while asleep or interrupted; disabled while open elsewhere or busy", () => {
    assert.deepEqual(stripActions(rec(), false), [{ action: "resume", label: "Resume", enabled: true }]);
    assert.deepEqual(stripActions(rec({ state: "interrupted" }), false), [
      { action: "resume", label: "Resume", enabled: true },
    ]);
    assert.deepEqual(stripActions(rec({ state: "elsewhere" }), false), [
      { action: "resume", label: "Resume", enabled: false },
    ]);
    assert.deepEqual(stripActions(rec(), true), [{ action: "resume", label: "Resume", enabled: false }]);
  });

  it("a missing conversation: Start new session and Forget; a failed start: Retry", () => {
    assert.deepEqual(
      stripActions(rec({ state: "missing" }), false).map((a) => a.label),
      ["Start new session", "Forget"],
    );
    assert.deepEqual(
      stripActions(rec({ state: "error" }), false).map((a) => a.label),
      ["Retry"],
    );
    assert.deepEqual(stripActions(rec({ state: "waking" }), false), []);
  });
});

describe("strip items", () => {
  it("branch → model → folder, the folder from the repository root", () => {
    const segs = stripSegments(rec().info, "\\");
    assert.deepEqual(
      segs.map((s) => s.key),
      ["branch", "model", "folder"],
    );
    assert.deepEqual(
      segs.map((s) => s.priority),
      [1, 2, 3],
    );
    assert.equal(segs[2]?.text, "repo\\src");
    assert.ok(segs[0]?.text.startsWith("feature/PORTAL-412"));
  });

  it("no data, no item", () => {
    const info = { ...rec().info, branch: null, model: null };
    assert.deepEqual(
      stripSegments(info, "\\").map((s) => s.key),
      ["folder"],
    );
  });
});

describe("last screen", () => {
  it("keeps the last lines that fit, without trailing blank lines", () => {
    assert.deepEqual(screenLines("a\nb\nc\n\n\n", 2), ["b", "c"]);
    assert.deepEqual(screenLines(null, 5), []);
    assert.deepEqual(screenLines("x\r\ny", 5), ["x", "y"]);
  });

  it("clock: hours and minutes today", () => {
    assert.equal(clock(at(9, 7), NOW), "09:07");
  });
});

describe("statusWords: the strip's status in a narrow pane (finding 6 of the blind review)", async () => {
  const { statusWords } = await import("../../src/ui/format.ts");
  // 6 px a character: "Asleep since 05:18" is 108 px.
  const six = (text: string): number => [...text].length * 6;
  const TEXT = "Asleep since 05:18 · Updated after sleep 05:20";
  const wordsOf = (lines: string[]): string[] =>
    lines
      .join(" ")
      .replace(/…$/, "")
      .split(/\s+/)
      .filter((w) => w !== "");
  const whole = TEXT.split(" ");

  it("is one line where it fits", () => {
    assert.deepEqual(statusWords(TEXT, 400, six), [TEXT]);
  });

  it("wraps at spaces, never inside a word, up to two lines, then ends with …", () => {
    for (let width = 30; width <= 300; width += 1) {
      const lines = statusWords(TEXT, width, six);
      assert.ok(lines.length <= 2, `${width}: ${lines.length} lines`);
      for (const line of lines) {
        assert.ok(six(line) <= width, `${width}: "${line}" is ${six(line)} px`);
      }
      const words = wordsOf(lines);
      words.forEach((w, i) => {
        assert.equal(w, whole[i], `${width}: word ${i} "${w}" is whole`);
      });
      if (words.length < whole.length && lines.length > 0) {
        assert.ok(lines.at(-1)?.endsWith("…"), `${width}: shortened, so it says so`);
      }
    }
  });

  it("is nothing where not even its first word and … fit (a lone … tells nothing)", () => {
    // "Asleep" is 36 px.
    assert.deepEqual(statusWords(TEXT, 35, six), []);
    assert.deepEqual(statusWords(TEXT, 36, six), ["Asleep", "since…"]);
  });
});
