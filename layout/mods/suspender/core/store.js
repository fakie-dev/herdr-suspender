// The mod's record of sessions: `~/.config/herdr-app/suspender/sessions.json`,
// outside `mods/` so reinstalling the mod does not wipe it. Several copies of
// the mod may write at once, so every write says what it expects to replace
// (optimistic locking); on a conflict the change is applied again to the
// newer file.
export const STORE_VERSION = 1;
/** How many times a change is tried against a file other copies keep changing. */
export const STORE_ATTEMPTS = 5;
export class StoreConflictError extends Error {
    constructor(path, attempts) {
        super(`store conflict: ${path} changed under every one of ${attempts} writes`);
        this.name = "StoreConflictError";
    }
}
export function emptyStore() {
    return { version: STORE_VERSION, sessions: {} };
}
export function defaultStorePath(p) {
    return [p.home(), ".config", "herdr-app", "suspender", "sessions.json"].join(p.sep);
}
/**
 * The store in `text`. Absent, empty, unreadable or of another version: an
 * empty store (the next write replaces such a file; the agents' own
 * transcripts are never touched, only the mod's index of them is lost).
 */
export function parseStore(text) {
    if (text === null || text.trim() === "") {
        return emptyStore();
    }
    try {
        const data = JSON.parse(text);
        if (typeof data === "object" &&
            data !== null &&
            data.version === STORE_VERSION &&
            typeof data.sessions === "object" &&
            data.sessions !== null) {
            return data;
        }
    }
    catch {
        // Broken JSON: fall through to an empty store.
    }
    return emptyStore();
}
export function serializeStore(file) {
    return `${JSON.stringify(file, null, 2)}\n`;
}
export async function readStore(p, path) {
    return parseStore(await p.readText(path));
}
/**
 * Reads the store, lets `mutate` change it, and writes it back if nobody
 * wrote in between; otherwise starts over from the newer file. `mutate` may
 * run more than once and must only change the file it is given.
 * Rejects with StoreConflictError after STORE_ATTEMPTS conflicts in a row.
 */
export async function updateStore(p, path, mutate, attempts = STORE_ATTEMPTS) {
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
