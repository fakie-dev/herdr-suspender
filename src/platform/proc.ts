// Processes and file times per operating system, through `Ports.exec` only:
// no "herdr" import, so the adapters and the tests use it as is.
//
// Cost matters (spec story 39): `memoryKb` and `statFile` are one cheap
// native call each (tasklist / ps, robocopy / stat). `processDetails` is the
// expensive one on Windows (PowerShell: nothing else built in lists parents
// and command lines since wmic was removed) and is only for rare paths:
// telling two sessions in one folder apart. `treesMemoryMb` is one PowerShell
// call too (the tree and the private working sets together; about 1.3 s, where
// PowerShell and tasklist side by side took 1.1 s and two processes), made at
// Sleep and, while the Sessions panel is open, at most every 30 seconds.

import type { ExecResult, Platform, Ports } from "./ports.ts";

type Exec = (cmd: string, args: string[], opts?: { cwd?: string; timeout?: number }) => Promise<ExecResult>;

const TIMEOUT_MS = 10_000;

async function run(exec: Exec, cmd: string, args: string[]): Promise<ExecResult | null> {
  try {
    return await exec(cmd, args, { timeout: TIMEOUT_MS });
  } catch {
    return null;
  }
}

const digitsOnly = (text: string): number | null => {
  const digits = text.replace(/\D/g, "");
  return digits === "" ? null : Number(digits);
};

/** Splits one `tasklist /FO CSV` line: `"name","pid","session","#","396 412 K"`. */
function csvFields(line: string): string[] {
  return [...line.matchAll(/"((?:[^"]|"")*)"/g)].map((m) => (m[1] ?? "").replace(/""/g, '"'));
}

export interface LiveProcess {
  /** Executable name (`claude.exe`) or, on POSIX, the command (`/usr/bin/claude`). */
  name: string;
  /** Resident memory in KiB, or null if the system didn't say. */
  rssKb: number | null;
}

/**
 * The pids of a set that are alive, with name and resident memory. One process
 * start for the whole set: `tasklist` lists everything (its PID filters can't
 * be OR-ed); `ps -p` takes a list. Empty set: no process at all.
 */
export async function liveProcesses(pids: readonly number[], p: Ports): Promise<Map<number, LiveProcess>> {
  return (await liveProcessesOrNull(pids, p)) ?? new Map();
}

