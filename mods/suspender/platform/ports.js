// Ports: everything the core and the adapters need from Herdr, the file
// system and processes, behind one interface. `core/` and `adapters/` import
// only this type; tests pass in-memory fakes (`test/fakePorts.ts`).
// `herdrPorts()` is the implementation on Herdr's runtime ("herdr" and its
// "fs/promises"); it is never loaded by the tests.
import { Buffer } from "buffer";
import * as fs from "fs/promises";
import { exec as herdrExec, hc as herdrHc, home as herdrHome, window as herdrWindow, readTextFile, watchFolder, writeTextFile, } from "herdr";
import * as os from "os";
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
async function readBytes(path) {
    try {
        return await fs.readFile(path);
    }
    catch {
        return null;
    }
}
const decode = (bytes) => Buffer.from(bytes).toString("utf8");
export function herdrPorts() {
    const platform = detectPlatform();
    return {
        home: () => herdrHome(),
        sep: platform === "windows" ? "\\" : "/",
        platform,
        wholeReads: true,
        now: () => Date.now(),
        // Not `readTextFile`: it stops at 1 MiB, and transcripts run to 50+ MB.
        readText: async (path) => {
            const all = await readBytes(path);
            return all === null ? null : decode(all);
        },
        readHead: async (path, bytes) => {
            const all = await readBytes(path);
            return all === null ? null : decode(all.subarray(0, bytes));
        },
        readTail: async (path, bytes) => {
            const all = await readBytes(path);
            return all === null ? null : decode(all.subarray(Math.max(0, all.length - bytes)));
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
