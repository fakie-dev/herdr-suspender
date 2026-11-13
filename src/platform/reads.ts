// A file's head and tail on Herdr's runtime, from two ways of reading it: the
// whole file as text, or a short process that reads only some bytes
// (`readPart`). Kept apart from ports.ts (which imports "herdr") so it is tested.

import { utf8Head, utf8Tail } from "../core/utf8.ts";

/**
 * From this size on, a tail is read by a process (`readPart`, about 30 ms on Windows)
 * instead of cut from a whole read: fs.readFile took 14 ms for 8 MiB and 120 ms for
 * 60 MiB on Herdr 0.1.15, and holds the whole text in memory meanwhile.
 */
export const PART_FROM = 8 * 1024 * 1024;

export interface ReadWays {
  /** The whole file as text; null when it cannot be read whole (refused, too big, absent). */
  whole(path: string): Promise<string | null>;
  /** Only `bytes` bytes of one end, by a short process; null when that fails. */
  part(path: string, end: "head" | "tail", bytes: number): Promise<string | null>;
}

/**
 * Head and tail readers. Either way may fail where the other works (Herdr's
 * `fs/promises` refuses some files, its own text read stops at 1 MiB, a process
 * may not start), so each falls back to the other: a failed read never ends it.
 */
export function partReaders(ways: ReadWays): {
  head(path: string, bytes: number): Promise<string | null>;
  tail(path: string, bytes: number, size?: number): Promise<string | null>;
} {
  return {
    // A head is read once per file (a rollout's first line, a transcript's first prompt):
    // from a whole read, which starts no process.
    head: async (path, bytes) => {
      const all = await ways.whole(path);
      return all !== null ? utf8Head(all, bytes) : await ways.part(path, "head", bytes);
    },
    // A tail is what a growing transcript is read by, every 30 s while Sessions is open:
    // a big one by only its bytes, one short process, not the whole file each time.
    tail: async (path, bytes, size) => {
      const big = size === undefined || size > PART_FROM;
      if (big) {
        const part = await ways.part(path, "tail", bytes);
        if (part !== null) {
          return part;
        }
      }
      const all = await ways.whole(path);
      if (all !== null) {
        return utf8Tail(all, bytes);
      }
      return big ? null : await ways.part(path, "tail", bytes);
    },
  };
}
