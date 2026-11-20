// The live copy of Herdr's tab bar: `mods/suspender-tabs/`, Herdr's shipped
// `tabs` mod with a third panel button, "Sessions", beside Files and
// Changes, so the strip reads `+ Files Changes Sessions  - □ ×`.
//
// The copy is made once with Herdr's own `mod.clone`. Its main.js is then the
// shipped tabs/main.js plus one patch, and its first line records the sha256
// of the shipped file it came from: when a Herdr update changes tabs/main.js,
// the next start notices and writes the copy again. Only main.js is ever
// written: the copy's other files stay as `mod.clone` made them.
//
// Herdr reloads a mod as soon as a file under `mods/` changes, so a layout
// already on the copy would show any text written there at once. The new
// main.js is therefore checked first, with `herdr-app check`, in a folder of
// its own outside `mods/` (`suspender/tabs-check/suspender-tabs`), and only
// text that passed is written over the copy. When the patch's anchors are
// gone, or the check fails, the copy is left as it was and the caller builds
// the layout around the shipped tab bar instead (see core/layout.ts, TabsMode).
//
// Paths inside the copy stay `mods/tabs/...`: its window-button icons are
// always the shipped ones.
import { PANE_COPY, TABS_CLONE } from "../core/layout.js";
import { sha256Hex } from "../core/sha256.js";
import { syncLayout, tabsFallbackNotice } from "./layoutSync.js";
export const CLONE_NAME = TABS_CLONE;
/** Bumped when the patch changes, so copies made by an older build are written again. */
export const PATCH_VERSION = 2;
export const CLONE_MARK = "// suspender-tabs: from tabs/main.js sha256=";
/** How long `mod.clone` may take to put the copy's main.js on disk. */
export const CLONE_WAIT_MS = 5_000;
const CLONE_POLL_MS = 100;
/** Writes refused because another copy of the mod wrote in between, before giving up. */
export const WRITE_ATTEMPTS = 3;
/** `herdr-app check` of the copy; it loads one small mod. */
export const CHECK_TIMEOUT_MS = 60_000;
/** Where a new main.js is checked before it goes live, under the app's folder: outside `mods/`, so nothing reloads. */
export const CANDIDATE_DIR = ["suspender", "tabs-check", CLONE_NAME];
/** The candidate's mod.json when the shipped tab bar has none to copy. */
const CANDIDATE_MOD_JSON = '{ "place": "none" }\n';
const ANCHOR_ENABLED = 'const enabled = shared("workspace.panels") ?? ["files", "changes"];';
const ENABLED = 'const enabled = [...(shared("workspace.panels") ?? ["files", "changes"]), "suspender"];';
const ANCHOR_BUTTONS = ".when(w?.buttons,";
const SESSIONS_BUTTON = '.child(panelButton("suspender", String(shared("suspender.tabLabel") ?? "Sessions"), "mods/suspender/icons/moon.svg"))';
/**
 * A tab's icon is its lead pane's program; a sleeping tab's lead is our pane,
 * which has none, so it gets the icon the engine published for its tab (ADR 19).
 * Optional: a tab bar that names the program another way is patched without it.
 */
const ANCHOR_PROGRAM = "const program = lead?.program;";
const PROGRAM = 'const program = (lead?.mod === "suspender" ? shared("suspender.tabIcons")?.[lead.tab] : null) ?? lead?.program;';
/** The pane header copy (ADR 20): Herdr's `pane/main.js`, with the pane it draws passed through `sleeping`. */
export const PANE_MARK = "// suspender-pane: from pane/main.js sha256=";
export const PANE_PATCH_VERSION = 1;
const ANCHOR_ME = "const p = this.me();";
const ME = "const p = sleeping(this.me());";
/**
 * Appended to the copy: an import may stand anywhere at a module's top level.
 * Our sleeping pane gets the program and folder of the agent asleep in it, as
 * the engine publishes them, so the header draws it as it drew the agent.
 */
const PANE_HELPER = [
    "",
    "// suspender-pane: a sleeping session's pane shows its agent and folder (Suspender, ADR 20).",
    'import { shared as suspenderShared } from "herdr";',
    "function sleeping(p) {",
    '  const head = p?.mod === "suspender" ? suspenderShared("suspender.paneHeads")?.[p.pane] : null;',
    "  if (!head) return p;",
    "  const program = { key: head.key, name: head.name, icon: head.icon ?? null, tint: head.tint === true,",
    "    tile: null, color: null, shell: false, agent: true };",
    "  return { ...p, cwd: head.cwd ?? p.cwd, program };",
    "}",
    "",
];
/**
 * The pane header copy's main.js for this shipped pane/main.js, or null when
 * its anchor is missing or not unique, or a `sleeping` is already there.
 */
