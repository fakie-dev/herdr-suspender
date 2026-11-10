// Ports: everything the core and the adapters need from Herdr, the file
// system and processes, behind one interface. `core/` and `adapters/` import
// only this type; tests pass in-memory fakes (`test/fakePorts.ts`).
// `herdrPorts()` is the implementation on Herdr's runtime ("herdr" and its
// "fs/promises"); it is never loaded by the tests.
import { Buffer } from "buffer";
import * as fs from "fs/promises";
import { exec as herdrExec, hc as herdrHc, home as herdrHome, window as herdrWindow, readTextFile, watchFolder, writeTextFile, } from "herdr";
import * as os from "os";
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
/** Quotes a path for a PowerShell single-quoted string. */
const psQuote = (text) => `'${text.replace(/'/g, "''")}'`;
/**
 * Herdr's "fs/promises" has no stat and no partial reads, so the size comes
 * from reading the file and the modification time from the system's own tool.
 */
async function statFile(path, platform) {
    const bytes = await readBytes(path);
    if (bytes === null) {
        return null;
    }
    const command = platform === "windows"
        ? [
            "powershell.exe",
            [
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                `([DateTimeOffset](Get-Item -LiteralPath ${psQuote(path)}).LastWriteTimeUtc).ToUnixTimeMilliseconds()`,
            ],
        ]
        : platform === "macos"
            ? ["stat", ["-f", "%m", path]]
            : ["stat", ["-c", "%Y", path]];
    try {
        const out = await herdrExec(command[0], command[1], { timeout: 10_000 });
        const value = Number(out.stdout.trim());
        if (out.code === 0 && Number.isFinite(value)) {
            return { mtimeMs: platform === "windows" ? value : value * 1000, size: bytes.length };
        }
    }
    catch {
        // Fall through: the size is still right.
    }
    return { mtimeMs: Number.NaN, size: bytes.length };
}
export function herdrPorts() {
    const platform = detectPlatform();
    return {
        home: () => herdrHome(),
        sep: platform === "windows" ? "\\" : "/",
        platform,
        now: () => Date.now(),
        readText: async (path) => {
            try {
                return await readTextFile(path);
            }
            catch {
                return null;
            }
        },
        readHead: async (path, bytes) => {
            const all = await readBytes(path);
            return all === null ? null : decode(all.subarray(0, bytes));
        },
        readTail: async (path, bytes) => {
            const all = await readBytes(path);
            return all === null ? null : decode(all.subarray(Math.max(0, all.length - bytes)));
        },
        stat: (path) => statFile(path, platform),
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
