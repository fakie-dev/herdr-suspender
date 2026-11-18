// The daily look at GitHub for a newer release, and the one toast per version.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { latestReleaseUrl } from "../../src/core/release.ts";
import { CHECK_EVERY_MS, MANUAL_SHOWN_MS, STARTUP_DELAY_MS, Updater } from "../../src/runtime/updater.ts";
import { DAY, LIVE, STATE, World } from "./world.ts";

async function started(world: World, version = "0.1.2"): Promise<Updater> {
  const u = new Updater(world.deps(version));
  await u.load();
  world.now += STARTUP_DELAY_MS;
  return u;
}

const latestFetches = (world: World): number => world.fetched.filter((u) => u === latestReleaseUrl()).length;

describe("the check", () => {
  it("waits a little after the module loads (a `herdr-app check` run never reaches the network)", async () => {
    const world = new World();
    world.install(LIVE, "0.1.2");
    world.publish("0.1.3");
    const u = new Updater(world.deps("0.1.2"));
    await u.load();
    await u.tick();
    world.now += STARTUP_DELAY_MS - 1;
    await u.tick();
    assert.deepEqual(world.fetched, []);
  });

  it("asks GitHub at most once a day", async () => {
    const world = new World();
    world.install(LIVE, "0.1.2");
    world.publish("0.1.2");
    const u = await started(world);
    await u.tick();
    assert.deepEqual(world.fetched, [latestReleaseUrl()]);
    const first = world.now;
    for (const step of [1, 60_000, DAY / 2, DAY - 60_000]) {
      world.now = first + step;
      await u.tick();
    }
    assert.equal(latestFetches(world), 1);
    world.now = first + CHECK_EVERY_MS;
    await u.tick();
    assert.equal(latestFetches(world), 2);
  });

  it("is shared by every copy and window: the one that claims the day asks, the others do not", async () => {
    const world = new World();
    world.install(LIVE, "0.1.2");
    world.publish("0.1.3");
    const a = await started(world);
    const b = new Updater(world.deps("0.1.2"));
    await b.load();
    await Promise.all([a.tick(), b.tick()]);
    assert.equal(latestFetches(world), 1);
    // A window that loaded later reads the day's check from the file.
    const c = await started(world);
    await c.tick();
    assert.equal(latestFetches(world), 1);
    assert.equal(c.state().latest, "0.1.3");
  });

  it("keeps the time and the result in suspender/update.json", async () => {
    const world = new World();
    world.install(LIVE, "0.1.2");
    world.publish("0.1.3");
    const u = await started(world);
    await u.tick();
    const saved = JSON.parse(world.ports.files.get(STATE) ?? "{}") as Record<string, unknown>;
    assert.equal(saved["lastCheck"], world.now);
    assert.equal(saved["result"], "ok");
    assert.equal(saved["latest"], "0.1.3");
  });

  it("says nothing when the request fails, and tries again the next day", async () => {
    const answers = [
      "fail",
      { status: 403, text: "Request forbidden" },
      { status: 200, text: "{not json" },
      // Only a 200 counts, whatever the body says.
      { status: 500, text: JSON.stringify({ tag_name: "v0.1.3" }) },
    ] as const;
    for (const broken of answers) {
      const world = new World();
      world.install(LIVE, "0.1.2");
      world.web.set(latestReleaseUrl(), broken);
      const u = await started(world);
      await u.tick();
      assert.equal(latestFetches(world), 1);
      assert.deepEqual(world.notices, []);
      assert.equal(u.state().result, "failed");
      world.now += DAY / 2;
      await u.tick();
      assert.equal(latestFetches(world), 1, "not again the same day");
      world.publish("0.1.3");
      world.now += DAY / 2;
      await u.tick();
      assert.equal(latestFetches(world), 2);
      assert.equal(world.notices.length, 1);
    }
  });
});

describe("the toast", () => {
  it("comes once per version, with a click that opens Sessions", async () => {
    const world = new World();
    world.install(LIVE, "0.1.2");
    world.publish("0.1.3");
    const u = await started(world);
    await u.tick();
    assert.equal(world.notices.length, 1);
    assert.equal(world.notices[0]?.title, "Suspender 0.1.3 is out");
    assert.deepEqual(world.notices[0]?.action, { name: "suspender.updates" });
    world.now += DAY;
    await u.tick();
    // A window opened later knows it was said.
    const other = await started(world);
    world.now += DAY;
    await other.tick();
    assert.equal(world.notices.length, 1);
    world.publish("0.1.4");
    world.now += DAY;
    await u.tick();
    assert.equal(world.notices.length, 2);
    assert.equal(world.notices[1]?.title, "Suspender 0.1.4 is out");
  });

  it("does not come for the version that is installed or an older one", async () => {
    for (const latest of ["0.1.2", "0.1.1", "0.0.9"]) {
      const world = new World();
      world.install(LIVE, "0.1.2");
      world.publish(latest);
      const u = await started(world);
      await u.tick();
      assert.equal(latestFetches(world), 1);
      assert.deepEqual(world.notices, [], latest);
      assert.equal(u.available(), null, latest);
    }
  });

  it("compares versions as numbers (0.1.10 is newer than 0.1.9)", async () => {
    const world = new World();
    world.install(LIVE, "0.1.9");
    world.publish("0.1.10");
    const u = await started(world, "0.1.9");
    await u.tick();
    assert.equal(u.available(), "0.1.10");
    assert.equal(world.notices.length, 1);
  });
});

