// The engine ties Herdr, the core and the adapters together: it finds agent
// sessions in terminals and binds them (labels + a record in the store), runs
// the effects the state machine asks for (stop an agent, put our pane in its
// slot, start it again), and recognises terminals that came back as shells
// after a restart. It sees Herdr only through `Host` and the machine through
// `Ports`, so the tests run it on a simulated Herdr.
//
// One leading copy of the mod (shared("suspender.leader"), taken over after
// 15 s of silence) binds, watches and recovers; every copy may carry out what
// a person asked for in it (Sleep, Resume, Forget). Store writes say what they
// replace, so two copies writing at once never lose each other's change.

import { emptyInfo } from "../adapters/common.ts";
import type { AgentAdapter, TerminalView } from "../adapters/contract.ts";
import { ADAPTERS } from "../adapters/index.ts";
import { classifyTerminal, LABEL_AGENT, LABEL_STATE, sessionLabels } from "../core/classify.ts";
import { type Effect, type Event, transition } from "../core/machine.ts";
import {
  type AgentId,
  isAgentId,
  type SessionKey,
  type SessionRecord,
  type SessionState,
  type StoreFile,
  sessionKey,
} from "../core/model.ts";
import {
  defaultStorePath,
  parseStore,
  readStore,
  STORE_ATTEMPTS,
  StoreConflictError,
  serializeStore,
} from "../core/store.ts";
import { hasMessage, t } from "../i18n/index.ts";
import type { Ports } from "../platform/ports.ts";
import { allProcesses, type ProcessDetail, processDetails } from "../platform/proc.ts";
import { type Host, type HostTerminal, normalizeTerminal, toTerminalView } from "./host.ts";

/** The mod's folder name: what `pane.split {mod}` asks for. */
export const MOD_NAME = "suspender";
export const LEADER_KEY = "suspender.leader";
/** Bumped after every store write, so other copies redraw (and other windows re-read). */
export const REV_KEY = "suspender.rev";
/** Bumped when a wake moves to its next step, so the sleep pane redraws. */
export const PROGRESS_KEY = "suspender.progress";
/** The terminal's own pid when it was bound: a restart gives it a new one. */
export const LABEL_PID = "suspender.pid";

export const LEADER_STALE_MS = 15_000;
export const HEARTBEAT_MS = 10_000;
/** How often each copy runs `tick` (interfaces.md: takeover after 15 s of silence). */
export const TICK_MS = 5_000;
export const START_TIMEOUT_MS = 30_000;
/** An agent missing from its labelled terminal this long has left (or was lost). */
export const ABSENT_GRACE_MS = 3_000;
/** A record's terminal or pane missing this long is gone for good (not still loading). */
export const GONE_GRACE_MS = 10_000;
/** A stopping or waking that nobody carries on for this long is resolved by the leader. */
export const STALE_FLOW_MS = 60_000;
/** An agent whose session was not found is asked again at most this often. */
export const BIND_RETRY_MS = 10_000;
/** A started agent that is up but silent this long counts as up. */
export const SETTLE_MS = 4_000;
/** How long the copy that asked waits for the answer; a later one is the leader's to carry out. */
export const QUESTION_WAIT_MS = 120_000;
const POLL_MS = 250;
const PANE_WAIT_MS = 3_000;

export type WakeStep = "found" | "starting" | "ready";
export interface Freshness {
  /** When the transcript last changed. */
  atMs: number;
  /** Messages added since the sleep. */
  added: number;
}
export type Choice = "sleepWhenDone" | "interruptAndSleep" | "cancel";

/**
 * What the copies of one window share (they run in one module instance): the
 * store as last read or written, which sessions a copy is acting on, choices
 * and progress that live only while the window does.
 */
export interface Coordinator {
  store: StoreFile | null;
  storeRev: unknown;
  busy: Set<SessionKey>;
  whenDone: Set<SessionKey>;
  progress: Map<SessionKey, WakeStep>;
  fresh: Map<SessionKey, Freshness>;
  /** Answers to the question for a working agent, not carried out yet. */
  answers: Map<SessionKey, Choice>;
  /** When each mod command was last carried out. */
  commands: Map<string, number>;
}

export function newCoordinator(): Coordinator {
  return {
    store: null,
    storeRev: undefined,
    busy: new Set(),
    whenDone: new Set(),
    progress: new Map(),
    fresh: new Map(),
    answers: new Map(),
    commands: new Map(),
  };
}

const RUNNING: readonly SessionState[] = ["running", "working", "confirming"];
const SLEEPING: readonly SessionState[] = ["asleep", "interrupted", "elsewhere", "missing", "error"];

const baseName = (path: string): string => path.split(/[\\/]/).pop() ?? path;
const program = (arg: string): string =>
  baseName(arg)
    .replace(/\.(exe|cmd|bat|ps1)$/i, "")
    .toLowerCase();

const SHELLS = /^(pwsh|powershell|cmd|bash|zsh|fish|sh|nu|dash|ksh|tcsh|csh)$/;

/**
 * The terminal's own program is not a shell: it is the agent itself (started
 * by argv, as Resume does). While such a terminal lives, its agent is there,
 * reported or not; when the agent exits, the terminal ends.
 */
function agentOwnsTerminal(term: HostTerminal): boolean {
  const first = term.argv[0];
  return first !== undefined && !SHELLS.test(program(first));
}

/** The argv Herdr ran is the one asked for (same program, same arguments). */
export function sameArgv(got: readonly string[], want: readonly string[]): boolean {
  if (got.length !== want.length || got.length === 0) {
    return false;
  }
  return got.every((arg, i) => (i === 0 ? program(arg) === program(want[0] ?? "") : arg === want[i]));
}

interface Leader {
  id: string;
  at: number;
}

