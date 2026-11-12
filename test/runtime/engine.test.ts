import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentAdapter } from "../../src/adapters/contract.ts";
import type { AgentId, SessionKey, SessionRecord } from "../../src/core/model.ts";
import { defaultStorePath, parseStore } from "../../src/core/store.ts";
import { Engine, LEADER_KEY, newCoordinator, subtree } from "../../src/runtime/engine.ts";
import { type FakePorts, fakePorts } from "../fakePorts.ts";
import { fakeAdapter, SHELL_ARGV, Sim, SPACE, TAB } from "./sim.ts";

const KEY: SessionKey = "claude:s1";

function world(opts: { status?: string; direct?: boolean } = {}) {
  const sim = new Sim();
  const ports = sim.ports();
  const claude = fakeAdapter("claude");
  const codex = fakeAdapter("codex");
  const adapters: Record<AgentId, AgentAdapter> = { claude, codex };
  const engine = new Engine({ host: sim, ports, id: "copy-a", adapters, coordinator: newCoordinator() });
  const agent = sim.addTerminal({
    agent: "claude",
    status: opts.status ?? "idle",
    ...(opts.direct ? { direct: true } : {}),
  });
  claude.state.sessions.set(agent.address, "s1");
  return { sim, ports, engine, claude, codex, adapters, agent };
}

function stored(ports: FakePorts): Record<string, SessionRecord> {
  return parseStore(ports.files.get(defaultStorePath(ports)) ?? null).sessions;
}

const hcOf = (sim: Sim, sub: string): string[][] => sim.hcCalls.filter((c) => c[0] === sub);
const commandsOf = (sim: Sim, name: string) => sim.commands.filter((c) => c.command === name);

/** An asleep session in its own sleep pane, as the store and the layout keep it after a sleep. */
async function asleep(opts: { status?: string } = {}) {
  const w = world(opts);
  await w.engine.tick();
  await w.engine.sleep(KEY);
  assert.equal(w.engine.record(KEY)?.state, "asleep");
  return w;
}

describe("binding", () => {
  it("labels an agent's terminal and records its session, also for agents started before the mod", async () => {
    const { sim, ports, engine, agent } = world();
    const shell = sim.addTerminal({ agent: null });
    await engine.tick();

    const t = sim.term(agent.address);
    assert.equal(t.labels["suspender.agent"], "claude");
    assert.equal(t.labels["suspender.session"], "s1");
    assert.equal(t.labels["suspender.state"], "running");
    assert.equal(t.labels["suspender.pid"], String(t.pid));
    assert.deepEqual(sim.term(shell.address).labels["suspender.agent"], undefined);

    const rec = stored(ports)[KEY];
    assert.ok(rec, "a record in sessions.json");
    assert.equal(rec.state, "running");
    assert.equal(rec.terminal, agent.address);
    assert.equal(rec.spaceId, SPACE);
    assert.equal(rec.tabId, TAB);
    assert.equal(rec.cwd, "C:\\work\\repo");
  });

  it("does nothing at all once everything is bound and nothing changes", async () => {
    const { sim, ports, engine } = world();
    await engine.tick();
    const hcBefore = sim.hcCalls.length;
    const writesBefore = ports.writes.length;
    await sim.advance(5_000);
    await engine.tick();
    await sim.advance(5_000);
    await engine.tick();
    assert.equal(sim.hcCalls.length, hcBefore);
    assert.equal(ports.execCalls.length, 0);
    assert.equal(ports.writes.length, writesBefore);
  });

  it("a session opened again in a new tab after its tab was closed is found in the new tab", async () => {
    const { sim, engine, claude, agent } = world();
    await engine.tick();
    // The agent hung, the person closed its tab and resumed the same conversation in a new one.
    sim.terms.delete(agent.address);
    sim.removePane(agent.pane);
    sim.addTab("tb2");
    const again = sim.addTerminal({ agent: "claude", tab: "tb2" });
    claude.state.sessions.set(again.address, "s1");
    await engine.tick();
    assert.equal(engine.record(KEY)?.tabId, "tb2", "right from the look that finds it there");
    await sim.advance(60_000);
    await engine.tick();

    const rec = engine.record(KEY);
    assert.equal(rec?.terminal, again.address);
    assert.equal(rec?.tabId, "tb2", "the Sessions row opens the tab the session is in now");
  });

  it("a terminal moved to another tab or space takes its session along", async () => {
    const { sim, engine, agent } = world();
    await engine.tick();
    sim.addTab("tb3", "sp3");
    const t = sim.term(agent.address);
    t.labels["herdr.tab"] = "tb3";
    t.labels["herdr.space"] = "sp3";
    await engine.tick();

    const rec = engine.record(KEY);
    assert.equal(rec?.tabId, "tb3");
    assert.equal(rec?.spaceId, "sp3");
  });
});

