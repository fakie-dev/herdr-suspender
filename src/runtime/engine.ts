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
import { classifyTerminal, LABEL_AGENT, LABEL_SESSION, LABEL_STATE, sessionLabels } from "../core/classify.ts";
import { type Effect, type Event, transition } from "../core/machine.ts";
import {
  type AgentId,
  isAgentId,
  type SessionKey,
  type SessionRecord,
  type SessionState,
  type SpacePin,
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
import {
  allProcesses,
  depthUnder,
  type ProcessDetail,
  processDetails,
  subtree,
  treesMemoryMb,
} from "../platform/proc.ts";
import { sleepingCount } from "../ui/sessionsModel.ts";
import {
  type Host,
  type HostPane,
  type HostTab,
  type HostTerminal,
  normalizeTerminal,
  toTerminalView,
} from "./host.ts";

/** The mod's folder name: what `pane.split {mod}` asks for. */
export const MOD_NAME = "suspender";
export const LEADER_KEY = "suspender.leader";
/** Bumped after every store write, so other copies redraw (and other windows re-read). */
export const REV_KEY = "suspender.rev";
/** Bumped when a wake moves to its next step, so the sleep pane redraws. */
export const PROGRESS_KEY = "suspender.progress";
/** "Sessions · N" for the live copy of the tab bar, which reads it with shared() (runtime/tabsClone.ts). */
export const TAB_LABEL_KEY = "suspender.tabLabel";
/** Set when the leader has confirmed sessions' states in this run: every copy redraws ("checking" ends). */
export const CHECKED_KEY = "suspender.checked";
/** The terminal's own pid when it was bound: a restart gives it a new one. */
export const LABEL_PID = "suspender.pid";

export const LEADER_STALE_MS = 15_000;
export const HEARTBEAT_MS = 10_000;
/** How often each copy runs `tick` (interfaces.md: takeover after 15 s of silence). */
export const TICK_MS = 5_000;
export const START_TIMEOUT_MS = 30_000;
/** An agent missing from its labelled terminal this long has left (or was lost). */
export const ABSENT_GRACE_MS = 3_000;
/** A sleeping pane asked for may still show this long after (a busy window); then it is not waited for. */
export const LATE_PANE_MS = 60_000;
/** A record's terminal or pane missing this long is gone for good (not still loading). */
export const GONE_GRACE_MS = 10_000;
/** A stopping or waking that nobody carries on for this long is resolved by the leader. */
export const STALE_FLOW_MS = 60_000;
/** An agent whose session was not found is asked again at most this often. */
export const BIND_RETRY_MS = 10_000;
/** A started agent that is up but silent this long counts as up. */
export const SETTLE_MS = 4_000;
/** How long a started agent may take to report (its screen drawn) before it is shown anyway. */
export const REPORT_WAIT_MS = 10_000;
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
/** A terminal Herdr does not list is looked up with `hc get` at most this often. */
const LOOK_EVERY_MS = 1_000;
const PANE_WAIT_MS = 3_000;
/**
 * How often the sleeping pane is looked for after the split: Herdr lists a
 * mod's new pane only after its next update, and until the park the agent is
 * squeezed beside it (ADR 9). One frame; only during a sleep, at most PANE_WAIT_MS.
 */
const FRAME_MS = 16;
/**
 * How long the stop waits for the memory figure of a sleep: the processes must
 * be listed while the agent and its shell still run (measured: about 1.1 to
 * 1.5 s, up to 3.4 s with six listings at once on a machine busy on every core).
 */
export const MEMORY_WAIT_MS = 5_000;
/**
 * How long a round waits for one step (a terminal, a record) before it goes
 * on without it. Longer than any flow a step may carry out (a whole Sleep).
 */
export const STEP_LIMIT_MS = 120_000;
const MEMORY_POLL_MS = 50;

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
  /** Sleeping panes asked for and not shown yet, by session (lateSplits). */
  splits: Map<SessionKey, Split>;
  /** Panes known to be sleeping panes, with their session (props are not in panes(): sweepStrays). */
  sleepPanes: Map<string, SessionKey>;
  /**
   * Sessions whose state the engine has confirmed since this module loaded: it saw the agent in its
   * terminal, bound it, or changed its state. A running record from before is "checking" until then.
   */
  confirmed: Set<SessionKey>;
  /** A session was confirmed since the copies were last told (CHECKED_KEY). */
  confirmedNews: boolean;
  /** Terminals found running a session whose record holds another live terminal (heldElsewhere), by address. */
  twins: Map<string, SessionKey>;
  /** Kinds of round failures already told (`tellOnce`). */
  told: Set<string>;
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
    splits: new Map(),
    sleepPanes: new Map(),
    confirmed: new Set(),
    confirmedNews: false,
    twins: new Map(),
    told: new Set(),
  };
}

