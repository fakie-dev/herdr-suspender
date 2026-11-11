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

import { emptyInfo, sameDir } from "../adapters/common.ts";
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
import { allProcesses, type ProcessDetail, processDetails, subtree } from "../platform/proc.ts";
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
/** How long a new shell may take to show its prompt before the command is typed anyway. */
export const PROMPT_WAIT_MS = 10_000;
/** Process snapshots while waiting for a started agent: at most this often. */
export const SNAPSHOT_EVERY_MS = 5_000;
/** How long the copy that asked waits for the answer; a later one is the leader's to carry out. */
export const QUESTION_WAIT_MS = 120_000;
/**
 * A copy acting on a session holds it (its buttons wait) and says so at every
 * step; a hold nobody renewed this long belongs to a copy Herdr closed
 * half-way (its tasks end at their next await), and is let go.
 */
export const LEASE_STALE_MS = 30_000;
/** "Closed elsewhere" is believed only when a second look this much later says so too. */
export const CONFIRM_CLOSED_MS = 1_500;
/** A silent agent (one that reports nothing) is looked for at most this often. */
export const SILENT_CHECK_MS = 60_000;
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

/** An agent's process found under a terminal's shell. */
export interface AgentProcess {
  /** The shell it runs under (the terminal's own pid when it was found). */
  shell: number;
  pid: number;
  name: string;
  /** Herdr has seen it report (status/app) since; until then a silent agent is not a gone one. */
  reported: boolean;
}

/** Who acts on a session, and when it last said so. */
export interface Lease {
  owner: string;
  at: number;
}

/**
 * What the copies of one window share (they run in one module instance): the
 * store as last read or written, which sessions a copy is acting on, choices
 * and progress that live only while the window does.
 */
export interface Coordinator {
  store: StoreFile | null;
  storeRev: unknown;
  /** Sessions a copy is acting on now. */
  busy: Map<SessionKey, Lease>;
  whenDone: Set<SessionKey>;
  progress: Map<SessionKey, WakeStep>;
  fresh: Map<SessionKey, Freshness>;
  /** Answers to the question for a working agent, not carried out yet. */
  answers: Map<SessionKey, Choice>;
  /** The agent's own process under a terminal's shell, found once (by terminal address). */
  agents: Map<string, AgentProcess>;
  /** When each terminal's session was last looked up (by terminal address). */
  checkedAt: Map<string, number>;
  /** When each mod command was last carried out. */
  commands: Map<string, number>;
  /** What a terminal looked like (title, processes) when its agent was last known to be there. */
  seen: Map<string, string>;
  /** When a silent agent's process was last looked for (by terminal address). */
  silentLook: Map<string, number>;
}

