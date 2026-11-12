// The leader's round goes over every terminal and every record. One that
// throws or hangs (a store conflict, an `hc` call that fails or never
// answers) must not keep the others from being looked at: before, one bad
// terminal stopped reconcile for every record in every round. A copy never
// runs two rounds at once. A sleeping record follows its pane: a tab moved to
// another space (a mod that groups spaces) takes its sleeping session along.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentAdapter } from "../../src/adapters/contract.ts";
import type { AgentId, SessionKey } from "../../src/core/model.ts";
import { defaultStorePath } from "../../src/core/store.ts";
import { Engine, GONE_GRACE_MS, newCoordinator } from "../../src/runtime/engine.ts";
import { fakeAdapter, Sim, SPACE } from "./sim.ts";

const KEY: SessionKey = "claude:s1";

function world() {
  const sim = new Sim();
  const ports = sim.ports();
  const claude = fakeAdapter("claude");
  const codex = fakeAdapter("codex");
  const adapters: Record<AgentId, AgentAdapter> = { claude, codex };
  const engine = new Engine({ host: sim, ports, id: "leader", adapters, coordinator: newCoordinator() });
  const agent = sim.addTerminal({ agent: "claude" });
  claude.state.sessions.set(agent.address, "s1");
  return { sim, ports, claude, codex, engine, agent };
}

async function ticks(w: ReturnType<typeof world>, ms: number): Promise<void> {
  const end = w.sim.now + ms;
  while (w.sim.now < end) {
    await w.engine.tick();
    await w.sim.advance(5_000);
  }
}

describe("one terminal that fails does not stop the round", () => {
  it("a terminal whose look throws every round: the others' records are still reconciled", async () => {
    const w = world();
    await w.engine.tick();
    await w.engine.sleep(KEY);
    const pane = w.engine.record(KEY)?.pane ?? "";
    // A Codex terminal whose labelling fails (an `hc` that rejects) on every look.
    const bad = w.sim.addTerminal({ agent: "codex" });
    w.codex.state.sessions.set(bad.address, "c1");
    const hc = w.sim.hc.bind(w.sim);
    w.sim.hc = async (args) => {
      if (args[0] === "label" && args[1] === bad.address) {
        throw new Error("hc: connection reset");
      }
      return hc(args);
    };
    w.sim.removePane(pane); // the person closed the sleeping pane: its record must go

    await ticks(w, GONE_GRACE_MS + 10_000);

    assert.equal(w.engine.record(KEY), null, "reconcile ran in spite of the failing terminal");
    const told = w.sim.notices.filter((n) => /connection reset/.test(n.text));
    assert.equal(told.length, 1, "the failure is told once, not every round");
  });

  it("a terminal whose look never answers: the round goes on without it", { timeout: 10_000 }, async () => {
    const w = world();
    await w.engine.tick();
    await w.engine.sleep(KEY);
    const pane = w.engine.record(KEY)?.pane ?? "";
    const stuck = w.sim.addTerminal({ agent: "codex" });
    w.codex.discoverSession = async (t) => {
      if (t.address === stuck.address) {
        return new Promise<string | null>(() => undefined);
      }
      return null;
    };
    w.sim.removePane(pane);

    // Each round waits for the stuck look only up to its time limit, then goes on.
    for (let i = 0; i < 4; i++) {
      await w.engine.tick();
      await w.sim.advance(5_000);
    }

    assert.equal(w.engine.record(KEY), null);
    assert.equal(w.sim.notices.length, 1, "told once that a terminal did not answer");
  });

  it("a record whose check throws: the records after it are still checked", async () => {
    const w = world();
    await w.engine.tick();
    await w.engine.sleep(KEY);
    const other = w.sim.addTerminal({ agent: "claude" });
    w.claude.state.sessions.set(other.address, "s2");
    await w.engine.tick();
    await w.engine.sleep("claude:s2");
    const pane2 = w.engine.record("claude:s2")?.pane ?? "";
    // s1 was being woken by a copy that is gone (a stale flow); ending it fails (its toast throws).
    const file = JSON.parse(w.ports.files.get(defaultStorePath(w.ports)) ?? "{}");
    file.sessions[KEY].state = "waking";
    w.ports.files.set(defaultStorePath(w.ports), JSON.stringify(file));
    w.sim.setShared("suspender.rev", "edited"); // another window wrote the store
    const notify = w.sim.notify.bind(w.sim);
    w.sim.notify = (text, level) => {
      if (/start Claude Code/.test(text)) {
        throw new Error("toast failed");
      }
      notify(text, level);
    };
    w.sim.removePane(pane2); // s2's pane closed: its record must go

    await ticks(w, 90_000);

    assert.equal(w.engine.record("claude:s2"), null);
  });

  it("a copy never runs two rounds at once", { timeout: 10_000 }, async () => {
    const w = world();
    // The first terminal's look waits; a second terminal is looked at after it in a round.
    const second = w.sim.addTerminal({ agent: "codex" });
    let release: () => void = () => undefined;
    w.claude.discoverSession = async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return "s1";
    };
    let secondLooks = 0;
    w.codex.discoverSession = async (t) => {
      if (t.address === second.address) {
        secondLooks++;
      }
      return null;
    };
    const first = w.engine.tick();
    await Promise.resolve();
    await w.engine.tick(); // the timer fires again while the first round waits
    assert.equal(secondLooks, 0, "no second round ran beside the first");
    release();
    await first;
    assert.equal(secondLooks, 1);
  });
});

describe("a sleeping session follows its pane", () => {
  it("a tab moved to another space takes its sleeping session along: its group, Resume all", async () => {
    const w = world();
    await w.engine.tick();
    await w.engine.sleep(KEY);
    assert.equal(w.engine.record(KEY)?.spaceId, SPACE);
    // A mod that groups spaces moves the tab (its pane, the sleeping one, goes with it).
    w.sim.addTab("tb-other", "sp2");
    const tab = w.sim.tabList.find((t) => t.id === w.engine.record(KEY)?.tabId);
    assert.ok(tab);
    tab.space = "sp2";

    await w.engine.tick();

    assert.equal(w.engine.record(KEY)?.spaceId, "sp2");
    const { woken } = await w.engine.resumeAll("sp2");
    assert.deepEqual(woken, [KEY]);
  });

  it("a sleeping pane moved to another tab takes its record's tab along", async () => {
    const w = world();
    await w.engine.tick();
    await w.engine.sleep(KEY);
    w.sim.addTab("tb3", "sp3");
    const pane = w.sim.pane(w.engine.record(KEY)?.pane ?? "");
    assert.ok(pane);
    pane.tab = "tb3";

    await w.engine.tick();

    assert.deepEqual([w.engine.record(KEY)?.spaceId, w.engine.record(KEY)?.tabId], ["sp3", "tb3"]);
  });
});

describe("a running record whose terminal is gone, with no terminal left at all", () => {
  it("goes after the same grace as any other, instead of staying running (or checking) for good", async () => {
    const w = world();
    await w.engine.tick();
    w.sim.terms.clear();
    w.sim.paneList = [];
    await ticks(w, GONE_GRACE_MS + 10_000);
    assert.equal(w.engine.record(KEY), null);
  });
});
