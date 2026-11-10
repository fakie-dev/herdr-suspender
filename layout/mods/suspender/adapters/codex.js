// Codex CLI. Facts this relies on are in the build's research
// (agent-sessions.md): each session is a rollout file
// `~/.codex/sessions/YYYY/MM/DD/rollout-<local time>-<uuid>.jsonl` whose first
// line is `session_meta` (id, cwd, timestamp); ids are UUIDv7, so the id
// carries the start time. Names given with /rename are in
// `~/.codex/session_index.jsonl`. `state_5.sqlite` is not read: Herdr's
// runtime has no SQLite and the mod has no native packages.
import { allProcesses, descendsFrom, processDetails } from "../platform/proc.js";
import { baseName, contextFields, emptyInfo, gitInfo, isRecord, join, jsonLines, num, oneLine, readTranscript, sameDir, str, terminalPids, tokensText, uuidIn, } from "./common.js";
const DAY_MS = 86_400_000;
const START_SLACK_MS = 2_000;
/** A rollout written this recently is taken as open somewhere. */
const FRESH_MS = 15_000;
/** How often a terminal may cost a process listing on Windows (PowerShell) while its id is unknown. */
const DETAILS_EVERY_MS = 60_000;
/** How many days back discovery looks for a terminal opened long ago. */
const MAX_DAYS_BACK = 7;
/** Records any field comes from; reasoning, tool calls and the like are not parsed. */
const WANTED = /"(message|turn_context|token_count)"/;
const codexDir = (p) => join(p, p.home(), ".codex");
const sessionsDir = (p) => join(p, codexDir(p), "sessions");
const pad = (n) => String(n).padStart(2, "0");
/** `YYYY`, `MM`, `DD` of a moment in local time: how Codex files rollouts. */
const dayParts = (ms) => {
    const d = new Date(ms);
    return [String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate())];
};
/** The time a UUIDv7 was made, or null for any other id. */
function uuidTime(id) {
    const match = /^([0-9a-f]{8})-([0-9a-f]{4})-7[0-9a-f]{3}-/i.exec(id);
    return match ? Number.parseInt(`${match[1]}${match[2]}`, 16) : null;
}
const ROLLOUT = /^rollout-.+-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
async function findRollout(sessionId, p) {
    const suffix = `-${sessionId}.jsonl`;
    const hit = (names) => names.find((n) => n.startsWith("rollout-") && n.endsWith(suffix));
    const root = sessionsDir(p);
    const born = uuidTime(sessionId);
    if (born !== null) {
        // Local date of its start; a day either side covers time zone edges.
        for (const offset of [0, -DAY_MS, DAY_MS]) {
            const dir = join(p, root, ...dayParts(born + offset));
            const name = hit(await p.list(dir));
            if (name) {
                return join(p, dir, name);
            }
        }
    }
    for (const year of await p.list(root)) {
        for (const month of await p.list(join(p, root, year))) {
            for (const day of await p.list(join(p, root, year, month))) {
                const dir = join(p, root, year, month, day);
                const name = hit(await p.list(dir));
                if (name) {
                    return join(p, dir, name);
                }
            }
        }
    }
    const archived = join(p, codexDir(p), "archived_sessions");
    const name = hit(await p.list(archived));
    return name ? join(p, archived, name) : null;
}
/** `cwd` from a rollout's first line, even if the read cut that line short (base instructions are long). */
function metaCwd(head) {
    if (head === null) {
        return null;
    }
    const end = head.indexOf("\n");
    const first = end === -1 ? head : head.slice(0, end);
    try {
        const value = JSON.parse(first);
        if (isRecord(value) && isRecord(value["payload"])) {
            return str(value["payload"]["cwd"]);
        }
    }
    catch {
        // Cut short: fall back to the field itself.
    }
    const match = /"cwd"\s*:\s*("(?:[^"\\]|\\.)*")/.exec(first);
    try {
        return match?.[1] ? str(JSON.parse(match[1])) : null;
    }
    catch {
        return null;
    }
}
// ---- finding the session
const detailsTried = new Map();
function codexProcesses(tree, shellPid) {
    return tree.filter((d) => (d.pid === shellPid || descendsFrom(tree, d.pid, shellPid)) &&
        /codex/i.test(`${d.name} ${d.commandLine ?? ""}`) &&
        !/app-server/i.test(d.commandLine ?? ""));
}
async function discoverSession(t, p) {
    const fg = t.foreground;
    if (fg?.argv.includes("resume")) {
        const id = uuidIn(fg.argv);
        if (id !== null) {
            return id;
        }
    }
    const root = sessionsDir(p);
    const now = p.now();
    const from = Math.max(t.createdMs - DAY_MS, now - MAX_DAYS_BACK * DAY_MS);
    const days = new Set();
    for (let ms = from; ms <= now + DAY_MS; ms += DAY_MS) {
        days.add(join(p, root, ...dayParts(Math.min(ms, now))));
    }
    const candidates = [];
    for (const dir of days) {
        for (const name of await p.list(dir)) {
            const id = ROLLOUT.exec(name)?.[1]?.toLowerCase();
            const born = id ? uuidTime(id) : null;
            if (!id || born === null || born < t.createdMs - START_SLACK_MS) {
                continue;
            }
            const cwd = metaCwd(await p.readHead(join(p, dir, name), 64 * 1024));
            if (cwd !== null && sameDir(cwd, t.cwd, p)) {
                candidates.push({ id, born });
            }
        }
    }
    if (candidates.length === 1) {
        return candidates[0]?.id ?? null;
    }
    if (fg === null) {
        return null;
    }
    // Zero (resumed from the shell, or not written yet) or several: ask the process tree,
    // which on Windows is PowerShell, so at most once a minute per terminal.
    if (p.platform === "windows") {
        const key = `${t.address}@${t.createdMs}`;
        if (now - (detailsTried.get(key) ?? Number.NEGATIVE_INFINITY) < DETAILS_EVERY_MS) {
            return null;
        }
        detailsTried.set(key, now);
    }
    const ours = codexProcesses(await processDetails(p), fg.pid);
    for (const proc of ours) {
        const id = uuidIn(proc.commandLine?.split(/\s+/) ?? []);
        if (id !== null && /\bresume\b/.test(proc.commandLine ?? "")) {
            return id;
        }
    }
    const starts = ours.map((d) => d.startMs).filter((ms) => ms !== null);
    if (starts.length === 0 || candidates.length === 0) {
        return null;
    }
    // The rollout a process makes is the first one after it started.
    const started = Math.min(...starts);
    const after = candidates.filter((c) => c.born >= started - START_SLACK_MS).sort((a, b) => a.born - b.born);
    return after[0]?.id ?? null;
}
const noFacts = () => ({
    firstPrompt: null,
    lastReply: null,
    model: null,
    messages: 0,
    context: null,
    window: null,
    tokensIn: null,
    tokensOut: null,
});
/** Text Codex itself puts in the user's turn: environment and instructions blocks. */
const injected = (text) => {
    const start = text.trimStart();
    return start.startsWith("<") || start.startsWith("# AGENTS.md instructions");
};
function messageText(content) {
    if (!Array.isArray(content)) {
        return "";
    }
    return content
        .filter((b) => isRecord(b) && (b["type"] === "input_text" || b["type"] === "output_text"))
        .map((b) => (isRecord(b) ? String(b["text"] ?? "") : ""))
        .join("\n");
}
function scan(records, facts) {
    for (const r of records) {
        const payload = r["payload"];
        if (!isRecord(payload)) {
            continue;
        }
        if (r["type"] === "turn_context") {
            facts.model = str(payload["model"]) ?? facts.model;
        }
        else if (r["type"] === "response_item" && payload["type"] === "message") {
            const text = oneLine(messageText(payload["content"]));
            if (text === null) {
                continue;
            }
            if (payload["role"] === "user" && !injected(text)) {
                facts.firstPrompt ??= text;
                facts.messages++;
            }
            else if (payload["role"] === "assistant") {
                facts.lastReply = text;
                facts.messages++;
            }
        }
        else if (r["type"] === "event_msg" && payload["type"] === "token_count" && isRecord(payload["info"])) {
            const info = payload["info"];
            const total = isRecord(info["total_token_usage"]) ? info["total_token_usage"] : {};
            const last = isRecord(info["last_token_usage"]) ? info["last_token_usage"] : {};
            facts.tokensIn = num(total["input_tokens"]) ?? facts.tokensIn;
            facts.tokensOut = num(total["output_tokens"]) ?? facts.tokensOut;
            facts.context = num(last["total_tokens"]) ?? facts.context;
            facts.window = num(info["model_context_window"]) ?? facts.window;
        }
    }
    return facts;
}
async function threadName(sessionId, p) {
    const index = await p.readText(join(p, codexDir(p), "session_index.jsonl"));
    let name = null;
    for (const r of jsonLines(index ?? "")) {
        if (r["id"] === sessionId) {
            name = str(r["thread_name"]) ?? name;
        }
    }
    return oneLine(name, 200);
}
async function snapshot(sessionId, cwd, p, prev) {
    const path = await findRollout(sessionId, p);
    const read = path === null ? { kind: "missing" } : await readTranscript(path, p, prev);
    if (read.kind === "unchanged" && prev) {
        return { ...prev };
    }
    const git = await gitInfo(cwd, p);
    const base = {
        ...(prev ?? emptyInfo(sessionId, cwd)),
        sessionId,
        cwd,
        repoRoot: git.repoRoot,
        // Codex keeps no branch in the rollout: the folder's current branch.
        branch: git.branch,
        title: (await threadName(sessionId, p)) ?? prev?.title ?? null,
    };
    if (read.kind === "missing" || read.kind === "unchanged") {
        return { ...base, transcriptSize: null, transcriptMtimeMs: null };
    }
    let facts = noFacts();
    if (read.kind === "grown" && prev) {
        facts = { ...facts, firstPrompt: prev.firstPrompt, lastReply: prev.lastReply, model: prev.model };
    }
    if (read.kind === "ends") {
        facts = { ...noFacts(), firstPrompt: scan(jsonLines(read.head, WANTED), noFacts()).firstPrompt };
    }
    facts = scan(jsonLines(read.text, WANTED), facts);
    const grown = read.kind === "grown";
    const context = facts.context !== null
        ? contextFields(facts.context, facts.window)
        : grown
            ? { contextPct: base.contextPct, contextText: base.contextText }
            : { contextPct: null, contextText: null };
    const messages = read.kind === "whole"
        ? facts.messages
        : grown && prev?.messages !== null && prev?.messages !== undefined
            ? prev.messages + facts.messages
            : null;
    return {
        ...base,
        firstPrompt: facts.firstPrompt,
        lastReply: facts.lastReply,
        model: facts.model,
        messages,
        ...context,
        // Codex writes running totals: the last count is the whole session's.
        tokensText: tokensText(facts.tokensIn, facts.tokensOut) ?? (grown ? base.tokensText : null),
        transcriptMtimeMs: read.mtimeMs,
        transcriptSize: read.size,
    };
}
// ---- open elsewhere
/** Windows command lines by `pid:name`: PowerShell runs only for codex processes not seen before. */
const commandLines = new Map();
async function codexCommandLines(p) {
    if (p.platform !== "windows") {
        return (await processDetails(p))
            .filter((d) => /codex/i.test(`${d.name} ${d.commandLine ?? ""}`))
            .map((d) => ({ pid: d.pid, commandLine: d.commandLine }));
    }
    const codex = [...(await allProcesses(p))].filter(([, live]) => /codex/i.test(live.name));
    const key = (pid, name) => `${pid}:${name}`;
    if (codex.some(([pid, live]) => !commandLines.has(key(pid, live.name)))) {
        const details = new Map((await processDetails(p)).map((d) => [d.pid, d]));
        for (const [pid, live] of codex) {
            commandLines.set(key(pid, live.name), details.get(pid)?.commandLine ?? null);
        }
    }
    return codex.map(([pid, live]) => ({ pid, commandLine: commandLines.get(key(pid, live.name)) ?? null }));
}
async function openElsewhere(sessionId, p, exceptTerminal) {
    let holders = (await codexCommandLines(p)).filter((c) => (c.commandLine ?? "").toLowerCase().includes(sessionId.toLowerCase()));
    if (exceptTerminal !== undefined && holders.length > 0) {
        const own = await terminalPids(exceptTerminal, p);
        if (own.length > 0) {
            const tree = await processDetails(p);
            holders = holders.filter((h) => !own.includes(h.pid) && !own.some((pid) => descendsFrom(tree, h.pid, pid)));
        }
    }
    const first = holders[0];
    if (first !== undefined) {
        return { open: true, where: `pid ${first.pid}` };
    }
    // Resumed without the id on its command line (a picker, the desktop app): only its writes show it.
    if (exceptTerminal === undefined) {
        const path = await findRollout(sessionId, p);
        const st = path === null ? null : await p.stat(path);
        if (path !== null && st !== null && p.now() - st.mtimeMs < FRESH_MS) {
            return { open: true, where: baseName(path) };
        }
    }
    return { open: false };
}
const STOP_STEPS = [{ send: "/quit" }, { waitExitMs: 10_000 }];
export const codexAdapter = {
    id: "codex",
    displayName: "Codex",
    matches: (t) => t.app === "codex" ||
        /^codex(\.exe)?$/i.test(t.foreground?.name ?? "") ||
        /(^|[\\/])codex(\.exe)?$/i.test(t.foreground?.argv[0] ?? ""),
    discoverSession,
    snapshot,
    transcriptExists: async (sessionId, _cwd, p) => (await findRollout(sessionId, p)) !== null,
    openElsewhere,
    stopSteps: () => STOP_STEPS.map((step) => ({ ...step })),
    resumeArgv: (sessionId) => ["codex", "resume", sessionId],
    newArgv: () => ["codex"],
};
