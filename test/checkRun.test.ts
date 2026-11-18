// `herdr-app check` runs the mod's module and its init() for real, with the
// person's own home (Herdr 0.1.16 says so through `checking()`). Under a check
// the mod only seeds a missing layout, which a clean install needs; it starts
// nothing else: no rebuild of the layout, no rounds over the sessions, no
// update check, no copy of the tab bar.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { type LoadedMod, loadMod } from "./standIns.ts";

interface Node {
  id?: string;
  size?: { px?: number };
  children?: Node[];
  suspender_generated?: { from: string };
}
const nodes = (n: Node): Node[] => [n, ...(n.children ?? []).flatMap(nodes)];
const g = globalThis as Record<string, unknown>;

/** A home whose main.json differs from the one the mod ships (a taller tab bar). */
function otherMain(): string {
  const main = JSON.parse(readFileSync(new URL("./fixtures/main-0.1.14.json", import.meta.url), "utf8")) as Node;
  const tabs = nodes(main).find((n) => n.id === "tabs");
  assert.ok(tabs);
  tabs.size = { px: 34 };
  return `${JSON.stringify(main, null, 2)}\n`;
}

describe("under herdr-app check", () => {
  let mod: LoadedMod;
  const main = otherMain();
  before(async () => {
    g["suspenderChecking"] = true;
    mod = await loadMod({ readsHang: false, main });
  });
  after(() => {
    delete g["suspenderChecking"];
    mod.cleanup();
  });

  it("seeds a missing layout, and does not rebuild it from the home's main.json", async () => {
    const living = join(mod.appHome, "layouts", "suspender.json");
    assert.ok(await mod.appears(living, 1_000), "a clean install still gets its layout");
    // The rebuild would land within a second (boot.test.ts); under a check it never comes.
    await new Promise((resolve) => setTimeout(resolve, 600));
    const layout = JSON.parse(readFileSync(living, "utf8")) as Node;
    const home = createHash("sha256")
      .update(JSON.stringify(JSON.parse(main)))
      .digest("hex");
    assert.notEqual(layout.suspender_generated?.from, home);
  });

  it("starts nothing from a copy's init()", async () => {
    const { default: Suspender } = (await import(new URL("../src/main.ts", import.meta.url).href)) as {
      default: new () => { init(props: unknown, cx: unknown): void };
    };
    const started: string[] = [];
    const cx = {
      spawn: () => started.push("spawn"),
      notify: () => undefined,
      sleep: () => new Promise(() => undefined),
      timer: { every: () => started.push("timer") },
    };
    new Suspender().init({}, cx);
    assert.equal(started.length, 0, started.join(","));
    // The same copy in a live window starts its rounds, its commands and the rest.
    g["suspenderChecking"] = false;
    try {
      new Suspender().init({}, cx);
    } finally {
      g["suspenderChecking"] = true;
    }
    assert.ok(started.includes("spawn") && started.includes("timer"), started.join(","));
  });
});
