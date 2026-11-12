// The updater's disk, programs and network on Herdr's runtime. Never loaded by
// the tests: `test/update/world.ts` simulates the same interface, and
// `test/update/swap.test.ts` runs the real swap command on real folders.

import { createHash } from "crypto";
import * as fs from "fs/promises";
import { exec, readTextFile, writeTextFile } from "herdr";
import { fileHash } from "../core/manifest.ts";
import { latestReleaseUrl } from "../core/release.ts";
import { parseSwapOutput, swapCommand } from "../runtime/swap.ts";
import type { SwapResult, UpdateFiles } from "../runtime/updater.ts";
import type { Platform } from "./ports.ts";

/** `herdr-app check` of a staged release: one small mod, as for the tab bar copy. */
const CHECK_TIMEOUT_MS = 60_000;
/** The swap: two renames, each retried for two seconds on Windows, and PowerShell's start. */
const SWAP_TIMEOUT_MS = 60_000;

function parentDir(path: string): string {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return cut > 0 ? path.slice(0, cut) : path;
}

async function readUtf8(path: string): Promise<string | null> {
  try {
    return await fs.readFile(path, "utf8");
  } catch {
    try {
      return await readTextFile(path);
    } catch {
      return null;
    }
  }
}

export function herdrUpdateFiles(platform: Platform): UpdateFiles {
  const sep = platform === "windows" ? "\\" : "/";
  const walk = async (dir: string, prefix: string, out: string[]): Promise<void> => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(`${dir}${sep}${entry.name}`, rel, out);
      } else {
        out.push(rel);
      }
    }
  };
  const remove = async (path: string): Promise<void> => {
    let entries: { name: string; isDirectory(): boolean }[];
    try {
      entries = await fs.readdir(path, { withFileTypes: true });
    } catch {
      await fs.unlink(path).catch(() => undefined);
      return;
    }
    for (const entry of entries) {
      const child = `${path}${sep}${entry.name}`;
      if (entry.isDirectory()) {
        await remove(child);
      } else {
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
      } catch {
        return false;
      }
    },
    listFiles: async (dir) => {
      if (!(await fs.exists(dir).catch(() => false))) {
        return null;
      }
      const out: string[] = [];
      try {
        await walk(dir, "", out);
      } catch {
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
      } catch {
        return "unavailable";
      }
    },
    swap: async (live, incoming, parked, drop): Promise<SwapResult> => {
      const { cmd, args } = swapCommand(platform, live, incoming, parked, drop);
      try {
        const out = await exec(cmd, args, { timeout: SWAP_TIMEOUT_MS });
        return parseSwapOutput(out.stdout);
      } catch (e) {
        return { result: "unchanged", detail: String(e) };
      }
    },
  };
}

/** A GET of one of release.ts's URLs, as GitHub wants it asked (its API refuses a request without a User-Agent). */
export async function fetchRelease(url: string, version: string): Promise<{ status: number; text: string }> {
  const headers: Record<string, string> = { "User-Agent": `herdr-suspender/${version}` };
  if (url === latestReleaseUrl()) {
    headers["Accept"] = "application/vnd.github+json";
    headers["X-GitHub-Api-Version"] = "2022-11-28";
  }
  const answer = await fetch(url, { headers });
  return { status: answer.status, text: await answer.text() };
}

/** Opens a page in the default browser. */
export function openInBrowser(platform: Platform, url: string): void {
  const [cmd, args]: [string, string[]] =
    platform === "windows" ? ["explorer.exe", [url]] : platform === "macos" ? ["open", [url]] : ["xdg-open", [url]];
  void exec(cmd, args).catch(() => undefined);
}

/**
 * manifest.ts's fileHash with Herdr's native sha256: the same digest (measured,
 * non-ASCII text included) in no time, where the script's own took 450 ms for
 * engine.js. The script's own stays as the fallback.
 */
export function nativeFileHash(text: string): string {
  try {
    const digest = createHash("sha256").update(text.replace(/\r\n/g, "\n")).digest("hex");
    if (typeof digest === "string" && /^[0-9a-f]{64}$/.test(digest)) {
      return digest;
    }
  } catch {
    // No native hash in this runtime.
  }
  return fileHash(text);
}