const asLeader = (value: unknown): Leader | null =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as Leader).id === "string" &&
  typeof (value as Leader).at === "number"
    ? (value as Leader)
    : null;

/** What an effect handed back: a check failed (or a step finished), so the machine moves on. */
interface Outcome {
  next: Event;
  /** Runs after `next` is applied (the store already says so). */
  after?: () => Promise<void>;
}

/** State kept across the effects of one flow. */
interface Flow {
  /** Our pane, already in the terminal's slot. */
  prepared: string | null;
  /** The snapshot's slow part, still running. */
  pending: Promise<void> | null;
}

export interface EngineOptions {
  host: Host;
  ports: Ports;
  /** This copy's id, unique among copies. */
  id: string;
  adapters?: Readonly<Record<AgentId, AgentAdapter>>;
  /** Defaults to one per engine; the mod passes the window's (`sharedCoordinator`). */
  coordinator?: Coordinator;
  storePath?: string;
}

export class Engine {
  private readonly host: Host;
  private readonly ports: Ports;
  private readonly id: string;
  private readonly adapters: Readonly<Record<AgentId, AgentAdapter>>;
  private readonly co: Coordinator;
  private readonly path: string;
  private revSeq = 0;
  private readonly absentSince = new Map<string, number>();
  private readonly bindTried = new Map<string, number>();
  private readonly flowSince = new Map<SessionKey, number>();

  constructor(o: EngineOptions) {
    this.host = o.host;
    this.ports = o.ports;
    this.id = o.id;
    this.adapters = o.adapters ?? ADAPTERS;
    this.co = o.coordinator ?? newCoordinator();
    this.path = o.storePath ?? defaultStorePath(o.ports);
  }

  // ---- reading

  /** Reads the store unless the cached copy is current. */
  async load(): Promise<void> {
    const rev = this.host.shared(REV_KEY);
    if (this.co.store !== null && rev === this.co.storeRev) {
      return;
    }
    this.co.store = await readStore(this.ports, this.path);
    this.co.storeRev = rev;
  }

  /** Changes whenever the cached store does (a write here or a read of another window's write). */
  revision(): unknown {
    return this.co.store;
  }

  /** Whether the cache is behind another copy's write (then `load`). */
  stale(): boolean {
    return this.co.store === null || this.host.shared(REV_KEY) !== this.co.storeRev;
  }

  records(): SessionRecord[] {
    return Object.values(this.co.store?.sessions ?? {});
  }

  record(key: SessionKey): SessionRecord | null {
    return this.co.store?.sessions[key] ?? null;
  }

  progress(key: SessionKey): WakeStep | null {
    return this.co.progress.get(key) ?? null;
  }

  freshness(key: SessionKey): Freshness | null {
    return this.co.fresh.get(key) ?? null;
  }

  /** A copy is acting on this session now (its buttons wait). */
  busy(key: SessionKey): boolean {
    return this.co.busy.has(key);
  }

  /** The person chose "Sleep when done" and the agent has not finished yet. */
  sleepingWhenDone(key: SessionKey): boolean {
    return this.co.whenDone.has(key);
  }

  adapter(agent: AgentId): AgentAdapter {
    return this.adapters[agent];
  }

  isLeader(): boolean {
    const cur = asLeader(this.host.shared(LEADER_KEY));
    return cur !== null && cur.id === this.id && this.ports.now() - cur.at < LEADER_STALE_MS;
  }

  /** Gives up leadership (the copy is closing), so another takes over at once. */
  release(): void {
    if (asLeader(this.host.shared(LEADER_KEY))?.id === this.id) {
      this.host.setShared(LEADER_KEY, null);
    }
  }

  // ---- the leader's round

  /** Every copy calls this every TICK_MS; only the leader does more than read. */
  async tick(): Promise<void> {
    if (!this.claim()) {
      await this.load();
      return;
    }
    await this.load();
    if (!this.host.ready()) {
      return;
    }
    const terms = this.host.terminals().filter((x) => x.parent === null && !x.address.includes("/"));
    for (const term of terms) {
      await this.observe(term);
    }
    await this.reconcile(terms);
  }

  private claim(): boolean {
    const now = this.ports.now();
    const cur = asLeader(this.host.shared(LEADER_KEY));
    if (cur !== null && cur.id !== this.id && now - cur.at < LEADER_STALE_MS) {
      return false;
    }
    if (cur === null || cur.id !== this.id || now - cur.at >= HEARTBEAT_MS) {
      this.host.setShared(LEADER_KEY, { id: this.id, at: now });
    }
    return true;
  }

  /** One terminal: bind a new agent, follow its status, or tell an exit from a restart. */
  private async observe(term: HostTerminal): Promise<void> {
    if (term.state !== "live" || term.labels["herdr.tab"] === undefined) {
      return;
    }
    const view = toTerminalView(term);
    const labelled = term.labels[LABEL_AGENT];
    const own = labelled !== undefined && isAgentId(labelled) ? this.adapters[labelled] : null;
    const cls = classifyTerminal(term, own !== null ? own.matches(view) : false);
    switch (cls.kind) {
      case "foreign":
      case "exited": {
        const detected = this.detect(view);
        if (detected !== null) {
          await this.bind(term, detected);
        }
        return;
      }
      case "running":
        this.absentSince.delete(term.address);
        await this.follow(term, cls.key);
        return;
      case "interrupted":
        if (agentOwnsTerminal(term)) {
          // Silent (at its own prompt, or not reporting at all), not gone.
          this.absentSince.delete(term.address);
          await this.follow(term, cls.key);
        } else {
          await this.agentGone(term, cls.key, cls.agent, cls.sessionId);
        }
        return;
    }
  }

  private detect(view: TerminalView): AgentAdapter | null {
    return Object.values(this.adapters).find((a) => a.matches(view)) ?? null;
  }

