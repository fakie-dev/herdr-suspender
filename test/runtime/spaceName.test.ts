// A space nobody named is called after where its first terminal is, else its
// own folder ("~" at home). Sleep takes the agent's terminal away (park), so a
// space whose only terminal was the agent turned into "~" while it slept
// (measured on Herdr 0.1.15, ADR 14). The mod pins the name at sleep and gives
// it back to Herdr when the space's last sleeping session wakes.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentAdapter } from "../../src/adapters/contract.ts";
import type { AgentId, SessionKey } from "../../src/core/model.ts";
import { Engine, GONE_GRACE_MS, newCoordinator } from "../../src/runtime/engine.ts";
import { fakeAdapter, Sim, SPACE } from "./sim.ts";

const KEY: SessionKey = "claude:s1";

/** One agent alone in its tab and space, in `C:\work\repo`: the space is called "repo". */
function world() {
  const sim = new Sim();
  const ports = sim.ports();
  const claude = fakeAdapter("claude");
  const adapters: Record<AgentId, AgentAdapter> = { claude, codex: fakeAdapter("codex") };
  const engine = new Engine({ host: sim, ports, id: "leader", adapters, coordinator: newCoordinator() });
  const agent = sim.addTerminal({ agent: "claude" });
  claude.state.sessions.set(agent.address, "s1");
  return { sim, ports, claude, adapters, engine, agent };
}

const nameOf = (sim: Sim, space = SPACE) => sim.spaces().find((s) => s.id === space);
const renames = (sim: Sim) => sim.commands.filter((c) => c.command === "space.rename").map((c) => c.args);

/** The space's name each time Herdr could draw: after every app command. */
function namesSeen(sim: Sim): string[] {
  const seen: string[] = [];
  const run = sim.run.bind(sim);
  sim.run = (command, args) => {
    run(command, args);
    seen.push(nameOf(sim)?.name ?? "(none)");
  };
  return seen;
}