/** As `liveProcesses`, but null when the system did not answer (the list failed): not the same as "none alive". */
export async function liveProcessesOrNull(pids: readonly number[], p: Ports): Promise<Map<number, LiveProcess> | null> {
  const result = new Map<number, LiveProcess>();
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
export async function allProcesses(p: Ports): Promise<Map<number, LiveProcess>> {
  return (await listAll(p, null)) ?? new Map();
}

/** Null when the list could not be taken (the tool failed, or Windows listed nothing at all). */
async function listAll(p: Ports, only: number[] | null): Promise<Map<number, LiveProcess> | null> {
  const result = new Map<number, LiveProcess>();
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
export async function memoryKb(pids: readonly number[], p: Ports): Promise<Map<number, number>> {
  const result = new Map<number, number>();
  for (const [pid, live] of await liveProcesses(pids, p)) {
    if (live.rssKb !== null) {
      result.set(pid, live.rssKb);
    }
  }
  return result;
}

export interface ProcessDetail {
  pid: number;
  ppid: number;
  /** Executable name, e.g. `claude.exe`, `codex`. */
  name: string;
  /** Start time (ms since epoch), or null if the system didn't say. */
  startMs: number | null;
  /** Full command line, or null if the system didn't say. */
  commandLine: string | null;
}

/** `[[dd-]hh:]mm:ss` (ps etime) in seconds. */
function elapsedSeconds(text: string): number | null {
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
export async function processDetails(p: Ports): Promise<ProcessDetail[]> {
  const list: ProcessDetail[] = [];
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

/** How many parents up from `pid` `ancestor` is (1: its parent), or null if it is not above it. */
export function depthUnder(tree: readonly ProcessDetail[], pid: number, ancestor: number, maxDepth = 8): number | null {
  const parent = new Map(tree.map((d) => [d.pid, d.ppid]));
  let current = pid;
  for (let depth = 1; depth <= maxDepth; depth++) {
    const next = parent.get(current);
    if (next === undefined || next === current) {
      return null;
    }
    if (next === ancestor) {
      return depth;
    }
    current = next;
  }
  return null;
}

/** True if `ancestor` is `pid`'s parent, grandparent, … (up to `maxDepth` levels). */
export function descendsFrom(list: readonly ProcessDetail[], pid: number, ancestor: number, maxDepth = 8): boolean {
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
export function subtree(list: readonly ProcessDetail[], root: number): number[] {
  if (!list.some((d) => d.pid === root)) {
    return [];
  }
  const startOf = new Map(list.map((d) => [d.pid, d.startMs]));
  const children = new Map<number, number[]>();
  for (const d of list) {
    // Windows reuses ids: a process older than the one now holding its parent id is not that one's child.
    const parentStart = startOf.get(d.ppid) ?? null;
    if (d.pid !== d.ppid && !(d.startMs !== null && parentStart !== null && d.startMs < parentStart)) {
      const siblings = children.get(d.ppid);
      if (siblings === undefined) {
        children.set(d.ppid, [d.pid]);
      } else {
        siblings.push(d.pid);
      }
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

const WINDOWS_MEMORY = [
  "[Console]::OutputEncoding = [Text.Encoding]::UTF8",
  "Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate | ForEach-Object {",
  "  $start = ''; if ($_.CreationDate) { $start = ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() }",
  '  "P`t$($_.ProcessId)`t$($_.ParentProcessId)`t$start"',
  "}",
  "Get-CimInstance Win32_PerfRawData_PerfProc_Process -Property IDProcess,WorkingSetPrivate | ForEach-Object {",
  '  "M`t$($_.IDProcess)`t$($_.WorkingSetPrivate)"',
  "}",
].join("\n");

/**
 * Every process with its parent and start, and the KiB it would give back by ending. Windows: the private
 * working set (Task Manager's memory column), not tasklist's working set, which also counts, once per
 * process, the pages it shares with others (node.exe, system DLLs): measured on a fresh Claude Code with
 * its MCP servers, 1442 MB of working sets against 702 MB private, and 878 MB came back when it ended.
 * macOS and Linux: the resident size, from the same ps call as the tree. Null when nothing could be read.
 */
async function processMemory(p: Ports): Promise<{ tree: ProcessDetail[]; kb: Map<number, number> } | null> {
  const tree: ProcessDetail[] = [];
  const kb = new Map<number, number>();
  if (p.platform === "windows") {
    const out = await run(p.exec, "powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_MEMORY]);
    for (const line of out?.stdout.split(/\r?\n/) ?? []) {
      const [kind, pid, a, b] = line.split("\t");
      const id = Number(pid);
      if (!pid || !Number.isFinite(id)) {
        continue;
      }
      if (kind === "P" && a) {
        tree.push({ pid: id, ppid: Number(a), startMs: b ? Number(b) : null, name: "", commandLine: null });
      } else if (kind === "M" && a) {
        kb.set(id, Math.round(Number(a) / 1024));
      }
    }
  } else {
    const now = p.now();
    const out = await run(p.exec, "ps", ["-A", "-o", "pid=,ppid=,etime=,rss="]);
    for (const line of out?.stdout.split("\n") ?? []) {
      const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s*$/.exec(line);
      if (match === null) {
        continue;
      }
      const seconds = elapsedSeconds(match[3] ?? "");
      const pid = Number(match[1]);
      tree.push({
        pid,
        ppid: Number(match[2]),
        startMs: seconds === null ? null : now - seconds * 1000,
        name: "",
        commandLine: null,
      });
      kb.set(pid, Number(match[4]));
    }
  }
  return tree.length === 0 ? null : { tree, kb };
}

/**
 * The memory, in MB, that the tree under each root (a terminal's process) would give back by ending: one
 * process start for all of them. Freed at sleep and used while running are both this, so they compare.
 * A root with nothing known is left out: no figure rather than another kind of figure.
 */
export async function treesMemoryMb(p: Ports, roots: readonly number[]): Promise<Map<number, number>> {
  const result = new Map<number, number>();
  if (roots.length === 0) {
    return result;
  }
  const memory = await processMemory(p);
  if (memory === null) {
    return result;
  }
  for (const root of roots) {
    const kb = subtree(memory.tree, root).reduce((sum, pid) => sum + (memory.kb.get(pid) ?? 0), 0);
    if (kb > 0) {
      result.set(root, Math.round(kb / 1024));
    }
  }
  return result;
}

function splitPath(path: string): { dir: string; name: string } {
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
export async function statFile(
  path: string,
  platform: Platform,
  exec: Exec,
): Promise<{ mtimeMs: number; size: number } | null> {
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
    const [size, year, month, day, hour, minute, second] = match.slice(1).map(Number) as [
      number,
      number,
      number,
      number,
      number,
      number,
      number,
    ];
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

/** A file:// URL curl takes on Windows: forward slashes, each path segment percent-encoded. */
function fileUrl(path: string): string {
  const parts = path.split(/[\\/]+/).filter((part) => part !== "");
  const drive = /^[A-Za-z]:$/.test(parts[0] ?? "") ? `${parts.shift()}/` : "";
  return `file:///${drive}${parts.map((part) => encodeURIComponent(part)).join("/")}`;
}

/**
 * The first or the last `bytes` bytes of a file, without reading the rest. Herdr's
 * "fs/promises" reads only whole files, and none over 64 MiB (measured on 0.1.15), so a
 * long transcript came back as nothing. One short process: on Windows the curl that ships
 * with it (Windows 10 and later) with a byte range of the file's URL, about 30 ms;
 * `head -c` / `tail -c` elsewhere. Null when the process fails or cannot start: the
 * caller falls back, and never takes it for an empty file.
 */
export async function readPart(
  path: string,
  end: "head" | "tail",
  bytes: number,
  platform: Platform,
  exec: Exec,
): Promise<string | null> {
  const out =
    platform === "windows"
      ? await run(exec, "curl", ["-s", "-g", "-r", end === "head" ? `0-${bytes - 1}` : `-${bytes}`, fileUrl(path)])
      : await run(exec, end, ["-c", String(bytes), "--", path]);
  return out?.code === 0 ? out.stdout : null;
}
