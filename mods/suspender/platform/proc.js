// Processes and file times per operating system, through `Ports.exec` only:
// no "herdr" import, so the adapters and the tests use it as is.
//
// Cost matters (spec story 39): `memoryKb` and `statFile` are one cheap
// native call each (tasklist / ps, robocopy / stat). `processDetails` is the
// expensive one on Windows (PowerShell: nothing else built in lists parents
// and command lines since wmic was removed) and is only for rare paths:
// telling two sessions in one folder apart.
const TIMEOUT_MS = 10_000;
async function run(exec, cmd, args) {
    try {
        return await exec(cmd, args, { timeout: TIMEOUT_MS });
    }
    catch {
        return null;
    }
}
const digitsOnly = (text) => {
    const digits = text.replace(/\D/g, "");
    return digits === "" ? null : Number(digits);
};
/** Splits one `tasklist /FO CSV` line: `"name","pid","session","#","396 412 K"`. */
function csvFields(line) {
    return [...line.matchAll(/"((?:[^"]|"")*)"/g)].map((m) => (m[1] ?? "").replace(/""/g, '"'));
}
/**
 * The pids of a set that are alive, with name and resident memory. One process
 * start for the whole set: `tasklist` lists everything (its PID filters can't
 * be OR-ed); `ps -p` takes a list. Empty set: no process at all.
 */
