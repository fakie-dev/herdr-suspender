// Fails when the committed build in `mods/suspender/` is not what the sources
// compile to: a changed, missing or left-over `.js` file. `pnpm build:check`
// compiles into a scratch folder and calls this with both folders; the scratch
// folder is removed afterwards. Files that are not compiler output (mod.json,
// icons) are not compared.

import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join, relative } from "node:path";

const [fresh, committed] = process.argv.slice(2);
if (!(fresh && committed)) {
  console.error("usage: compare-build.ts <fresh build dir> <committed build dir>");
  process.exit(2);
}

function jsFiles(root: string): Map<string, string> {
  const files = new Map<string, string>();
  if (!existsSync(root)) {
    return files;
  }
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else if (entry.name.endsWith(".js")) {
        // Line endings are normalised: a Windows checkout may hold CRLF.
        const text = readFileSync(path, "utf8").replace(/\r\n/g, "\n");
        files.set(relative(root, path).replace(/\\/g, "/"), text);
      }
    }
  };
  walk(root);
  return files;
}

const want = jsFiles(fresh);
const have = jsFiles(committed);
rmSync(fresh, { recursive: true, force: true });

const problems: string[] = [];
for (const [path, text] of want) {
  const old = have.get(path);
  if (old === undefined) {
    problems.push(`missing  ${path}`);
  } else if (old !== text) {
    problems.push(`stale    ${path}`);
  }
}
for (const path of have.keys()) {
  if (!want.has(path)) {
    problems.push(`leftover ${path}`);
  }
}

if (problems.length > 0) {
  console.error(`${committed} is not the current build of src/ (run \`pnpm build\`):`);
  for (const line of problems) {
    console.error(`  ${line}`);
  }
  process.exit(1);
}
console.log(`${committed} matches the sources (${want.size} files)`);