  /** Finds the session of an agent's terminal and records it. Returns its key, or null if not (yet) known. */
  private async bind(term: HostTerminal, adapter: AgentAdapter, force = false): Promise<SessionKey | null> {
    const now = this.ports.now();
    if (!force && now - (this.bindTried.get(term.address) ?? Number.NEGATIVE_INFINITY) < BIND_RETRY_MS) {
      return null;
    }
    this.bindTried.set(term.address, now);
    let sessionId: string | null = null;
    try {
      sessionId = await adapter.discoverSession(toTerminalView(term), this.ports);
    } catch {
      sessionId = null;
    }
    if (sessionId === null) {
      return null;
    }
    const key = sessionKey(adapter.id, sessionId);
    const existing = this.record(key);
    if (existing !== null && !RUNNING.includes(existing.state) && existing.terminal !== term.address) {
      // The session sleeps in another tab and was opened here by hand: that tab shows "open elsewhere".
      return null;
    }
    await this.label(term, adapter.id, sessionId);
    const working = isWorking(term.status);
    await this.mutate((file) => {
      const rec = file.sessions[key];
      if (rec !== undefined) {
        if (rec.terminal === term.address) {
          return false;
        }
        rec.terminal = term.address;
        return true;
      }
      file.sessions[key] = newRecord(key, adapter.id, sessionId, term, working ? "working" : "running");
      return true;
    });
    this.bindTried.delete(term.address);
    return key;
  }

  private async label(term: HostTerminal, agent: AgentId, sessionId: string): Promise<void> {
    const labels: Record<string, string> = { ...sessionLabels(agent, sessionId, "running") };
    if (term.pid !== null) {
      labels[LABEL_PID] = String(term.pid);
    }
    const changed = Object.entries(labels).filter(([k, v]) => term.labels[k] !== v);
    if (changed.length > 0) {
      await this.ports.hc(["label", term.address, ...changed.map(([k, v]) => `${k}=${v}`)]);
    }
  }

  /** A bound agent that is there: keep the record's state in step with what it reports. */
  private async follow(term: HostTerminal, key: SessionKey): Promise<void> {
    const rec = this.record(key);
    if (rec === null) {
      // Labelled but unknown (the store was lost): record it again.
      const agent = term.labels[LABEL_AGENT];
      if (agent !== undefined && isAgentId(agent)) {
        await this.bind(term, this.adapters[agent]);
      }
      return;
    }
    if (this.co.busy.has(key) || !RUNNING.includes(rec.state)) {
      return;
    }
    if (rec.terminal !== term.address) {
      await this.patch(key, (r) => {
        r.terminal = term.address;
      });
    }
    const working = isWorking(term.status);
    const idle = term.status !== null && !working;
    if (rec.state === "running" && working) {
      await this.dispatch(key, { t: "agentWorking" });
    } else if (rec.state === "working" && idle) {
      await this.dispatch(key, { t: "agentIdle" });
    } else if (rec.state === "confirming" && idle && this.co.whenDone.has(key)) {
      await this.act(key, () => this.dispatch(key, { t: "interruptAndSleep" }));
    } else if (rec.state === "confirming" && this.co.answers.has(key)) {
      await this.takeAnswer(key);
    }
  }

  /**
   * A terminal labelled "running" without its agent. Same shell as when it was
   * bound: the person left the agent. A new process: the terminal was lost
   * (core crash, restart) and came back as a shell. Either way only after a
   * short grace, and never by starting anything.
   */
  private async agentGone(term: HostTerminal, key: SessionKey, agent: AgentId, sessionId: string): Promise<void> {
    const rec = this.record(key);
    if (rec !== null && (this.co.busy.has(key) || !RUNNING.includes(rec.state))) {
      return;
    }
    const now = this.ports.now();
    const since = this.absentSince.get(term.address);
    if (since === undefined) {
      this.absentSince.set(term.address, now);
      return;
    }
    if (now - since < ABSENT_GRACE_MS) {
      return;
    }
    this.absentSince.delete(term.address);
    const boundPid = term.labels[LABEL_PID];
    if (boundPid !== undefined && term.pid !== null && boundPid === String(term.pid)) {
      await this.ports.hc(["label", term.address, `${LABEL_STATE}=exited`]);
      if (rec !== null) {
        await this.act(key, () => this.dispatch(key, { t: "agentExited", byUser: true }));
      }
      return;
    }
    if (rec === null) {
      await this.mutate((file) => {
        file.sessions[key] = newRecord(key, agent, sessionId, term, "running");
        return true;
      });
    }
    await this.act(key, () => this.dispatch(key, { t: "lostOnRestart" }));
  }

  /** Records whose terminal or pane went away; flows nobody carries on. */
  private async reconcile(terms: HostTerminal[]): Promise<void> {
    const live = new Set(terms.filter((x) => x.state === "live").map((x) => x.address));
    const panes = new Set(this.host.panes().map((p) => p.pane));
    const now = this.ports.now();
    for (const rec of this.records()) {
      const key = rec.key;
      if (this.co.busy.has(key)) {
        this.flowSince.delete(key);
        continue;
      }
      let gone = false;
      if (RUNNING.includes(rec.state)) {
        gone = live.size > 0 && (rec.terminal === null || !live.has(rec.terminal));
      } else if (SLEEPING.includes(rec.state)) {
        gone = rec.pane === null || !panes.has(rec.pane);
      } else {
        const since = this.flowSince.get(key) ?? now;
        this.flowSince.set(key, since);
        if (now - since >= STALE_FLOW_MS) {
          this.flowSince.delete(key);
          await this.recover(rec, live);
        }
        continue;
      }
      const mark = `record:${key}`;
      if (!gone) {
        this.absentSince.delete(mark);
        continue;
      }
      const since = this.absentSince.get(mark) ?? now;
      this.absentSince.set(mark, since);
      if (now - since >= GONE_GRACE_MS) {
        this.absentSince.delete(mark);
        await this.removeRecord(key);
      }
    }
  }

