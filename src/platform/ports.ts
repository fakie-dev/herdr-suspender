// Ports: everything the core and the adapters need from Herdr, the file
// system and processes, behind one interface. `core/` and `adapters/` import
// only this type; tests pass in-memory fakes (`test/fakePorts.ts`).
// `herdrPorts()` is the implementation on Herdr's runtime ("herdr" and its
// "fs/promises"); it is never loaded by the tests.

import { Buffer } from "buffer";
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
import { statFile } from "./proc.ts";

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
   * True when `readHead`/`readTail` read the whole file anyway (Herdr, D01):
   * then a whole read costs no more than a partial one, and callers may take
   * everything in one `readTail(path, size)`. Absent: partial reads are cheap.
   */
  wholeReads?: boolean;
  /** UTF-8 text of the whole file (no size cap), or null if absent or unreadable. */
  readText(path: string): Promise<string | null>;
  /** The first `bytes` bytes as text, or null if absent. In Herdr this still reads the whole file (D01). */
  readHead(path: string, bytes: number): Promise<string | null>;
  /** The last `bytes` bytes as text, or null if absent. In Herdr this still reads the whole file (D01). */
  readTail(path: string, bytes: number): Promise<string | null>;
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

async function readBytes(path: string): Promise<Uint8Array | null> {
  try {
    return await fs.readFile(path);
  } catch {
    return null;
  }
}

const decode = (bytes: Uint8Array): string => Buffer.from(bytes).toString("utf8");

export function herdrPorts(): Ports {
  const platform = detectPlatform();
  return {
    home: () => herdrHome(),
    sep: platform === "windows" ? "\\" : "/",
    platform,
    wholeReads: true,
    now: () => Date.now(),
    // Not `readTextFile`: it stops at 1 MiB, and transcripts run to 50+ MB.
    readText: async (path) => {
      const all = await readBytes(path);
      return all === null ? null : decode(all);
    },
    readHead: async (path, bytes) => {
      const all = await readBytes(path);
      return all === null ? null : decode(all.subarray(0, bytes));
    },
    readTail: async (path, bytes) => {
      const all = await readBytes(path);
      return all === null ? null : decode(all.subarray(Math.max(0, all.length - bytes)));
    },
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
