// Helpers the adapters share: paths, JSON Lines, git, number formatting, and
// the incremental transcript read that keeps the mod cheap (spec story 39, D01).
export function join(p, ...parts) {
    return parts
        .filter((part) => part !== "")
        .map((part, i) => (i === 0 ? part.replace(/[\\/]+$/, "") : part.replace(/^[\\/]+|[\\/]+$/g, "")))
        .join(p.sep);
}
/** Same folder? Ignores trailing separators and, on Windows, case and slash direction. */
export function sameDir(a, b, p) {
    const norm = (dir) => {
        const trimmed = dir.replace(/[\\/]+$/, "");
        return p.platform === "windows" ? trimmed.replace(/\//g, "\\").toLowerCase() : trimmed;
    };
    return norm(a) === norm(b);
}
export function baseName(path) {
    return path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
}
export const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
export const str = (value) => (typeof value === "string" && value !== "" ? value : null);
export const num = (value) => typeof value === "number" && Number.isFinite(value) ? value : null;
/**
 * Every line of `text` that parses as a JSON object; anything else (a cut line)
 * is skipped. `wanted` skips lines before parsing them (a whole 50 MB transcript
 * is mostly records no field needs); it may let extra lines through, never drop needed ones.
 */
export function jsonLines(text, wanted) {
    const records = [];
    for (const line of text.split("\n")) {
        if (line.trim() === "" || (wanted !== undefined && !wanted.test(line))) {
            continue;
        }
        try {
            const value = JSON.parse(line);
            if (isRecord(value)) {
                records.push(value);
            }
        }
        catch {
            // A line cut by a partial read, or one being written right now.
        }
    }
    return records;
}
/** One line of at most `max` characters, or null if nothing is left. */
export function oneLine(text, max = 400) {
    if (text === null) {
        return null;
    }
    const flat = text.replace(/\s+/g, " ").trim();
    if (flat === "") {
        return null;
    }
    return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
/** 950, 8.4k, 192k, 1.2M, 1M. */
export function compact(n) {
    if (n < 1000) {
        return String(Math.round(n));
    }
    if (n < 1_000_000) {
        const k = n / 1000;
        return `${k < 10 ? trim1(k) : Math.round(k)}k`;
    }
    return `${trim1(n / 1_000_000)}M`;
}
const trim1 = (x) => x.toFixed(1).replace(/\.0$/, "");
/** "192k / 1M" with a window, "192k" without; the percentage agrees with the text. */
export function contextFields(used, window) {
    if (used === null || used <= 0) {
        return { contextPct: null, contextText: null };
    }
    if (window === null || window <= 0) {
        return { contextPct: null, contextText: compact(used) };
    }
    return {
        contextPct: Math.min(100, Math.round((used / window) * 100)),
        contextText: `${compact(used)} / ${compact(window)}`,
    };
}
/** "↑1.2M ↓86k": tokens sent to the model and received from it. */
export function tokensText(input, output) {
    if (input === null || output === null || input + output <= 0) {
        return null;
    }
    return `↑${compact(input)} ↓${compact(output)}`;
}
/** The repository holding `cwd` and its checked-out branch, from `.git/HEAD` (or a worktree's `.git` file). */
export async function gitInfo(cwd, p) {
    let dir = cwd.replace(/[\\/]+$/, "");
    for (let depth = 0; depth < 40 && dir !== ""; depth++) {
        let head = await p.readText(join(p, dir, ".git", "HEAD"));
        if (head === null) {
            const pointer = await p.readText(join(p, dir, ".git"));
            const gitdir = pointer === null ? null : /^gitdir:\s*(.+)$/m.exec(pointer)?.[1]?.trim();
            if (gitdir) {
                const absolute = /^([A-Za-z]:)?[\\/]/.test(gitdir) ? gitdir : join(p, dir, gitdir);
                head = await p.readText(join(p, absolute, "HEAD"));
            }
        }
        if (head !== null) {
            const ref = /^ref:\s*refs\/heads\/(.+)$/m.exec(head)?.[1]?.trim();
            return { repoRoot: dir, branch: ref ?? null };
        }
        // Up one folder; `C:` (then `C:\.git`) is the last stop on Windows, `/` is skipped.
        const cut = Math.max(dir.lastIndexOf("/"), dir.lastIndexOf("\\"));
        if (cut <= 0) {
            break;
        }
        dir = dir.slice(0, cut);
    }
    return { repoRoot: null, branch: null };
}
export function emptyInfo(sessionId, cwd) {
    return {
        title: null,
        firstPrompt: null,
        lastReply: null,
        messages: null,
        branch: null,
        model: null,
        cwd,
        repoRoot: null,
        sessionId,
        contextPct: null,
        contextText: null,
        tokensText: null,
        transcriptMtimeMs: null,
        transcriptSize: null,
    };
}
/** Budgets for one snapshot: < 2 MB in all (ticket 03). */
export const TAIL_BYTES = 1024 * 1024;
export const HEAD_BYTES = 512 * 1024;
/** UTF-8 length of `text` in bytes (no TextEncoder in Herdr's runtime types). */
function utf8Length(text) {
    let bytes = 0;
    for (const char of text) {
        const code = char.codePointAt(0) ?? 0;
        bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    }
    return bytes;
}
/**
 * Reads what changed in a JSON Lines transcript since `prev`: nothing if size
 * and time match, the appended bytes if it only grew, else the whole file or
 * its two ends. A half-written last line is left for next time: `size` stops
 * before it, so the next read starts at that line.
 */
export async function readTranscript(path, p, prev) {
    const st = await p.stat(path);
    if (st === null) {
        return { kind: "missing" };
    }
    const known = prev?.transcriptSize ?? null;
    if (known !== null && known === st.size && prev?.transcriptMtimeMs === st.mtimeMs) {
        return { kind: "unchanged", mtimeMs: st.mtimeMs };
    }
    const settled = (text) => {
        const cut = text.lastIndexOf("\n");
        const rest = text.slice(cut + 1);
        return rest === "" ? { text, size: st.size } : { text: text.slice(0, cut + 1), size: st.size - utf8Length(rest) };
    };
    // Where every read is whole anyway (Herdr, D01), take the whole file in one read
    // instead of its two ends: exact counts cost nothing extra.
    const whole = p.wholeReads === true;
    if (known !== null && st.size >= known && st.size - known <= TAIL_BYTES) {
        const grown = st.size - known;
        const text = grown === 0 ? "" : ((await p.readTail(path, grown)) ?? "");
        return { kind: "grown", mtimeMs: st.mtimeMs, ...settled(text) };
    }
    if (whole || st.size <= TAIL_BYTES) {
        const text = (await p.readTail(path, st.size)) ?? "";
        return { kind: "whole", mtimeMs: st.mtimeMs, ...settled(text) };
    }
    const head = (await p.readHead(path, HEAD_BYTES)) ?? "";
    const text = (await p.readTail(path, TAIL_BYTES)) ?? "";
    return { kind: "ends", head, mtimeMs: st.mtimeMs, ...settled(text) };
}
/** A uuid anywhere in `args` (e.g. `codex resume <id>`, `claude --resume <id>`). */
export function uuidIn(args) {
    for (const arg of args) {
        const match = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i.exec(arg);
        if (match) {
            return match[0].toLowerCase();
        }
    }
    return null;
}
/** The terminal's own pids (`hc get <t> --json`: pid and foreground.pid). */
export async function terminalPids(address, p) {
    try {
        const out = await p.hc(["get", address, "--json"]);
        const value = JSON.parse(out.stdout);
        if (!isRecord(value)) {
            return [];
        }
        const fg = isRecord(value["foreground"]) ? num(value["foreground"]["pid"]) : null;
        return [num(value["pid"]), fg].filter((pid) => pid !== null);
    }
    catch {
        return [];
    }
}