  /** A stopping or waking left behind (its copy closed mid-way): finish it the machine's way. */
  private async recover(rec: SessionRecord, live: Set<string>): Promise<void> {
    const key = rec.key;
    if (rec.state === "stopping") {
      const running = rec.terminal !== null && live.has(rec.terminal);
      await this.act(key, () => this.dispatch(key, running ? { t: "stopTimeout" } : { t: "stopped", forced: false }));
    } else if (rec.state === "waking") {
      await this.act(key, () => this.dispatch(key, { t: "startFailed", reason: "reason.interrupted" }));
    }
  }

  // ---- what a person asks for

  /** Sleep: stops an idle agent at once; a working one is asked first. */
  async sleep(key: SessionKey): Promise<void> {
    await this.load();
    await this.act(key, async () => {
      const rec = this.record(key);
      const term = rec?.terminal ? this.term(rec.terminal) : null;
      if (rec === null || term === null) {
        return;
      }
      // The record may lag behind the agent's own report by a tick.
      const working = isWorking(term.status);
      if (rec.state === "running" && working) {
        await this.dispatch(key, { t: "agentWorking" });
      } else if (rec.state === "working" && term.status !== null && !working) {
        await this.dispatch(key, { t: "agentIdle" });
      }
      const state = await this.dispatch(key, { t: "sleep" });
      if (state === "confirming") {
        this.co.answers.delete(key);
        this.host.askConfirm(key);
      }
    });
    // Wait here for the answer: this copy stays, the dialog does not.
    if (this.record(key)?.state === "confirming") {
      await this.waitUntil(
        () => this.co.answers.has(key) || this.record(key)?.state !== "confirming",
        QUESTION_WAIT_MS,
      );
      await this.takeAnswer(key);
    }
  }

  /** Carries out a recorded answer, if there is one. */
  private async takeAnswer(key: SessionKey): Promise<void> {
    const choice = this.co.answers.get(key);
    if (choice !== undefined && !this.co.busy.has(key)) {
      this.co.answers.delete(key);
      await this.choose(key, choice);
    }
  }

  /** Sleep for whatever agent runs in this terminal, binding it first if needed. */
  async sleepTerminal(address: string): Promise<void> {
    await this.load();
    const term = this.term(address);
    if (term === null) {
      return;
    }
    let key = this.records().find((r) => r.terminal === address && RUNNING.includes(r.state))?.key ?? null;
    if (key === null) {
      const adapter = this.detect(toTerminalView(term));
      key = adapter === null ? null : await this.bind(term, adapter, true);
    }
    if (key !== null) {
      await this.sleep(key);
    }
  }

  /**
   * The question's answer, from its dialog. The dialog closes at once (and its
   * tasks with it), so it only records the answer: the copy that asked carries
   * it out, or the leader does if nobody waits for it any more.
   */
  answer(key: SessionKey, choice: Choice): void {
    this.co.answers.set(key, choice);
  }

  /** The answer to "is still answering". */
  async choose(key: SessionKey, choice: Choice): Promise<void> {
    await this.load();
    if (choice === "sleepWhenDone") {
      this.co.whenDone.add(key);
      await this.dispatch(key, { t: "sleepWhenDone" });
      const rec = this.record(key);
      const term = rec?.terminal ? this.term(rec.terminal) : null;
      if (term !== null && term.status !== null && !isWorking(term.status)) {
        await this.act(key, () => this.dispatch(key, { t: "interruptAndSleep" }));
      }
      return;
    }
    this.co.whenDone.delete(key);
    if (choice === "cancel") {
      await this.dispatch(key, { t: "cancel" });
    } else {
      await this.act(key, () => this.dispatch(key, { t: "interruptAndSleep" }));
    }
  }

  /** Resume (also Retry). Returns the state it ended in. */
  async resume(key: SessionKey, how: "resume" | "resumeAll" = "resume"): Promise<SessionState | null> {
    await this.load();
    let end: SessionState | null = this.record(key)?.state ?? null;
    await this.act(key, async () => {
      const rec = this.record(key);
      if (rec !== null) {
        const argv = this.adapter(rec.agent).resumeArgv(rec.sessionId, rec.cwd);
        end = await this.dispatch(key, { t: how, argv });
      }
    });
    return end;
  }

  /** A fresh agent in the same folder, for a conversation that is gone. */
  async startNew(key: SessionKey): Promise<void> {
    await this.load();
    await this.act(key, async () => {
      const rec = this.record(key);
      if (rec !== null) {
        await this.dispatch(key, { t: "startNew", argv: this.adapter(rec.agent).newArgv(rec.cwd) });
      }
    });
  }

  /** Forget: the record goes; the tab keeps an ordinary terminal where our pane was. */
  async forget(key: SessionKey): Promise<void> {
    await this.load();
    await this.act(key, async () => {
      const pane = this.record(key)?.pane ?? null;
      await this.dispatch(key, { t: "forget" });
      if (this.record(key) === null && pane !== null && this.paneExists(pane)) {
        const before = new Set(this.host.panes().map((p) => p.pane));
        this.host.run("pane.split", { pane, direction: "right" });
        const shell = await this.waitFor(
          () => this.host.panes().find((p) => !before.has(p.pane) && p.terminal !== null)?.pane ?? null,
          PANE_WAIT_MS,
        );
        if (shell !== null) {
          this.host.run("pane.swap", { pane: shell, target: pane });
        }
        this.host.run("pane.close", { pane });
      }
    });
  }

