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
import { emptyInfo } from "../adapters/common.js";
import { ADAPTERS } from "../adapters/index.js";
import { classifyTerminal, LABEL_AGENT, LABEL_STATE, sessionLabels } from "../core/classify.js";
import { transition } from "../core/machine.js";
import { isAgentId, sessionKey, } from "../core/model.js";
import { defaultStorePath, parseStore, readStore, STORE_ATTEMPTS, StoreConflictError, serializeStore, } from "../core/store.js";
import { hasMessage, t } from "../i18n/index.js";
import { allProcesses, processDetails } from "../platform/proc.js";
import { normalizeTerminal, toTerminalView } from "./host.js";
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
const POLL_MS = 250;
const PANE_WAIT_MS = 3_000;
export function newCoordinator() {
    return {
        store: null,
        storeRev: undefined,
        busy: new Set(),
        whenDone: new Set(),
        progress: new Map(),
        fresh: new Map(),
        answers: new Map(),
        agents: new Map(),
        checkedAt: new Map(),
        commands: new Map(),
    };
}
const RUNNING = ["running", "working", "confirming"];
const SLEEPING = ["asleep", "interrupted", "elsewhere", "missing", "error"];
const baseName = (path) => path.split(/[\\/]/).pop() ?? path;
const program = (arg) => baseName(arg)
    .replace(/\.(exe|cmd|bat|ps1)$/i, "")
    .toLowerCase();
const SHELLS = /^(pwsh|powershell|cmd|bash|zsh|fish|sh|nu|dash|ksh|tcsh|csh)$/;
/**
 * The terminal's own program is not a shell: it is the agent itself (started
 * by argv, as Resume does). While such a terminal lives, its agent is there,
 * reported or not; when the agent exits, the terminal ends.
 */
