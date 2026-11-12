// A session's folder is its own, from the agent's own files (Claude Code's
// pid file, Codex's session_meta), never the folder its terminal's shell
// reported: `cd Y; claude` on one line runs the agent in Y while the shell
// still says X (seen live: the record said home). Resume starts in it.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { claudeAdapter } from "../../src/adapters/claude.ts";
import { codexAdapter } from "../../src/adapters/codex.ts";
import type { AgentAdapter } from "../../src/adapters/contract.ts";
import type { AgentId, SessionKey } from "../../src/core/model.ts";
import { Engine, newCoordinator } from "../../src/runtime/engine.ts";
import { claudePidFile, codex, jsonl, uuidV7 } from "../adapters/synthetic.ts";
import { fakePorts } from "../fakePorts.ts";
import { fakeAdapter, Sim } from "./sim.ts";

const KEY: SessionKey = "claude:s1";
const Y = "C:\\work\\y";

describe("a session's own folder", () => {
  it("is the record's folder, not the one its shell reported, and Resume starts there", async () => {
    const sim = new Sim();
    const ports = sim.ports();
    const claude = fakeAdapter("claude");
    const adapters: Record<AgentId, AgentAdapter> = { claude, codex: fakeAdapter("codex") };
    const engine = new Engine({ host: sim, ports, id: "leader", adapters, coordinator: newCoordinator() });
    // The shell still says C:\work\repo; the agent was started after a `cd` in the same line.
    const agent = sim.addTerminal({ agent: "claude", cwd: "C:\\work\\repo" });
    claude.state.sessions.set(agent.address, "s1");
    claude.state.folders.set("s1", Y);

    await engine.tick();
    assert.equal(engine.record(KEY)?.cwd, Y);
    assert.equal(engine.record(KEY)?.info.cwd, Y);

    await engine.sleep(KEY);
    await engine.resume(KEY);
    const run = sim.hcCalls.find((c) => c[0] === "run");
    assert.equal(run?.[run.indexOf("--cwd") + 1], Y);
  });

  it("follows the session when the terminal moves to another one (/resume of a session from elsewhere)", async () => {
    const sim = new Sim();
    const ports = sim.ports();
    const claude = fakeAdapter("claude");
    const engine = new Engine({
      host: sim,
      ports,
      id: "leader",
      adapters: { claude, codex: fakeAdapter("codex") },
      coordinator: newCoordinator(),
    });
    const agent = sim.addTerminal({ agent: "claude", status: "working" });
    claude.state.sessions.set(agent.address, "s1");
    await engine.tick();
    claude.state.sessions.set(agent.address, "s9");
    claude.state.folders.set("s9", Y);
    sim.setStatus(agent.address, "idle");
    await engine.tick();
    assert.equal(engine.record("claude:s9")?.cwd, Y);
  });
});

describe("the adapters say a session's folder from its own files", () => {
  it("Claude Code: from its pid file", async () => {
    const p = fakePorts();
    const id = "11111111-2222-4333-8444-555555555555";
    p.files.set(
      "/home/tester/.claude/sessions/4242.json",
      claudePidFile({ pid: 4242, sessionId: id, cwd: "/home/tester/dev/y", startedAt: 1 }),
    );
    assert.equal(await claudeAdapter.sessionCwd(id, p), "/home/tester/dev/y");
    assert.equal(await claudeAdapter.sessionCwd("99999999-2222-4333-8444-555555555555", p), null);
  });

  it("Codex: from the session_meta of its rollout", async () => {
    const p = fakePorts({ now: 1_800_000_000_000 });
    const born = 1_800_000_000_000 - 60_000;
    const id = uuidV7(born, "f0");
    const d = new Date(born);
    const pad = (n: number): string => String(n).padStart(2, "0");
    const day = `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
    p.files.set(
      `/home/tester/.codex/sessions/${day}/rollout-2027-01-15T08-00-00-${id}.jsonl`,
      jsonl(codex.meta(id, "/home/tester/dev/y", d.toISOString())),
    );
    assert.equal(await codexAdapter.sessionCwd(id, p), "/home/tester/dev/y");
  });
});