  /** Wakes every sleeping or interrupted session of a space, one after another. */
  async resumeAll(spaceId: string): Promise<{ woken: SessionKey[]; skipped: SessionKey[] }> {
    await this.load();
    const keys = this.records()
      .filter((r) => r.spaceId === spaceId && (r.state === "asleep" || r.state === "interrupted"))
      .map((r) => r.key);
    const woken: SessionKey[] = [];
    const skipped: SessionKey[] = [];
    for (const key of keys) {
      const end = await this.resume(key, "resumeAll");
      if (end === "elsewhere") {
        skipped.push(key);
      } else if (end === "running") {
        woken.push(key);
      }
    }
    if (skipped.length > 0) {
      this.host.notify(t("notice.skippedElsewhere"), "warning");
    }
    return { woken, skipped };
  }

  /** The strip is shown: is the conversation still there, and did it change while asleep? Once per show. */
  async refreshOnShow(key: SessionKey): Promise<void> {
    await this.load();
    const rec = this.record(key);
    if (rec === null || !["asleep", "interrupted", "error", "elsewhere"].includes(rec.state) || this.co.busy.has(key)) {
      return;
    }
    const adapter = this.adapter(rec.agent);
    if (!(await adapter.transcriptExists(rec.sessionId, rec.cwd, this.ports))) {
      await this.act(key, () => this.dispatch(key, { t: "transcriptMissing" }));
      return;
    }
    const before = rec.info;
    const now = await adapter.snapshot(rec.sessionId, rec.cwd, this.ports, before);
    const newer =
      now.transcriptMtimeMs !== null &&
      before.transcriptMtimeMs !== null &&
      (now.transcriptMtimeMs > before.transcriptMtimeMs || now.transcriptSize !== before.transcriptSize);
    if (newer && now.transcriptMtimeMs !== null) {
      this.co.fresh.set(key, {
        atMs: now.transcriptMtimeMs,
        added: Math.max(0, (now.messages ?? 0) - (before.messages ?? 0)),
      });
    }
  }

  /** While a session is open elsewhere: has it been closed there? */
  async recheckElsewhere(key: SessionKey): Promise<void> {
    await this.load();
    const rec = this.record(key);
    if (rec === null || rec.state !== "elsewhere" || this.co.busy.has(key)) {
      return;
    }
    const open = await this.adapter(rec.agent).openElsewhere(rec.sessionId, this.ports);
    if (!open.open) {
      await this.act(key, () => this.dispatch(key, { t: "closedElsewhere" }));
    }
  }

  /** Every shown copy gets a mod command: one press is one action. */
  private firstOf(command: string): boolean {
    const now = this.ports.now();
    if (now - (this.co.commands.get(command) ?? Number.NEGATIVE_INFINITY) < 1_000) {
      return false;
    }
    this.co.commands.set(command, now);
    return true;
  }

  /** The command `suspender.resume-all`: Resume all in the shown space. */
  async resumeAllShown(): Promise<void> {
    const space = this.host.tabs().find((x) => x.spaceActive)?.space;
    if (space !== undefined && this.firstOf("resume-all")) {
      await this.resumeAll(space);
    }
  }

  /** The command `suspender.toggle-focused`: Sleep the focused agent, or Resume the focused sleeping tab. */
  async toggleFocused(): Promise<void> {
    if (!this.firstOf("toggle-focused")) {
      return;
    }
    await this.load();
    const f = this.host.focused();
    if (f?.terminal) {
      await this.sleepTerminal(f.terminal);
      return;
    }
    const rec = f?.pane ? this.records().find((r) => r.pane === f.pane) : undefined;
    if (rec !== undefined && ["asleep", "interrupted", "error"].includes(rec.state)) {
      await this.resume(rec.key);
    }
  }

  /** The sleeping tab that has the focus, if any. */
  private focusedSleeper(): SessionRecord | null {
    const pane = this.host.focused()?.pane;
    return pane ? (this.records().find((r) => r.pane === pane) ?? null) : null;
  }

  /** The command `suspender.forget`: Forget for the focused sleeping tab. */
  async forgetFocused(): Promise<void> {
    await this.load();
    const rec = this.focusedSleeper();
    if (rec !== null && this.firstOf("forget")) {
      await this.forget(rec.key);
    }
  }

  /** The command `suspender.start-new`: Start new session for the focused tab whose conversation is gone. */
  async startNewFocused(): Promise<void> {
    await this.load();
    const rec = this.focusedSleeper();
    if (rec?.state === "missing" && this.firstOf("start-new")) {
      await this.startNew(rec.key);
    }
  }

  // ---- the machine and its effects

  /** Runs `body` unless another copy is already acting on this session. */
  private async act(key: SessionKey, body: () => Promise<unknown>): Promise<void> {
    if (this.co.busy.has(key)) {
      return;
    }
    this.co.busy.add(key);
    try {
      await body();
    } finally {
      this.co.busy.delete(key);
    }
  }

  private async dispatch(
    key: SessionKey,
    ev: Event,
    flow: Flow = { prepared: null, pending: null },
  ): Promise<SessionState | null> {
    const rec = this.record(key);
    if (rec === null) {
      return null;
    }
    const step = transition(rec.state, ev);
    if (step.state !== rec.state) {
      await this.patch(key, (r) => {
        r.state = step.state;
        if (step.state !== "error") {
          r.error = null;
        }
      });
      if (step.state !== "confirming") {
        this.co.whenDone.delete(key);
      }
    }
    for (const effect of step.effects) {
      const outcome = await this.execute(key, effect, ev, flow);
      if (outcome !== null) {
        const end = await this.dispatch(key, outcome.next, flow);
        if (outcome.after) {
          await outcome.after();
        }
        return this.record(key)?.state ?? end;
      }
    }
    return this.record(key)?.state ?? null;
  }

