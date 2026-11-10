// The mod's record of sessions: `~/.config/herdr-app/suspender/sessions.json`,
// outside `mods/` so reinstalling the mod does not wipe it. Several copies of
// the mod may write at once, so every write says what it expects to replace
// (optimistic locking); on a conflict the change is applied again to the
// newer file.

import type { Ports } from "../platform/ports.ts";
import type { StoreFile } from "./model.ts";

export const STORE_VERSION = 1;
/** How many times a change is tried against a file other copies keep changing. */
export const STORE_ATTEMPTS = 5;

export class StoreConflictError extends Error {
  constructor(path: string, attempts: number) {
    super(`store conflict: ${path} changed under every one of ${attempts} writes`);
    this.name = "StoreConflictError";
  }
}

export function emptyStore(): StoreFile {
  return { version: STORE_VERSION, sessions: {} };
}

export function defaultStorePath(p: Ports): string {
  return [p.home(), ".config", "herdr-app", "suspender", "sessions.json"].join(p.sep);
}

/**
 * The store in `text`. Absent, empty, unreadable or of another version: an
 * empty store (the next write replaces such a file; the agents' own
 * transcripts are never touched, only the mod's index of them is lost).
 */
export function parseStore(text: string | null): StoreFile {
  if (text === null || text.trim() === "") {
    return emptyStore();
  }
  try {
    const data: unknown = JSON.parse(text);
    if (
      typeof data === "object" &&
      data !== null &&
      (data as { version?: unknown }).version === STORE_VERSION &&
      typeof (data as { sessions?: unknown }).sessions === "object" &&
      (data as { sessions?: unknown }).sessions !== null
    ) {
      return data as StoreFile;
    }
  } catch {
    // Broken JSON: fall through to an empty store.
  }
  return emptyStore();
}

export function serializeStore(file: StoreFile): string {
  return `${JSON.stringify(file, null, 2)}\n`;
}

export async function readStore(p: Ports, path: string): Promise<StoreFile> {
  return parseStore(await p.readText(path));
}

/**
 * Reads the store, lets `mutate` change it, and writes it back if nobody
 * wrote in between; otherwise starts over from the newer file. `mutate` may
 * run more than once and must only change the file it is given.
 * Rejects with StoreConflictError after STORE_ATTEMPTS conflicts in a row.
 */
export async function updateStore(
  p: Ports,
  path: string,
  mutate: (file: StoreFile) => void,
  attempts: number = STORE_ATTEMPTS,
): Promise<StoreFile> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const before = await p.readText(path);
    const file = parseStore(before);
    mutate(file);
    if (await p.writeText(path, serializeStore(file), before)) {
      return file;
    }
  }
  throw new StoreConflictError(path, attempts);
}
