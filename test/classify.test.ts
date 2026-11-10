import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyTerminal, LABEL_AGENT, LABEL_SESSION, LABEL_STATE } from "../src/core/classify.ts";

const SESSION = "8d65845f-73cb-4be6-aa62-4ab2279d0de0";
const labels = (state: string): Record<string, string> => ({
  [LABEL_AGENT]: "claude",
  [LABEL_SESSION]: SESSION,
  [LABEL_STATE]: state,
});

describe("classifyTerminal", () => {
  it("uses the label names of the interface", () => {
    assert.deepEqual(
      [LABEL_AGENT, LABEL_SESSION, LABEL_STATE],
      ["suspender.agent", "suspender.session", "suspender.state"],
    );
  });

  it("marked running but no agent process: interrupted (a restart took it)", () => {
    assert.deepEqual(classifyTerminal({ labels: labels("running") }, false), {
      kind: "interrupted",
      agent: "claude",
      sessionId: SESSION,
      key: `claude:${SESSION}`,
    });
  });

  it("marked running and the agent is there: running", () => {
    assert.deepEqual(classifyTerminal({ labels: labels("running") }, true), {
      kind: "running",
      agent: "claude",
      sessionId: SESSION,
      key: `claude:${SESSION}`,
    });
  });

  it("marked exited (the person left the agent): left alone, whatever runs there now", () => {
    assert.equal(classifyTerminal({ labels: labels("exited") }, false).kind, "exited");
    assert.equal(classifyTerminal({ labels: labels("exited") }, true).kind, "exited");
  });

  it("without our labels: not ours", () => {
    assert.deepEqual(classifyTerminal({ labels: {} }, false), { kind: "foreign" });
    assert.deepEqual(classifyTerminal({ labels: { "other.mod": "x" } }, true), { kind: "foreign" });
  });

  it("with half our labels or values it does not know: not ours, so nothing is offered or started", () => {
    assert.equal(classifyTerminal({ labels: { [LABEL_STATE]: "running" } }, false).kind, "foreign");
    assert.equal(classifyTerminal({ labels: { ...labels("running"), [LABEL_AGENT]: "aider" } }, false).kind, "foreign");
    assert.equal(classifyTerminal({ labels: { ...labels("running"), [LABEL_SESSION]: "" } }, false).kind, "foreign");
    assert.equal(classifyTerminal({ labels: labels("sleeping") }, false).kind, "foreign");
  });
});
