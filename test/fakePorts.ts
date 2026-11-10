// In-memory Ports for tests: files live in a map, nothing touches the disk,
// no process starts. `beforeWrite` lets a test play another copy of the mod
// writing between our read and our write.

import type { ExecResult, Ports } from "../src/platform/ports.ts";

export interface FakePorts extends Ports {
  files: Map<string, string>;
  writes: { path: string; text: string; expected: string | null | undefined; ok: boolean }[];
  beforeWrite: ((path: string) => void) | null;
  execCalls: { cmd: string; args: string[] }[];
  hcCalls: string[][];
}

export function fakePorts(options: { home?: string; sep?: "\\" | "/"; now?: number } = {}): FakePorts {
  const sep = options.sep ?? "/";
  const home = options.home ?? (sep === "/" ? "/home/tester" : "C:\\Users\\tester");
  const files = new Map<string, string>();
  const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
  const decode = (data: Uint8Array): string => new TextDecoder().decode(data);
  const noProcess: ExecResult = { code: 127, stdout: "", stderr: "fake: no processes" };

  const ports: FakePorts = {
    files,
    writes: [],
    beforeWrite: null,
    execCalls: [],
    hcCalls: [],
    home: () => home,
    sep,
    platform: sep === "/" ? "linux" : "windows",
    now: () => options.now ?? 1_800_000_000_000,
    readText: async (path) => files.get(path) ?? null,
    readHead: async (path, n) => {
      const text = files.get(path);
      return text === undefined ? null : decode(bytes(text).subarray(0, n));
    },
    readTail: async (path, n) => {
      const text = files.get(path);
      if (text === undefined) {
        return null;
      }
      const all = bytes(text);
      return decode(all.subarray(Math.max(0, all.length - n)));
    },
    stat: async (path) => {
      const text = files.get(path);
      return text === undefined ? null : { mtimeMs: options.now ?? 1_800_000_000_000, size: bytes(text).length };
    },
    list: async (dir) => {
      const prefix = dir.endsWith(sep) ? dir : dir + sep;
      const names = new Set<string>();
      for (const path of files.keys()) {
        if (path.startsWith(prefix)) {
          names.add(path.slice(prefix.length).split(sep)[0] ?? "");
        }
      }
      return [...names];
    },
    writeText: async (path, text, expected) => {
      ports.beforeWrite?.(path);
      const current = files.get(path) ?? null;
      const ok = expected === undefined || expected === current;
      if (ok) {
        files.set(path, text);
      }
      ports.writes.push({ path, text, expected, ok });
      return ok;
    },
    watch: () => new Promise<string[]>(() => undefined),
    exec: async (cmd, args) => {
      ports.execCalls.push({ cmd, args });
      return noProcess;
    },
    hc: async (args) => {
      ports.hcCalls.push(args);
      return noProcess;
    },
  };
  return ports;
}
