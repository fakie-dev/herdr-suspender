// Herdr's toast draws a title and a body of one line each and cuts the rest
// (mods/toast: 13 px semibold and 12 px, about 280 px of room). Every toast of
// an update says all it has to say inside that, with room to spare for a UI
// font wider than Geist; the long story is in the Sessions line's tooltip.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { UPDATE_REASONS } from "../../src/core/updateState.ts";
import { STARTUP_DELAY_MS, Updater, updateNotice } from "../../src/runtime/updater.ts";
import { uiMeasure } from "../../src/ui/textWidth.ts";
import { build, KEYS, LIVE, World } from "../update/world.ts";

const ROOM = 260;
const fits = (title: string, body: string | undefined, what: string): void => {
  const t = uiMeasure(title, 13, "semibold");
  assert.ok(t <= ROOM, `${what} title: ${t.toFixed(0)} px "${title}"`);
  if (body !== undefined) {
    const b = uiMeasure(body, 12);
    assert.ok(b <= ROOM, `${what} body: ${b.toFixed(0)} px "${body}"`);
  }
};

describe("every update toast fits Herdr's toast", () => {
  it("for each reason an update or a rollback stops", () => {
    for (const reason of UPDATE_REASONS) {
      const n = updateNotice(
        { kind: "failed", from: "10.10.10", to: "10.10.11", reason, count: 57, at: 0, keys: [] },
        "C:/Users/tester/.config/herdr-app/suspender/update/backup/suspender",
      );
      fits(n.title, n.body, reason);
    }
  });

  it("for a new release, a finished update with new keys, and a rollback", async () => {
    const world = new World();
    world.install(LIVE, "10.10.10");
    const keys = { ...KEYS, global: { ...KEYS["global"], "ctrl-alt-shift-u": "suspender.some-long-command" } };
    world.publish("10.10.11", build("10.10.11"), keys);
    const u = new Updater(world.deps("10.10.10"));
    await u.load();
    world.now += STARTUP_DELAY_MS;
    await u.tick();
    await u.update();
    const next = new Updater(world.deps("10.10.11"));
    await next.load();
    await next.rollback();
    assert.equal(world.notices.length, 3);
    for (const n of world.notices) {
      fits(n.title, n.body, n.title);
    }
  });
});
