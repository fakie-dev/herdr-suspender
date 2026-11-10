// Copies Herdr's type declarations (`herdr.d.ts`, `gpui-kit.d.ts`) from the
// app folder into `types/`, with the Herdr version they came from in a header
// line. Herdr rewrites its copies on every start, so ours are refreshed by
// hand: run `pnpm sync-types` after a Herdr update and commit the diff.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HEADER_PREFIX = "// Synced from Herdr app ";
const FILES = ["herdr.d.ts", "gpui-kit.d.ts"];

const appHome = process.env.HERDR_APP_HOME ?? join(homedir(), ".config", "herdr-app");
const outDir = join(import.meta.dirname, "..", "types");

function herdrVersion(): string {
  try {
    const out = execFileSync("herdr-app", ["--version"], { encoding: "utf8", timeout: 10_000 });
    const match = out.match(/\d+\.\d+\.\d+\S*/);
    if (match) {
      return match[0];
    }
  } catch {
    // Not on PATH: fall back to what the app recorded as its last run.
  }
  const notes = join(appHome, "update-notes.json");
  if (existsSync(notes)) {
    const lastRun = (JSON.parse(readFileSync(notes, "utf8")) as { last_run?: unknown }).last_run;
    if (typeof lastRun === "string") {
      return lastRun;
    }
  }
  return "unknown";
}

const version = herdrVersion();
for (const name of FILES) {
  const source = join(appHome, name);
  if (!existsSync(source)) {
    console.error(`missing ${source}: is Herdr app installed and started once?`);
    process.exit(1);
  }
  const body = readFileSync(source, "utf8").replace(/\r\n/g, "\n");
  const header = `${HEADER_PREFIX}${version} by \`pnpm sync-types\`; do not edit.\n`;
  writeFileSync(join(outDir, name), header + body);
  console.log(`types/${name} <- ${source} (Herdr ${version})`);
}