function agentOwnsTerminal(term) {
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
const RECHECK = { claude: "process", codex: "newer" };
/** A command line to type into a shell: plain words as they are, anything else in single quotes. */
export function commandLine(argv) {
    return argv.map((a) => (/^[\w@%+=:,./\\-]+$/.test(a) ? a : `'${a.replace(/'/g, "''")}'`)).join(" ");
}
const asLeader = (value) => typeof value === "object" &&
    value !== null &&
    typeof value.id === "string" &&
    typeof value.at === "number"
    ? value
    : null;
export class Engine {
    host;
    ports;
    id;
    adapters;
    co;
    path;
    revSeq = 0;
    absentSince = new Map();
    bindTried = new Map();
    flowSince = new Map();
    constructor(o) {
        this.host = o.host;
        this.ports = o.ports;
        this.id = o.id;
        this.adapters = o.adapters ?? ADAPTERS;
        this.co = o.coordinator ?? newCoordinator();
        this.path = o.storePath ?? defaultStorePath(o.ports);
    }
    // ---- reading
    /** Reads the store unless the cached copy is current. */
    async load() {
        const rev = this.host.shared(REV_KEY);
        if (this.co.store !== null && rev === this.co.storeRev) {
            return;
        }
        this.co.store = await readStore(this.ports, this.path);
        this.co.storeRev = rev;
    }
    /** Changes whenever the cached store does (a write here or a read of another window's write). */
    revision() {
        return this.co.store;
    }
    /** Whether the cache is behind another copy's write (then `load`). */
    stale() {
        return this.co.store === null || this.host.shared(REV_KEY) !== this.co.storeRev;
    }
    records() {
        return Object.values(this.co.store?.sessions ?? {});
    }
    record(key) {
        return this.co.store?.sessions[key] ?? null;
    }
    progress(key) {
        return this.co.progress.get(key) ?? null;
    }
    freshness(key) {
        return this.co.fresh.get(key) ?? null;
    }
    /** A copy is acting on this session now (its buttons wait). */
    busy(key) {
        return this.co.busy.has(key);
    }
    /** The person chose "Sleep when done" and the agent has not finished yet. */
    sleepingWhenDone(key) {
        return this.co.whenDone.has(key);
    }
    adapter(agent) {
        return this.adapters[agent];
    }
    isLeader() {
        const cur = asLeader(this.host.shared(LEADER_KEY));
        return cur !== null && cur.id === this.id && this.ports.now() - cur.at < LEADER_STALE_MS;
    }
    /** Gives up leadership (the copy is closing), so another takes over at once. */
    release() {
        if (asLeader(this.host.shared(LEADER_KEY))?.id === this.id) {
            this.host.setShared(LEADER_KEY, null);
        }
    }
    // ---- the leader's round
    /** Every copy calls this every TICK_MS; only the leader does more than read. */
    async tick() {
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
    claim() {
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
    async observe(term) {
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
                if (agentOwnsTerminal(term) || this.silentAgent(term)) {
                    // Silent (at its own prompt, or not reporting at all), not gone.
                    this.absentSince.delete(term.address);
                    await this.follow(term, cls.key);
                }
                else {
                    await this.agentGone(term, cls.key, cls.agent, cls.sessionId);
                }
                return;
        }
    }
    detect(view) {
        return Object.values(this.adapters).find((a) => a.matches(view)) ?? null;
    }
    /** Finds the session of an agent's terminal and records it. Returns its key, or null if not (yet) known. */
    async bind(term, adapter, force = false) {
        const now = this.ports.now();
        if (!force && now - (this.bindTried.get(term.address) ?? Number.NEGATIVE_INFINITY) < BIND_RETRY_MS) {
            return null;
        }
        this.bindTried.set(term.address, now);
        let sessionId = null;
        try {
            sessionId = await adapter.discoverSession(toTerminalView(term), this.ports);
        }
        catch {
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
        await this.noteAgent(term, adapter);
        return key;
    }
    async label(term, agent, sessionId) {
        const labels = { ...sessionLabels(agent, sessionId, "running") };
        if (term.pid !== null) {
            labels[LABEL_PID] = String(term.pid);
        }
        const changed = Object.entries(labels).filter(([k, v]) => term.labels[k] !== v);
        if (changed.length > 0) {
            await this.ports.hc(["label", term.address, ...changed.map(([k, v]) => `${k}=${v}`)]);
        }
    }
    /** A bound agent that is there: keep the record's state in step with what it reports. */
    async follow(term, key) {
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
        const known = this.co.agents.get(term.address);
        if (known !== undefined && term.status !== null) {
            known.reported = true;
        }
        const working = isWorking(term.status);
        const idle = term.status !== null && !working;
        if (rec.state === "running" && working) {
            await this.dispatch(key, { t: "agentWorking" });
        }
        else if (rec.state === "working" && idle) {
            await this.dispatch(key, { t: "agentIdle" });
            // A turn just ended: the session may be another one now (/clear, /resume, Codex /new).
            await this.verifySession(key);
        }
        else if (rec.state === "confirming" && idle && this.co.whenDone.has(key)) {
            await this.act(key, () => this.dispatch(key, { t: "interruptAndSleep" }));
        }
        else if (rec.state === "confirming" && this.co.answers.has(key)) {
            await this.takeAnswer(key);
        }
    }
    /**
     * A terminal labelled "running" without its agent. Same shell as when it was
     * bound: the person left the agent. A new process: the terminal was lost
     * (core crash, restart) and came back as a shell. Either way only after a
     * short grace, and never by starting anything.
     */
    async agentGone(term, key, agent, sessionId) {
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
    async reconcile(terms) {
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
            }
            else if (SLEEPING.includes(rec.state)) {
                gone = rec.pane === null || !panes.has(rec.pane);
            }
            else {
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
    async recover(rec, live) {
        const key = rec.key;
        if (rec.state === "stopping") {
            const running = rec.terminal !== null && live.has(rec.terminal);
            await this.act(key, () => this.dispatch(key, running ? { t: "stopTimeout" } : { t: "stopped", forced: false }));
        }
        else if (rec.state === "waking") {
            await this.act(key, () => this.dispatch(key, { t: "startFailed", reason: "reason.interrupted" }));
        }
    }
    // ---- which session a terminal runs now
    /** A terminal whose agent was found under its shell and has not reported yet: silent, not gone. */
    silentAgent(term) {
        const known = this.co.agents.get(term.address);
        return known !== undefined && known.shell === term.pid && !known.reported;
    }
    /**
     * The agent's process under this terminal's shell, from one process
     * snapshot (PowerShell on Windows: seconds), never per process. With
     * `args`, it must also run with them (somewhere in its process chain).
     */
    async findAgent(term, adapter, args) {
        if (term.pid === null) {
            return null;
        }
        const shell = term.pid;
        const tree = await processDetails(this.ports).catch(() => []);
        const below = new Set(subtree(tree, shell));
        below.delete(shell);
        const under = tree.filter((d) => below.has(d.pid));
        const view = toTerminalView(term);
        const agent = under.find((d) => adapter.matches({ ...view, app: null, foreground: { pid: d.pid, argv: [d.name], name: d.name } }));
        if (agent === undefined) {
            return null;
        }
        if (args !== null && !args.every((arg) => under.some((d) => (d.commandLine ?? "").includes(arg)))) {
            return null;
        }
        return { shell, pid: agent.pid, name: agent.name, reported: false };
    }
    /**
     * Once per terminal (not on a timer): the agent's own process under its
     * shell, for agents looked up by it. One snapshot; none when the foreground
     * already is the agent or it is known.
     */
    async noteAgent(term, adapter) {
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
    recheckView(term, adapter) {
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
    async verifySession(key) {
        const rec = this.record(key);
        const term = rec?.terminal ? this.term(rec.terminal) : null;
        if (rec === null || term === null || term.state !== "live" || !RUNNING.includes(rec.state)) {
            return key;
        }
        const adapter = this.adapter(rec.agent);
        const view = this.recheckView(term, adapter);
        const lookedAt = this.ports.now();
        let sessionId = null;
        try {
            sessionId = await adapter.discoverSession(view, this.ports);
        }
        catch {
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
        return this.rekey(rec, term, sessionId);
    }
    /** The terminal now runs `sessionId`: its record and labels move there; the old id is let go. */
    async rekey(rec, term, sessionId) {
        const key = sessionKey(rec.agent, sessionId);
        await this.label(term, rec.agent, sessionId);
        await this.mutate((file) => {
            const old = file.sessions[rec.key] ?? rec;
            delete file.sessions[rec.key];
            const there = file.sessions[key];
            // A session that sleeps in another tab keeps its record there (that tab shows "open elsewhere").
            if (there === undefined || RUNNING.includes(there.state) || there.terminal === term.address) {
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
            return true;
        });
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
    async sleep(asked) {
        await this.load();
        // The agent may have moved to another session since it was bound (/clear, /resume, Codex /new).
        const key = this.co.busy.has(asked) ? asked : await this.verifySession(asked);
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
            }
            else if (rec.state === "working" && term.status !== null && !working) {
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
            await this.waitUntil(() => this.co.answers.has(key) || this.record(key)?.state !== "confirming", QUESTION_WAIT_MS);
            await this.takeAnswer(key);
        }
    }
    /** Carries out a recorded answer, if there is one. */
    async takeAnswer(key) {
        const choice = this.co.answers.get(key);
        if (choice !== undefined && !this.co.busy.has(key)) {
            this.co.answers.delete(key);
            await this.choose(key, choice);
        }
    }
    /** Sleep for whatever agent runs in this terminal, binding it first if needed. */
    async sleepTerminal(address) {
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
    answer(key, choice) {
        this.co.answers.set(key, choice);
    }
    /** The answer to "is still answering". */
    async choose(key, choice) {
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
        }
        else {
            await this.act(key, () => this.dispatch(key, { t: "interruptAndSleep" }));
        }
    }
    /** Resume (also Retry). Returns the state it ended in. */
    async resume(key, how = "resume") {
        await this.load();
        let end = this.record(key)?.state ?? null;
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
    async startNew(key) {
        await this.load();
        await this.act(key, async () => {
            const rec = this.record(key);
            if (rec !== null) {
                await this.dispatch(key, { t: "startNew", argv: this.adapter(rec.agent).newArgv(rec.cwd) });
            }
        });
    }
    /** Forget: the record goes; the tab keeps an ordinary terminal where our pane was. */
    async forget(key) {
        await this.load();
        await this.act(key, async () => {
            const pane = this.record(key)?.pane ?? null;
            await this.dispatch(key, { t: "forget" });
            if (this.record(key) === null && pane !== null && this.paneExists(pane)) {
                const before = new Set(this.host.panes().map((p) => p.pane));
                this.host.run("pane.split", { pane, direction: "right" });
                const shell = await this.waitFor(() => this.host.panes().find((p) => !before.has(p.pane) && p.terminal !== null)?.pane ?? null, PANE_WAIT_MS);
                if (shell !== null) {
                    this.host.run("pane.swap", { pane: shell, target: pane });
                }
                this.host.run("pane.close", { pane });
            }
        });
    }
    /** Wakes every sleeping or interrupted session of a space, one after another. */
    async resumeAll(spaceId) {
        await this.load();
        const keys = this.records()
            .filter((r) => r.spaceId === spaceId && (r.state === "asleep" || r.state === "interrupted"))
            .map((r) => r.key);
        const woken = [];
        const skipped = [];
        for (const key of keys) {
            const end = await this.resume(key, "resumeAll");
            if (end === "elsewhere") {
                skipped.push(key);
            }
            else if (end === "running") {
                woken.push(key);
            }
        }
        if (skipped.length > 0) {
            this.host.notify(t("notice.skippedElsewhere"), "warning");
        }
        return { woken, skipped };
    }
    /** The strip is shown: is the conversation still there, and did it change while asleep? Once per show. */
    async refreshOnShow(key) {
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
        const newer = now.transcriptMtimeMs !== null &&
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
    async recheckElsewhere(key) {
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
    firstOf(command) {
        const now = this.ports.now();
        if (now - (this.co.commands.get(command) ?? Number.NEGATIVE_INFINITY) < 1_000) {
            return false;
        }
        this.co.commands.set(command, now);
        return true;
    }
    /** The command `suspender.resume-all`: Resume all in the shown space. */
    async resumeAllShown() {
        const space = this.host.tabs().find((x) => x.spaceActive)?.space;
        if (space !== undefined && this.firstOf("resume-all")) {
            await this.resumeAll(space);
        }
    }
    /** The command `suspender.toggle-focused`: Sleep the focused agent, or Resume the focused sleeping tab. */
    async toggleFocused() {
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
    focusedSleeper() {
        const pane = this.host.focused()?.pane;
        return pane ? (this.records().find((r) => r.pane === pane) ?? null) : null;
    }
    /** The command `suspender.forget`: Forget for the focused sleeping tab. */
    async forgetFocused() {
        await this.load();
        const rec = this.focusedSleeper();
        if (rec !== null && this.firstOf("forget")) {
            await this.forget(rec.key);
        }
    }
    /** The command `suspender.start-new`: Start new session for the focused tab whose conversation is gone. */
    async startNewFocused() {
        await this.load();
        const rec = this.focusedSleeper();
        if (rec?.state === "missing" && this.firstOf("start-new")) {
            await this.startNew(rec.key);
        }
    }
    // ---- the machine and its effects
    /** Runs `body` unless another copy is already acting on this session. */
    async act(key, body) {
        if (this.co.busy.has(key)) {
            return;
        }
        this.co.busy.add(key);
        try {
            await body();
        }
        finally {
            this.co.busy.delete(key);
        }
    }
    async dispatch(key, ev, flow = { prepared: null, pending: null }) {
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
    async execute(key, effect, ev, flow) {
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
                await this.placeSleepPane(key, flow, ev.t === "stopped" || ev.t === "agentExited", ev.t === "stopped" && ev.forced);
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
                const params = { agent, ...(effect.params ?? {}) };
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
    async snapshot(rec, adapter, readScreen, flow) {
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
    async memoryMb(root) {
        const [tree, all] = await Promise.all([processDetails(this.ports), allProcesses(this.ports)]);
        const kb = subtree(tree, root).reduce((sum, pid) => sum + (all.get(pid)?.rssKb ?? 0), 0);
        return kb > 0 ? Math.round(kb / 1024) : null;
    }
    /** The adapter's graceful stop, with our pane already in the terminal's slot (an exit may close its pane). */
    async stop(rec, adapter, flow) {
        const address = rec.terminal;
        if (address === null || !this.alive(address)) {
            return { next: { t: "stopped", forced: false } };
        }
        await this.prepare(rec.key, flow);
        const gone = () => {
            const term = this.term(address);
            return term === null || term.state !== "live" || !adapter.matches(toTerminalView(term));
        };
        for (const step of adapter.stopSteps()) {
            if (gone()) {
                break;
            }
            if ("key" in step) {
                await this.ports.hc(["keys", address, "esc"]);
            }
            else if ("send" in step) {
                // Typed key by key: `hc send` pastes, and wraps the text in an <hc from=…>
                // tag when Herdr itself runs inside a terminal; the agent then reads a
                // message instead of its command.
                await this.ports.hc(["keys", address, ...typedKeys(step.send), "enter"]);
            }
            else if ("waitIdleMs" in step) {
                await this.waitUntil(() => {
                    const status = this.term(address)?.status ?? null;
                    return gone() || (status !== null && !isWorking(status));
                }, step.waitIdleMs);
            }
            else if (!(await this.waitUntil(gone, step.waitExitMs))) {
                return { next: { t: "stopTimeout" } };
            }
        }
        return { next: { t: "stopped", forced: false } };
    }
    /** split → swap: our pane takes the terminal's slot (experiments.md E1); the terminal is closed later. */
    async prepare(key, flow) {
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
    async newSleepPane(rec, anchor) {
        const before = new Set(this.host.panes().map((p) => p.pane));
        const props = { role: "sleep", key: rec.key };
        const beside = anchor ?? this.host.panes().find((p) => p.tab === rec.tabId)?.pane ?? null;
        if (beside !== null) {
            this.host.run("pane.split", { pane: beside, direction: "right", mod: MOD_NAME, props });
        }
        else {
            this.host.run("tab.new", { space: rec.spaceId, mod: MOD_NAME, props });
        }
        return this.waitFor(() => this.host.panes().find((p) => !before.has(p.pane) && p.mod === MOD_NAME)?.pane ?? null, PANE_WAIT_MS);
    }
    /** `stopped`: the agent was just stopped (not lost); `forced`: by `terminal.kill`. */
    async placeSleepPane(key, flow, stopped, forced) {
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
     * Starts the agent as a new tab would (D02): Herdr's default shell in the
     * session's folder (`hc run` without a program, with Herdr's labels so it
     * adopts it into the tab), the resume command typed into it at its prompt.
     * `hc get` must show that shell; the agent must then run under it with the
     * command's arguments (one process snapshot per check, at most every 5 s).
     * After /exit the shell stays, like any tab. Our pane stays until the agent
     * is up, so a failure leaves it with the error and "Retry".
     */
    async start(key, adapter, argv, fresh) {
        const rec = this.record(key);
        if (rec === null) {
            return { next: { t: "startFailed", reason: "reason.spawn" } };
        }
        const failed = async (reason, address) => {
            if (address !== null) {
                await this.discard(address);
            }
            this.setProgress(key, null);
            return { next: { t: "startFailed", reason } };
        };
        this.setProgress(key, "found");
        const labels = fresh ? {} : sessionLabels(rec.agent, rec.sessionId, "running");
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
        await this.ports.hc(["keys", address, ...typedKeys(commandLine(argv)), "enter"]);
        const typedAt = this.ports.now();
        // Up when the agent runs under the shell with the command's arguments.
        // Herdr lists the terminal only once it adopts it; an agent at its own
        // prompt (Codex's update question) may report nothing to Herdr.
        let found = null;
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
            await this.host.sleep(POLL_MS);
        }
        if (found === null) {
            return failed("reason.timeout", address);
        }
        this.co.agents.set(address, found);
        this.co.checkedAt.set(address, this.ports.now());
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
                }
                else {
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
    async waitForPrompt(address) {
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
            await this.host.sleep(POLL_MS);
        }
    }
    /** Ends a terminal we started that did not come up right (through the core: Herdr may not list it yet). */
    async discard(address) {
        await this.ports.hc(["kill", address]).catch(() => null);
        await this.waitUntil(() => !this.alive(address), 3_000);
        await this.ports.hc(["rm", address]).catch(() => null);
    }
    async removeRecord(key) {
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
    async patch(key, change) {
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
    async mutate(change) {
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
    term(address) {
        return this.host.terminals().find((x) => x.address === address) ?? null;
    }
    alive(address) {
        return this.term(address)?.state === "live";
    }
    paneOf(address) {
        return this.host.panes().find((p) => p.terminal === address)?.pane ?? null;
    }
    paneExists(pane) {
        return this.host.panes().some((p) => p.pane === pane);
    }
    setProgress(key, step) {
        if (step === null) {
            this.co.progress.delete(key);
        }
        else {
            this.co.progress.set(key, step);
        }
        this.host.setShared(PROGRESS_KEY, { key, step, at: this.ports.now() });
    }
    async waitUntil(done, ms) {
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
    async waitFor(find, ms) {
        let found = null;
        await this.waitUntil(() => {
            found = find();
            return found !== null;
        }, ms);
        return found;
    }
}
const isWorking = (status) => status === "working" || status === "blocked";
/** `hc keys` names for typing `text`: each character is its own key, a space is "space". */
export function typedKeys(text) {
    return [...text].map((ch) => (ch === " " ? "space" : ch));
}
/**
 * `root` and every process under it, in one pass over the list (a process
 * table has hundreds of entries; Herdr's interpreter makes n² walks slow).
 */
export function subtree(list, root) {
    if (!list.some((d) => d.pid === root)) {
        return [];
    }
    const children = new Map();
    for (const d of list) {
        if (d.pid !== d.ppid) {
            children.set(d.ppid, [...(children.get(d.ppid) ?? []), d.pid]);
        }
    }
    const seen = new Set([root]);
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
function newRecord(key, agent, sessionId, term, state) {
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
function parseJson(text) {
    try {
        return JSON.parse(text);
    }
    catch {
        return null;
    }
}
function addressIn(stdout) {
    const value = parseJson(stdout);
    if (typeof value === "object" && value !== null && typeof value.address === "string") {
        return value.address;
    }
    return null;
}