  private async execute(key: SessionKey, effect: Effect, ev: Event, flow: Flow): Promise<Outcome | null> {
    const rec = this.record(key);
    if (rec === null) {
      return null;
    }
    const adapter = this.adapter(rec.agent);
    switch (effect.e) {
      case "snapshot":
        await this.snapshot(rec, adapter, ev.t !== "lostOnRestart", flow);
        return null;
      case "sendStop":
        return this.stop(rec, adapter, flow);
      case "kill": {
        await this.prepare(key, flow);
        const address = rec.terminal;
        if (address !== null) {
          this.host.run("terminal.kill", { terminal: address });
          await this.waitUntil(() => !this.alive(address), 5_000);
        }
        return { next: { t: "stopped", forced: true } };
      }
      case "placeSleepPane":
        await this.placeSleepPane(
          key,
          flow,
          ev.t === "stopped" || ev.t === "agentExited",
          ev.t === "stopped" && ev.forced,
        );
        return null;
      case "checkTranscript":
        return (await adapter.transcriptExists(rec.sessionId, rec.cwd, this.ports))
          ? null
          : { next: { t: "transcriptMissing" } };
      case "checkElsewhere": {
        const open = await adapter.openElsewhere(rec.sessionId, this.ports);
        return open.open ? { next: { t: "openElsewhere", where: open.where ?? "" } } : null;
      }
      case "startAgent":
        return this.start(key, adapter, effect.argv, ev.t === "startNew");
      case "removeRecord":
        await this.removeRecord(key);
        return null;
      case "notify": {
        const reason = effect.params?.["reason"] ?? null;
        const agent = adapter.displayName;
        const params: Record<string, string> = { agent, ...(effect.params ?? {}) };
        if (reason !== null && hasMessage(reason)) {
          params["reason"] = t(reason, { agent });
        }
        this.host.notify(hasMessage(effect.key) ? t(effect.key, params) : effect.key, "error");
        await this.patch(key, (r) => {
          r.error = reason ?? effect.key;
        });
        return null;
      }
    }
  }

  /**
   * The screen is read now, before anything changes it. The transcript and the
   * memory (a big file; PowerShell and tasklist, seconds each on a busy
   * machine) are started now and finish while the agent stops: the pane is
   * placed only once they are in (`flow.pending`).
   */
  private async snapshot(rec: SessionRecord, adapter: AgentAdapter, readScreen: boolean, flow: Flow): Promise<void> {
    const term = rec.terminal !== null ? this.term(rec.terminal) : null;
    const live = readScreen && term !== null && term.state === "live" ? term : null;
    const prev = rec.info.sessionId === rec.sessionId && rec.info.transcriptSize !== null ? rec.info : undefined;
    const infoP = adapter.snapshot(rec.sessionId, rec.cwd, this.ports, prev).catch(() => null);
    const memP = live?.pid != null ? this.memoryMb(live.pid).catch(() => null) : Promise.resolve(null);
    const screen = live !== null ? await this.ports.hc(["read", live.address]).catch(() => null) : null;
    if (screen !== null && screen.code === 0) {
      await this.patch(rec.key, (r) => {
        r.lastScreen = screen.stdout;
      });
    }
    flow.pending = (async () => {
      const [info, mem] = await Promise.all([infoP, memP]);
      await this.patch(rec.key, (r) => {
        if (info !== null) {
          r.info = info;
        }
        if (mem !== null) {
          r.memFreedMb = mem;
        }
      });
    })();
  }

  /** Resident memory of a terminal's process and everything under it, in MB. Both lists start at once. */
  private async memoryMb(root: number): Promise<number | null> {
    const [tree, all] = await Promise.all([processDetails(this.ports), allProcesses(this.ports)]);
    const kb = subtree(tree, root).reduce((sum, pid) => sum + (all.get(pid)?.rssKb ?? 0), 0);
    return kb > 0 ? Math.round(kb / 1024) : null;
  }

  /** The adapter's graceful stop, with our pane already in the terminal's slot (an exit may close its pane). */
  private async stop(rec: SessionRecord, adapter: AgentAdapter, flow: Flow): Promise<Outcome> {
    const address = rec.terminal;
    if (address === null || !this.alive(address)) {
      return { next: { t: "stopped", forced: false } };
    }
    await this.prepare(rec.key, flow);
    const gone = (): boolean => {
      const term = this.term(address);
      return term === null || term.state !== "live" || !adapter.matches(toTerminalView(term));
    };
    for (const step of adapter.stopSteps()) {
      if (gone()) {
        break;
      }
      if ("key" in step) {
        await this.ports.hc(["keys", address, "esc"]);
      } else if ("send" in step) {
        // Typed key by key: `hc send` pastes, and wraps the text in an <hc from=…>
        // tag when Herdr itself runs inside a terminal; the agent then reads a
        // message instead of its command.
        await this.ports.hc(["keys", address, ...typedKeys(step.send), "enter"]);
      } else if ("waitIdleMs" in step) {
        await this.waitUntil(() => {
          const status = this.term(address)?.status ?? null;
          return gone() || (status !== null && !isWorking(status));
        }, step.waitIdleMs);
      } else if (!(await this.waitUntil(gone, step.waitExitMs))) {
        return { next: { t: "stopTimeout" } };
      }
    }
    return { next: { t: "stopped", forced: false } };
  }

  /** split → swap: our pane takes the terminal's slot (experiments.md E1); the terminal is closed later. */
  private async prepare(key: SessionKey, flow: Flow): Promise<void> {
    if (flow.prepared !== null) {
      return;
    }
    const rec = this.record(key);
    if (rec === null) {
      return;
    }
    const target = rec.terminal !== null ? this.paneOf(rec.terminal) : null;
    const pane = await this.newSleepPane(rec, target);
    if (pane === null) {
      return;
    }
    if (target !== null) {
      this.host.run("pane.swap", { pane, target });
    }
    flow.prepared = pane;
    const tab = this.host.panes().find((p) => p.pane === pane)?.tab ?? rec.tabId;
    await this.patch(key, (r) => {
      r.pane = pane;
      r.tabId = tab;
    });
  }

