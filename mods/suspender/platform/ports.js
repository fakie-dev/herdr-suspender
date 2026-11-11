// Ports: everything the core and the adapters need from Herdr, the file
// system and processes, behind one interface. `core/` and `adapters/` import
// only this type; tests pass in-memory fakes (`test/fakePorts.ts`).
// `herdrPorts()` is the implementation on Herdr's runtime ("herdr" and its
// "fs/promises"); it is never loaded by the tests.
import * as fs from "fs/promises";
import { exec as herdrExec, hc as herdrHc, home as herdrHome, window as herdrWindow, readTextFile, watchFolder, writeTextFile, } from "herdr";
import * as os from "os";
import { utf8Head, utf8Tail } from "../runtime/utf8.js";
import { statFile } from "./proc.js";
function detectPlatform() {
    try {
        return herdrWindow().platform;
    }
    catch {
        // No window to ask (e.g. during a check run): ask the runtime.
    }
    const name = os.platform();
    if (name === "win32" || name === "windows") {
        return "windows";
    }
    return name === "darwin" || name === "macos" ? "macos" : "linux";
}
function parentDir(path) {
    const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
    return cut > 0 ? path.slice(0, cut) : path;
}
/**
 * The whole file as UTF-8 text. Herdr's runtime has no TextDecoder and its
 * Buffer does not decode (toString gives ""), so files are read as text and
 * cut by bytes with `utf8Head` / `utf8Tail`.
 */
async function readUtf8(path) {
    try {
        return await fs.readFile(path, "utf8");
    }
    catch {
        // "fs/promises" reads only in the home: a HERDR_APP_HOME elsewhere is read through Herdr (up to 1 MiB).
        try {
            return await readTextFile(path);
        }
        catch {
            return null;
        }
    }
}
export function herdrPorts() {
    const platform = detectPlatform();
    return {
        home: () => herdrHome(),
        sep: platform === "windows" ? "\\" : "/",
        platform,
        wholeReads: true,
        now: () => Date.now(),
        // Not `readTextFile`: it stops at 1 MiB, and transcripts run to 50+ MB.
        readText: (path) => readUtf8(path),
        readHead: async (path, bytes) => {
            const all = await readUtf8(path);
            return all === null ? null : utf8Head(all, bytes);
        },
        readTail: async (path, bytes) => {
            const all = await readUtf8(path);
            return all === null ? null : utf8Tail(all, bytes);
        },
        stat: (path) => statFile(path, platform, herdrExec),
        list: async (dir) => {
            try {
                return await fs.readdir(dir);
            }
            catch {
                return [];
            }
        },
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
        watch: (dir) => watchFolder(dir),
        exec: (cmd, args, opts) => herdrExec(cmd, args, opts),
        hc: (args) => herdrHc(args),
    };
}
