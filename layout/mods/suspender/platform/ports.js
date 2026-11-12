// Ports: everything the core and the adapters need from Herdr, the file
// system and processes, behind one interface. `core/` and `adapters/` import
// only this type; tests pass in-memory fakes (`test/fakePorts.ts`).
// `herdrPorts()` is the implementation on Herdr's runtime ("herdr" and its
// "fs/promises"); it is never loaded by the tests.
import * as fs from "fs/promises";
import { exec as herdrExec, hc as herdrHc, home as herdrHome, window as herdrWindow, readTextFile, watchFolder, writeTextFile, } from "herdr";
import * as os from "os";
import { utf8Head, utf8Tail } from "../runtime/utf8.js";
import { readPart, statFile } from "./proc.js";
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
 * The most Herdr's `fs.readFile` reads: a bigger file is refused ("over the
 * 67108864-byte limit for fs.readFile; read it in pieces"), measured on 0.1.15.
 */
const FS_READ_MAX = 64 * 1024 * 1024;
/**
 * From this size on, a tail is read by a process (`readPart`, about 30 ms on Windows)
 * instead of cut from a whole read: fs.readFile took 14 ms for 8 MiB and 120 ms for
 * 60 MiB on Herdr 0.1.15, and holds the whole text in memory meanwhile.
 */
const PART_FROM = 8 * 1024 * 1024;
/**
 * The whole file as UTF-8 text. Herdr's runtime has no TextDecoder and its
 * Buffer does not decode (toString gives ""), so files are read as text and
 * cut by bytes with `utf8Head` / `utf8Tail`. Null past FS_READ_MAX.
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
        wholeMax: FS_READ_MAX,
        now: () => Date.now(),
        // Not `readTextFile`: it stops at 1 MiB, and transcripts run to 50+ MB.
        readText: (path) => readUtf8(path),
        // A head is read once per file (a rollout's first line, a transcript's first prompt):
        // from a whole read, which starts no process, unless the file is past fs's limit.
        readHead: async (path, bytes) => {
            const all = await readUtf8(path);
            return all !== null ? utf8Head(all, bytes) : await readPart(path, "head", bytes, platform, herdrExec);
        },
        // A tail is what a growing transcript is read by, every 30 s while Sessions is open:
        // a big one by only its bytes, one short process, not the whole file each time.
        readTail: async (path, bytes, size) => {
            const part = size !== undefined && size <= PART_FROM ? null : await readPart(path, "tail", bytes, platform, herdrExec);
            if (part !== null) {
                return part;
            }
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