describe("turning the checks off", () => {
  it("means no request at all, whatever is due or pressed", async () => {
    const world = new World();
    world.install(LIVE, "0.1.2");
    world.publish("0.1.3");
    const u = await started(world);
    await u.setChecks(false);
    for (let day = 0; day < 3; day++) {
      await u.tick();
      world.now += DAY;
    }
    await u.update();
    assert.deepEqual(world.fetched, []);
    assert.deepEqual(world.notices, []);
    // Another window reads the switch from the file.
    const other = await started(world);
    await other.tick();
    assert.deepEqual(world.fetched, []);
  });

  it("hides a release found before, and asks again once turned back on", async () => {
    const world = new World();
    world.install(LIVE, "0.1.2");
    world.publish("0.1.3");
    const u = await started(world);
    await u.tick();
    assert.equal(u.available(), "0.1.3");
    await u.setChecks(false);
    assert.equal(u.available(), null);
    await u.setChecks(true);
    assert.equal(u.available(), "0.1.3");
  });
});

describe("checking by hand (Check now)", () => {
  it("asks at once, whatever the day's check found, and counts as the day's check", async () => {
    const world = new World();
    world.install(LIVE, "0.1.2");
    world.publish("0.1.2");
    const u = await started(world);
    await u.tick();
    world.publish("0.1.3");
    world.now += 60_000;
    await u.checkNow();
    assert.equal(latestFetches(world), 2);
    assert.equal(u.available(), "0.1.3");
    assert.equal(u.manualCheck(), null, "the line at the top offers it; nothing more to say below");
    assert.equal(u.state().lastCheck, world.now);
    assert.deepEqual(world.notices, [], "no toast: the person is looking at Sessions");
    // The daily check does not toast it later either, and waits a day from here.
    world.now += DAY - 60_000;
    await u.tick();
    assert.equal(latestFetches(world), 2);
    world.now += 60_000;
    await u.tick();
    assert.equal(latestFetches(world), 3);
    assert.deepEqual(world.notices, []);
  });

  it("says Checking while it asks, and a second press does not ask twice", async () => {
    const world = new World();
    world.install(LIVE, "0.1.2");
    world.publish("0.1.2");
    const u = await started(world);
    const first = u.checkNow();
    assert.equal(u.manualCheck(), "checking");
    await Promise.all([first, u.checkNow()]);
    assert.equal(latestFetches(world), 1);
  });

  it("says up to date for a while, then goes quiet with a redraw", async () => {
    const world = new World();
    world.install(LIVE, "0.1.2");
    world.publish("0.1.2");
    const u = await started(world);
    await u.checkNow();
    assert.equal(u.manualCheck(), "upToDate");
    world.now += MANUAL_SHOWN_MS - 1;
    await u.tick();
    assert.equal(u.manualCheck(), "upToDate");
    world.now += 1;
    const redraws = u.revision();
    await u.tick();
    assert.equal(u.manualCheck(), null);
    assert.ok(u.revision() > redraws, "the panel is told");
  });

  it("says the check failed when the request fails", async () => {
    const world = new World();
    world.install(LIVE, "0.1.2");
    world.web.set(latestReleaseUrl(), "fail");
    const u = await started(world);
    await u.checkNow();
    assert.equal(u.manualCheck(), "failed");
    assert.equal(u.state().result, "failed");
  });

  it("works with the daily check off, offers what it found, and still asks nothing by itself", async () => {
    const world = new World();
    world.install(LIVE, "0.1.2");
    world.publish("0.1.3");
    const u = await started(world);
    await u.setChecks(false);
    await u.checkNow();
    assert.equal(latestFetches(world), 1);
    assert.equal(u.available(), "0.1.3");
    for (let day = 0; day < 3; day++) {
      world.now += DAY;
      await u.tick();
    }
    assert.equal(latestFetches(world), 1);
    assert.equal(u.state().checks, false);
    // The switch turned on and off again: off hides what was found, as for a daily check.
    await u.setChecks(true);
    await u.setChecks(false);
    assert.equal(u.available(), null);
  });
});