describe("a space keeps its name while its session sleeps", () => {
  it("a space nobody named is not called after its folder (~) while its only agent sleeps", async () => {
    const { sim, engine } = world();
    await engine.tick();
    assert.deepEqual(nameOf(sim), { id: SPACE, name: "repo", named: false });
    const seen = namesSeen(sim);

    await engine.sleep(KEY);

    assert.equal(engine.record(KEY)?.state, "asleep");
    assert.deepEqual(nameOf(sim), { id: SPACE, name: "repo", named: true });
    assert.deepEqual(engine.record(KEY)?.spaceName, { space: SPACE, name: "repo" });
    assert.deepEqual(
      seen.filter((n) => n !== "repo"),
      [],
      "the name never shows the space's folder, not even between park and rename",
    );
  });

  it("Resume gives the name back to Herdr, once the woken agent is in the space", async () => {
    const { sim, engine } = world();
    await engine.tick();
    await engine.sleep(KEY);
    const seen = namesSeen(sim);

    await engine.resume(KEY);

    assert.equal(engine.record(KEY)?.state, "running");
    assert.deepEqual(nameOf(sim), { id: SPACE, name: "repo", named: false });
    assert.equal(engine.record(KEY)?.spaceName ?? null, null);
    assert.deepEqual(
      seen.filter((n) => n !== "repo"),
      [],
      "never ~ on the way back",
    );
  });

  it("a space the person named is never renamed, at sleep or at wake", async () => {
    const { sim, engine } = world();
    sim.run("space.rename", { id: SPACE, name: "my work" });
    await engine.tick();
    const before = renames(sim).length;

    await engine.sleep(KEY);
    assert.equal(engine.record(KEY)?.spaceName ?? null, null);
    await engine.resume(KEY);

    assert.equal(renames(sim).length, before);
    assert.deepEqual(nameOf(sim), { id: SPACE, name: "my work", named: true });
  });

  it("a name given while asleep stays after the wake", async () => {
    const { sim, engine } = world();
    await engine.tick();
    await engine.sleep(KEY);
    sim.run("space.rename", { id: SPACE, name: "renamed by hand" });

    await engine.resume(KEY);

    assert.deepEqual(nameOf(sim), { id: SPACE, name: "renamed by hand", named: true });
    assert.equal(engine.record(KEY)?.spaceName ?? null, null, "the pin is let go all the same");
  });

  it("a space given back to Herdr's name while asleep (another mod, the person) is left alone", async () => {
    const { sim, engine } = world();
    await engine.tick();
    await engine.sleep(KEY);
    sim.run("space.rename", { id: SPACE, name: "" });
    const before = renames(sim).length;

    await engine.resume(KEY);

    assert.equal(renames(sim).length, before);
    assert.equal(nameOf(sim)?.named, false);
  });

  it("two sessions in one space: the name holds until the last one wakes, in any order", async () => {
    for (const first of [KEY, "claude:s2"] as const) {
      const { sim, engine, claude } = world();
      const second = sim.addTerminal({ agent: "claude", cwd: "C:\\work\\other" });
      claude.state.sessions.set(second.address, "s2");
      await engine.tick();
      await engine.sleep(KEY);
      await engine.sleep("claude:s2");
      assert.deepEqual(nameOf(sim), { id: SPACE, name: "repo", named: true });

      await engine.resume(first);
      assert.deepEqual(nameOf(sim), { id: SPACE, name: "repo", named: true }, `after ${first} woke`);

      await engine.resume(first === KEY ? "claude:s2" : KEY);
      assert.equal(nameOf(sim)?.named, false, "Herdr names it again once nobody sleeps there");
      assert.deepEqual(
        engine.records().map((r) => r.spaceName ?? null),
        [null, null],
      );
    }
  });

  it("Resume all in project gives the name back once, after the last wake", async () => {
    const { sim, engine, claude } = world();
    const second = sim.addTerminal({ agent: "claude" });
    claude.state.sessions.set(second.address, "s2");
    await engine.tick();
    await engine.sleep(KEY);
    await engine.sleep("claude:s2");

    await engine.resumeAll(SPACE);

    assert.deepEqual(nameOf(sim), { id: SPACE, name: "repo", named: false });
    assert.deepEqual(
      renames(sim).filter((a) => a["name"] === ""),
      [{ id: SPACE, name: "" }],
    );
  });

  it("Forget gives the name back, with the shell that takes the agent's place", async () => {
    const { sim, engine } = world();
    await engine.tick();
    await engine.sleep(KEY);

    await engine.forget(KEY);

    assert.equal(engine.record(KEY), null);
    assert.equal(nameOf(sim)?.named, false);
  });

  it("the pin is kept in the store: a copy started later gives the name back", async () => {
    const { sim, ports, adapters, engine } = world();
    await engine.tick();
    await engine.sleep(KEY);

    const later = new Engine({ host: sim, ports, id: "after-restart", adapters, coordinator: newCoordinator() });
    await later.resume(KEY);

    assert.equal(nameOf(sim)?.named, false);
  });

  it("a wake whose agent Herdr never shows keeps the name pinned: the session still sleeps", async () => {
    const { sim, engine } = world();
    await engine.tick();
    await engine.sleep(KEY);
    sim.adopts = false;

    await engine.resume(KEY);

    assert.equal(engine.record(KEY)?.state, "error");
    assert.deepEqual(nameOf(sim), { id: SPACE, name: "repo", named: true });
    assert.deepEqual(engine.record(KEY)?.spaceName, { space: SPACE, name: "repo" });
  });

  it("a closed space is not renamed: its record goes and nothing is sent", async () => {
    const { sim, engine } = world();
    await engine.tick();
    await engine.sleep(KEY);
    const before = renames(sim).length;

    sim.closeSpace(SPACE);
    await engine.tick();
    await sim.advance(GONE_GRACE_MS);
    await engine.tick();

    assert.equal(engine.record(KEY), null);
    assert.equal(renames(sim).length, before);
  });

  it("a session gone with its pane while another still sleeps hands the name on", async () => {
    const { sim, engine, claude } = world();
    const second = sim.addTerminal({ agent: "claude" });
    claude.state.sessions.set(second.address, "s2");
    await engine.tick();
    await engine.sleep(KEY);
    await engine.sleep("claude:s2");
    const pane = engine.record(KEY)?.pane ?? "";

    sim.removePane(pane); // the person closed the first sleeping pane
    await engine.tick();
    await sim.advance(GONE_GRACE_MS);
    await engine.tick();

    assert.equal(engine.record(KEY), null);
    assert.deepEqual(nameOf(sim), { id: SPACE, name: "repo", named: true }, "the other still sleeps there");
    assert.deepEqual(engine.record("claude:s2")?.spaceName, { space: SPACE, name: "repo" });
    await engine.resume("claude:s2");
    assert.equal(nameOf(sim)?.named, false);
  });
});
