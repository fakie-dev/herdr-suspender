// Writes `mods/suspender/manifest.json`, the checksum manifest a release
// carries (src/core/manifest.ts, ADR 12): every file of the mod with the
// sha256 of its text, the version from package.json and the key snippet from
// keys.json. The update button installs a release only when every file it
// downloads matches the manifest at the same tag.
//
//   node scripts/build-manifest.ts           write it
//   node scripts/build-manifest.ts --check   fail when it is not what a write would produce
//
// It also fails when a file could not be updated by the button: a name the
// updater would refuse (SAFE_PATH) or a file that is not UTF-8 text. And when
// src/core/release.ts names another version than package.json.

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { buildManifest, herdrWritten, type KeyMap, MANIFEST_FILE, renderManifest } from "../src/core/manifest.ts";
import { MOD_VERSION, SAFE_PATH } from "../src/core/release.ts";

const root = join(import.meta.dirname, "..");
const MOD = join(root, "mods", "suspender");
const OUT = join(MOD, MANIFEST_FILE);

function modFiles(problems: string[]): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      const rel = relative(MOD, path).replace(/\\/g, "/");
      if (herdrWritten(rel) || rel === MANIFEST_FILE) {
        continue;
      }
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      const bytes = readFileSync(path);
      const text = bytes.toString("utf8");
      if (!SAFE_PATH.test(rel)) {
        problems.push(`${rel}: a name the update button cannot install (letters, digits, _ - and .js .json .svg)`);
      } else if (bytes.includes(0) || Buffer.from(text, "utf8").compare(bytes) !== 0) {
        problems.push(`${rel}: not UTF-8 text, which is all the update button installs`);
      }
      files.set(rel, text);
    }
  };
  walk(MOD);
  return files;
}

// Line endings are normalised: a Windows checkout may hold CRLF.
const read = (path: string): string => readFileSync(path, "utf8").replace(/\r\n/g, "\n");

const problems: string[] = [];
const pkg = JSON.parse(read(join(root, "package.json"))) as { version: string };
if (MOD_VERSION !== pkg.version) {
  problems.push(`src/core/release.ts says ${MOD_VERSION}, package.json ${pkg.version}`);
}
const keys = JSON.parse(read(join(root, "keys.json"))) as KeyMap;
const want = renderManifest(buildManifest(pkg.version, keys, modFiles(problems)));

if (process.argv.includes("--check")) {
  if (!existsSync(OUT)) {
    problems.push(`missing  mods/suspender/${MANIFEST_FILE}`);
  } else if (read(OUT) !== want) {
    problems.push(`stale    mods/suspender/${MANIFEST_FILE}`);
  }
} else if (problems.length === 0) {
  writeFileSync(OUT, want);
}
if (problems.length > 0) {
  console.error(`mods/suspender/${MANIFEST_FILE} is not what the build produces (run \`pnpm build\`):`);
  for (const line of problems) {
    console.error(`  ${line}`);
  }
  process.exit(1);
}
console.log(
  `mods/suspender/${MANIFEST_FILE} ${process.argv.includes("--check") ? "matches" : "written for"} ${Object.keys(JSON.parse(want).files).length} files`,
);
