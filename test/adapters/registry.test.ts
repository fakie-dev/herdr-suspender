import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ADAPTERS, adapterFor, detectAgent } from "../../src/adapters/index.ts";
import { AGENT_IDS } from "../../src/core/model.ts";
import { terminal } from "./synthetic.ts";

describe("adapter registry", () => {
  it("has one adapter per agent id, each under its own id", () => {
    assert.deepEqual(Object.keys(ADAPTERS).sort(), [...AGENT_IDS].sort());
    for (const id of AGENT_IDS) {
      assert.equal(adapterFor(id).id, id);
    }
  });

  it("detects the agent a terminal runs, or none", () => {
    assert.equal(detectAgent(terminal({ app: "claude-code" }))?.id, "claude");
    assert.equal(detectAgent(terminal({ app: "codex" }))?.id, "codex");
    assert.equal(detectAgent(terminal({ foreground: { pid: 1, argv: ["pwsh.exe"], name: "pwsh.exe" } })), null);
  });
});