  /** Our pane beside `anchor` (else beside any pane of the tab, else in a new tab of the space). */
  private async newSleepPane(rec: SessionRecord, anchor: string | null): Promise<string | null> {
    const before = new Set(this.host.panes().map((p) => p.pane));
    const props = { role: "sleep", key: rec.key };
    const beside = anchor ?? this.host.panes().find((p) => p.tab === rec.tabId)?.pane ?? null;
    if (beside !== null) {
      this.host.run("pane.split", { pane: beside, direction: "right", mod: MOD_NAME, props });
    } else {
      this.host.run("tab.new", { space: rec.spaceId, mod: MOD_NAME, props });
    }
    return this.waitFor(
      () => this.host.panes().find((p) => !before.has(p.pane) && p.mod === MOD_NAME)?.pane ?? null,
      PANE_WAIT_MS,
    );
  }

  /** `stopped`: the agent was just stopped (not lost); `forced`: by `terminal.kill`. */
  private async placeSleepPane(key: SessionKey, flow: Flow, stopped: boolean, forced: boolean): Promise<void> {
    const rec = this.record(key);
    if (rec === null) {
      return;
    }
    if (flow.prepared === null && rec.pane !== null && this.paneExists(rec.pane)) {
      flow.prepared = rec.pane;
    }
    await this.prepare(key, flow);
    const address = rec.terminal;
    if (address !== null) {
      const pane = this.paneOf(address);
      if (pane !== null) {
        this.host.run("pane.close", { pane });
      }
      await this.waitUntil(() => !this.alive(address), 2_000);
      await this.ports.hc(["rm", address]).catch(() => null);
    }
    if (flow.pending !== null) {
      await flow.pending;
      flow.pending = null;
    }
    // The agent writes its transcript on the way out (the exit command, hooks):
    // the snapshot "updated after sleep" compares with is the one after that.
    const after = stopped
      ? await this.adapter(rec.agent)
          .snapshot(rec.sessionId, rec.cwd, this.ports, this.record(key)?.info ?? rec.info)
          .catch(() => null)
      : null;
    await this.patch(key, (r) => {
      r.terminal = null;
      r.pane = flow.prepared ?? r.pane;
      r.sleptAtMs = this.ports.now();
      r.forced = forced;
      if (after !== null) {
        r.info = after;
      }
    });
  }

  /**
   * Starts the agent in the session's folder as a terminal of the same tab
   * (`hc run` with Herdr's labels: Herdr adopts it), checks with `hc get` that
   * the command is the one asked for, waits until the agent reports, then puts
   * it in our pane's slot and closes our pane. Our pane stays until then, so a
   * failure leaves it with the error and "Retry".
   */
  private async start(key: SessionKey, adapter: AgentAdapter, argv: string[], fresh: boolean): Promise<Outcome> {
    const rec = this.record(key);
    if (rec === null) {
      return { next: { t: "startFailed", reason: "reason.spawn" } };
    }
    const failed = async (reason: string, address: string | null): Promise<Outcome> => {
      if (address !== null) {
        await this.discard(address);
      }
      this.setProgress(key, null);
      return { next: { t: "startFailed", reason } };
    };
    this.setProgress(key, "found");
    const labels: Record<string, string> = fresh ? {} : sessionLabels(rec.agent, rec.sessionId, "running");
    const args = [
      "run",
      "--bg",
      "--keep",
      "--json",
      "--no-parent",
      "--no-notify",
      "--cwd",
      rec.cwd,
      "--label",
      `herdr.space=${rec.spaceId}`,
      "--label",
      `herdr.tab=${rec.tabId}`,
      ...Object.entries(labels).flatMap(([k, v]) => ["--label", `${k}=${v}`]),
      "--",
      ...argv,
    ];
    this.setProgress(key, "starting");
    const out = await this.ports.hc(args).catch(() => null);
    const address = out === null || out.code !== 0 ? null : addressIn(out.stdout);
    if (address === null) {
      return failed("reason.spawn", null);
    }
    const got = await this.ports.hc(["get", address, "--json"]).catch(() => null);
    const started = got === null ? null : normalizeTerminal(parseJson(got.stdout));
    if (started === null || !sameArgv(started.argv, argv)) {
      return failed("reason.wrongCommand", address);
    }
    if (started.pid !== null) {
      await this.ports.hc(["label", address, `${LABEL_PID}=${started.pid}`]);
    }
    // Herdr lists a terminal started this way only once it adopts it: not
    // listed yet is "still starting", not "gone". Up and reporting is ready;
    // so is up and silent for a few seconds (an agent at its own prompt,
    // like Codex's update question, reports nothing to Herdr).
    let ended = false;
    let listedAt: number | null = null;
    const ready = await this.waitUntil(() => {
      const term = this.term(address);
      ended = term !== null && term.state !== "live";
      if (term === null || ended) {
        return ended;
      }
      listedAt ??= this.ports.now();
      const reporting = adapter.matches(toTerminalView(term)) && term.status !== null;
      return reporting || this.ports.now() - listedAt >= SETTLE_MS;
    }, START_TIMEOUT_MS);
    if (ended) {
      return failed("reason.exited", address);
    }
    if (!ready) {
      return failed("reason.timeout", address);
    }
    const pane = await this.waitFor(() => this.paneOf(address), PANE_WAIT_MS);
    if (pane === null) {
      return failed("reason.noPane", address);
    }
    this.setProgress(key, "ready");
    if (!fresh) {
      await this.patch(key, (r) => {
        r.terminal = address;
        r.forced = false;
        r.sleptAtMs = null;
      });
    }
    const sleepPane = rec.pane;
    return {
      next: { t: "started" },
      after: async () => {
        if (sleepPane !== null && this.paneExists(sleepPane)) {
          this.host.run("pane.swap", { pane, target: sleepPane });
        }
        if (fresh) {
          await this.removeRecord(key);
          const term = this.term(address);
          if (term !== null) {
            await this.bind(term, adapter, true);
          }
        } else {
          await this.patch(key, (r) => {
            r.pane = null;
          });
        }
        this.setProgress(key, null);
        this.host.run("pane.focus", { pane });
        // Last: when this copy is that pane, closing it ends this copy.
        if (sleepPane !== null && this.paneExists(sleepPane)) {
          this.host.run("pane.close", { pane: sleepPane });
        }
      },
    };
  }

