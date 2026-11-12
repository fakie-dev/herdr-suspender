// The updater's disk, programs and network on Herdr's runtime. Never loaded by
// the tests: `test/update/world.ts` simulates the same interface, and
// `test/update/swap.test.ts` runs the real swap command on real folders.
import * as fs from "fs/promises";
import { exec, readTextFile, writeTextFile } from "herdr";
import { latestReleaseUrl } from "../core/release.js";
import { parseSwapOutput, swapCommand } from "../runtime/swap.js";
/** `herdr-app check` of a staged release: one small mod, as for the tab bar copy. */
const CHECK_TIMEOUT_MS = 60_000;
/** The swap: two renames, each retried for two seconds on Windows, and PowerShell's start. */
const SWAP_TIMEOUT_MS = 60_000;
function parentDir(path) {
    const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
    return cut > 0 ? path.slice(0, cut) : path;
}
async function readUtf8(path) {
    try {
        return await fs.readFile(path, "utf8");
    }
    catch {
        try {
            return await readTextFile(path);
        }
        catch {
            return null;
        }
    }
}
export function herdrUpdateFiles(platform) {
    const sep = platform === "windows" ? "\\" : "/";
    const walk = async (dir, prefix, out) => {
        for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
            const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
            if (entry.isDirectory()) {
                await walk(`${dir}${sep}${entry.name}`, rel, out);
            }
            else {
                out.push(rel);
            }
        }
    };
    const remove = async (path) => {
        let entries;
        try {
            entries = await fs.readdir(path, { withFileTypes: true });
        }
        catch {
            await fs.unlink(path).catch(() => undefined);
            return;
        }
        for (const entry of entries) {
            const child = `${path}${sep}${entry.name}`;
            if (entry.isDirectory()) {
                await remove(child);
            }
            else {
                await fs.unlink(child).catch(() => undefined);
            }
        }
        await fs.rmdir(path).catch(() => undefined);
    };
    return {
        sep,
        readText: readUtf8,
        writeText: async (path, text, expected) => {
            try {
                await fs.mkdir(parentDir(path), { recursive: true });
                const base = expected === undefined ? await readTextFile(path) : expected;
                await writeTextFile(path, text, base);
                return true;
            }
            catch {
                return false;
            }
        },
        listFiles: async (dir) => {
            if (!(await fs.exists(dir).catch(() => false))) {
                return null;
            }
            const out = [];
            try {
                await walk(dir, "", out);
            }
            catch {
                return null;
            }
            return out;
        },
        removeTree: async (dir) => {
            if (await fs.exists(dir).catch(() => false)) {
                await remove(dir);
            }
        },
        checkMod: async (dir) => {
            try {
                const out = await exec("herdr-app", ["check", dir], { timeout: CHECK_TIMEOUT_MS });
                return out.code === 0 ? "passed" : "failed";
            }
            catch {
                return "unavailable";
            }
        },
        swap: async (live, incoming, parked, drop) => {
            const { cmd, args } = swapCommand(platform, live, incoming, parked, drop);
            try {
                const out = await exec(cmd, args, { timeout: SWAP_TIMEOUT_MS });
                return parseSwapOutput(out.stdout);
            }
            catch (e) {
                return { result: "unchanged", detail: String(e) };
            }
        },
    };
}
/** A GET of one of release.ts's URLs, as GitHub wants it asked (its API refuses a request without a User-Agent). */
export async function fetchRelease(url, version) {
    const headers = { "User-Agent": `herdr-suspender/${version}` };
    if (url === latestReleaseUrl()) {
        headers["Accept"] = "application/vnd.github+json";
        headers["X-GitHub-Api-Version"] = "2022-11-28";
    }
    const answer = await fetch(url, { headers });
    return { status: answer.status, text: await answer.text() };
}
/** Opens a page in the default browser. */
export function openInBrowser(platform, url) {
    const [cmd, args] = platform === "windows" ? ["explorer.exe", [url]] : platform === "macos" ? ["open", [url]] : ["xdg-open", [url]];
    void exec(cmd, args).catch(() => undefined);
}
