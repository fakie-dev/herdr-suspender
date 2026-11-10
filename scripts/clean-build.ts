// Removes compiled `.js` files from `mods/suspender/` before a build, so a
// source that was deleted or renamed leaves no stale module behind. mod.json
// and icons are kept.

import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..", "mods", "suspender");

function clean(dir: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      clean(path);
      if (readdirSync(path).length === 0) {
        rmSync(path, { recursive: true });
      }
    } else if (entry.name.endsWith(".js")) {
      rmSync(path);
    }
  }
}

if (existsSync(root)) {
  clean(root);
}