  /** Ends a terminal we started that did not come up right (through the core: Herdr may not list it yet). */
  private async discard(address: string): Promise<void> {
    await this.ports.hc(["kill", address]).catch(() => null);
    await this.waitUntil(() => !this.alive(address), 3_000);
    await this.ports.hc(["rm", address]).catch(() => null);
  }

  private async removeRecord(key: SessionKey): Promise<void> {
    this.co.whenDone.delete(key);
    this.co.progress.delete(key);
    this.co.fresh.delete(key);
    await this.mutate((file) => {
      if (file.sessions[key] === undefined) {
        return false;
      }
      delete file.sessions[key];
      return true;
    });
  }

  // ---- the store

  private async patch(key: SessionKey, change: (r: SessionRecord) => void): Promise<void> {
    await this.mutate((file) => {
      const rec = file.sessions[key];
      if (rec === undefined) {
        return false;
      }
      const before = JSON.stringify(rec);
      change(rec);
      return JSON.stringify(rec) !== before;
    });
  }

  /** Read, change, write if nobody wrote in between (else again on the newer file). No change: no write. */
  private async mutate(change: (file: StoreFile) => boolean): Promise<void> {
    for (let attempt = 0; attempt < STORE_ATTEMPTS; attempt++) {
      const before = await this.ports.readText(this.path);
      const file = parseStore(before);
      if (!change(file)) {
        this.co.store = file;
        this.co.storeRev = this.host.shared(REV_KEY);
        return;
      }
      if (await this.ports.writeText(this.path, serializeStore(file), before)) {
        this.co.store = file;
        const rev = `${this.id}:${++this.revSeq}`;
        this.co.storeRev = rev;
        this.host.setShared(REV_KEY, rev);
        return;
      }
    }
    throw new StoreConflictError(this.path, STORE_ATTEMPTS);
  }

  // ---- Herdr

  private term(address: string): HostTerminal | null {
    return this.host.terminals().find((x) => x.address === address) ?? null;
  }

  private alive(address: string): boolean {
    return this.term(address)?.state === "live";
  }

  private paneOf(address: string): string | null {
    return this.host.panes().find((p) => p.terminal === address)?.pane ?? null;
  }

  private paneExists(pane: string): boolean {
    return this.host.panes().some((p) => p.pane === pane);
  }

  private setProgress(key: SessionKey, step: WakeStep | null): void {
    if (step === null) {
      this.co.progress.delete(key);
    } else {
      this.co.progress.set(key, step);
    }
    this.host.setShared(PROGRESS_KEY, { key, step, at: this.ports.now() });
  }

  private async waitUntil(done: () => boolean, ms: number): Promise<boolean> {
    const end = this.ports.now() + ms;
    for (;;) {
      if (done()) {
        return true;
      }
      if (this.ports.now() >= end) {
        return false;
      }
      await this.host.sleep(POLL_MS);
    }
  }

  private async waitFor<T>(find: () => T | null, ms: number): Promise<T | null> {
    let found: T | null = null;
    await this.waitUntil(() => {
      found = find();
      return found !== null;
    }, ms);
    return found;
  }
}

const isWorking = (status: string | null): boolean => status === "working" || status === "blocked";

/** `hc keys` names for typing `text`: each character is its own key, a space is "space". */
export function typedKeys(text: string): string[] {
  return [...text].map((ch) => (ch === " " ? "space" : ch));
}

/**
 * `root` and every process under it, in one pass over the list (a process
 * table has hundreds of entries; Herdr's interpreter makes n² walks slow).
 */
export function subtree(list: readonly ProcessDetail[], root: number): number[] {
  if (!list.some((d) => d.pid === root)) {
    return [];
  }
  const children = new Map<number, number[]>();
  for (const d of list) {
    if (d.pid !== d.ppid) {
      children.set(d.ppid, [...(children.get(d.ppid) ?? []), d.pid]);
    }
  }
  const seen = new Set<number>([root]);
  const queue = [root];
  for (let i = 0; i < queue.length; i++) {
    for (const child of children.get(queue[i] ?? -1) ?? []) {
      if (!seen.has(child)) {
        seen.add(child);
        queue.push(child);
      }
    }
  }
  return queue;
}

function newRecord(
  key: SessionKey,
  agent: AgentId,
  sessionId: string,
  term: HostTerminal,
  state: SessionState,
): SessionRecord {
  return {
    key,
    agent,
    sessionId,
    cwd: term.cwd,
    state,
    spaceId: term.labels["herdr.space"] ?? "",
    tabId: term.labels["herdr.tab"] ?? "",
    terminal: term.address,
    pane: null,
    info: emptyInfo(sessionId, term.cwd),
    lastScreen: null,
    sleptAtMs: null,
    memFreedMb: null,
    forced: false,
    error: null,
  };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function addressIn(stdout: string): string | null {
  const value = parseJson(stdout);
  if (typeof value === "object" && value !== null && typeof (value as { address?: unknown }).address === "string") {
    return (value as { address: string }).address;
  }
  return null;
}