export function patchPane(source, hash) {
    if (count(source, ANCHOR_ME) !== 1 || source.includes("function sleeping(")) {
        return null;
    }
    const eol = source.includes("\r\n") ? "\r\n" : "\n";
    const body = source.replace(ANCHOR_ME, ME).replace(/(\r?\n)*$/, "");
    return `${PANE_MARK}${hash} patch=${PANE_PATCH_VERSION}\n${body}${eol}${PANE_HELPER.join(eol)}`;
}
const TABS_SPEC = { source: "tabs", name: CLONE_NAME, mark: CLONE_MARK, patch: patchTabs };
const PANE_SPEC = { source: "pane", name: PANE_COPY, mark: PANE_MARK, patch: patchPane };
const count = (text, needle) => text.split(needle).length - 1;
/**
 * The copy's main.js for this shipped tabs/main.js, or null when an anchor is
 * missing or not unique, or when the result would not hold each change exactly
 * once (whichever order the anchors come in).
 */
export function patchTabs(source, hash) {
    if (count(source, ANCHOR_ENABLED) !== 1 || count(source, ANCHOR_BUTTONS) !== 1) {
        return null;
    }
    // The icon only where its anchor is there once and the change is not there yet; never a reason to refuse.
    const iconed = count(source, ANCHOR_PROGRAM) === 1 && count(source, PROGRAM) === 0
        ? source.replace(ANCHOR_PROGRAM, PROGRAM)
        : source;
    const enabled = iconed.replace(ANCHOR_ENABLED, ENABLED);
    // The new button goes on a line of its own, indented like the `.when` it precedes.
    const at = enabled.indexOf(ANCHOR_BUTTONS);
    const lineStart = enabled.lastIndexOf("\n", at) + 1;
    const indent = /^[ \t]*/.exec(enabled.slice(lineStart, at))?.[0] ?? "";
    const eol = enabled[lineStart - 2] === "\r" ? "\r\n" : "\n";
    const body = `${enabled.slice(0, at)}${SESSIONS_BUTTON}${eol}${indent}${enabled.slice(at)}`;
    if (count(body, ENABLED) !== 1 || count(body, SESSIONS_BUTTON) !== 1) {
        return null;
    }
    return `${CLONE_MARK}${hash} patch=${PATCH_VERSION}\n${body}`;
}
function parse(text) {
    try {
        return text === null ? null : JSON.parse(text);
    }
    catch {
        return null;
    }
}
/** A copy this mod may write over: one it patched, or Herdr's plain clone of the shipped mod. */
function ours(spec, main, modJson) {
    if (main.startsWith(spec.mark)) {
        return true;
    }
    const meta = parse(modJson);
    const from = typeof meta === "object" && meta !== null ? meta.cloned_from : null;
    return typeof from === "object" && from !== null && from.name === spec.source;
}
/** Puts `text` at `path` unless it is there already; false when that does not stick. */
async function put(ports, path, text) {
    if ((await ports.readText(path)) === text || (await ports.writeText(path, text))) {
        return true;
    }
    // Refused: another copy of the mod wrote in between. If it wrote this same text, that is done.
    return (await ports.readText(path)) === text;
}
/**
 * Whether `main` passes `herdr-app check` as the tab bar copy: written with the
 * shipped mod.json into the candidate folder outside `mods/`, and checked
 * there. A check that cannot run does not pass.
 */
async function candidatePasses(spec, d, main) {
    const { ports } = d;
    const dir = [d.appHome, CANDIDATE_DIR[0], CANDIDATE_DIR[1], spec.name].join(ports.sep);
    const modJson = (await ports.readText([d.appHome, "mods", spec.source, "mod.json"].join(ports.sep))) ?? CANDIDATE_MOD_JSON;
    if (!(await put(ports, [dir, "mod.json"].join(ports.sep), modJson)) ||
        !(await put(ports, [dir, "main.js"].join(ports.sep), main))) {
        return false;
    }
    try {
        const checked = await ports.exec("herdr-app", ["check", dir], { timeout: CHECK_TIMEOUT_MS });
        return checked.code === 0;
    }
    catch {
        return false;
    }
}
/**
 * Makes sure `mods/suspender-tabs/main.js` is the patch of the shipped
 * tabs/main.js, and that this text passed `herdr-app check` before it was
 * written there. Never throws.
 */
export async function ensureTabsClone(d) {
    return ensureCopy(TABS_SPEC, d, d.cloneMod);
}
/**
 * Makes sure `mods/suspender-pane/main.js` is the patch of Herdr's shipped
 * pane header, checked as the tab bar's copy is (ADR 20). Never throws.
 */