export async function liveProcesses(pids, p) {
    return (await liveProcessesOrNull(pids, p)) ?? new Map();
}
/** As `liveProcesses`, but null when the system did not answer (the list failed): not the same as "none alive". */
export async function liveProcessesOrNull(pids, p) {
    const result = new Map();
    const wanted = new Set(pids);
    if (wanted.size === 0) {
        return result;
    }
    const all = await listAll(p, [...wanted]);
    if (all === null) {
        return null;
    }
    for (const [pid, live] of all) {
        if (wanted.has(pid)) {
            result.set(pid, live);
        }
    }
    return result;
}
/** Every process with name and resident memory: one cheap call (tasklist / ps). */
export async function allProcesses(p) {
    return (await listAll(p, null)) ?? new Map();
}
/** Null when the list could not be taken (the tool failed, or Windows listed nothing at all). */
async function listAll(p, only) {
    const result = new Map();
    if (p.platform === "windows") {
        const out = await run(p.exec, "tasklist", ["/FO", "CSV", "/NH"]);
        if (out === null) {
            return null;
        }
        for (const line of out.stdout.split(/\r?\n/)) {
            const fields = csvFields(line);
            const pid = Number(fields[1]);
            if (fields.length >= 5 && Number.isFinite(pid)) {
                result.set(pid, { name: fields[0] ?? "", rssKb: digitsOnly(fields[4] ?? "") });
            }
        }
        // tasklist lists every process there is: nothing at all means it did not work.
        return result.size === 0 ? null : result;
    }
    const select = only === null ? ["-A"] : ["-p", only.join(",")];
    const out = await run(p.exec, "ps", ["-o", "pid=,rss=,comm=", ...select]);
    if (out === null) {
        return null;
    }
    for (const line of out.stdout.split("\n")) {
        const match = /^\s*(\d+)\s+(\d+)\s*(.*)$/.exec(line);
        if (match) {
            result.set(Number(match[1]), { name: (match[3] ?? "").trim(), rssKb: Number(match[2]) });
        }
    }
    return result;
}
/** Resident memory (KiB) of each pid of the set that is alive: one process start for the set. */
export async function memoryKb(pids, p) {
    const result = new Map();
    for (const [pid, live] of await liveProcesses(pids, p)) {
        if (live.rssKb !== null) {
            result.set(pid, live.rssKb);
        }
    }
    return result;
}
/** `[[dd-]hh:]mm:ss` (ps etime) in seconds. */
function elapsedSeconds(text) {
    const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(text) ?? /^()()()(\d+)$/.exec(text);
    if (match === null) {
        return null;
    }
    const [, days, hours, minutes, seconds] = match.map((part) => Number(part || 0));
    return (((days ?? 0) * 24 + (hours ?? 0)) * 60 + (minutes ?? 0)) * 60 + (seconds ?? 0);
}
const WINDOWS_DETAILS = [
    "[Console]::OutputEncoding = [Text.Encoding]::UTF8",
    "Get-CimInstance Win32_Process | ForEach-Object {",
    "  $start = ''; if ($_.CreationDate) { $start = ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() }",
    '  "$($_.ProcessId)`t$($_.ParentProcessId)`t$start`t$($_.Name)`t$($_.CommandLine)"',
    "}",
].join("\n");
/** Every process with its parent, start time and command line. Slow on Windows (PowerShell): rare paths only. */
export async function processDetails(p) {
    const list = [];
    if (p.platform === "windows") {
        const out = await run(p.exec, "powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_DETAILS]);
        for (const line of out?.stdout.split(/\r?\n/) ?? []) {
            const [pid, ppid, start, name, ...rest] = line.split("\t");
            const commandLine = rest.join("\t").trim();
            if (pid && ppid && Number.isFinite(Number(pid))) {
                list.push({
                    pid: Number(pid),
                    ppid: Number(ppid),
                    startMs: start ? Number(start) : null,
                    name: name ?? "",
                    commandLine: commandLine === "" ? null : commandLine,
                });
            }
        }
        return list;
    }
    const now = p.now();
    const out = await run(p.exec, "ps", ["-A", "-o", "pid=,ppid=,etime=,args="]);
    for (const line of out?.stdout.split("\n") ?? []) {
        const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
        if (match === null) {
            continue;
        }
        const [, pid, ppid, etime, args] = match;
        const seconds = elapsedSeconds(etime ?? "");
        const commandLine = (args ?? "").trim();
        const first = commandLine.split(/\s+/)[0] ?? "";
        list.push({
            pid: Number(pid),
            ppid: Number(ppid),
            startMs: seconds === null ? null : now - seconds * 1000,
            name: first.slice(Math.max(first.lastIndexOf("/"), first.lastIndexOf("\\")) + 1),
            commandLine: commandLine === "" ? null : commandLine,
        });
    }
    return list;
}
/** True if `ancestor` is `pid`'s parent, grandparent, … (up to `maxDepth` levels). */
export function descendsFrom(list, pid, ancestor, maxDepth = 8) {
    const parent = new Map(list.map((d) => [d.pid, d.ppid]));
    let current = pid;
    for (let depth = 0; depth < maxDepth; depth++) {
        const next = parent.get(current);
        if (next === undefined || next === current) {
            return false;
        }
        if (next === ancestor) {
            return true;
        }
        current = next;
    }
    return false;
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
            const siblings = children.get(d.ppid);
            if (siblings === undefined) {
                children.set(d.ppid, [d.pid]);
            }
            else {
                siblings.push(d.pid);
            }
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
function splitPath(path) {
    const cut = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
    return { dir: cut > 0 ? path.slice(0, cut) : path, name: path.slice(cut + 1) };
}
/**
 * Size and modification time without reading the file (D01: Herdr's
 * "fs/promises" has neither stat nor partial reads). Windows: `robocopy /L`
 * lists the file without copying anything and prints its size in bytes and its
 * time in UTC to the second, in the same format on every locale (`cmd`'s
 * `%~tI` gives local minutes in the locale's own format). POSIX: `stat`.
 * Null if the file or its folder is missing, or the tool failed.
 */
export async function statFile(path, platform, exec) {
    if (platform === "windows") {
        const { dir, name } = splitPath(path);
        const out = await run(exec, "robocopy", [
            dir,
            `${dir}\\.suspender-stat-probe`,
            name,
            "/L",
            "/IS",
            "/IT",
            "/TS",
            "/BYTES",
            "/NJH",
            "/NJS",
            "/NC",
            "/NDL",
            "/NP",
            "/R:0",
            "/W:0",
        ]);
        // Exit codes 0–7 are success (bit 0: "would copy"); 8 and up are failures.
        if (out === null || out.code >= 8) {
            return null;
        }
        const match = /^\s*(\d+)\s+(\d{4})\/(\d\d)\/(\d\d) (\d\d):(\d\d):(\d\d)\s/m.exec(out.stdout);
        if (match === null) {
            return null;
        }
        const [size, year, month, day, hour, minute, second] = match.slice(1).map(Number);
        return { size, mtimeMs: Date.UTC(year, month - 1, day, hour, minute, second) };
    }
    const args = platform === "macos" ? ["-f", "%z %m", path] : ["-c", "%s %Y", path];
    const out = await run(exec, "stat", args);
    const match = out?.code === 0 ? /^(\d+) (\d+)/.exec(out.stdout.trim()) : null;
    if (!match) {
        return null;
    }
    return { size: Number(match[1]), mtimeMs: Number(match[2]) * 1000 };
}
