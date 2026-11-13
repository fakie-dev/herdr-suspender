// Ports: everything the core and the adapters need from Herdr, the file
// system and processes, behind one interface. `core/` and `adapters/` import
// only this type; tests pass in-memory fakes (`test/fakePorts.ts`).
// `herdrPorts()` is the implementation on Herdr's runtime ("herdr" and its
// "fs/promises"); it is never loaded by the tests.

import * as fs from "fs/promises";
import {
  exec as herdrExec,
  hc as herdrHc,
  home as herdrHome,
  window as herdrWindow,
  readTextFile,
  watchFolder,
  writeTextFile,
} from "herdr";
import * as os from "os";
import { readPart, statFile } from "./proc.ts";
import { partReaders } from "./reads.ts";

export type Platform = "windows" | "macos" | "linux";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface Ports {
  home(): string;
  sep: "\\" | "/";
  platform: Platform;
  now(): number;
  /**
   * Up to this many bytes, a transcript's first read takes the whole file
   * (`readText`) for exact counts; past it, only its two ends. Herdr: 64 MiB,
   * the most its `fs.readFile` reads (a bigger file is refused). Absent: 1 MiB.
   */
  wholeMax?: number;
  /**
   * Lets Herdr's runtime run other work, so a long job is not stopped: it ends
   * a script that runs between 0.5 and 0.7 s without a pause (measured on
   * 0.1.15), and a microtask is no pause. Absent: no pause is needed (tests).
   */
  breathe?(): Promise<void>;
  /** UTF-8 text of the whole file, or null if absent or unreadable (in Herdr: over 64 MiB). */
  readText(path: string): Promise<string | null>;
  /**
   * The first `bytes` bytes as text, or null if absent or unreadable. In Herdr: cut from a
   * whole read (D01), and past 64 MiB read by a short process (`readPart`).
   */
  readHead(path: string, bytes: number): Promise<string | null>;
  /**
   * The last `bytes` bytes as text, or null if absent or unreadable. `size`, when the caller
   * knows it: in Herdr a file up to PART_FROM is cut from a whole read (no process), a bigger
   * one is read by one short process that reads only those bytes (`readPart`).
   */
  readTail(path: string, bytes: number, size?: number): Promise<string | null>;
  /**
   * Size and modification time, or null if absent. Starts a process in Herdr
   * (D01: no stat in its "fs/promises"); never reads the file. The time is
   * whole seconds on Windows.
   */
  stat(path: string): Promise<{ mtimeMs: number; size: number } | null>;
  /** Names in a folder; empty if it does not exist. */
  list(dir: string): Promise<string[]>;
  /**
   * Writes only if the file still holds `expected` (null: it must not exist);
   * without `expected`, writes over whatever is there. False on a conflict.
   * Creates missing folders.
   */
  writeText(path: string, text: string, expected?: string | null): Promise<boolean>;
  /** Resolves with changed paths the next time anything under `dir` changes. */
  watch(dir: string): Promise<string[]>;
  exec(cmd: string, args: string[], opts?: { cwd?: string; timeout?: number }): Promise<ExecResult>;
  hc(args: string[]): Promise<ExecResult>;
}

function detectPlatform(): Platform {
  try {
    return herdrWindow().platform;
  } catch {
    // No window to ask (e.g. during a check run): ask the runtime.
  }
  const name = os.platform();
  if (name === "win32" || name === "windows") {
    return "windows";
  }
  return name === "darwin" || name === "macos" ? "macos" : "linux";
}

function parentDir(path: string): string {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return cut > 0 ? path.slice(0, cut) : path;
}

/**
 * The most Herdr's `fs.readFile` reads: a bigger file is refused ("over the
 * 67108864-byte limit for fs.readFile; read it in pieces"), measured on 0.1.15.
 */
const FS_READ_MAX = 64 * 1024 * 1024;
/**
 * The whole file as UTF-8 text. Herdr's runtime has no TextDecoder and its
 * Buffer does not decode (toString gives ""), so files are read as text and
 * cut by bytes with `utf8Head` / `utf8Tail`. Null past FS_READ_MAX.
 */
async function readUtf8(path: string): Promise<string | null> {
  try {
    return await fs.readFile(path, "utf8");
  } catch {
    // "fs/promises" reads only in the home: a HERDR_APP_HOME elsewhere is read through Herdr (up to 1 MiB).
    try {
      return await readTextFile(path);
    } catch {
      return null;
    }
  }
}

/**
 * `clock`: the copy's own task context (init's), whose `sleep` is a real pause
 * for `breathe` (a timer; a microtask is none). Without one, no pauses.
 */
export function herdrPorts(clock?: { sleep(ms: number): Promise<void> }): Ports {
  const platform = detectPlatform();
  const parts = partReaders({
    whole: (path) => readUtf8(path),
    part: (path, end, bytes) => readPart(path, end, bytes, platform, herdrExec),
  });
  return {
    ...(clock !== undefined ? { breathe: () => clock.sleep(1) } : {}),
    home: () => herdrHome(),
    sep: platform === "windows" ? "\\" : "/",
    platform,
    wholeMax: FS_READ_MAX,
    now: () => Date.now(),
    // Not `readTextFile`: it stops at 1 MiB, and transcripts run to 50+ MB.
    readText: (path) => readUtf8(path),
    readHead: (path, bytes) => parts.head(path, bytes),
    readTail: (path, bytes, size) => parts.tail(path, bytes, size),
    stat: (path) => statFile(path, platform, herdrExec),
    list: async (dir) => {
      try {
        return await fs.readdir(dir);
      } catch {
        return [];
      }
    },
    writeText: async (path, text, expected) => {
      try {
        await fs.mkdir(parentDir(path), { recursive: true });
        const base = expected === undefined ? await readTextFile(path) : expected;
        await writeTextFile(path, text, base);
        return true;
      } catch {
        return false;
      }
    },
    watch: (dir) => watchFolder(dir),
    exec: (cmd, args, opts) => herdrExec(cmd, args, opts),
    hc: (args) => herdrHc(args),
  };
}