/** The steps of a round whose failure is told (`tellOnce`). */
type RoundStep = "observe" | "record" | "panes";

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
 * or anything else cmd.exe, PowerShell or a POSIX shell would act on. `=`
 * only inside a word (`key=value` for Codex's `-c`): zsh expands a word that
 * starts with it to a path.
 */
const PLAIN_WORD = /^[\w./\\:-][\w./\\:=-]*$/;

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

/** A sleeping pane asked for and not shown yet: where it will show, and what was there before. */
export interface Split {
  /** The tab it was split in (null: a new tab). */
  tab: string | null;
  before: Set<string>;
  /** The tabs there were before (a new tab's pane is in none of them). */
  tabs: Set<string>;
  at: number;
}

/** State kept across the effects of one flow. */
/**
 * A memory figure on its way. It counts only if it came in before anything of
 * the tree was ended (`closed`): a listing made after the exit command finds
 * the agent and its children gone, or half gone, and would give a figure for
 * something else.
 */
interface Measure {
  done: boolean;
  closed: boolean;
  /** In MB; null when not measured, or measured too late. */
  value: number | null;
}

interface Flow {
  /** Our pane, already in the terminal's slot. */
  prepared: string | null;
  /** The snapshot's slow part, still running. */
  pending: Promise<void> | null;
  /** The memory figure of this sleep, taken by the snapshot; null: none was asked for. */
  memory: Measure | null;
  /**
   * The panes there were before this flow split for its sleeping pane: set
   * once it has split. Herdr may show the pane after the wait for it (a busy
   * window); it is still that pane, so the flow waits for it again rather
   * than split a second time (two sleeping panes, one left after Resume).
   */
  splitFrom: Set<string> | null;
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
  /** A round is under way in this copy (`tick`). */
  private ticking = false;
  /** The last `hc get` of a terminal Herdr does not list (look). */
  private readonly looked = new Map<string, { at: number; term: HostTerminal | null }>();
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

  /**
   * The record says the agent runs, but the engine has not confirmed it in this
   * run: after a restart the terminal may have come back as a bare shell, which
   * shows as "interrupted" only after the leader's look and its grace. Only
   * running states: a sleeping one is what its pane shows.
   */
  checking(key: SessionKey): boolean {
    const rec = this.record(key);
    return rec !== null && RUNNING.includes(rec.state) && !this.co.confirmed.has(key);
  }

  private confirm(key: SessionKey): void {
    if (!this.co.confirmed.has(key)) {
      this.co.confirmed.add(key);
      this.co.confirmedNews = true;
    }
  }

  /**
   * Where the session is on screen right now, as Herdr shows it: its sleeping
   * pane's tab, else its terminal's. Null when neither is in a tab: the ids in
   * the record may be of a tab that is gone, and selecting one fails.
   */
  placeNow(key: SessionKey): { spaceId: string; tabId: string } | null {
    const rec = this.record(key);
    if (rec === null) {
      return null;
    }
    const panes = this.host.panes();
    const pane =
      (rec.pane !== null ? panes.find((p) => p.pane === rec.pane) : undefined) ??
      (rec.terminal !== null ? panes.find((p) => p.terminal === rec.terminal) : undefined);
    const tab = pane === undefined ? undefined : this.host.tabs().find((x) => x.id === pane.tab);
    return tab === undefined ? null : { spaceId: tab.space, tabId: tab.id };
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

  /**
   * Every copy calls this every TICK_MS; only the leader does more than read.
   * A copy runs one round at a time: the timer fires again while a slow round
   * still waits, and that tick does nothing.
   */
  async tick(): Promise<void> {
    if (this.ticking) {
      return;
    }
    this.ticking = true;
    try {
      await this.round();
    } finally {
      this.ticking = false;
    }
  }

  /**
   * Each terminal and each record is a step of its own (`guarded`): one that
   * throws or does not answer is told once and skipped, and the others are
   * still looked at.
   */
  private async round(): Promise<void> {
    if (!this.claim()) {
      await this.load();
      this.publishTabLabel();
      return;
    }
    await this.load();
    this.publishTabLabel();
    if (!this.host.ready()) {
      return;
    }
    const terms = this.host.terminals().filter((x) => x.parent === null && !x.address.includes("/"));
    for (const term of terms) {
      await this.guarded("observe", () => this.observe(term));
    }
    await this.guarded("panes", () => this.lateSplits());
    await this.reconcile(terms);
    await this.guarded("panes", async () => {
      this.sweepStrays();
    });
    if (this.co.confirmedNews) {
      // Once per round that confirmed something: setting a shared value redraws every copy.
      this.co.confirmedNews = false;
      this.host.setShared(CHECKED_KEY, this.ports.now());
    }
  }

  /** Whether a split for this session's pane may still show (lateSplits). */
  private awaitingPane(key: SessionKey | undefined): boolean {
    const split = key === undefined ? undefined : this.co.splits.get(key);
    return split !== undefined && this.ports.now() - split.at < LATE_PANE_MS;
  }

  /**
   * "Sessions · N" for the live copy of the tab bar. Setting a shared value
   * redraws every mod in the window, so only a changed text is set.
   */
  private publishTabLabel(): void {
    const label = t("toggle.label", { count: sleepingCount(this.records()) });
    if (this.host.shared(TAB_LABEL_KEY) !== label) {
      this.host.setShared(TAB_LABEL_KEY, label);
    }
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
    // A second terminal of a session another live terminal holds: not looked up again while that holds.
    const twinOf = this.co.twins.get(term.address);
    const twinRec = twinOf === undefined ? null : this.record(twinOf);
    if (twinRec !== null && this.heldElsewhere(twinRec, term.address)) {
      return null;
    }
    this.co.twins.delete(term.address);
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
      // The session sleeps in another tab (or says "open elsewhere") and runs here, by this
      // terminal's own process tree: it runs here now. Not while a copy sleeps or wakes it.
      if (!(await this.runsHere(key, term))) {
        return null;
      }
      this.bindTried.delete(term.address);
      this.confirm(key);
      return key;
    }
    if (existing !== null && this.heldElsewhere(existing, term.address)) {
      this.co.twins.set(term.address, key);
      return null;
    }
    await this.label(term, adapter.id, sessionId);
    const working = isWorking(term.status);
    await this.mutate((file) => {
      const rec = file.sessions[key];
      if (rec !== undefined) {
        return placeAt(rec, term);
      }
      file.sessions[key] = newRecord(key, adapter.id, sessionId, term, working ? "working" : "running");
      return true;
    });
    this.bindTried.delete(term.address);
    this.confirm(key);
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
    if (this.heldElsewhere(rec, term.address)) {
      return;
    }
    // Its agent is in its terminal: the state the record says is true in this run.
    this.confirm(key);
    if (this.busy(key) || !RUNNING.includes(rec.state)) {
      return;
    }
    if (!samePlace(rec, term)) {
      await this.patch(key, (r) => {
        placeAt(r, term);
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

  /**
   * A step of the round, bounded: a throw or a step still waiting after
   * STEP_LIMIT_MS is told once per kind (not every round) and the round goes on.
   * A step that is let go may still finish later; flows hold their session
   * (`act`), so nothing else acts on it meanwhile.
   */
  private async guarded(kind: RoundStep, step: () => Promise<void>): Promise<void> {
    const limit = this.host.deadline(STEP_LIMIT_MS);
    try {
      const outcome = await Promise.race([step().then(() => "done" as const), limit.done.then(() => "late" as const)]);
      if (outcome === "late") {
        this.tellOnce(kind, t("reason.noAnswer"));
      }
    } catch (error) {
      this.tellOnce(kind, error instanceof Error ? error.message : String(error));
    } finally {
      limit.cancel();
    }
  }

  /** One toast per kind of failure while the module is loaded: a broken round repeats every five seconds. */
  private tellOnce(kind: RoundStep, reason: string): void {
    if (this.co.told.has(kind)) {
      return;
    }
    this.co.told.add(kind);
    this.host.notify(t(`notice.roundFailed.${kind}`, { reason }), "warning");
  }

  /** Records whose terminal or pane went away; flows nobody carries on. Each record is its own step. */
  private async reconcile(terms: HostTerminal[]): Promise<void> {
    const live = new Set(terms.filter((x) => x.state === "live").map((x) => x.address));
    const panes = this.host.panes();
    const paneIds = new Set(panes.map((p) => p.pane));
    const tabs = this.host.tabs();
    for (const rec of this.records()) {
      await this.guarded("record", () => this.reconcileOne(rec, live, paneIds, panes, tabs));
    }
  }

  private async reconcileOne(
    rec: SessionRecord,
    live: Set<string>,
    paneIds: Set<string>,
    panes: HostPane[],
    tabs: HostTab[],
  ): Promise<void> {
    const key = rec.key;
    const now = this.ports.now();
    if (this.busy(key)) {
      this.flowSince.delete(key);
      return;
    }
    let gone = false;
    if (RUNNING.includes(rec.state)) {
      // Also with no terminal left at all: Herdr's layout is loaded (ready), and the grace
      // below covers a list that lags. Before, such a record said "running" (or "checking") for good.
      gone = rec.terminal === null || !live.has(rec.terminal);
    } else if (SLEEPING.includes(rec.state)) {
      gone = rec.pane === null ? !this.awaitingPane(key) : !paneIds.has(rec.pane);
      if (rec.pane !== null && !gone) {
        this.co.sleepPanes.set(rec.pane, key);
        await this.followPane(rec, panes, tabs);
      }
      if (!gone && unfinished(rec)) {
        await this.finishSleep(rec);
        return;
      }
    } else {
      const since = this.flowSince.get(key) ?? now;
      this.flowSince.set(key, since);
      if (now - since >= STALE_FLOW_MS) {
        this.flowSince.delete(key);
        await this.recover(rec, live);
      }
      return;
    }
    const mark = `record:${key}`;
    if (!gone) {
      this.absentSince.delete(mark);
      return;
    }
    const since = this.absentSince.get(mark) ?? now;
    this.absentSince.set(mark, since);
    if (now - since >= GONE_GRACE_MS) {
      this.absentSince.delete(mark);
      await this.removeRecord(key);
      this.giveBack(await this.letGoOfSpaceName(key, rec.spaceName));
    }
  }

  /**
   * A sleeping session is where its pane is: a tab moved to another space (a
   * mod that groups spaces), or the pane moved to another tab, takes the record
   * along, so its row is in the right group, Resume all finds it and a click
   * goes to a tab that exists.
   */
  private async followPane(rec: SessionRecord, panes: HostPane[], tabs: HostTab[]): Promise<void> {
    const tabId = panes.find((p) => p.pane === rec.pane)?.tab;
    const spaceId = tabs.find((x) => x.id === tabId)?.space;
    if (tabId === undefined || spaceId === undefined || (rec.tabId === tabId && rec.spaceId === spaceId)) {
      return;
    }
    await this.patch(rec.key, (r) => {
      r.tabId = tabId;
      r.spaceId = spaceId;
    });
  }

  /**
   * Sleeping panes whose session no longer owns them, in a tab a session
   * lives in: left over by a flow that went wrong (a split Herdr showed after
   * its session was forgotten, a copy closed half-way). Such a pane shows
   * nothing anyone can use. It is closed once it has stayed so GONE_GRACE_MS
   * while nothing was being slept or woken. Never in a tab without a session:
   * that pane may be the tab's only one.
   *
   * Herdr's panes() gives a mod pane's name, not its props (role, key), so
   * "a sleeping pane of session K" is what this window knows: the panes its
   * copies split for K (newSleepPane, lateSplits) and the panes records own.
   * Any other Suspender pane (a Sessions list split in by hand, a sleeping
   * pane left from before Herdr was opened and owned by nobody) is never
   * closed here (ADR 7).
   */
  private sweepStrays(): void {
    const panes = this.host.panes();
    const records = this.records();
    const owner = new Map(records.filter((r) => r.pane !== null).map((r) => [r.pane, r.key]));
    const lived = new Set<string>();
    for (const r of records) {
      const at = r.pane ?? (r.terminal !== null ? this.paneOf(r.terminal) : null);
      const tab = panes.find((p) => p.pane === at)?.tab;
      if (tab !== undefined) {
        lived.add(tab);
      }
    }
    const acting = [...this.co.busy.keys()].some((key) => this.busy(key));
    const now = this.ports.now();
    const present = new Set(panes.map((p) => `stray:${p.pane}`));
    for (const mark of [...this.absentSince.keys()]) {
      if (mark.startsWith("stray:") && !present.has(mark)) {
        this.absentSince.delete(mark);
      }
    }
    for (const [pane, key] of [...this.co.sleepPanes]) {
      const now = owner.get(pane);
      if (!panes.some((p) => p.pane === pane)) {
        this.co.sleepPanes.delete(pane);
      } else if (now !== undefined && now !== key) {
        // Its record moved to another id (rekey): it is that one's.
        this.co.sleepPanes.set(pane, now);
      }
    }
    for (const p of panes) {
      const mark = `stray:${p.pane}`;
      const session = p.mod === MOD_NAME ? this.co.sleepPanes.get(p.pane) : undefined;
      if (acting || session === undefined || owner.has(p.pane) || this.awaitingPane(session) || !lived.has(p.tab)) {
        this.absentSince.delete(mark);
        continue;
      }
      const since = this.absentSince.get(mark) ?? now;
      this.absentSince.set(mark, since);
      if (now - since >= GONE_GRACE_MS) {
        this.absentSince.delete(mark);
        this.host.run("pane.close", { pane: p.pane });
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
      const flow: Flow = { prepared: now.pane, pending: null, memory: null, splitFrom: null };
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
    const known = this.co.agents.get(term.address)?.pid;
    if (before === undefined || before === now || (await this.agentAlive(term, adapter)) !== false) {
      const found = this.co.agents.get(term.address)?.pid;
      if (known !== undefined && found !== undefined && found !== known) {
        // Started again in the same shell (/exit, then the agent again): its session may be a new one.
        await this.verifySession(key);
      }
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
      if (live !== undefined && adapter.matches(processView(term, known.pid, live.name))) {
        return true;
      }
    }
    // Not the process it knew: the agent may have been started again in the same shell
    // (/exit, then the agent again within a round). One tree says whether one runs there now.
    const tree = await processDetails(this.ports).catch(() => []);
    if (tree.length === 0) {
      return null;
    }
    const found = agentIn(tree, term, adapter, null);
    if (found !== null && known !== undefined) {
      this.co.agents.set(term.address, { ...found, reported: known.reported });
    }
    return found !== null;
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
      // A new session since the last look is the cheap trigger; the terminal's own
      // shell stays in front, so the adapter confirms it through the process tree.
      const since = this.co.checkedAt.get(term.address) ?? term.createdMs;
      return { ...view, createdMs: Math.max(since, term.createdMs) };
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
    const lookedAt = this.ports.now();
    const ask = async (): Promise<string | null> => {
      try {
        return await adapter.discoverSession(this.recheckView(term, adapter), this.ports);
      } catch {
        return null;
      }
    };
    let sessionId = await ask();
    const known = this.co.agents.get(term.address);
    if (sessionId === null && RECHECK[adapter.id] === "process" && known !== undefined) {
      // Nothing for the process it knew: it may be gone, the agent started again in the
      // same shell (/exit, then the agent again). The process under the shell now, once.
      const found = await this.findAgent(term, adapter, null);
      if (found !== null && found.pid !== known.pid) {
        this.co.agents.set(term.address, { ...found, reported: known.reported });
        sessionId = await ask();
      }
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
    // without a record, anywhere, the newer session may well be its own.
    if (RECHECK[adapter.id] === "newer" && this.unboundNeighbour(term, adapter)) {
      return key;
    }
    return this.rekey(rec, term, sessionId);
  }

  /**
   * Another live terminal runs this adapter's agent and has no record yet, in
   * any folder: a folder is only where a shell was told it is.
   */
  private unboundNeighbour(term: HostTerminal, adapter: AgentAdapter): boolean {
    const bound = new Set(this.records().map((r) => r.terminal));
    return this.host
      .terminals()
      .some(
        (x) =>
          x.address !== term.address &&
          x.state === "live" &&
          !bound.has(x.address) &&
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
    let sleptElsewhere = false;
    await this.mutate((file) => {
      const old = file.sessions[rec.key];
      if (old === undefined) {
        return false;
      }
      delete file.sessions[rec.key];
      const there = file.sessions[key];
      sleptElsewhere = there !== undefined && SLEEPING.includes(there.state) && !this.busy(key);
      if (sleptElsewhere && there !== undefined) {
        // It sleeps in another tab and runs here now (its /resume here): it moves here, with its facts.
        placeAt(there, term);
      } else if (there === undefined || (RUNNING.includes(there.state) && there.terminal !== term.address)) {
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
    if (sleptElsewhere) {
      await this.act(key, () => this.dispatch(key, { t: "runsHere" }));
    }
    if (this.co.confirmed.has(rec.key)) {
      this.confirm(key);
    }
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
      const pin = this.record(key)?.spaceName;
      await this.dispatch(key, { t: "forget" });
      // The shell below takes the agent's place; Herdr names the space after it.
      const giveBack = this.record(key) === null ? await this.letGoOfSpaceName(key, pin) : null;
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
        this.giveBack(giveBack);
        this.host.run("pane.close", { pane });
      } else {
        this.giveBack(giveBack);
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
    await this.recheckOpen(key);
  }

  /**
   * What the Sessions list shows for running sessions (name, branch, model…),
   * as a sleeping session has it from its sleep. The panel asks while it is
   * shown (R34: the transcript is read when shown, and only if it changed:
   * the adapter checks the file's size and time against what was read last).
   * A record a copy is acting on is left alone; nothing new, no write.
   */
  async refreshRunning(): Promise<void> {
    await this.load();
    for (const rec of this.records()) {
      if (!RUNNING.includes(rec.state) || rec.terminal === null || this.busy(rec.key)) {
        continue;
      }
      const prev = rec.info.sessionId === rec.sessionId && rec.info.transcriptSize !== null ? rec.info : undefined;
      const info = await this.adapter(rec.agent)
        .snapshot(rec.sessionId, rec.cwd, this.ports, prev)
        .catch(() => null);
      if (info === null) {
        continue;
      }
      await this.patch(rec.key, (r) => {
        if (r.sessionId === info.sessionId && RUNNING.includes(r.state)) {
          r.info = info;
        }
      });
    }
  }

  /**
   * Is a sleeping session open in another tab or program now, or no longer?
   * Asked when the strip is shown and when the agent's sessions change (a
   * folder watch, no timer): "open elsewhere" shows before anyone presses
   * Resume. A check that could not tell (no process list) changes nothing.
   */
  async recheckOpen(key: SessionKey): Promise<void> {
    await this.load();
    const rec = this.record(key);
    if (rec === null || this.busy(key)) {
      return;
    }
    if (rec.state === "elsewhere") {
      await this.recheckElsewhere(key);
      return;
    }
    if (rec.state !== "asleep" && rec.state !== "interrupted") {
      return;
    }
    const open = await this.adapter(rec.agent).openElsewhere(rec.sessionId, this.ports);
    if (open.open && open.unsure !== true) {
      await this.act(key, () => this.dispatch(key, { t: "openElsewhere", where: open.where ?? "" }));
    }
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
    // Only new messages are news: a resume elsewhere that added none (its own
    // records, a title) is not "updated after sleep · +0 messages".
    const added = Math.max(0, (now.messages ?? 0) - (before.messages ?? 0));
    if (newer && now.transcriptMtimeMs !== null && added > 0) {
      this.co.fresh.set(key, { atMs: now.transcriptMtimeMs, added });
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
    flow: Flow = { prepared: null, pending: null, memory: null, splitFrom: null },
  ): Promise<SessionState | null> {
    const rec = this.record(key);
    if (rec === null) {
      return null;
    }
    const step = transition(rec.state, ev);
    if (step.state !== rec.state) {
      this.confirm(key);
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
      case "retireSleepPane":
        await this.retireSleepPane(key);
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
   * The screen is read now, before anything changes it. The transcript (a big
   * file) is read while the agent stops: the pane is placed only once it is in
   * (`flow.pending`). The memory (PowerShell on Windows, a second or more) is
   * started now too, and the stop waits for it before the first key
   * (`listedFirst`). This sleep's screen and figure replace the last sleep's
   * at once: one that cannot be taken is shown as none, never as the old one.
   */
  private async snapshot(rec: SessionRecord, adapter: AgentAdapter, readScreen: boolean, flow: Flow): Promise<void> {
    const term = rec.terminal !== null ? this.term(rec.terminal) : null;
    const live = readScreen && term !== null && term.state === "live" ? term : null;
    const prev = rec.info.sessionId === rec.sessionId && rec.info.transcriptSize !== null ? rec.info : undefined;
    const infoP = adapter.snapshot(rec.sessionId, rec.cwd, this.ports, prev).catch(() => null);
    const memory: Measure = { done: false, closed: false, value: null };
    flow.memory = memory;
    const root = live?.pid ?? null;
    if (root === null) {
      memory.done = true;
    } else {
      void this.memoryMb(root)
        .catch(() => null)
        .then((mb) => {
          memory.value = memory.closed ? null : mb;
          memory.done = true;
        });
    }
    const screen = live !== null ? await this.ports.hc(["read", live.address]).catch(() => null) : null;
    await this.patch(rec.key, (r) => {
      r.lastScreen = screen !== null && screen.code === 0 ? screen.stdout : null;
      r.memFreedMb = null;
    });
    flow.pending = (async () => {
      const info = await infoP;
      if (info !== null) {
        await this.patch(rec.key, (r) => {
          r.info = info;
        });
      }
    })();
  }

  /**
   * Before anything of the tree ends (a key to the agent, the shell killed):
   * the memory listing is waited for, at most MEMORY_WAIT_MS, and a figure that
   * comes in after that no longer counts.
   */
  private async listedFirst(flow: Flow): Promise<void> {
    const memory = flow.memory;
    if (memory === null || memory.closed) {
      return;
    }
    if (!memory.done) {
      await this.waitUntil(() => memory.done, MEMORY_WAIT_MS, MEMORY_POLL_MS);
    }
    memory.closed = true;
  }

  /** What a terminal's process and everything under it give back by ending, in MB (`treesMemoryMb`). */
  private async memoryMb(root: number): Promise<number | null> {
    return (await treesMemoryMb(this.ports, [root])).get(root) ?? null;
  }

  /**
   * The adapter's graceful stop, with our pane already in the terminal's slot
   * and the terminal out of sight (prepare): the steps reach it by its address,
   * and its status is still in terminals().
   */
  private async stop(rec: SessionRecord, adapter: AgentAdapter, flow: Flow): Promise<Outcome> {
    const address = rec.terminal;
    if (address === null || !this.alive(address)) {
      return { next: { t: "stopped", forced: false } };
    }
    await this.prepare(rec.key, flow);
    // Even Esc ends processes of the tree (a tool the agent is running).
    await this.listedFirst(flow);
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

  /**
   * split → swap: our pane takes the terminal's slot (experiments.md E1). Then
   * `terminal.park` takes the terminal's pane away at once (ADR 9): its share
   * goes to ours, the terminal keeps running out of sight and is stopped there,
   * so the tab shows the sleeping pane beside the live agent only until Herdr
   * lists our pane (a few frames: it does so after its next update, hence
   * FRAME_MS). Once listed, nothing is awaited until the park, so no other task
   * of the mod runs in between. Without our pane in place the terminal stays
   * where it is (a hole in the tab would be worse). If park fails (Herdr shows
   * a toast and the pane stays), placeSleepPane closes the pane at the end.
   */
  private async prepare(key: SessionKey, flow: Flow): Promise<void> {
    if (flow.prepared !== null) {
      return;
    }
    const rec = this.record(key);
    if (rec === null) {
      return;
    }
    const target = rec.terminal !== null ? this.paneOf(rec.terminal) : null;
    const pane = this.splitSleepPane(rec, target, flow) ?? (await this.newSleepPane(rec, target, flow));
    if (pane === null) {
      return;
    }
    let pin: SpacePin | null = null;
    if (target !== null && rec.terminal !== null) {
      // In the same step as the park, before it: the space never shows its folder's name.
      pin = this.pinSpaceName(target);
      this.host.run("pane.swap", { pane, target });
      this.host.run("terminal.park", { terminal: rec.terminal });
    }
    flow.prepared = pane;
    const tab = this.host.panes().find((p) => p.pane === pane)?.tab ?? rec.tabId;
    await this.patch(key, (r) => {
      r.pane = pane;
      r.tabId = tab;
      if (pin !== null) {
        r.spaceName = pin;
      }
    });
  }

  /**
   * A space nobody named is called after where its first terminal is, else its
   * own folder ("~" at home), so a space whose only terminal is the agent's
   * would take its folder's name once the agent is parked (measured, ADR 14).
   * Such a space is renamed to the name it shows now; a space someone named is
   * left as it is. Returns the pin, or null when nothing was renamed.
   */
  private pinSpaceName(pane: string): SpacePin | null {
    const tab = this.host.panes().find((p) => p.pane === pane)?.tab;
    const space = this.host.tabs().find((t) => t.id === tab)?.space;
    const now = this.host.spaces().find((s) => s.id === space);
    if (now === undefined || now.named || now.name === "") {
      return null;
    }
    this.host.run("space.rename", { id: now.id, name: now.name });
    return { space: now.id, name: now.name };
  }

  /**
   * A session that pinned its space's name leaves the sleeping ones (woken,
   * forgotten, gone). Another session still sleeping in that space takes the
   * pin over, so the name holds until the last of them wakes. Otherwise the
   * name goes back to Herdr, but only if it is still the one pinned: a name
   * someone gave it since, or Herdr's own again, is theirs. The store first;
   * the rename is returned to run in the caller's step (`giveBack`).
   */
  private async letGoOfSpaceName(key: SessionKey, pin: SpacePin | null | undefined): Promise<SpacePin | null> {
    if (pin === undefined || pin === null) {
      return null;
    }
    await this.patch(key, (r) => {
      r.spaceName = null;
    });
    const heir = this.records().find(
      (r) => r.key !== key && r.spaceId === pin.space && !RUNNING.includes(r.state) && (r.spaceName ?? null) === null,
    );
    if (heir !== undefined) {
      await this.patch(heir.key, (r) => {
        r.spaceName = pin;
      });
      return null;
    }
    return pin;
  }

  /**
   * The session runs in a live terminal now (`runsHere`): the sleeping pane it
   * left in its old tab shows nothing anyone can use. The name it pinned is let
   * go first; the pane is closed last, as this copy may be that pane.
   */
  private async retireSleepPane(key: SessionKey): Promise<void> {
    const rec = this.record(key);
    if (rec === null) {
      return;
    }
    const pane = rec.pane;
    const pin = rec.spaceName;
    await this.patch(key, (r) => {
      r.pane = null;
      r.sleptAtMs = null;
      r.forced = false;
    });
    this.giveBack(await this.letGoOfSpaceName(key, pin));
    if (pane !== null && this.paneExists(pane)) {
      this.co.sleepPanes.delete(pane);
      this.host.run("pane.close", { pane });
    }
  }

  /**
   * Session `key`, sleeping (or open elsewhere) in its old place, runs in live
   * terminal `term`: the terminal's own process tree said so. Its record goes
   * there as running and its sleeping pane goes. Never while a copy acts on it.
   */
  private async runsHere(key: SessionKey, term: HostTerminal): Promise<boolean> {
    const rec = this.record(key);
    if (rec === null || this.busy(key) || !SLEEPING.includes(rec.state)) {
      return false;
    }
    await this.patch(key, (r) => {
      placeAt(r, term);
    });
    await this.label(term, rec.agent, rec.sessionId);
    await this.act(key, () => this.dispatch(key, { t: "runsHere" }));
    return this.record(key)?.terminal === term.address;
  }

  /**
   * The record's own terminal is alive and still says it runs this session:
   * another terminal that runs it too (the conversation opened twice) does not
   * take the record, or the two would take it back and forth every round.
   */
  private heldElsewhere(rec: SessionRecord, address: string): boolean {
    if (rec.terminal === null || rec.terminal === address) {
      return false;
    }
    const own = this.term(rec.terminal);
    return own !== null && own.state === "live" && own.labels[LABEL_SESSION] === rec.sessionId;
  }

  /** Herdr's name again for a space the mod pinned, if nobody renamed it since. Never waits. */
  private giveBack(pin: SpacePin | null): void {
    if (pin === null) {
      return;
    }
    const now = this.host.spaces().find((s) => s.id === pin.space);
    if (now?.named === true && now.name === pin.name) {
      this.host.run("space.rename", { id: pin.space, name: "" });
    }
  }

  /**
   * Our pane beside `anchor` (else beside any pane of the tab, else in a new
   * tab of the space). Once per flow: a later call waits for the same pane.
   */
  private async newSleepPane(rec: SessionRecord, anchor: string | null, flow: Flow): Promise<string | null> {
    const shown = this.splitSleepPane(rec, anchor, flow);
    if (shown !== null) {
      return shown;
    }
    const split = this.co.splits.get(rec.key);
    const pane = await this.waitFor(() => (split === undefined ? null : this.splitPane(split)), PANE_WAIT_MS, FRAME_MS);
    if (pane !== null) {
      this.co.splits.delete(rec.key);
      this.co.sleepPanes.set(pane, rec.key);
    }
    return pane;
  }

  /** Asks for our pane once per flow (newSleepPane), and returns it if Herdr already shows it. Never waits. */
  private splitSleepPane(rec: SessionRecord, anchor: string | null, flow: Flow): string | null {
    if (flow.splitFrom === null) {
      flow.splitFrom = new Set(this.host.panes().map((p) => p.pane));
      const props = { role: "sleep", key: rec.key };
      const beside = anchor ?? this.host.panes().find((p) => p.tab === rec.tabId)?.pane ?? null;
      if (beside !== null) {
        this.host.run("pane.split", { pane: beside, direction: "right", mod: MOD_NAME, props });
      } else {
        this.newTabOffScreen(rec.spaceId, props);
      }
      const tab = beside === null ? null : (this.host.panes().find((p) => p.pane === beside)?.tab ?? null);
      const tabs = new Set([...this.host.tabs().map((t) => t.id), ...this.host.panes().map((p) => p.tab)]);
      // Until it shows: a pane that comes after this flow stopped waiting is still this session's (lateSplits).
      this.co.splits.set(rec.key, { tab, before: flow.splitFrom, tabs, at: this.ports.now() });
    }
    const split = this.co.splits.get(rec.key);
    const pane = split === undefined ? null : this.splitPane(split);
    if (pane !== null) {
      this.co.splits.delete(rec.key);
      this.co.sleepPanes.set(pane, rec.key);
    }
    return pane;
  }

  /**
   * A new tab for our pane in `space`, and the screen given back at once: Herdr
   * shows a new tab (measured), and nobody asked to go there. In the same step,
   * so Herdr applies them in order: the tab that space showed, then the tab that
   * was on screen (`tab.select` goes to another space too, with that tab's focus).
   */
  private newTabOffScreen(space: string, props: Record<string, unknown>): void {
    const tabs = this.host.tabs();
    const shown = tabs.find((t) => t.active && t.spaceActive)?.id ?? null;
    const spaceShown = tabs.find((t) => t.space === space && t.active)?.id ?? null;
    this.host.runOnScreen("tab.new", { space, mod: MOD_NAME, props });
    if (spaceShown !== null && spaceShown !== shown) {
      this.host.runOnScreen("tab.select", { id: spaceShown });
    }
    if (shown !== null) {
      this.host.runOnScreen("tab.select", { id: shown });
    }
  }

  /** The pane is in the tab on screen (the shown tab of the shown space). */
  private onScreen(pane: string): boolean {
    const tab = this.host.panes().find((p) => p.pane === pane)?.tab;
    return tab !== undefined && this.host.tabs().some((t) => t.id === tab && t.active && t.spaceActive);
  }

  /**
   * The Suspender pane a split asked for, once Herdr shows it: new since, in
   * its tab (a new tab: one that was not there before), and nobody's yet.
   * panes() has no props, so in the split's own tab a Suspender pane someone
   * splits in by hand before ours shows cannot be told from ours (ADR 7).
   */
  private splitPane(split: Split): string | null {
    return (
      this.host
        .panes()
        .find(
          (p) =>
            p.mod === MOD_NAME &&
            !split.before.has(p.pane) &&
            !this.co.sleepPanes.has(p.pane) &&
            (split.tab === null ? !split.tabs.has(p.tab) : p.tab === split.tab),
        )?.pane ?? null
    );
  }

  /**
   * Splits whose pane showed after their flow stopped waiting (twice
   * PANE_WAIT_MS: a busy window). The pane is its session's: a sleeping record
   * without a pane takes it, so the record is not dropped as gone and the pane
   * does not hang there. A pane whose session is gone by then is known as a
   * sleeping pane all the same, so sweepStrays closes it. A split that never
   * showed is forgotten after LATE_PANE_MS.
   */
  private async lateSplits(): Promise<void> {
    const now = this.ports.now();
    for (const [key, split] of [...this.co.splits]) {
      if (this.busy(key)) {
        continue;
      }
      const pane = this.splitPane(split);
      if (pane === null) {
        if (now - split.at >= LATE_PANE_MS) {
          this.co.splits.delete(key);
        }
        continue;
      }
      this.co.splits.delete(key);
      this.co.sleepPanes.set(pane, key);
      const rec = this.record(key);
      if (rec !== null && SLEEPING.includes(rec.state) && (rec.pane === null || !this.paneExists(rec.pane))) {
        const tab = this.host.panes().find((p) => p.pane === pane)?.tab ?? rec.tabId;
        await this.patch(key, (r) => {
          r.pane = pane;
          r.tabId = tab;
        });
      }
    }
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
    // An agent that was not stopped (killed hard, gone): its shell is ended here.
    await this.listedFirst(flow);
    const address = rec.terminal;
    if (address !== null) {
      const pane = this.paneOf(address);
      if (pane !== null) {
        // Still in view (park failed, or our pane never showed): closing its pane ends it.
        this.host.run("pane.close", { pane });
      } else if (this.alive(address)) {
        // Out of sight: the shell the agent ran in is still there, and nobody can see or close it.
        this.host.run("terminal.kill", { terminal: address });
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
      if (flow.memory !== null) {
        r.memFreedMb = flow.memory.value;
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
        this.looked.delete(address);
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
      // No herdr.space / herdr.tab yet: without them Herdr keeps the terminal
      // out of its screens (measured), so nobody sees a bare shell with the
      // command typed into it. They are added once the agent runs.
      ...Object.entries(labels).flatMap(([k, v]) => ["--label", `${k}=${v}`]),
    ];
    // No size either: `hc run` (and `hc attach`) take none, so the shell, and
    // the agent typed into it, start at the core's 200×120 and get the pane's
    // size only when Herdr adopts the terminal. `terminal.run.size` exists only
    // as a request to `hc connect` on stdin, and `exec` has no stdin; a
    // `pwsh -c "<json> | hc connect"` wrapper through `exec` was rejected: its
    // environment may point at another core (HC_SESSION). ADR 8.
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
    const prompted = await this.look(address);
    if (prompted !== null && prompted.state !== "live") {
      return failed("reason.exited", address);
    }
    // `hc send`, not `hc keys`: keys has no name for `_` or `:` (Codex's
    // check_for_update_on_startup=false) and refuses the whole line. A shell
    // gets sent text as it is; only an agent gets it wrapped as a message.
    const sent = await this.ports.hc(["send", address, line]).catch(() => null);
    if (sent === null || sent.code !== 0) {
      return failed("reason.notTyped", address);
    }
    const typedAt = this.ports.now();

    // Up when the agent runs under the shell with the command's arguments.
    // Herdr lists the terminal only once it adopts it (`hc get` until then);
    // an agent at a question of its own (Codex asking to trust a folder) may report nothing.
    let found: AgentProcess | null = null;
    let lastSnapshot = Number.NEGATIVE_INFINITY;
    const end = typedAt + START_TIMEOUT_MS;
    while (this.ports.now() < end) {
      const term = await this.look(address);
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
    // Its process can be there before its screen is drawn (measured: the shell's
    // screen showed for a moment). It reports its status once it is at its
    // prompt; one that reports nothing (Codex's trust question) is shown
    // after REPORT_WAIT_MS all the same.
    const drawnBy = Math.min(end, this.ports.now() + REPORT_WAIT_MS);
    while (!found.reported && this.ports.now() < drawnBy) {
      await this.pause(POLL_MS);
      const term = await this.look(address);
      if (term === null || term.state !== "live") {
        return failed("reason.exited", address);
      }
      found.reported = adapter.matches(toTerminalView(term)) && term.status !== null;
    }
    this.looked.delete(address);
    this.co.agents.set(address, found);
    this.co.checkedAt.set(address, this.ports.now());
    this.setProgress(key, "ready");
    // Everything that waits is done before Herdr shows the agent: from then on
    // the flow only looks for its pane every frame and puts it in the slot.
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
      after: () => this.showWoken(key, address, sleepPane, fresh, adapter),
    };
  }

  /**
   * The woken agent takes the sleeping pane's slot. Herdr adopts the terminal
   * once it has its tab's labels, by splitting the tab's last pane, and lists
   * the new pane only after its next update. The pane is looked for every
   * frame, and in the same step it is swapped into the slot and the sleeping
   * pane is closed: the split shows for a frame or two, and the agent goes from
   * the core's 200 columns to the slot's size within them. Before, the store
   * was written in between and the pane looked for every 250 ms, and the agent
   * stood at half its slot beside the sleeping pane for up to 0.8 s.
   */
  private async showWoken(
    key: SessionKey,
    address: string,
    sleepPane: string | null,
    fresh: boolean,
    adapter: AgentAdapter,
  ): Promise<void> {
    const rec = this.record(key);
    const pin = rec?.spaceName ?? null;
    if (fresh) {
      await this.removeRecord(key);
    } else {
      await this.patch(key, (r) => {
        r.pane = null;
      });
    }
    // Decided now, given back in the step that shows the agent: nothing may wait there.
    const giveBack = await this.letGoOfSpaceName(key, pin);
    const where = rec ?? null;
    if (where !== null) {
      await this.ports
        .hc(["label", address, `herdr.space=${where.spaceId}`, `herdr.tab=${where.tabId}`])
        .catch(() => null);
    }
    const pane = await this.waitFor(() => this.paneOf(address), PANE_WAIT_MS, FRAME_MS);
    if (pane === null) {
      this.setProgress(key, null);
      await this.discard(address);
      if (fresh) {
        this.host.notify(
          t("error.startFailed", {
            agent: adapter.displayName,
            reason: t("reason.noPane", { agent: adapter.displayName }),
          }),
          "error",
        );
        return;
      }
      await this.patch(key, (r) => {
        r.terminal = null;
        r.pane = sleepPane;
        // Still asleep: the pin stays, unless another sleeping session took it over.
        if (giveBack !== null) {
          r.spaceName = giveBack;
        }
      });
      await this.dispatch(key, { t: "startFailed", reason: "reason.noPane" });
      return;
    }
    // One step, nothing awaited: Herdr draws the tab again only after it.
    if (sleepPane !== null && this.paneExists(sleepPane)) {
      this.host.run("pane.swap", { pane, target: sleepPane });
    }
    // The agent is in the space again: Herdr names it after it.
    this.giveBack(giveBack);
    this.setProgress(key, null);
    // Only on the tab the person is on: focusing a pane of another tab shows
    // that tab and its space (measured), and the side panel goes with the space.
    if (this.onScreen(pane)) {
      this.host.runOnScreen("pane.focus", { pane });
    }
    // Last: when this copy is that pane, closing it ends this copy.
    if (sleepPane !== null && this.paneExists(sleepPane)) {
      this.host.run("pane.close", { pane: sleepPane });
    }
    const started = this.term(address);
    if (started !== null) {
      this.co.seen.set(address, signature(started));
      if (fresh) {
        // A copy that was the sleeping pane ends at the close; the leader binds the new agent then.
        await this.bind(started, adapter, true);
      }
    }
  }

  /**
   * A terminal as Herdr lists it, or as `hc get` describes one Herdr does not
   * show (yet): the shell a wake starts stays out of Herdr's screens until its
   * agent runs. `hc get` is a process: at most once per LOOK_EVERY_MS for a
   * terminal, the last answer in between.
   */
  private async look(address: string): Promise<HostTerminal | null> {
    const listed = this.term(address);
    if (listed !== null) {
      return listed;
    }
    const last = this.looked.get(address);
    const now = this.ports.now();
    if (last !== undefined && now - last.at < LOOK_EVERY_MS) {
      return last.term;
    }
    const got = await this.ports.hc(["get", address, "--json"]).catch(() => null);
    const term = got === null || got.code !== 0 ? null : normalizeTerminal(parseJson(got.stdout));
    this.looked.set(address, { at: now, term });
    return term;
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
        this.publishTabLabel();
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

  private async waitUntil(done: () => boolean, ms: number, every = POLL_MS): Promise<boolean> {
    const end = this.ports.now() + ms;
    for (;;) {
      if (done()) {
        return true;
      }
      if (this.ports.now() >= end) {
        return false;
      }
      await this.pause(every);
    }
  }

  private async waitFor<T>(find: () => T | null, ms: number, every = POLL_MS): Promise<T | null> {
    let found: T | null = null;
    await this.waitUntil(
      () => {
        found = find();
        return found !== null;
      },
      ms,
      every,
    );
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
  // The nearest to the shell: an agent may run another of its kind (`claude -p`) under it.
  let agent: ProcessDetail | undefined;
  let nearest = Number.POSITIVE_INFINITY;
  for (const d of under) {
    const depth = depthUnder(tree, d.pid, shell) ?? Number.POSITIVE_INFINITY;
    if (depth < nearest && adapter.matches(processView(term, d.pid, d.name))) {
      agent = d;
      nearest = depth;
    }
  }
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

/**
 * A running session is where its terminal is: a terminal moved to another
 * tab, or the conversation opened again in a new tab after its tab was closed,
 * takes the record along, so its Sessions row opens the tab it is in now.
 */
function samePlace(rec: SessionRecord, term: HostTerminal): boolean {
  const { spaceId, tabId } = placeOf(term, rec);
  return rec.terminal === term.address && rec.spaceId === spaceId && rec.tabId === tabId;
}

/** Moves the record to its terminal's place; false if it was there already. */
function placeAt(rec: SessionRecord, term: HostTerminal): boolean {
  if (samePlace(rec, term)) {
    return false;
  }
  const { spaceId, tabId } = placeOf(term, rec);
  rec.terminal = term.address;
  rec.spaceId = spaceId;
  rec.tabId = tabId;
  return true;
}

/** The terminal's space and tab as Herdr labels them; a missing label keeps what the record has. */
function placeOf(term: HostTerminal, rec: SessionRecord): { spaceId: string; tabId: string } {
  return { spaceId: term.labels["herdr.space"] ?? rec.spaceId, tabId: term.labels["herdr.tab"] ?? rec.tabId };
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
