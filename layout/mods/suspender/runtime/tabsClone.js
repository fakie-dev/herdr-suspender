// The live copy of Herdr's tab bar: `mods/suspender-tabs/`, Herdr's shipped
// `tabs` mod with a third panel button, "Sessions · N", beside Files and
// Changes, so the strip reads `+ Files Changes Sessions · N  - □ ×`.
//
// The copy is made once with Herdr's own `mod.clone`. Its main.js is then the
// shipped tabs/main.js plus one patch, and its first line records the sha256
// of the shipped file it came from: when a Herdr update changes tabs/main.js,
// the next start notices and writes the copy again. When the patch's anchors
// are gone, or the copy does not pass `herdr-app check`, the caller builds the
// layout around the shipped tab bar instead (see core/layout.ts, TabsMode).
//
// Paths inside the copy stay `mods/tabs/...`: its window-button icons are
// always the shipped ones.
import { TABS_CLONE } from "../core/layout.js";
import { sha256Hex } from "../core/sha256.js";
export const CLONE_NAME = TABS_CLONE;
/** Bumped when the patch changes, so copies made by an older build are written again. */
export const PATCH_VERSION = 1;
export const CLONE_MARK = "// suspender-tabs: from tabs/main.js sha256=";
/** How long `mod.clone` may take to put the copy's main.js on disk. */
export const CLONE_WAIT_MS = 5_000;
const CLONE_POLL_MS = 100;
/** Writes refused because another copy of the mod wrote in between, before giving up. */
export const WRITE_ATTEMPTS = 3;
/** `herdr-app check` of the copy; it loads one small mod. */
export const CHECK_TIMEOUT_MS = 60_000;
const ANCHOR_ENABLED = 'const enabled = shared("workspace.panels") ?? ["files", "changes"];';
const ENABLED = 'const enabled = [...(shared("workspace.panels") ?? ["files", "changes"]), "suspender"];';
const ANCHOR_BUTTONS = ".when(w?.buttons,";
const SESSIONS_BUTTON = '.child(panelButton("suspender", String(shared("suspender.tabLabel") ?? "Sessions"), "mods/suspender/icons/moon.svg"))';
const count = (text, needle) => text.split(needle).length - 1;
/** The copy's main.js for this shipped tabs/main.js, or null when an anchor is missing or not unique. */
export function patchTabs(source, hash) {
    if (count(source, ANCHOR_ENABLED) !== 1 || count(source, ANCHOR_BUTTONS) !== 1) {
        return null;
    }
    // The new button goes on a line of its own, indented like the `.when` it precedes.
    const at = source.indexOf(ANCHOR_BUTTONS);
    const lineStart = source.lastIndexOf("\n", at) + 1;
    const indent = /^[ \t]*/.exec(source.slice(lineStart, at))?.[0] ?? "";
    const eol = source[lineStart - 2] === "\r" ? "\r\n" : "\n";
    const head = source.slice(0, at).replace(ANCHOR_ENABLED, ENABLED);
    return `${CLONE_MARK}${hash} patch=${PATCH_VERSION}\n${head}${SESSIONS_BUTTON}${eol}${indent}${source.slice(at)}`;
}
function parse(text) {
    try {
        return text === null ? null : JSON.parse(text);
    }
    catch {
        return null;
    }
}
/** A copy this mod may write over: one it patched, or Herdr's plain clone of `tabs`. */
function ours(main, modJson) {
    if (main.startsWith(CLONE_MARK)) {
        return true;
    }
    const meta = parse(modJson);
    const from = typeof meta === "object" && meta !== null ? meta.cloned_from : null;
    return typeof from === "object" && from !== null && from.name === "tabs";
}
/**
 * Makes sure `mods/suspender-tabs/main.js` is the patch of the shipped
 * tabs/main.js and passes `herdr-app check`. Never throws.
 */
export async function ensureTabsClone(d) {
    const { ports } = d;
    const path = (...parts) => [d.appHome, ...parts].join(ports.sep);
    const shipped = await ports.readText(path("mods", "tabs", "main.js"));
    if (shipped === null) {
        return { mode: "builtin", why: "no-tabs" };
    }
    const want = patchTabs(shipped, sha256Hex(shipped));
    if (want === null) {
        return { mode: "builtin", why: "anchors" };
    }
    const cloneDir = path("mods", CLONE_NAME);
    const clonePath = [cloneDir, "main.js"].join(ports.sep);
    let current = await ports.readText(clonePath);
    if (current === null) {
        try {
            d.cloneMod();
        }
        catch {
            return { mode: "builtin", why: "clone-failed" };
        }
        for (let waited = 0; current === null && waited < CLONE_WAIT_MS; waited += CLONE_POLL_MS) {
            await d.sleep(CLONE_POLL_MS);
            current = await ports.readText(clonePath);
        }
        if (current === null) {
            return { mode: "builtin", why: "clone-failed" };
        }
    }
    else if (current !== want && !ours(current, await ports.readText([cloneDir, "mod.json"].join(ports.sep)))) {
        return { mode: "builtin", why: "foreign" };
    }
    let why = "fresh";
    for (let attempt = 0; current !== want; attempt++) {
        if (attempt === WRITE_ATTEMPTS) {
            return { mode: "builtin", why: "write-refused" };
        }
        if (await ports.writeText(clonePath, want, current)) {
            why = "written";
            break;
        }
        // Another copy of the mod wrote in between: if it wrote the same patch, that is done.
        current = await ports.readText(clonePath);
        why = "written-elsewhere";
    }
    try {
        const checked = await ports.exec("herdr-app", ["check", cloneDir], { timeout: CHECK_TIMEOUT_MS });
        if (checked.code !== 0) {
            return { mode: "builtin", why: "check-failed" };
        }
    }
    catch {
        return { mode: "builtin", why: "check-failed" };
    }
    return { mode: "clone", why };
}
