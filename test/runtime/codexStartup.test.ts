// Codex asks about an available update before it loads a session. A wake the
// mod starts turns that check off on Codex's command line, so the command still
// has to pass the shell check and the check that the agent runs what was typed.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { codexAdapter } from "../../src/adapters/codex.ts";
import type { AgentAdapter } from "../../src/adapters/contract.ts";
import type { AgentId, SessionKey } from "../../src/core/model.ts";
import { commandLine, Engine, newCoordinator } from "../../src/runtime/engine.ts";
import { uuidV7 } from "../adapters/synthetic.ts";
import { fakeAdapter, Sim } from "./sim.ts";

const ID = uuidV7(1_800_000_000_000, "c0dec");
const KEY: SessionKey = `codex:${ID}`;

async function asleepCodex() {
  const sim = new Sim();
  const ports = sim.ports();
  const codex = fakeAdapter("codex");
  // The real adapter's commands, the simulated Herdr's everything else.
  const real: AgentAdapter = { ...codex, resumeArgv: codexAdapter.resumeArgv, newArgv: codexAdapter.newArgv };
  const adapters: Record<AgentId, AgentAdapter> = { claude: fakeAdapter("claude"), codex: real };
  const engine = new Engine({ host: sim, ports, id: "leader", adapters, coordinator: newCoordinator() });
  const term = sim.addTerminal({ agent: "codex", status: "idle" });
  codex.state.sessions.set(term.address, ID);
  await engine.tick();
  await engine.sleep(KEY);
  assert.equal(engine.record(KEY)?.state, "asleep");
  return { sim, engine };
}

describe("a Codex wake with the update check off", () => {
  it("is a command line every shell reads as typed", () => {
    assert.equal(
      commandLine(codexAdapter.resumeArgv(ID, "C:work")),
      `codex -c check_for_update_on_startup=false resume ${ID}`,
    );
  });

  it("is typed into the shell and the agent found running it", async () => {
    const { sim, engine } = await asleepCodex();
    await engine.resume(KEY);
    assert.deepEqual(
      sim.typed.map((x) => x.line),
      [`codex -c check_for_update_on_startup=false resume ${ID}`],
    );
    assert.equal(engine.record(KEY)?.state, "running");
  });

  it("that cannot be typed fails at once with its own reason, not after 30 s of waiting", async () => {
    const { sim, engine } = await asleepCodex();
    sim.sendFails = true;
    const from = sim.now;
    await engine.resume(KEY);
    const rec = engine.record(KEY);
    assert.equal(rec?.error, "reason.notTyped");
    assert.ok(sim.now - from < 30_000, `failed after ${sim.now - from} ms`);
  });
});

describe("the shell check", () => {
  it("still refuses a word a shell would act on, and a word that starts with =", () => {
    assert.equal(commandLine(["codex", "resume", "x&calc"]), null);
    assert.equal(commandLine(["codex", "resume", "a b"]), null);
    assert.equal(commandLine(["codex", "=calc"]), null, "zsh expands =word to a path");
  });
});
