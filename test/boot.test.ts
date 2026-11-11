// Installing the mod into a running Herdr: the module loads with no copy of the
// mod on screen, and a clean home gets layouts/suspender.json, built from the
// main.json that home really has (here a newer one than the mod knows).

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { loadMod } from "./standIns.ts";

interface Node {
  id?: string;
  size?: { px?: number };
  children?: Node[];
  cloned_from?: { name: string; version: string };
  suspender_generated?: { from: string };
}
const nodes = (n: Node): Node[] => [n, ...(n.children ?? []).flatMap(nodes)];

/** "A newer Herdr": its main.json has a taller tab bar. */
function newerMain(): string {
  const main = JSON.parse(readFileSync(new URL("./fixtures/main-0.1.14.json", import.meta.url), "utf8")) as Node;
  const tabs = nodes(main).find((n) => n.id === "tabs");
  assert.ok(tabs);
  tabs.size = { px: 34 };
  return `${JSON.stringify(main, null, 2)}\n`;
}

describe("installing the mod", () => {
  it("builds layouts/suspender.json from the home's own main.json before any copy is shown", async () => {
    const main = newerMain();
    const mod = await loadMod({ readsHang: false, main });
    after(mod.cleanup);
    const living = join(mod.appHome, "layouts", "suspender.json");
    const from = createHash("sha256")
      .update(JSON.stringify(JSON.parse(main)))
      .digest("hex");
    let layout: Node | null = null;
    const end = Date.now() + 3_000;
    while (Date.now() < end && layout?.suspender_generated?.from !== from) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      try {
        layout = JSON.parse(readFileSync(living, "utf8")) as Node;
      } catch {
        layout = null;
      }
    }
    assert.equal(layout?.suspender_generated?.from, from, "built from this home's main.json");
    assert.deepEqual(layout?.cloned_from, { name: "main", version: "0.1.14" });
  });
});