describe("going to sleep", () => {
  it("an idle agent: graceful stop, and our pane takes the terminal's slot", async () => {
    const { sim, ports, engine, claude, agent } = world();
    // Neighbours before and after it in the same row: only then does a missing swap show.
    sim.addTerminal({ agent: null, first: true });
    sim.addTerminal({ agent: null });
    await engine.tick();
    const rowBefore = sim.row();
    const slot = rowBefore.indexOf(agent.pane);
    const layoutBefore = sim.layout();

    await engine.sleep(KEY);

    const rec = stored(ports)[KEY];
    assert.ok(rec);
    assert.equal(rec.state, "asleep");
    assert.equal(rec.terminal, null);
    assert.ok(rec.pane);
    assert.equal(rec.lastScreen, `screen of ${agent.address}`);
    assert.equal(rec.info.title, "title of s1");
    assert.equal(rec.forced, false);
    assert.ok(rec.sleptAtMs);
    // Before the stop, and once more after it (only what the exit added).
    assert.deepEqual(claude.state.snapshots, ["s1", "s1"]);

    // Same slot of the same size, every neighbour as it was; the terminal and its process are gone.
    const row = sim.row();
    assert.equal(row.length, rowBefore.length);
    assert.equal(row.indexOf(rec.pane), slot);
    assert.deepEqual(
      sim.layout().map((p) => p.size),
      layoutBefore.map((p) => p.size),
    );
    assert.deepEqual(sim.pane(rec.pane)?.props, { role: "sleep", key: KEY });
    assert.equal(sim.terms.has(agent.address), false, "the finished terminal is removed (hc rm)");

    // Claude's steps: Esc, Ctrl+C (empties the prompt), then /exit typed as keys (`hc send` would
    // wrap it in an <hc from=…> tag when Herdr runs inside a terminal, and the agent would read a
    // message). The agent is never killed: the one kill ends the shell it left, out of sight (ADR 9).
    assert.deepEqual(hcOf(sim, "keys")[0], ["keys", agent.address, "esc"]);
    assert.deepEqual(hcOf(sim, "keys")[1], ["keys", agent.address, "ctrl+c"]);
    assert.deepEqual(hcOf(sim, "keys")[2], ["keys", agent.address, "/", "e", "x", "i", "t", "enter"]);
    assert.equal(hcOf(sim, "send").length, 0);
    assert.deepEqual(sim.killed, [{ address: agent.address, agent: false }]);
  });

  it("a process listing that never answers (memory freed) holds up the stop no longer than its wait", async () => {
    const { sim, ports, engine } = world();
    await engine.tick();
    // PowerShell and tasklist took 7–8 s each on a busy machine: here they answer only when released.
    // The stop waits for the figure MEMORY_WAIT_MS at most (memoryFreed.test.ts), then goes on without it.
    let release: () => void = () => undefined;
    const listed = new Promise<void>((resolve) => {
      release = resolve;
    });
    ports.exec = async () => {
      await listed;
      return { code: 1, stdout: "", stderr: "" };
    };
    const sleeping = engine.sleep(KEY);
    for (let i = 0; i < 200 && !hcOf(sim, "keys").some((c) => c.includes("enter")); i++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.ok(
      hcOf(sim, "keys").some((c) => c.includes("enter")),
      "the stop keys go out while the process list is still being taken",
    );
    release();
    await sleeping;
    assert.equal(engine.record(KEY)?.state, "asleep");
  });

  it("an agent that is the terminal's own program keeps its slot too (its pane closes when it exits)", async () => {
    const { sim, engine, agent } = world({ direct: true });
    sim.addTerminal({ agent: null, first: true });
    sim.addTerminal({ agent: null });
    await engine.tick();
    const slot = sim.row().indexOf(agent.pane);
    const sizes = sim.layout().map((p) => p.size);
    await engine.sleep(KEY);
    const rec = engine.record(KEY);
    assert.equal(rec?.state, "asleep");
    assert.equal(sim.row().indexOf(rec?.pane ?? ""), slot);
    assert.deepEqual(
      sim.layout().map((p) => p.size),
      sizes,
    );
  });

  it("an agent that does not exit within 10 s is killed, and the strip says so", async () => {
    const { sim, engine, agent } = world();
    sim.exitsOnStop = false;
    await engine.tick();
    const slot = sim.row().indexOf(agent.pane);
    const started = sim.now;
    await engine.sleep(KEY);
    const rec = engine.record(KEY);
    assert.equal(rec?.state, "asleep");
    assert.equal(rec?.forced, true);
    assert.deepEqual(commandsOf(sim, "terminal.kill")[0]?.args, { terminal: agent.address });
    assert.ok(sim.now - started >= 10_000, "it waited the 10 s first");
    assert.equal(sim.row().indexOf(rec?.pane ?? ""), slot);
  });

  it("a working agent is asked first; Cancel stops nothing, even when it goes idle later", async () => {
    const { sim, engine, agent } = world({ status: "working" });
    await engine.tick();
    await engine.sleep(KEY);
    assert.equal(engine.record(KEY)?.state, "confirming");
    assert.deepEqual(sim.confirms, [KEY]);
    assert.equal(hcOf(sim, "keys").length, 0);

    await engine.choose(KEY, "cancel");
    sim.setStatus(agent.address, "idle");
    await engine.tick();
    assert.equal(engine.record(KEY)?.state, "running");
    assert.equal(hcOf(sim, "keys").length, 0);
  });

  it("the question's answer is carried out by the copy that asked, not by the dialog (which closes)", async () => {
    const { sim, engine } = world({ status: "working" });
    await engine.tick();
    sim.onConfirm = (key) => engine.answer(key, "interruptAndSleep");
    await engine.sleep(KEY);
    assert.equal(engine.record(KEY)?.state, "asleep");
  });

  it("an answer nobody waits for any more is carried out by the leader", async () => {
    const { sim, engine } = world({ status: "working" });
    await engine.tick();
    await engine.sleep(KEY);
    assert.equal(engine.record(KEY)?.state, "confirming");
    engine.answer(KEY, "interruptAndSleep");
    await engine.tick();
    assert.equal(engine.record(KEY)?.state, "asleep");
    assert.ok(hcOf(sim, "keys").some((c) => c.includes("esc")));
  });

  it("Sleep again while the question went unanswered asks again", async () => {
    const { sim, engine } = world({ status: "working" });
    await engine.tick();
    await engine.sleep(KEY);
    await engine.sleep(KEY);
    assert.deepEqual(sim.confirms, [KEY, KEY]);
    assert.equal(engine.record(KEY)?.state, "confirming");
  });

  it("a working agent left unanswered is not put to sleep when it goes idle", async () => {
    const { sim, engine, agent } = world({ status: "working" });
    await engine.tick();
    await engine.sleep(KEY);
    sim.setStatus(agent.address, "idle");
    await engine.tick();
    assert.equal(engine.record(KEY)?.state, "confirming");
    assert.equal(hcOf(sim, "keys").length, 0);
  });

  it("sleep when done: waits while it works, sleeps once it is idle", async () => {
    const { sim, engine, agent } = world({ status: "working" });
    await engine.tick();
    await engine.sleep(KEY);
    await engine.choose(KEY, "sleepWhenDone");
    await engine.tick();
    assert.equal(engine.record(KEY)?.state, "confirming");
    assert.equal(hcOf(sim, "keys").length, 0);

    sim.setStatus(agent.address, "idle");
    await engine.tick();
    assert.equal(engine.record(KEY)?.state, "asleep");
  });

  it("interrupt and sleep: Esc, then exit, at once", async () => {
    const { sim, engine } = world({ status: "working" });
    await engine.tick();
    await engine.sleep(KEY);
    await engine.choose(KEY, "interruptAndSleep");
    assert.equal(engine.record(KEY)?.state, "asleep");
    assert.deepEqual(hcOf(sim, "keys")[0]?.slice(2), ["esc"]);
  });
});

describe("waking up", () => {
  it("resume: the agent's resume command in the session's folder, checked, then in the pane's slot", async () => {
    const { sim, ports, engine } = await asleep();
    sim.addTerminal({ agent: null, first: true });
    sim.addTerminal({ agent: null });
    const before = engine.record(KEY);
    const pane = before?.pane ?? "";
    const slot = sim.row().indexOf(pane);
    const count = sim.row().length;
    const sizes = sim.layout().map((p) => p.size);
    const steps: (string | null)[] = [];
    sim.onShared = () => {
      const step = engine.progress(KEY);
      if (steps.at(-1) !== step) {
        steps.push(step);
      }
    };

    const listedBefore = sim.execCalls.length;
    await engine.resume(KEY);

    // Herdr's default shell in the session's folder, as a new tab gets (no command of its own)…
    const run = hcOf(sim, "run")[0] ?? [];
    assert.equal(run.includes("--"), false, "no program: the machine's own shell");
    assert.equal(run[run.indexOf("--cwd") + 1], "C:\\work\\repo");
    // Out of Herdr's screens until the agent runs (finding 4 of the blind review): no tab labels yet…
    assert.ok(!run.some((a) => a.startsWith("herdr.")), "no herdr.tab / herdr.space at the start");
    const address = engine.record(KEY)?.terminal ?? "";
    assert.ok(
      hcOf(sim, "label").some((c) => c[1] === address && c.includes("herdr.tab=tb1") && c.includes("herdr.space=sp1")),
      "the tab's labels once the agent runs",
    );
    assert.deepEqual(sim.term(address).argv, SHELL_ARGV);
    // …the resume command typed into it, and the agent found running under it.
    assert.deepEqual(sim.typed, [{ address, line: "claude --resume s1", shown: false }]);
    assert.equal(sim.term(address).ran, "claude --resume s1");
    assert.ok(
      hcOf(sim, "get").some((c) => c[1] === address),
      "the started shell is checked with hc get",
    );
    assert.equal(
      sim.execCalls.slice(listedBefore).filter((c) => /powershell/i.test(c.cmd)).length,
      1,
      "one process snapshot",
    );

    const rec = stored(ports)[KEY];
    assert.equal(rec?.state, "running");
    assert.equal(rec?.pane, null);
    assert.equal(sim.pane(pane), undefined, "the sleep pane is closed");
    const newPane = sim.paneList.find((p) => p.terminal === address)?.pane ?? "";
    assert.equal(sim.row().indexOf(newPane), slot);
    assert.equal(sim.row().length, count);
    assert.deepEqual(
      sim.layout().map((p) => p.size),
      sizes,
    );
    assert.equal(sim.term(address).labels["suspender.session"], "s1");
    assert.deepEqual(
      steps.filter((s) => s !== null),
      ["found", "starting", "ready"],
    );
  });

  it("after /exit in a woken agent the tab keeps its shell, and the session is let go", async () => {
    const { sim, engine } = await asleep();
    await engine.resume(KEY);
    const address = engine.record(KEY)?.terminal ?? "";
    await sim.hc(["keys", address, "/", "e", "x", "i", "t", "enter"]);
    await sim.advance(1_000);
    await engine.tick();
    await sim.advance(3_000);
    await engine.tick();
    assert.equal(sim.term(address).state, "live", "the shell stays");
    assert.ok(
      sim.paneList.some((p) => p.terminal === address),
      "and so does its pane",
    );
    assert.equal(engine.record(KEY), null);
    assert.equal(sim.term(address).labels["suspender.state"], "exited");
  });

  it("an agent silent at its own prompt (Codex's update question) is up, not failed", async () => {
    const { sim, engine } = await asleep();
    sim.reportAfterMs = null;
    await engine.resume(KEY);
    const rec = engine.record(KEY);
    assert.equal(rec?.state, "running");
    assert.equal(sim.term(rec?.terminal ?? "").state, "live", "not killed");
    // And the leader does not take the silent agent for one the person left.
    await engine.tick();
    await sim.advance(5_000);
    await engine.tick();
    assert.equal(engine.record(KEY)?.state, "running");
  });

  it("a started agent Herdr never shows fails with its reason, keeps the pane, and does not retry", async () => {
    const { sim, engine } = await asleep();
    sim.adopts = false;
    const pane = engine.record(KEY)?.pane ?? "";
    const count = sim.row().length;
    await engine.resume(KEY);
    const rec = engine.record(KEY);
    assert.equal(rec?.state, "error");
    assert.equal(rec?.error, "reason.noPane");
    assert.equal(rec?.pane, pane);
    assert.equal(sim.row().length, count, "the terminal that did not start is gone again");
    const notice = sim.notices.at(-1)?.text ?? "";
    assert.match(notice, /Claude Code/);
    assert.doesNotMatch(notice, /\{(reason|agent)\}/);

    await sim.advance(120_000);
    await engine.tick();
    assert.equal(hcOf(sim, "run").length, 1, "no automatic retry");
  });

  it("an agent that runs another session than the one typed is not taken for it", async () => {
    const { sim, engine } = await asleep();
    sim.shellRewrites = (line) => line.replace("s1", "s7");
    await engine.resume(KEY);
    assert.equal(engine.record(KEY)?.state, "error");
  });

  it("a typed command that starts no agent fails after 30 s with its reason and keeps the pane", async () => {
    const { sim, engine } = await asleep();
    sim.typedStartsNothing = true;
    const pane = engine.record(KEY)?.pane ?? "";
    const count = sim.row().length;
    await engine.resume(KEY);
    assert.equal(engine.record(KEY)?.state, "error");
    assert.equal(engine.record(KEY)?.error, "reason.timeout");
    assert.equal(engine.record(KEY)?.pane, pane);
    assert.equal(sim.row().length, count, "the shell that ran nothing is gone again");
  });

  it("a session open elsewhere: nothing starts; resume works again once it is closed there", async () => {
    const { sim, engine, claude } = await asleep();
    claude.state.elsewhere.set("s1", "pid 4242");
    await engine.resume(KEY);
    assert.equal(engine.record(KEY)?.state, "elsewhere");
    assert.equal(hcOf(sim, "run").length, 0);

    await engine.recheckElsewhere(KEY);
    assert.equal(engine.record(KEY)?.state, "elsewhere");
    claude.state.elsewhere.delete("s1");
    await engine.recheckElsewhere(KEY);
    assert.equal(engine.record(KEY)?.state, "asleep");
  });

  it("a conversation gone from disk: missing; Start new runs a fresh agent and drops the old record", async () => {
    const { sim, engine, claude } = await asleep();
    claude.state.missing.add("s1");
    await engine.refreshOnShow(KEY);
    assert.equal(engine.record(KEY)?.state, "missing");

    await engine.startNew(KEY);
    assert.deepEqual(
      sim.typed.map((x) => x.line),
      ["claude"],
    );
    assert.equal(engine.record(KEY), null);
  });

  it("what the agent writes while it exits is not 'updated after sleep'", async () => {
    const w = world();
    w.sim.onLeave = () => {
      w.claude.state.info.set("s1", { messages: 11, transcriptMtimeMs: 1_700_000_100_000, transcriptSize: 1100 });
    };
    await w.engine.tick();
    await w.engine.sleep(KEY);
    await w.engine.refreshOnShow(KEY);
    assert.equal(w.engine.freshness(KEY), null);
    assert.equal(w.engine.record(KEY)?.info.messages, 11);
  });

  it("Start new session and Forget also work as commands on the focused sleeping tab", async () => {
    const { sim, ports, engine, claude } = await asleep();
    claude.state.missing.add("s1");
    await engine.refreshOnShow(KEY);
    sim.focus = { pane: engine.record(KEY)?.pane ?? null, terminal: null };
    await engine.forgetFocused();
    assert.equal(stored(ports)[KEY], undefined);
  });

  it("work done elsewhere while asleep shows as updated after sleep", async () => {
    const { engine, claude } = await asleep();
    assert.equal(engine.freshness(KEY), null);
    claude.state.info.set("s1", { messages: 13, transcriptMtimeMs: 1_700_000_900_000, transcriptSize: 2000 });
    await engine.refreshOnShow(KEY);
    assert.deepEqual(engine.freshness(KEY), { atMs: 1_700_000_900_000, added: 3 });
  });

  it("resume all in project wakes one after another and skips sessions open elsewhere", async () => {
    const { sim, engine, claude } = await asleep();
    const second = sim.addTerminal({ agent: "claude" });
    claude.state.sessions.set(second.address, "s2");
    const third = sim.addTerminal({ agent: "claude" });
    claude.state.sessions.set(third.address, "s3");
    await engine.tick();
    await engine.sleep("claude:s2");
    await engine.sleep("claude:s3");
    claude.state.elsewhere.set("s2", "pid 1");

    const result = await engine.resumeAll(SPACE);
    assert.deepEqual(result, { woken: [KEY, "claude:s3"], skipped: ["claude:s2"] });
    assert.deepEqual(
      sim.typed.map((x) => x.line),
      ["claude --resume s1", "claude --resume s3"],
    );
    assert.ok(sim.notices.some((n) => /open elsewhere/.test(n.text)));
  });
});

describe("a session that changes inside the agent (/clear, /resume, Codex /new)", () => {
  it("Sleep follows the terminal to its new session, and Resume starts that one", async () => {
    const { sim, ports, engine, claude, agent } = world();
    await engine.tick();
    claude.state.sessions.set(agent.address, "s9"); // the person ran /clear
    await engine.sleep(KEY);
    assert.equal(stored(ports)[KEY], undefined, "nothing left on the old id");
    assert.equal(engine.record("claude:s9")?.state, "asleep");
    assert.ok(
      hcOf(sim, "label").some((c) => c[1] === agent.address && c.includes("suspender.session=s9")),
      "the terminal's labels moved too",
    );
    await engine.resume("claude:s9");
    assert.deepEqual(
      sim.typed.map((x) => x.line),
      ["claude --resume s9"],
    );
  });

  it("the leader moves the record when a turn ends on another session", async () => {
    const { sim, engine, claude, agent } = world({ status: "working" });
    await engine.tick();
    claude.state.sessions.set(agent.address, "s9"); // /resume of another conversation
    sim.setStatus(agent.address, "idle");
    await engine.tick();
    assert.equal(engine.record(KEY), null);
    assert.equal(engine.record("claude:s9")?.state, "running");
    assert.equal(sim.term(agent.address).labels["suspender.session"], "s9");
    // Claude is asked with its own process in front (it reads sessions/<pid>.json),
    // found once when the terminal was bound.
    assert.equal(claude.state.views.at(-1)?.foreground?.pid, sim.term(agent.address).agentPid);
  });

  it("Codex /new takes the same path, and nothing is asked or started while it idles", async () => {
    const { sim, engine, codex } = world();
    const term = sim.addTerminal({ agent: "codex", status: "working" });
    codex.state.sessions.set(term.address, "c1");
    await engine.tick();
    assert.equal(engine.record("codex:c1")?.state, "working");
    codex.state.sessions.set(term.address, "c2");
    const asked = codex.state.discovers.length;
    const listed = sim.execCalls.length; // binding looked once for the Claude terminal's process
    for (let i = 0; i < 4; i++) {
      await sim.advance(5_000);
      await engine.tick();
    }
    assert.equal(codex.state.discovers.length, asked, "no lookups while nothing happens");
    assert.equal(sim.execCalls.length, listed, "no PowerShell (no process at all) while idle");
    const checkedFrom = sim.now;
    sim.setStatus(term.address, "idle"); // the turn after /new ends
    await engine.tick();
    assert.equal(engine.record("codex:c1"), null);
    assert.equal(engine.record("codex:c2")?.state, "running");
    // Codex is asked without a process in front (its lookup would take a PowerShell
    // snapshot to choose between sessions), for sessions started since the last look.
    const view = codex.state.views.at(-1);
    assert.equal(view?.foreground, null);
    assert.ok(
      (view?.createdMs ?? 0) >= checkedFrom - 30_000 && (view?.createdMs ?? 0) > sim.term(term.address).createdMs,
    );
  });

  it("a Codex session another terminal already has is not taken over", async () => {
    const { sim, engine, codex } = world();
    const a = sim.addTerminal({ agent: "codex", status: "idle" });
    const b = sim.addTerminal({ agent: "codex", status: "working" });
    codex.state.sessions.set(a.address, "cA");
    codex.state.sessions.set(b.address, "cB");
    await engine.tick();
    codex.state.sessions.set(b.address, "cA"); // B's look finds A's newer session in the same folder
    sim.setStatus(b.address, "idle");
    await engine.tick();
    assert.equal(engine.record("codex:cA")?.terminal, a.address);
    assert.equal(engine.record("codex:cB")?.terminal, b.address);
  });
});

describe("restart", () => {
  it("a terminal that came back as a shell becomes interrupted, gets a snapshot and starts nothing", async () => {
    const { sim, engine, claude, agent } = world();
    sim.addTerminal({ agent: null, first: true });
    await engine.tick();
    const slot = sim.row().indexOf(agent.pane);
    const sizes = sim.layout().map((p) => p.size);
    sim.loseTerminal(agent.address);

    await engine.tick();
    await sim.advance(3_000);
    await engine.tick();

    const rec = engine.record(KEY);
    assert.equal(rec?.state, "interrupted");
    assert.equal(sim.row().indexOf(rec?.pane ?? ""), slot);
    assert.deepEqual(
      sim.layout().map((p) => p.size),
      sizes,
    );
    assert.deepEqual(claude.state.snapshots, ["s1"]);
    // The shell that came back is not the agent's last screen.
    assert.equal(rec?.lastScreen, null);
    assert.equal(hcOf(sim, "run").length, 0);
  });

  it("an agent the person exited (/exit, same shell) is not turned into a sleeping tab", async () => {
    const { sim, engine, agent } = world();
    await engine.tick();
    const t = sim.term(agent.address);
    t.app = null;
    t.status = null;
    await engine.tick();
    await sim.advance(3_000);
    await engine.tick();
    assert.equal(engine.record(KEY), null);
    assert.equal(t.labels["suspender.state"], "exited");
    assert.equal(
      sim.paneList.some((p) => p.mod === "suspender"),
      false,
    );
  });

  it("in doubt for a moment, nothing happens yet", async () => {
    const { sim, engine, agent } = world();
    await engine.tick();
    sim.loseTerminal(agent.address);
    await engine.tick();
    await sim.advance(1_000);
    await engine.tick();
    assert.equal(engine.record(KEY)?.state, "running");
    assert.equal(
      sim.paneList.some((p) => p.mod === "suspender"),
      false,
    );
  });

  it("a restart before the layout is loaded waits for it", async () => {
    const { sim, engine, agent } = world();
    await engine.tick();
    sim.loseTerminal(agent.address);
    sim.isReady = false;
    await engine.tick();
    await sim.advance(5_000);
    await engine.tick();
    assert.equal(engine.record(KEY)?.state, "running");
  });
});

describe("forgetting", () => {
  it("Forget removes the record and leaves an ordinary terminal in the tab", async () => {
    const { sim, ports, engine } = await asleep();
    const pane = engine.record(KEY)?.pane ?? "";
    const slot = sim.row().indexOf(pane);
    await engine.forget(KEY);
    assert.equal(stored(ports)[KEY], undefined);
    assert.equal(sim.pane(pane), undefined);
    const now = sim.paneList[sim.paneList.findIndex((p) => p.tab === TAB) + slot];
    assert.ok(now?.terminal, "a shell where the sleep pane was");
  });

  it("closing a sleeping tab removes its record", async () => {
    const { sim, ports, engine } = await asleep();
    const pane = engine.record(KEY)?.pane ?? "";
    sim.paneList = sim.paneList.filter((p) => p.pane !== pane);
    await engine.tick();
    assert.ok(stored(ports)[KEY], "not at the first look: panes may still be loading");
    await sim.advance(10_000);
    await engine.tick();
    assert.equal(stored(ports)[KEY], undefined);
  });
});

describe("one leading copy", () => {
  it("only the leader binds and writes; another copy takes over after 15 s of silence", async () => {
    const sim = new Sim();
    const ports = sim.ports(fakePorts({ sep: "\\", home: "C:\\Users\\tester" }));
    const claude = fakeAdapter("claude");
    const adapters = { claude, codex: fakeAdapter("codex") };
    // Two windows: separate coordinators, one shared store and one shared() map.
    const a = new Engine({ host: sim, ports, id: "a", adapters, coordinator: newCoordinator() });
    const b = new Engine({ host: sim, ports, id: "b", adapters, coordinator: newCoordinator() });
    const first = sim.addTerminal({ agent: "claude" });
    claude.state.sessions.set(first.address, "s1");

    await a.tick();
    await b.tick();
    assert.equal(a.isLeader(), true);
    assert.equal(b.isLeader(), false);
    assert.equal(hcOf(sim, "label").length, 1, "bound once");
    const writes = ports.writes.filter((w) => w.ok).length;

    const second = sim.addTerminal({ agent: "claude" });
    claude.state.sessions.set(second.address, "s2");
    await b.tick();
    assert.equal(ports.writes.filter((w) => w.ok).length, writes, "the follower writes nothing");

    // The leader goes quiet (its copy closed without a word).
    await sim.advance(16_000);
    await b.tick();
    assert.equal(b.isLeader(), true);
    assert.deepEqual((sim.shared(LEADER_KEY) as { id: string }).id, "b");
    assert.equal(sim.term(second.address).labels["suspender.session"], "s2");
  });

  it("two copies writing at once both land (the store's expected-text check)", async () => {
    const sim = new Sim();
    const ports = sim.ports();
    const claude = fakeAdapter("claude");
    const adapters = { claude, codex: fakeAdapter("codex") };
    const a = new Engine({ host: sim, ports, id: "a", adapters, coordinator: newCoordinator() });
    const b = new Engine({ host: sim, ports, id: "b", adapters, coordinator: newCoordinator() });
    const t1 = sim.addTerminal({ agent: "claude" });
    const t2 = sim.addTerminal({ agent: "claude" });
    claude.state.sessions.set(t1.address, "s1");
    claude.state.sessions.set(t2.address, "s2");
    await a.tick();
    await b.load();
    // Both act at once on different sessions; b's write lands between a's read and write.
    await Promise.all([a.sleep("claude:s1"), b.sleep("claude:s2")]);
    await a.load();
    const sessions = stored(ports);
    assert.equal(sessions["claude:s1"]?.state, "asleep");
    assert.equal(sessions["claude:s2"]?.state, "asleep");
  });
});

describe("memory freed", () => {
  it("records what the agent's tree gives back: its private working set, not the working set", async () => {
    // The sim's tasklist says 10 000 K a process; its private working sets are 40 MB (shell) and 200 MB (agent).
    const { engine } = await asleep();
    assert.equal(engine.record(KEY)?.memFreedMb, 240);
  });

  it("counts a terminal's process and everything under it, once each", () => {
    const d = (pid: number, ppid: number) => ({ pid, ppid, name: "x", startMs: null, commandLine: null });
    // 10 → 11 → 12, 10 → 13; 20 is someone else's; 0 is its own parent (System Idle).
    const list = [d(0, 0), d(10, 1), d(11, 10), d(12, 11), d(13, 10), d(20, 1), d(21, 20)];
    assert.deepEqual(subtree(list, 10).sort(), [10, 11, 12, 13]);
    assert.deepEqual(subtree(list, 99), []);
    // A table of hundreds of processes in one pass (descendsFrom per process would rebuild its map each time).
    const big = Array.from({ length: 3000 }, (_, i) => d(i + 1, i));
    assert.equal(subtree(big, 1).length, 3000);
  });

  it("leaves out a process whose parent id now belongs to a younger process (Windows reuses ids)", () => {
    const d = (pid: number, ppid: number, startMs: number | null) => ({
      pid,
      ppid,
      name: "x",
      startMs,
      commandLine: null,
    });
    // 11 started after the shell 10: its child. 30 started before 10: its parent was an earlier process 10.
    const list = [d(10, 1, 5_000), d(11, 10, 6_000), d(12, 11, 6_000), d(30, 10, 1_000), d(31, 30, 1_500)];
    assert.deepEqual(subtree(list, 10).sort(), [10, 11, 12]);
    // Unknown start times are taken as they are.
    assert.deepEqual(subtree([d(10, 1, null), d(11, 10, 1_000)], 10).sort(), [10, 11]);
  });
});
