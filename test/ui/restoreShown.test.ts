// What a session in the restore line looks like (engine: restore.test.ts).
// The person: «при запуске пользователь должен это видеть, не должен иметь
// возможность пока идет запуск что-то запустить сам или натыкать». So the
// sleeping tab says where it is in the line and has no buttons, its row says
// "in line" with no Resume, "Resume all" leaves it out, and Sessions says how
// far the line is.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { stripActions, stripStatus } from "../../src/ui/format.ts";
import { groupSessions, shownState } from "../../src/ui/sessionsModel.ts";
import { rec } from "./helpers.ts";

const opts = { now: 0, agentName: "Claude Code", progress: null, fresh: null };

describe("a session waiting in the restore line", () => {
  it("has no buttons on its sleeping tab", () => {
    assert.deepEqual(stripActions(rec("a", "interrupted", { restore: true }), false), []);
    // Without the mark: Resume, as before.
    assert.equal(stripActions(rec("a", "interrupted"), false).length, 1);
  });

  it("says on its tab that it resumes by itself, and where it is in the line", () => {
    const text = stripStatus(rec("a", "interrupted", { restore: true }), { ...opts, line: { place: 2, count: 3 } });
    assert.equal(text, "Resumes after the restart by itself · 2 of 3");
    // Without the mark: interrupted, as before.
    assert.ok(stripStatus(rec("a", "interrupted"), { ...opts, line: null }).startsWith("Interrupted by restart"));
  });

  it("says «in line» in its row, as something pending", () => {
    assert.deepEqual(shownState(rec("a", "interrupted", { restore: true }), false), {
      word: "in line",
      tone: "pending",
      moving: false,
    });
    assert.equal(shownState(rec("a", "interrupted"), false).word, "interrupted");
  });

  it("is left out of Resume all in project", () => {
    const [group] = groupSessions(
      [rec("a", "interrupted", { restore: true }), rec("b", "interrupted"), rec("c", "asleep")],
      [{ id: "sp1", name: "api" }],
    );
    assert.deepEqual(group?.resumable, ["claude:c", "claude:b"]); // in row order: asleep, then interrupted
  });
});
