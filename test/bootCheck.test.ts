// `herdr-app check` (which installing the mod runs) loads the module, renders
// once and exits: measured live, a write started at once lands, but nothing
// that first waits for a read does. A clean home must still get
// layouts/suspender.json from it.

import assert from "node:assert/strict";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { loadMod } from "./standIns.ts";

describe("installing the mod, checked with herdr-app check", () => {
  it("writes layouts/suspender.json although no read finishes", async () => {
    const mod = await loadMod({ readsHang: true });
    after(mod.cleanup);
    assert.ok(await mod.appears(join(mod.appHome, "layouts", "suspender.json"), 1_000));
  });
});