export async function ensurePaneCopy(d, clonePane) {
    return ensureCopy(PANE_SPEC, d, clonePane);
}
async function ensureCopy(spec, d, cloneMod) {
    const { ports } = d;
    const path = (...parts) => [d.appHome, ...parts].join(ports.sep);
    const shipped = await ports.readText(path("mods", spec.source, "main.js"));
    if (shipped === null) {
        return { mode: "builtin", why: "no-tabs" };
    }
    const want = spec.patch(shipped, sha256Hex(shipped));
    if (want === null) {
        return { mode: "builtin", why: "anchors" };
    }
    const cloneDir = path("mods", spec.name);
    const clonePath = [cloneDir, "main.js"].join(ports.sep);
    let current = await ports.readText(clonePath);
    if (current !== null &&
        current !== want &&
        !ours(spec, current, await ports.readText([cloneDir, "mod.json"].join(ports.sep)))) {
        return { mode: "builtin", why: "foreign" };
    }
    // Checked before anything under mods/ changes: the live copy only ever gets this text.
    if (!(await candidatePasses(spec, d, want))) {
        return { mode: "builtin", why: "check-failed" };
    }
    if (current === null) {
        try {
            cloneMod();
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
    return { mode: "clone", why };
}
/**
 * How long a check of the tab bar copy may go without a sign of life (a read,
 * a write, a wait for `mod.clone` ending) before it is taken for lost: its
 * task belonged to a copy of the mod that closed. A running `herdr-app check`
 * is alive until its own timeout has passed as well.
 */
export const TABS_CHECK_STALE_MS = 90_000;
/** `exec`'s own timeout when none is given (herdr.d.ts). */
const EXEC_DEFAULT_TIMEOUT_MS = 30_000;
/**
 * The tab bar for this module load: the first call makes or rebuilds the copy
 * once and checks it (ensureTabsClone), later calls share that answer. A run
 * that went quiet (its copy closed) is started again, but never while its
 * `herdr-app check` may still be running: only once that check's timeout has
 * passed. Every call then keeps layouts/suspender.json built around the tab
 * bar it got. A copy that cannot be used says so in one short toast. Waiting
 * for `mod.clone` sleeps in the task of the caller that asked first. Never
 * throws.
 */
export function tabsKeeper(d) {
    let attempt = null;
    const start = (sleep, toast) => {
        const run = {
            result: Promise.resolve({ mode: "builtin", why: "check-failed" }),
            header: Promise.resolve("builtin"),
            settled: false,
            aliveUntil: 0,
        };
        const alive = (forMs) => {
            run.aliveUntil = Math.max(run.aliveUntil, d.now() + forMs);
        };
        // Every step of the run is a sign of life; a running check lives until its timeout.
        const step = (f) => async (...args) => {
            alive(TABS_CHECK_STALE_MS);
            try {
                return await f(...args);
            }
            finally {
                alive(TABS_CHECK_STALE_MS);
            }
        };
        const ports = {
            ...d.ports,
            readText: step(d.ports.readText),
            writeText: step(d.ports.writeText),
            exec: async (cmd, args, opts) => {
                alive((opts?.timeout ?? EXEC_DEFAULT_TIMEOUT_MS) + TABS_CHECK_STALE_MS);
                try {
                    return await d.ports.exec(cmd, args, opts);
                }
                finally {
                    alive(TABS_CHECK_STALE_MS);
                }
            },
        };
        alive(TABS_CHECK_STALE_MS);
        run.result = ensureTabsClone({ ports, appHome: d.appHome, cloneMod: d.cloneMod, sleep: step(sleep) })
            .catch(() => ({ mode: "builtin", why: "check-failed" }))
            .then((out) => {
            if (out.mode === "builtin") {
                tabsFallbackNotice({ herdrVersion: d.herdrVersion(), toast, warned: d.warned });
            }
            return out;
        });
        // The header copy after the tab bar's, in the same run; a header that cannot be used is quiet (Herdr's own stays).
        const clonePane = d.clonePane;
        run.header = run.result
            .then(async () => {
            if (clonePane === undefined) {
                return "builtin";
            }
            const out = await ensurePaneCopy({ ports, appHome: d.appHome, sleep: step(sleep) }, clonePane);
            return out.mode === "clone" ? "clone" : "builtin";
        })
            .catch(() => "builtin")
            .finally(() => {
            run.settled = true;
        });
        return run;
    };
    return async (sleep, toast) => {
        if (attempt === null || (!attempt.settled && d.now() > attempt.aliveUntil)) {
            attempt = start(sleep, toast);
        }
        const out = await attempt.result;
        const header = await attempt.header;
        try {
            await syncLayout({
                ports: d.ports,
                appHome: d.appHome,
                herdrVersion: d.herdrVersion(),
                toast,
                warned: d.warned,
                tabs: out.mode,
                header,
            });
        }
        catch {
            // The mod works without its layout.
        }
        return out;
    };
}
