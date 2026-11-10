// Keeps `layout/`, the second catalog card, in step with the mod. The card is
// a ready-made window: `layouts/suspender.json` is what the mod's own generator
// writes for Herdr 0.1.14's shipped main.json (the fixture the tests use), and
// `mods/suspender/` is a copy of the committed build.
//
//   node scripts/build-layout.ts           write layout/layouts and layout/mods
//   node scripts/build-layout.ts --check   fail when they differ from what a write would produce
//
// `pnpm build` writes, `pnpm check` checks. The JSON is compared as data, so
// the formatter is free to lay the file out as it likes.

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { buildLivingLayout, LAYOUT_NAME } from "../src/core/layout.ts";

const root = join(import.meta.dirname, "..");
const MOD_SRC = join(root, "mods", "suspender");
const MOD_DST = join(root, "layout", "mods", "suspender");
const LAYOUT_DST = join(root, "layout", "layouts", `${LAYOUT_NAME}.json`);
const MAIN_FIXTURE = join(root, "test", "fixtures", "main-0.1.14.json");
const MAIN_VERSION = "0.1.14";

/** Files of the mod Herdr loads. Herdr also writes `*.d.ts` and `*.error` next to a mod it checks. */
function modFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (at: string): void => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else if (!(entry.name.endsWith(".d.ts") || entry.name.endsWith(".error"))) {
        out.push(relative(dir, path).replace(/\\/g, "/"));
      }
    }
  };
  if (existsSync(dir)) {
    walk(dir);
  }
  return out.sort();
}

// Line endings are normalised: a Windows checkout may hold CRLF.
const text = (path: string): string => readFileSync(path, "utf8").replace(/\r\n/g, "\n");

function generatedLayout(): object {
  const main: unknown = JSON.parse(readFileSync(MAIN_FIXTURE, "utf8"));
  const built = buildLivingLayout(main, MAIN_VERSION);
  if (!built.ok) {
    throw new Error(`the generator does not fit the fixture main.json: ${built.reason}`);
  }
  return built.layout;
}

function write(): void {
  rmSync(MOD_DST, { recursive: true, force: true });
  mkdirSync(MOD_DST, { recursive: true });
  for (const file of modFiles(MOD_SRC)) {
    const to = join(MOD_DST, file);
    mkdirSync(join(to, ".."), { recursive: true });
    cpSync(join(MOD_SRC, file), to);
  }
  mkdirSync(join(LAYOUT_DST, ".."), { recursive: true });
  writeFileSync(LAYOUT_DST, `${JSON.stringify(generatedLayout(), null, 2)}\n`);
  console.log(`layout/ written (${modFiles(MOD_DST).length} mod files, 1 layout)`);
}

function check(): number {
  const problems: string[] = [];
  const want = modFiles(MOD_SRC);
  const have = modFiles(MOD_DST);
  for (const file of want) {
    if (!have.includes(file)) {
      problems.push(`missing  layout/mods/suspender/${file}`);
    } else if (text(join(MOD_SRC, file)) !== text(join(MOD_DST, file))) {
      problems.push(`stale    layout/mods/suspender/${file}`);
    }
  }
  for (const file of have) {
    if (!want.includes(file)) {
      problems.push(`leftover layout/mods/suspender/${file}`);
    }
  }
  if (!existsSync(LAYOUT_DST)) {
    problems.push(`missing  layout/layouts/${LAYOUT_NAME}.json`);
  } else if (JSON.stringify(JSON.parse(text(LAYOUT_DST))) !== JSON.stringify(generatedLayout())) {
    problems.push(`stale    layout/layouts/${LAYOUT_NAME}.json`);
  }
  if (problems.length > 0) {
    console.error("layout/ is not what the build produces (run `pnpm build`):");
    for (const line of problems) {
      console.error(`  ${line}`);
    }
    return 1;
  }
  console.log(`layout/ matches the build (${want.length} mod files, 1 layout)`);
  return 0;
}

if (process.argv.includes("--check")) {
  process.exit(check());
}
write();