export function newCoordinator(): Coordinator {
  return {
    store: null,
    storeRev: undefined,
    busy: new Map(),
    whenDone: new Set(),
    progress: new Map(),
    fresh: new Map(),
    answers: new Map(),
    agents: new Map(),
    checkedAt: new Map(),
    commands: new Map(),
    seen: new Map(),
    silentLook: new Map(),
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

/**
 * How a terminal's session is looked up again, per agent (every agent must
 * answer). "process": with the agent's own process in front: Claude rewrites
 * `sessions/<pid>.json` on /clear and /resume. "newer": without a process,
 * sessions started since the last look: Codex's lookup would otherwise take a
 * PowerShell snapshot (and walk it per process) to choose between sessions.
 */
const RECHECK: Readonly<Record<AgentId, "process" | "newer">> = { claude: "process", codex: "newer" };

/**
 * A word every shell reads as itself: no quotes, spaces, `&`, `|`, `%`, `$`
 * or anything else cmd.exe, PowerShell or a POSIX shell would act on.
 */
const PLAIN_WORD = /^[\w./\\:-]+$/;

/**
 * The command line typed into a new shell, or null when a word is not plain.
 * Quoting differs per shell (single quotes mean nothing to cmd.exe), so a
 * word that would need it is not typed at all: session ids are UUIDs, and
 * one that is not came from a file another program could write.
 */
export function commandLine(argv: readonly string[]): string | null {
  return argv.length > 0 && argv.every((a) => PLAIN_WORD.test(a)) ? argv.join(" ") : null;
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
  /** When a bound agent's process was found gone while Herdr still showed its status (by terminal address). */
  private readonly goneUnderReport = new Map<string, number>();

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
    const lease = this.co.busy.get(key);
    return lease !== undefined && this.ports.now() - lease.at < LEASE_STALE_MS;
  }

  /** This copy is still at work: its holds stay fresh. */
  private touch(): void {
    const now = this.ports.now();
    for (const lease of this.co.busy.values()) {
      if (lease.owner === this.id) {
        lease.at = now;
      }
    }
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

  /** Gives up leadership and its holds (the copy is closing), so another takes over at once. */
  release(): void {
    if (asLeader(this.host.shared(LEADER_KEY))?.id === this.id) {
      this.host.setShared(LEADER_KEY, null);
    }
    for (const [key, lease] of this.co.busy) {
      if (lease.owner === this.id) {
        this.co.busy.delete(key);
      }
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
        if (own !== null && (await this.killedUnderReport(term, cls.key, own))) {
          return;
        }
        await this.follow(term, cls.key);
        return;
      case "interrupted":
        // Its status went out: an agent found gone a moment ago left by itself.
        this.goneUnderReport.delete(term.address);
        if (agentOwnsTerminal(term) || (own !== null && (await this.silentAgent(term, own)))) {
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
    this.co.checkedAt.set(term.address, this.ports.now());
    this.co.seen.set(term.address, signature(term));
    await this.noteAgent(term, adapter);
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
    if (this.busy(key) || !RUNNING.includes(rec.state)) {
      return;
    }
    if (rec.terminal !== term.address) {
      await this.patch(key, (r) => {
        r.terminal = term.address;
      });
    }
    const known = this.co.agents.get(term.address);
    if (known !== undefined && term.status !== null) {
      known.reported = true;
    }
    const working = isWorking(term.status);
    const idle = term.status !== null && !working;
    if (rec.state === "running" && working) {
      await this.dispatch(key, { t: "agentWorking" });
    } else if (rec.state === "working" && idle) {
      await this.dispatch(key, { t: "agentIdle" });
      // A turn just ended: the session may be another one now (/clear, /resume, Codex /new).
      await this.verifySession(key);
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
    if (rec !== null && (this.busy(key) || !RUNNING.includes(rec.state))) {
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
    // Whatever runs in this shell next is another process.
    this.co.agents.delete(term.address);
    this.co.seen.delete(term.address);
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
      if (this.busy(key)) {
        this.flowSince.delete(key);
        continue;
      }
      let gone = false;
      if (RUNNING.includes(rec.state)) {
        gone = live.size > 0 && (rec.terminal === null || !live.has(rec.terminal));
      } else if (SLEEPING.includes(rec.state)) {
        gone = rec.pane === null || !panes.has(rec.pane);
        if (!gone && unfinished(rec)) {
          await this.finishSleep(rec);
          continue;
        }
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

  /**
   * A sleep whose copy was closed after the record said "asleep" (or
   * "interrupted") but before the pane took over: the terminal is still
   * attached, the time and the facts are missing. Its pane is there; finish
   * what placing it does.
   */
  private async finishSleep(rec: SessionRecord): Promise<void> {
    const key = rec.key;
    await this.act(key, async () => {
      const now = this.record(key);
      if (now === null || !unfinished(now) || now.pane === null) {
        return;
      }
      const flow: Flow = { prepared: now.pane, pending: null };
      await this.placeSleepPane(key, flow, now.info.transcriptSize === null, now.forced);
    });
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

  // ---- which session a terminal runs now

  /**
   * A terminal whose agent was found under its shell and has not reported
   * yet: silent, not gone, as long as its process is there. That is looked
   * at when the terminal changes (its title, its processes) and otherwise at
   * most every SILENT_CHECK_MS: one process list each time, none in between.
   */
  private async silentAgent(term: HostTerminal, adapter: AgentAdapter): Promise<boolean> {
    const known = this.co.agents.get(term.address);
    if (known === undefined || known.shell !== term.pid || known.reported) {
      return false;
    }
    const now = this.ports.now();
    const last = this.co.silentLook.get(term.address);
    if (last === undefined) {
      this.co.silentLook.set(term.address, now);
      this.co.seen.set(term.address, signature(term));
      return true;
    }
    const changed = this.co.seen.get(term.address) !== signature(term);
    if (!changed && now - last < SILENT_CHECK_MS) {
      return true;
    }
    this.co.silentLook.set(term.address, now);
    if ((await this.agentAlive(term, adapter)) === false) {
      this.co.agents.delete(term.address);
      this.co.silentLook.delete(term.address);
      return false;
    }
    this.co.seen.set(term.address, signature(term));
    return true;
  }

  /**
   * Herdr keeps an agent's last report after its process is killed hard
   * (taskkill /F, a crash): "claude-code idle" stays with nothing behind it.
   * When a bound terminal changes while its agent is not working (its title,
   * its processes: the shell's title comes back when the agent ends), one
   * process list says whether the agent is still there. Gone is not yet
   * killed: after /exit the title comes back first and the status goes out a
   * moment later. Only a status still shown ABSENT_GRACE_MS later means
   * killed: the session is interrupted (Resume), as after a crash. Nothing is
   * looked at while nothing changes, and a list that failed proves nothing.
   */
  private async killedUnderReport(term: HostTerminal, key: SessionKey, adapter: AgentAdapter): Promise<boolean> {
    const rec = this.record(key);
    if (rec === null || this.busy(key) || !RUNNING.includes(rec.state) || isWorking(term.status)) {
      this.goneUnderReport.delete(term.address);
      return false;
    }
    const goneAt = this.goneUnderReport.get(term.address);
    if (goneAt !== undefined) {
      if (this.ports.now() - goneAt < ABSENT_GRACE_MS) {
        return true;
      }
      this.goneUnderReport.delete(term.address);
      await this.act(key, () => this.dispatch(key, { t: "agentExited", byUser: false }));
      return true;
    }
    const now = signature(term);
    const before = this.co.seen.get(term.address);
    this.co.seen.set(term.address, now);
    if (before === undefined || before === now || (await this.agentAlive(term, adapter)) !== false) {
      return false;
    }
    this.co.agents.delete(term.address);
    this.co.seen.delete(term.address);
    this.goneUnderReport.set(term.address, this.ports.now());
    return true;
  }

  /**
   * Whether the agent's own process still runs under the terminal's shell:
   * its known pid in one cheap list (tasklist / ps), else one process tree.
   * Null when the system did not answer.
   */
  private async agentAlive(term: HostTerminal, adapter: AgentAdapter): Promise<boolean | null> {
    const known = this.co.agents.get(term.address);
    if (known !== undefined && known.shell === term.pid) {
      const all = await allProcesses(this.ports).catch(() => new Map<number, { name: string }>());
      if (all.size === 0) {
        return null;
      }
      const live = all.get(known.pid);
      return live !== undefined && adapter.matches(processView(term, known.pid, live.name));
    }
    const tree = await processDetails(this.ports).catch(() => []);
    return tree.length === 0 ? null : agentIn(tree, term, adapter, null) !== null;
  }

  /**
   * The agent's process under this terminal's shell, from one process
   * snapshot (PowerShell on Windows: seconds), never per process. With
   * `args`, it must also run with them (somewhere in its process chain).
   */
  private async findAgent(
    term: HostTerminal,
    adapter: AgentAdapter,
    args: readonly string[] | null,
  ): Promise<AgentProcess | null> {
    if (term.pid === null) {
      return null;
    }
    const tree = await processDetails(this.ports).catch(() => []);
    return agentIn(tree, term, adapter, args);
  }

  /**
   * Once per terminal (not on a timer): the agent's own process under its
   * shell, for agents looked up by it. One snapshot; none when the foreground
   * already is the agent or it is known.
   */
  private async noteAgent(term: HostTerminal, adapter: AgentAdapter): Promise<void> {
    if (RECHECK[adapter.id] !== "process" || this.co.agents.get(term.address)?.shell === term.pid) {
      return;
    }
    if (term.foreground !== null && adapter.matches({ ...toTerminalView(term), app: null })) {
      return;
    }
    const found = await this.findAgent(term, adapter, null);
    if (found !== null) {
      this.co.agents.set(term.address, { ...found, reported: true });
    }
  }

  /** The terminal as the adapter should see it to look its session up again (see RECHECK). */
  private recheckView(term: HostTerminal, adapter: AgentAdapter): TerminalView {
    const view = toTerminalView(term);
    if (RECHECK[adapter.id] === "newer") {
      const since = this.co.checkedAt.get(term.address) ?? term.createdMs;
      return { ...view, foreground: null, createdMs: Math.max(since, term.createdMs) };
    }
    const known = this.co.agents.get(term.address);
    return known === undefined || known.shell !== term.pid
      ? view
      : { ...view, foreground: { pid: known.pid, argv: [], name: known.name } };
  }

  /**
   * Asks the adapter again which session the terminal runs. Only at Sleep and
   * when a turn ends (never on a timer): a changed id moves the record and the
   * labels to the new key. Returns the key the session has now.
   */
  private async verifySession(key: SessionKey): Promise<SessionKey> {
    const rec = this.record(key);
    const term = rec?.terminal ? this.term(rec.terminal) : null;
    if (rec === null || term === null || term.state !== "live" || !RUNNING.includes(rec.state)) {
      return key;
    }
    const adapter = this.adapter(rec.agent);
    const view = this.recheckView(term, adapter);
    const lookedAt = this.ports.now();
    let sessionId: string | null = null;
    try {
      sessionId = await adapter.discoverSession(view, this.ports);
    } catch {
      sessionId = null;
    }
    this.co.checkedAt.set(term.address, lookedAt);
    if (sessionId === null || sessionId === rec.sessionId) {
      return key;
    }
    // Another live terminal already runs it (two agents in one folder): not ours.
    const other = this.record(sessionKey(rec.agent, sessionId));
    if (other !== null && other.terminal !== null && other.terminal !== term.address && this.alive(other.terminal)) {
      return key;
    }
    // Looked up by "sessions started since": while another agent of this kind runs
    // in the folder without a record, the newer session may well be its own.
    if (RECHECK[adapter.id] === "newer" && this.unboundNeighbour(term, adapter)) {
      return key;
    }
    return this.rekey(rec, term, sessionId);
  }

  /** Another live terminal in the same folder runs this adapter's agent and has no record yet. */
  private unboundNeighbour(term: HostTerminal, adapter: AgentAdapter): boolean {
    const bound = new Set(this.records().map((r) => r.terminal));
    return this.host
      .terminals()
      .some(
        (x) =>
          x.address !== term.address &&
          x.state === "live" &&
          !bound.has(x.address) &&
          sameDir(x.cwd, term.cwd, this.ports) &&
          adapter.matches(toTerminalView(x)),
      );
  }

  /**
   * The terminal now runs `sessionId`: its record and labels move there; the
   * old id is let go. Another copy may have moved it first (and started a
   * Sleep on the new key): with the old record gone, nothing is touched.
   */
  private async rekey(rec: SessionRecord, term: HostTerminal, sessionId: string): Promise<SessionKey> {
    const key = sessionKey(rec.agent, sessionId);
    let moved = false;
    await this.mutate((file) => {
      const old = file.sessions[rec.key];
      if (old === undefined) {
        return false;
      }
      delete file.sessions[rec.key];
      const there = file.sessions[key];
      // A session that sleeps in another tab keeps its record there (that tab shows "open elsewhere");
      // one this terminal already has is already moved.
      if (there === undefined || (RUNNING.includes(there.state) && there.terminal !== term.address)) {
        file.sessions[key] = {
          ...old,
          key,
          sessionId,
          terminal: term.address,
          pane: null,
          info: emptyInfo(sessionId, old.cwd),
          lastScreen: null,
          memFreedMb: null,
        };
      }
      moved = true;
      return true;
    });
    if (!moved) {
      return this.record(key)?.terminal === term.address ? key : rec.key;
    }
    await this.label(term, rec.agent, sessionId);
    for (const set of [this.co.whenDone]) {
      if (set.delete(rec.key)) {
        set.add(key);
      }
    }
    const answer = this.co.answers.get(rec.key);
    if (answer !== undefined) {
      this.co.answers.delete(rec.key);
      this.co.answers.set(key, answer);
    }
    return key;
  }

  // ---- what a person asks for

  /** Sleep: stops an idle agent at once; a working one is asked first. */
  async sleep(asked: SessionKey): Promise<void> {
    await this.load();
    // The agent may have moved to another session since it was bound (/clear, /resume, Codex /new).
    const key = this.busy(asked) ? asked : await this.verifySession(asked);
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
    if (choice !== undefined && !this.busy(key)) {
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

  /**
   * The strip is shown: is the conversation still there, and did it change
   * while asleep? Once per show; nothing watches it while the strip stays on
   * screen (a write elsewhere would cost a read each time). The other read is
   * right after the session is closed in another window (`recheckElsewhere`).
   */
  async refreshOnShow(key: SessionKey): Promise<void> {
    await this.load();
    await this.reread(key);
  }

  /** Is the conversation still there, and what changed in it since the sleep ("updated after sleep · +N"). */
  private async reread(key: SessionKey): Promise<void> {
    const rec = this.record(key);
    if (rec === null || !["asleep", "interrupted", "error", "elsewhere"].includes(rec.state) || this.busy(key)) {
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

  /**
   * While a session is open elsewhere: has it been closed there? One look can
   * be wrong (a session file read while the other copy rewrites it, a process
   * list that failed), so "closed" counts only when a second look a moment
   * later says so too. Closed: what the other copy added is read at once.
   */
  async recheckElsewhere(key: SessionKey): Promise<void> {
    await this.load();
    const rec = this.record(key);
    if (rec === null || rec.state !== "elsewhere" || this.busy(key)) {
      return;
    }
    const adapter = this.adapter(rec.agent);
    if ((await adapter.openElsewhere(rec.sessionId, this.ports)).open) {
      return;
    }
    await this.host.sleep(CONFIRM_CLOSED_MS);
    if (this.record(key)?.state !== "elsewhere" || (await adapter.openElsewhere(rec.sessionId, this.ports)).open) {
      return;
    }
    await this.act(key, () => this.dispatch(key, { t: "closedElsewhere" }));
    await this.reread(key);
  }

  /**
   * Every shown copy gets a mod command: one press is one action. A press is
   * the command and where it was pressed (the pane in focus, the space shown),
   * so presses on two tabs within a second are two actions.
   */
  private firstOf(command: string, where: string | null | undefined): boolean {
    const press = `${command}@${where ?? ""}`;
    const now = this.ports.now();
    if (now - (this.co.commands.get(press) ?? Number.NEGATIVE_INFINITY) < 1_000) {
      return false;
    }
    this.co.commands.set(press, now);
    return true;
  }

  /** The command `suspender.resume-all`: Resume all in the shown space. */
  async resumeAllShown(): Promise<void> {
    const space = this.host.tabs().find((x) => x.spaceActive)?.space;
    if (space !== undefined && this.firstOf("resume-all", space)) {
      await this.resumeAll(space);
    }
  }

  /** The command `suspender.toggle-focused`: Sleep the focused agent, or Resume the focused sleeping tab. */
  async toggleFocused(): Promise<void> {
    // Where it was pressed: the focus may move on while this press is carried out.
    const f = this.host.focused();
    if (!this.firstOf("toggle-focused", f?.pane ?? f?.terminal)) {
      return;
    }
    await this.load();
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
    if (rec !== null && this.firstOf("forget", rec.pane)) {
      await this.forget(rec.key);
    }
  }

  /** The command `suspender.start-new`: Start new session for the focused tab whose conversation is gone. */
  async startNewFocused(): Promise<void> {
    await this.load();
    const rec = this.focusedSleeper();
    if (rec?.state === "missing" && this.firstOf("start-new", rec.pane)) {
      await this.startNew(rec.key);
    }
  }

  // ---- the machine and its effects

  /** Runs `body` unless another copy is already acting on this session. */
  private async act(key: SessionKey, body: () => Promise<unknown>): Promise<void> {
    if (this.busy(key)) {
      return;
    }
    const lease: Lease = { owner: this.id, at: this.ports.now() };
    this.co.busy.set(key, lease);
    try {
      await body();
    } finally {
      if (this.co.busy.get(key) === lease) {
        this.co.busy.delete(key);
      }
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
        await this.ports.hc(["keys", address, step.key]);
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
    const known = this.record(key)?.info ?? rec.info;
    const after = stopped
      ? await this.adapter(rec.agent)
          .snapshot(rec.sessionId, rec.cwd, this.ports, known.transcriptSize !== null ? known : undefined)
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
   * Starts the agent as a new tab would (D02): Herdr's default shell in the
   * session's folder (`hc run` without a program, with Herdr's labels so it
   * adopts it into the tab), the resume command typed into it at its prompt.
   * `hc get` must show that shell; the agent must then run under it with the
   * command's arguments (one process snapshot per check, at most every 5 s).
   * After /exit the shell stays, like any tab. Our pane stays until the agent
   * is up, so a failure leaves it with the error and "Retry".
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
    const line = commandLine(argv);
    if (line === null) {
      return failed("reason.badId", null);
    }
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
    ];
    this.setProgress(key, "starting");
    const out = await this.ports.hc(args).catch(() => null);
    const address = out === null || out.code !== 0 ? null : addressIn(out.stdout);
    if (address === null) {
      return failed("reason.spawn", null);
    }
    const got = await this.ports.hc(["get", address, "--json"]).catch(() => null);
    const shell = got === null ? null : normalizeTerminal(parseJson(got.stdout));
    if (shell === null || !SHELLS.test(program(shell.argv[0] ?? ""))) {
      return failed("reason.wrongCommand", address);
    }
    if (shell.pid !== null) {
      await this.ports.hc(["label", address, `${LABEL_PID}=${shell.pid}`]);
    }

    // Its prompt first: a command typed before the shell reads input may be lost.
    await this.waitForPrompt(address);
    if (!this.alive(address) && this.term(address) !== null) {
      return failed("reason.exited", address);
    }
    await this.ports.hc(["keys", address, ...typedKeys(line), "enter"]);
    const typedAt = this.ports.now();

    // Up when the agent runs under the shell with the command's arguments.
    // Herdr lists the terminal only once it adopts it; an agent at its own
    // prompt (Codex's update question) may report nothing to Herdr.
    let found: AgentProcess | null = null;
    let lastSnapshot = Number.NEGATIVE_INFINITY;
    const end = typedAt + START_TIMEOUT_MS;
    while (this.ports.now() < end) {
      const term = this.term(address);
      if (term !== null && term.state !== "live") {
        return failed("reason.exited", address);
      }
      const now = this.ports.now();
      if (term !== null) {
        const reporting = adapter.matches(toTerminalView(term)) && term.status !== null;
        if ((reporting || now - typedAt >= SETTLE_MS) && now - lastSnapshot >= SNAPSHOT_EVERY_MS) {
          lastSnapshot = now;
          found = await this.findAgent(term, adapter, argv.slice(1));
          if (found !== null) {
            found.reported = reporting;
            break;
          }
        }
      }
      await this.pause(POLL_MS);
    }
    if (found === null) {
      return failed("reason.timeout", address);
    }
    this.co.agents.set(address, found);
    this.co.checkedAt.set(address, this.ports.now());
    const started = this.term(address);
    if (started !== null) {
      this.co.seen.set(address, signature(started));
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

  /** Until the new shell shows something (its prompt), at most PROMPT_WAIT_MS. */
  private async waitForPrompt(address: string): Promise<void> {
    const end = this.ports.now() + PROMPT_WAIT_MS;
    while (this.ports.now() < end) {
      const term = this.term(address);
      if (term !== null && term.state !== "live") {
        return;
      }
      if (term !== null) {
        const screen = await this.ports.hc(["read", address]).catch(() => null);
        if (screen !== null && screen.code === 0 && screen.stdout.trim() !== "") {
          return;
        }
      }
      await this.pause(POLL_MS);
    }
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

  /** Every wait of a flow goes through here: the copy is at work, so its holds stay fresh. */
  private async pause(ms: number): Promise<void> {
    this.touch();
    await this.host.sleep(ms);
    this.touch();
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
      await this.pause(POLL_MS);
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

export { subtree };

/** What a terminal looks like from outside: its title and its processes. A change is worth one look. */
function signature(term: HostTerminal): string {
  return JSON.stringify([term.title, term.pid, term.foreground?.pid ?? null]);
}

/** A record that says the session sleeps while its terminal is still attached, or without its time. */
function unfinished(rec: SessionRecord): boolean {
  return rec.terminal !== null || ((rec.state === "asleep" || rec.state === "interrupted") && rec.sleptAtMs === null);
}

/** The terminal as the adapter should see it with `pid` (named `name`) in front. */
function processView(term: HostTerminal, pid: number, name: string): TerminalView {
  return { ...toTerminalView(term), app: null, foreground: { pid, argv: [name], name } };
}

/** The agent's process under the terminal's shell in a process tree (with `args`, run with them). */
function agentIn(
  tree: readonly ProcessDetail[],
  term: HostTerminal,
  adapter: AgentAdapter,
  args: readonly string[] | null,
): AgentProcess | null {
  if (term.pid === null) {
    return null;
  }
  const shell = term.pid;
  const below = new Set(subtree(tree, shell));
  below.delete(shell);
  const under = tree.filter((d) => below.has(d.pid));
  const agent = under.find((d) => adapter.matches(processView(term, d.pid, d.name)));
  if (agent === undefined) {
    return null;
  }
  if (args !== null && !args.every((arg) => under.some((d) => (d.commandLine ?? "").includes(arg)))) {
    return null;
  }
  return { shell, pid: agent.pid, name: agent.name, reported: false };
}

const isWorking = (status: string | null): boolean => status === "working" || status === "blocked";

/** `hc keys` names for typing `text`: each character is its own key, a space is "space". */
export function typedKeys(text: string): string[] {
  return [...text].map((ch) => (ch === " " ? "space" : ch));
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
