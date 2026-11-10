// Claude Code. Facts this relies on are in the build's research
// (agent-sessions.md): a live session keeps `~/.claude/sessions/<pid>.json`
// (pid, sessionId, cwd, startedAt, status, name) and removes it on exit; the
// conversation is `~/.claude/projects/<cwd, non-alphanumerics as ->/<id>.jsonl`,
// one JSON record per line (user, assistant, ai-title, custom-title, …).
import { descendsFrom, liveProcesses, processDetails } from "../platform/proc.js";
import { contextFields, emptyInfo, gitInfo, isRecord, join, jsonLines, num, oneLine, readTranscript, sameDir, str, terminalPids, tokensText, uuidIn, } from "./common.js";
/** Claude's context windows are 200k or 1M tokens; more than 200k in use means 1M. */
const SMALL_WINDOW = 200_000;
const LARGE_WINDOW = 1_000_000;
/** A session file written up to this long before the terminal existed still counts (clock skew). */
const START_SLACK_MS = 2_000;
/** Records any field comes from; the rest (attachments, api-request, …) is not parsed. */
const WANTED = /"type":\s*"(user|assistant|ai-title|custom-title|agent-name)"/;
const claudeDir = (p) => join(p, p.home(), ".claude");
const sessionsDir = (p) => join(p, claudeDir(p), "sessions");
const projectsDir = (p) => join(p, claudeDir(p), "projects");
/** Claude's folder name for a project: the cwd with every non-alphanumeric character as `-`. */
const projectName = (cwd) => cwd.replace(/[^A-Za-z0-9]/g, "-");
function parseLive(text) {
    if (text === null) {
        return null;
    }
    try {
        const value = JSON.parse(text);
        if (!isRecord(value)) {
            return null;
        }
        const pid = num(value["pid"]);
        const sessionId = str(value["sessionId"]);
        const cwd = str(value["cwd"]);
        if (pid === null || sessionId === null || cwd === null) {
            return null;
        }
        return { pid, sessionId, cwd, startedAt: num(value["startedAt"]) ?? 0, name: str(value["name"]) };
    }
    catch {
        return null;
    }
}
async function liveSessions(p) {
    const dir = sessionsDir(p);
    const names = (await p.list(dir)).filter((name) => /^\d+\.json$/.test(name));
    const parsed = await Promise.all(names.map(async (name) => parseLive(await p.readText(join(p, dir, name)))));
    return parsed.filter((s) => s !== null);
}
/** The transcript's path: in the cwd's project folder, else in whichever project folder has it (long or renamed paths). */
async function findTranscript(sessionId, cwd, p) {
    const file = `${sessionId}.jsonl`;
    const projects = projectsDir(p);
    const own = projectName(cwd);
    if ((await p.list(join(p, projects, own))).includes(file)) {
        return join(p, projects, own, file);
    }
    for (const dir of await p.list(projects)) {
        if (dir !== own && (await p.list(join(p, projects, dir))).includes(file)) {
            return join(p, projects, dir, file);
        }
    }
    return null;
}
const noFacts = () => ({
    title: null,
    titleRank: 0,
    firstPrompt: null,
    lastReply: null,
    model: null,
    branch: null,
    context: null,
    maxContext: 0,
    messages: 0,
    tokensIn: 0,
    tokensOut: 0,
    usageSeen: false,
});
/** The text a person typed: not a tool result, not a meta or command record, not another agent's message. */
function humanPrompt(r) {
    if (r["type"] !== "user" || r["isSidechain"] === true || r["isMeta"] === true) {
        return null;
    }
    const origin = r["origin"];
    if (isRecord(origin) && origin["kind"] !== "human") {
        return null;
    }
    const message = r["message"];
    const content = isRecord(message) ? message["content"] : null;
    let text = null;
    if (typeof content === "string") {
        text = content;
    }
    else if (Array.isArray(content) && content.every((b) => isRecord(b) && b["type"] === "text")) {
        text = content.map((b) => (isRecord(b) ? String(b["text"] ?? "") : "")).join("\n");
    }
    if (text === null || text.trimStart().startsWith("<")) {
        return null;
    }
    return oneLine(text);
}
function assistantText(content) {
    if (!Array.isArray(content)) {
        return null;
    }
    const parts = content.filter((b) => isRecord(b) && b["type"] === "text").map((b) => String(b["text"] ?? ""));
    return parts.length === 0 ? null : oneLine(parts.join("\n"));
}
function scan(records, facts) {
    const counted = new Set();
    const billed = new Set();
    for (const r of records) {
        const branch = str(r["gitBranch"]);
        if (branch !== null) {
            facts.branch = branch;
        }
        const type = r["type"];
        const title = type === "custom-title"
            ? { text: str(r["customTitle"]), rank: 3 }
            : type === "agent-name"
                ? { text: str(r["agentName"]), rank: 2 }
                : type === "ai-title"
                    ? { text: str(r["aiTitle"]), rank: 1 }
                    : null;
        if (title?.text && title.rank >= facts.titleRank) {
            facts.title = oneLine(title.text, 200);
            facts.titleRank = title.rank;
        }
        const prompt = humanPrompt(r);
        if (prompt !== null) {
            facts.firstPrompt ??= prompt;
            facts.messages++;
        }
        const message = r["message"];
        if (type !== "assistant" || r["isSidechain"] === true || !isRecord(message)) {
            continue;
        }
        const model = str(message["model"]);
        if (model === null || model === "<synthetic>") {
            continue;
        }
        facts.model = model;
        const id = str(message["id"]) ?? str(r["uuid"]) ?? String(counted.size);
        const reply = assistantText(message["content"]);
        if (reply !== null) {
            facts.lastReply = reply;
            if (!counted.has(id)) {
                counted.add(id);
                facts.messages++;
            }
        }
        const usage = message["usage"];
        if (isRecord(usage)) {
            const input = (num(usage["input_tokens"]) ?? 0) +
                (num(usage["cache_read_input_tokens"]) ?? 0) +
                (num(usage["cache_creation_input_tokens"]) ?? 0);
            facts.context = input;
            facts.maxContext = Math.max(facts.maxContext, input);
            // One API message is written as one record per content block, each with the same usage.
            if (!billed.has(id)) {
                billed.add(id);
                facts.usageSeen = true;
                facts.tokensIn += input;
                facts.tokensOut += num(usage["output_tokens"]) ?? 0;
            }
        }
    }
    return facts;
}
async function snapshot(sessionId, cwd, p, prev) {
    const path = await findTranscript(sessionId, cwd, p);
    const read = path === null ? { kind: "missing" } : await readTranscript(path, p, prev);
    if (read.kind === "unchanged" && prev) {
        return { ...prev };
    }
    const git = await gitInfo(cwd, p);
    const base = { ...(prev ?? emptyInfo(sessionId, cwd)), sessionId, cwd, repoRoot: git.repoRoot };
    if (read.kind === "missing" || read.kind === "unchanged") {
        return { ...base, transcriptSize: null, transcriptMtimeMs: null };
    }
    let facts = noFacts();
    if (read.kind === "grown" && prev) {
        facts = {
            ...facts,
            title: prev.title,
            // A title from before keeps its place against a generated one, not against the user's.
            titleRank: prev.title === null ? 0 : 1.5,
            firstPrompt: prev.firstPrompt,
            lastReply: prev.lastReply,
            model: prev.model,
            branch: prev.branch,
        };
    }
    if (read.kind === "ends") {
        facts = scan(jsonLines(read.head, WANTED), facts);
        // The head is only for what comes first; the tail says what is current.
        facts = { ...noFacts(), firstPrompt: facts.firstPrompt, title: facts.title, titleRank: facts.titleRank };
    }
    facts = scan(jsonLines(read.text, WANTED), facts);
    const windowKnown = facts.maxContext > SMALL_WINDOW ||
        /\[1m\]/i.test(facts.model ?? "") ||
        (read.kind === "grown" && prev?.contextPct !== null && prev?.contextPct !== undefined);
    const context = facts.context !== null
        ? contextFields(facts.context, windowKnown ? LARGE_WINDOW : null)
        : read.kind === "grown"
            ? { contextPct: base.contextPct, contextText: base.contextText }
            : { contextPct: null, contextText: null };
    const messages = read.kind === "whole"
        ? facts.messages
        : read.kind === "grown" && prev?.messages !== null && prev?.messages !== undefined
            ? prev.messages + facts.messages
            : null;
    // Totals need every turn: known only from a whole read; a grown read keeps them if no turn was added.
    const tokens = read.kind === "whole"
        ? tokensText(facts.usageSeen ? facts.tokensIn : null, facts.tokensOut)
        : read.kind === "grown" && !facts.usageSeen
            ? base.tokensText
            : null;
    let title = facts.title;
    if (title === null) {
        title = oneLine((await liveSessions(p)).find((s) => s.sessionId === sessionId)?.name ?? null, 200);
    }
    return {
        ...base,
        title,
        firstPrompt: facts.firstPrompt,
        lastReply: facts.lastReply,
        messages,
        branch: facts.branch ?? git.branch,
        model: facts.model,
        ...context,
        tokensText: tokens,
        transcriptMtimeMs: read.mtimeMs,
        transcriptSize: read.size,
    };
}
// ---- finding the session
async function discoverSession(t, p) {
    const fg = t.foreground;
    if (fg !== null) {
        // POSIX: the foreground process is claude itself.
        const own = parseLive(await p.readText(join(p, sessionsDir(p), `${fg.pid}.json`)));
        if (own !== null) {
            return own.sessionId;
        }
    }
    const candidates = (await liveSessions(p)).filter((s) => sameDir(s.cwd, t.cwd, p) && s.startedAt >= t.createdMs - START_SLACK_MS);
    if (candidates.length === 1) {
        return candidates[0]?.sessionId ?? null;
    }
    if (candidates.length > 1 && fg !== null) {
        // Two sessions in one folder: the one whose process runs under this terminal's shell.
        const tree = await processDetails(p);
        const ours = candidates.filter((s) => descendsFrom(tree, s.pid, fg.pid));
        return ours.length === 1 ? (ours[0]?.sessionId ?? null) : null;
    }
    // No session file (yet): `claude --resume <id>` / `--session-id <id>` in the visible argv.
    const argv = fg?.argv ?? [];
    return argv.some((a) => a === "--resume" || a === "-r" || a === "--session-id") ? uuidIn(argv) : null;
}
async function openElsewhere(sessionId, p, exceptTerminal) {
    const holders = (await liveSessions(p)).filter((s) => s.sessionId === sessionId);
    if (holders.length === 0) {
        return { open: false };
    }
    // A file can outlive its process (a crash) and a pid can be reused: the process must be alive and be claude.
    const live = await liveProcesses(holders.map((s) => s.pid), p);
    let alive = holders.filter((s) => /claude/i.test(live.get(s.pid)?.name ?? ""));
    if (exceptTerminal !== undefined && alive.length > 0) {
        const own = await terminalPids(exceptTerminal, p);
        alive = alive.filter((s) => !own.includes(s.pid));
        if (alive.length > 0 && own.length > 0) {
            const tree = await processDetails(p);
            alive = alive.filter((s) => !own.some((pid) => descendsFrom(tree, s.pid, pid)));
        }
    }
    const first = alive[0];
    return first === undefined ? { open: false } : { open: true, where: `pid ${first.pid}` };
}
const STOP_STEPS = [{ key: "escape" }, { waitIdleMs: 10_000 }, { send: "/exit" }, { waitExitMs: 10_000 }];
export const claudeAdapter = {
    id: "claude",
    displayName: "Claude Code",
    matches: (t) => t.app === "claude-code" ||
        t.app === "claude" ||
        /^claude(\.exe)?$/i.test(t.foreground?.name ?? "") ||
        /(^|[\\/])claude(\.exe)?$/i.test(t.foreground?.argv[0] ?? ""),
    discoverSession,
    snapshot,
    transcriptExists: async (sessionId, cwd, p) => (await findTranscript(sessionId, cwd, p)) !== null,
    openElsewhere,
    watchOpenness: async (p) => {
        await p.watch(sessionsDir(p));
    },
    stopSteps: () => STOP_STEPS.map((step) => ({ ...step })),
    resumeArgv: (sessionId) => ["claude", "--resume", sessionId],
    newArgv: () => ["claude"],
};
