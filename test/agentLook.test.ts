// Where an agent's icon comes from: Herdr's program table, read with
// knownAgents() once per load (it runs a check process), and a live pane's
// program while the table is not known. Fakes stand in for both; the
// programs have the shape knownAgents() resolved with on Herdr 0.1.15.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AgentLooks, LOOK_RETRY_MS, lookOf } from "../src/core/agentLook.ts";

const program = (key: string, icon: string | null, tint = false): Record<string, unknown> => ({
  key,
  name: key,
  icon,
  tint,
  tile: "#1c1d21",
  color: "#ffffff",
  shell: false,
  agent: true,
});
const CLAUDE = { ...program("claude", "icons/claude.svg"), run: ["claude"], installed: true };
const CODEX = { ...program("codex", "icons/codex.svg"), run: ["codex", "--no-daemon"], installed: true };
const PI = { ...program("pi", "icons/pi.svg", true), run: ["pi"], installed: false };

/** knownAgents() answered by hand: each call waits until the test settles it. */
function controlled() {
  const calls: { resolve: (v: unknown) => void; reject: (e: unknown) => void }[] = [];
  let live: unknown[] = [];
  const looks = new AgentLooks({
    known: () => new Promise((resolve, reject) => calls.push({ resolve, reject })),
    live: () => live,
  });
  return {
    looks,
    calls,
    setLive: (programs: unknown[]) => {
      live = programs;
    },
  };
}

describe("lookOf: a Program's icon", () => {
  it("takes the icon and whether it is a one-colour glyph", () => {
    assert.deepEqual(lookOf(CLAUDE), { icon: "icons/claude.svg", tint: false });
    assert.deepEqual(lookOf(PI), { icon: "icons/pi.svg", tint: true });
  });

  it("is null without an icon, or for anything that is not a Program", () => {
    assert.equal(lookOf(program("claude", null)), null);
    assert.equal(lookOf(program("claude", "")), null);
    assert.equal(lookOf({ key: "claude", icon: 7, tint: false }), null);
    assert.equal(lookOf(null), null);
    assert.equal(lookOf("icons/claude.svg"), null);
  });

  it("reads only a tint that is true as a glyph", () => {
    assert.equal(lookOf({ ...program("claude", "icons/claude.svg"), tint: "yes" })?.tint, false);
  });
});

describe("AgentLooks: the program table, asked once", () => {
  it("knows nothing before the table answers", () => {
    const { looks } = controlled();
    assert.equal(looks.look("claude"), null);
  });

  it("gives each agent its own row of the table, a sleeping one included (no pane needed)", async () => {
    const { looks, calls } = controlled();
    const done = looks.start(0);
    assert.ok(done !== null, "a lookup starts");
    calls[0]?.resolve([PI, CLAUDE, CODEX]);
    assert.equal(await done, true, "it says what it knows changed");
    assert.deepEqual(looks.look("claude"), { icon: "icons/claude.svg", tint: false });
    assert.deepEqual(looks.look("codex"), { icon: "icons/codex.svg", tint: false });
  });

  it("asks Herdr once: not again while one is under way, nor after it answered", async () => {
    const { looks, calls } = controlled();
    const first = looks.start(0);
    assert.equal(looks.start(10), null, "one under way");
    calls[0]?.resolve([CLAUDE]);
    await first;
    assert.equal(looks.start(10 * LOOK_RETRY_MS), null, "answered");
    assert.equal(calls.length, 1);
  });

  it("after a failure asks again only a minute later, and draws the letter meanwhile", async () => {
    const { looks, calls } = controlled();
    const first = looks.start(1000);
    calls[0]?.reject(new Error("the check failed"));
    assert.equal(await first, false);
    assert.equal(looks.look("claude"), null);
    assert.equal(looks.start(1000 + LOOK_RETRY_MS - 1), null, "not within the minute");
    const again = looks.start(1000 + LOOK_RETRY_MS);
    assert.ok(again !== null, "asked again after it");
    calls[1]?.resolve([CLAUDE]);
    assert.equal(await again, true);
    assert.equal(looks.look("claude")?.icon, "icons/claude.svg");
  });

  it("takes a knownAgents that throws at once as a failure", async () => {
    const looks = new AgentLooks({
      known: () => {
        throw new Error("not here");
      },
      live: () => [],
    });
    const done = looks.start(0);
    assert.ok(done !== null);
    assert.equal(await done, false);
    assert.equal(looks.look("claude"), null);
    assert.equal(looks.start(1), null, "a minute's wait after it too");
  });

  it("takes an answer that is not a list as a failure, a string included", async () => {
    for (const odd of [{ claude: CLAUDE }, "claude"]) {
      const { looks, calls } = controlled();
      const done = looks.start(0);
      calls[0]?.resolve(odd);
      assert.equal(await done, false, JSON.stringify(odd));
      assert.equal(looks.look("claude"), null);
      assert.ok(looks.start(LOOK_RETRY_MS) !== null, "asked again later");
    }
  });

  it("an agent the table has no icon for, or does not list, has none", async () => {
    const { looks, calls } = controlled();
    const done = looks.start(0);
    calls[0]?.resolve([program("claude", null), PI]);
    await done;
    assert.equal(looks.look("claude"), null, "no icon");
    assert.equal(looks.look("codex"), null, "not listed");
  });
});

describe("AgentLooks: a live pane's program while the table is not known", () => {
  it("takes the icon of a pane running that agent", () => {
    const { looks, setLive } = controlled();
    setLive([program("shell", "icons/shell.svg", true), program("codex", "icons/codex.svg")]);
    assert.deepEqual(looks.look("codex"), { icon: "icons/codex.svg", tint: false });
    assert.equal(looks.look("claude"), null, "no pane runs Claude Code");
  });

  it("skips panes without a program or an icon", () => {
    const { looks, setLive } = controlled();
    setLive([undefined, program("claude", null), program("claude", "icons/claude.svg")]);
    assert.equal(looks.look("claude")?.icon, "icons/claude.svg");
  });

  it("the table wins once it answered", async () => {
    const { looks, calls, setLive } = controlled();
    setLive([program("claude", "my-icons/old.svg", true)]);
    const done = looks.start(0);
    calls[0]?.resolve([CLAUDE]);
    await done;
    assert.deepEqual(looks.look("claude"), { icon: "icons/claude.svg", tint: false });
  });
});
