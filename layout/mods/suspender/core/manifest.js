// The checksum manifest: `mods/suspender/manifest.json`, written by `pnpm
// build` and held current by `pnpm check`. It names the release (`version`),
// lists every file of the mod with the sha256 of its text, and carries the
// mod's key snippet (`keys.json`), so an update can say which keys are new.
//
// It serves twice. A release's manifest, fetched from its tag, is what each
// downloaded file must match before anything is installed. The installed
// manifest is what the installed files must still match, or the person has
// changed them and the update button leaves them alone (ADR 12).
import { SAFE_PATH } from "./release.js";
import { parseVersion } from "./semver.js";
import { sha256Hex } from "./sha256.js";
export const MANIFEST_FILE = "manifest.json";
/** Most files a manifest may list: a guard against a broken one, far above the mod's ~50. */
const MAX_FILES = 500;
const HASH = /^[0-9a-f]{64}$/;
/**
 * The sha256 of a file's UTF-8 text with its line endings as LF. A release is
 * LF throughout (.gitattributes); a checkout with CRLF is the same file.
 */
export function fileHash(text) {
    return sha256Hex(text.replace(/\r\n/g, "\n"));
}
/**
 * What Herdr writes next to a mod it loads or checks (`jsconfig.json`, `*.d.ts`,
 * `*.error`) and hidden files: never part of the mod, never listed, never an edit.
 */
export function herdrWritten(path) {
    const name = path.slice(path.lastIndexOf("/") + 1);
    return (name === "jsconfig.json" ||
        name.endsWith(".d.ts") ||
        name.endsWith(".error") ||
        path.split("/").some((part) => part.startsWith(".")));
}
const sortedObject = (entries) => Object.fromEntries(entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
export function buildManifest(version, keys, files) {
    return {
        mod: "suspender",
        version,
        keys,
        files: sortedObject([...files].map(([path, text]) => [path, fileHash(text)])),
    };
}
export function renderManifest(m) {
    return `${JSON.stringify({ mod: m.mod, version: m.version, keys: m.keys, files: sortedObject(Object.entries(m.files)) }, null, 2)}\n`;
}
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
function parseKeys(value) {
    if (!isRecord(value)) {
        return null;
    }
    const out = {};
    for (const [section, bindings] of Object.entries(value)) {
        if (!isRecord(bindings)) {
            return null;
        }
        const map = {};
        for (const [keys, action] of Object.entries(bindings)) {
            if (typeof action !== "string") {
                return null;
            }
            map[keys] = action;
        }
        out[section] = map;
    }
    return out;
}
/** A manifest of this mod, whole and safe to act on, or null. */
export function parseManifest(text) {
    let raw;
    try {
        raw = text === null ? null : JSON.parse(text);
    }
    catch {
        return null;
    }
    if (!isRecord(raw) || raw["mod"] !== "suspender" || parseVersion(raw["version"]) === null) {
        return null;
    }
    const keys = parseKeys(raw["keys"] ?? {});
    const listed = raw["files"];
    if (keys === null || !isRecord(listed)) {
        return null;
    }
    const entries = Object.entries(listed);
    if (entries.length > MAX_FILES) {
        return null;
    }
    const files = {};
    for (const [path, hash] of entries) {
        if (!SAFE_PATH.test(path) || path === MANIFEST_FILE || typeof hash !== "string" || !HASH.test(hash)) {
            return null;
        }
        files[path] = hash;
    }
    if (files["main.js"] === undefined || files["mod.json"] === undefined) {
        return null;
    }
    return { mod: "suspender", version: String(raw["version"]), keys, files };
}
/** How the files on disk (path → text, `/` paths) differ from the manifest they came with. */
export function installDiff(m, disk) {
    const out = { changed: [], missing: [], extra: [] };
    for (const [path, hash] of Object.entries(m.files)) {
        const text = disk.get(path);
        if (text === undefined) {
            out.missing.push(path);
        }
        else if (fileHash(text) !== hash) {
            out.changed.push(path);
        }
    }
    for (const path of disk.keys()) {
        if (m.files[path] === undefined && path !== MANIFEST_FILE && !herdrWritten(path)) {
            out.extra.push(path);
        }
    }
    return out;
}
/**
 * The keys of a new release worth telling the person about: commands the
 * release before it did not bind, that no key of the person's runs yet. The
 * mod never writes keys.json: the person adds these.
 */
export function missingKeys(next, old, bound) {
    const had = new Set(Object.values(old ?? {}).flatMap((section) => Object.values(section)));
    const have = new Set(bound.map((b) => b.action));
    const out = [];
    for (const [section, bindings] of Object.entries(next)) {
        for (const [keys, action] of Object.entries(bindings)) {
            if (!had.has(action) && !have.has(action)) {
                out.push({ section, keys, action });
            }
        }
    }
    return out;
}
