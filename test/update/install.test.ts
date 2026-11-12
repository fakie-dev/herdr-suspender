// Update by button and roll back: only mods/suspender changes, only with files
// that match the release's manifest, and never over an install the person changed.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { rawFileUrl } from "../../src/core/release.ts";
import { JOB_STALE_MS } from "../../src/core/updateState.ts";
import { STARTUP_DELAY_MS, Updater } from "../../src/runtime/updater.ts";
import { updateLine } from "../../src/ui/updateLine.ts";
import { APP, build, KEYS, LIVE, SESSIONS, STATE, WORK, World } from "./world.ts";

const BACKUP = `${WORK}/backup/suspender`;
const STAGING = `${WORK}/staging`;

/** A machine with 0.1.2 installed, 0.1.3 released, the daily check done. */
async function ready(): Promise<{ world: World; u: Updater }> {
  const world = new World();
  world.install(LIVE, "0.1.2");
  world.publish("0.1.3");
  world.ports.files.set(`${APP}/keys.json`, JSON.stringify(KEYS));
  world.ports.files.set(SESSIONS, '{"version":1,"sessions":[]}');
  world.ports.files.set(`${APP}/mods/suspender-tabs/main.js`, "// tab bar copy\n");
  const u = new Updater(world.deps("0.1.2"));
  await u.load();
  world.now += STARTUP_DELAY_MS;
  await u.tick();
  assert.equal(u.available(), "0.1.3");
  world.notices.length = 0;
  world.fetched.length = 0;
  return { world, u };
}

/** Everything outside the update's own places, to compare before and after. */
function rest(world: World): [string, string][] {
  return [...world.ports.files]
    .filter(([p]) => !p.startsWith(`${WORK}/`) && p !== STATE)
    .sort(([a], [b]) => (a < b ? -1 : 1));
}

function nothingChanged(world: World, before: [string, string][]): void {
  assert.deepEqual(rest(world), before, "the app's folder is as it was");
  assert.deepEqual(world.tree(BACKUP), [], "no backup");
  assert.deepEqual(world.tree(STAGING), [], "no staging left");
}

/** Only mods/suspender, the update's own folder and its state file are ever written, moved or removed. */
function onlyOwnPlaces(world: World): void {
  for (const path of world.touched()) {
    assert.ok(path === LIVE || path.startsWith(`${LIVE}/`) || path.startsWith(`${WORK}`) || path === STATE, path);
  }
}

describe("updating", () => {
  it("swaps in the release's files and keeps the old ones as the backup", async () => {
    const { world, u } = await ready();
    const before = world.tree(LIVE);
    await u.update();
    const want = [...build("0.1.3")].sort(([a], [b]) => (a < b ? -1 : 1));
    assert.deepEqual(
      world.tree(LIVE).filter(([p]) => p !== "manifest.json"),
      want,
    );
    assert.deepEqual(world.tree(BACKUP), before);
    assert.deepEqual(world.tree(STAGING), []);
    assert.equal(world.checked.length, 1, "herdr-app check ran on the new files");
    assert.ok(world.checked[0]?.startsWith(STAGING), "outside mods/");
    assert.equal(world.swaps.length, 1);
    assert.equal(world.swaps[0]?.parked, BACKUP);
    assert.ok(!world.swaps[0]?.incoming.startsWith(`${APP}/mods/`), "staged outside mods/");
    onlyOwnPlaces(world);
    assert.deepEqual(
      world.fetched.filter((url) => !url.startsWith(rawFileUrl("0.1.3", "main.js").replace("main.js", ""))),
      [],
      "every file comes from the release's tag",
    );
    assert.equal(world.notices.length, 1);
    assert.equal(world.notices[0]?.title, "Suspender updated to 0.1.3");
    assert.equal(world.notices[0]?.level, "success");
    assert.equal(u.state().outcome?.kind, "updated");
  });

  it("is cancelled with nothing changed when a file does not match the manifest", async () => {
    const { world, u } = await ready();
    world.web.set(rawFileUrl("0.1.3", "ui/panel.js"), { status: 200, text: "// something else\n" });
    const before = rest(world);
    await u.update();
    nothingChanged(world, before);
    assert.deepEqual(world.swaps, []);
    assert.equal(u.state().outcome?.reason, "mismatch");
    assert.equal(world.notices.length, 1);
    assert.match(world.notices[0]?.body ?? "", /Checksum mismatch/);
  });

  it("is cancelled with nothing changed when the release has no manifest of its own version", async () => {
    for (const manifest of [
      { status: 404, text: "404: Not Found" },
      { status: 200, text: "{}" },
    ]) {
      const { world, u } = await ready();
      world.web.set(rawFileUrl("0.1.3", "manifest.json"), manifest);
      const before = rest(world);
      await u.update();
      nothingChanged(world, before);
      assert.equal(u.state().outcome?.kind, "failed");
    }
    const { world, u } = await ready();
    // The tag 0.1.3 serving 0.1.4's manifest: not the version asked for.
    world.publish("0.1.4");
    const other = world.web.get(rawFileUrl("0.1.4", "manifest.json"));
    assert.ok(other !== undefined && other !== "fail");
    world.web.set(rawFileUrl("0.1.3", "manifest.json"), other);
    const before = rest(world);
    await u.update();
    nothingChanged(world, before);
    assert.equal(u.state().outcome?.reason, "manifest");
  });

  it("is cancelled with nothing changed when the network drops half way, and staging is cleaned", async () => {
    const { world, u } = await ready();
    world.web.set(rawFileUrl("0.1.3", "runtime/engine.js"), "fail");
    const before = rest(world);
    await u.update();
    nothingChanged(world, before);
    assert.ok(
      world.removed.some((dir) => dir.startsWith(STAGING)),
      "staging was removed",
    );
    assert.equal(u.state().outcome?.reason, "network");
    assert.deepEqual(world.swaps, []);
  });

  it("is cancelled when the new files do not pass herdr-app check, and refused without herdr-app", async () => {
    for (const [result, reason] of [
      ["failed", "check"],
      ["unavailable", "noCheck"],
    ] as const) {
      const { world, u } = await ready();
      world.checkResult = result;
      const before = rest(world);
      await u.update();
      nothingChanged(world, before);
      assert.equal(u.state().outcome?.reason, reason);
      assert.equal(world.notices.length, 1);
    }
  });

  it("is cancelled with nothing changed when a file of mods/suspender is in use", async () => {
    const { world, u } = await ready();
    world.swapBusy = true;
    const before = rest(world);
    await u.update();
    nothingChanged(world, before);
    assert.equal(u.state().outcome?.reason, "busy");
  });

  it("counts a swap whose answer was lost by what is in mods/suspender", async () => {
    const { world, u } = await ready();
    world.swapAnswerLost = true;
    await u.update();
    assert.equal(u.state().outcome?.kind, "updated");
    assert.equal(world.notices[0]?.title, "Suspender updated to 0.1.3");
    assert.notDeepEqual(world.tree(BACKUP), []);
  });

  it("never writes keys.json: it names the keys the new release needs", async () => {
    const { world, u } = await ready();
    const keys = { ...KEYS, global: { ...KEYS["global"], "alt-shift-u": "suspender.updates" } };
    world.publish("0.1.3", build("0.1.3"), keys);
    await u.update();
    assert.equal(u.state().outcome?.kind, "updated");
    assert.equal(world.ports.files.get(`${APP}/keys.json`), JSON.stringify(KEYS));
    onlyOwnPlaces(world);
    assert.match(world.notices[0]?.body ?? "", /new keys/);
    assert.deepEqual(u.state().outcome?.keys, [
      { section: "global", keys: "alt-shift-u", action: "suspender.updates" },
    ]);
    assert.match(
      updateLine(u.state(), "0.1.3", null, null)?.detail ?? "",
      /"alt-shift-u": "suspender\.updates" in global/,
    );
  });

  it("leaves sessions, the tab bar copy and every other file of the app alone", async () => {
    const { world, u } = await ready();
    const sessions = world.ports.files.get(SESSIONS);
    await u.update();
    assert.equal(world.ports.files.get(SESSIONS), sessions);
    assert.equal(world.ports.files.get(`${APP}/mods/suspender-tabs/main.js`), "// tab bar copy\n");
    onlyOwnPlaces(world);
  });
});

describe("hashing", () => {
  it("goes through the hash it is given, for the install and for every download", async () => {
    const { world, u } = await ready();
    await u.update();
    assert.equal(u.state().outcome?.kind, "updated");
    const old = build("0.1.2");
    const next = build("0.1.3");
    for (const text of [...old.values(), ...next.values()]) {
      assert.ok(world.hashed.includes(text), text);
    }
  });

  it("never hashes the files Herdr writes beside the mod (gpui-kit.d.ts is over a megabyte)", async () => {
    const { world, u } = await ready();
    world.ports.files.set(`${LIVE}/gpui-kit.d.ts`, "declare module 'gpui-kit' {}");
    await u.update();
    assert.ok(!world.hashed.includes("declare module 'gpui-kit' {}"));
  });

  it("refuses when that hash disagrees with the installed manifest", async () => {
    const { world, u } = await ready();
    world.hash = () => "0".repeat(64);
    await u.update();
    assert.equal(u.state().outcome?.reason, "edited");
  });
});

describe("refusing", () => {
  it("an install the person changed: nothing downloaded, nothing changed", async () => {
    for (const edit of ["changed", "missing", "added"] as const) {
      const { world, u } = await ready();
      if (edit === "changed") {
        world.ports.files.set(`${LIVE}/ui/panel.js`, "// my own panel\n");
      } else if (edit === "missing") {
        world.ports.files.delete(`${LIVE}/icons/moon.svg`);
      } else {
        world.ports.files.set(`${LIVE}/ui/mine.js`, "// mine\n");
      }
      // Herdr's own files beside the mod are not an edit.
      world.ports.files.set(`${LIVE}/jsconfig.json`, "{}");
      const before = rest(world);
      await u.update();
      nothingChanged(world, before);
      assert.deepEqual(world.fetched, [], edit);
      assert.equal(u.state().outcome?.reason, "edited", edit);
      assert.match(world.notices[0]?.body ?? "", /See Sessions/, edit);
      assert.match(updateLine(u.state(), "0.1.2", null, null)?.detail ?? "", /by hand/, edit);
    }
  });

  it("Herdr's own files beside the mod are not an edit", async () => {
    const { world, u } = await ready();
    world.ports.files.set(`${LIVE}/jsconfig.json`, "{}");
    world.ports.files.set(`${LIVE}/ui/gpui-kit.d.ts`, "declare module");
    await u.update();
    assert.equal(u.state().outcome?.kind, "updated");
  });

  it("an install that is not ours at mods/suspender (renamed for a name clash, or another version there)", async () => {
    const cases: [string, (w: World) => void][] = [
      ["no folder", (w) => w.files.removeTree(LIVE)],
      ["no manifest", (w) => w.ports.files.delete(`${LIVE}/manifest.json`)],
      [
        "another mod",
        (w) =>
          w.ports.files.set(
            `${LIVE}/manifest.json`,
            (w.ports.files.get(`${LIVE}/manifest.json`) ?? "").replace('"mod": "suspender"', '"mod": "other"'),
          ),
      ],
      ["another version", (w) => w.install(LIVE, "0.1.1")],
    ];
    for (const [name, setUp] of cases) {
      const { world, u } = await ready();
      setUp(world);
      world.removed.length = 0;
      const before = rest(world);
      await u.update();
      assert.deepEqual(rest(world), before, name);
      assert.deepEqual(world.swaps, [], name);
      assert.deepEqual(world.fetched, [], name);
      assert.equal(u.state().outcome?.reason, "renamed", name);
      assert.match(world.notices[0]?.body ?? "", /See Sessions/, name);
      assert.match(updateLine(u.state(), "0.1.2", null, null)?.detail ?? "", /by hand/, name);
    }
  });
});

describe("rolling back", () => {
  it("puts the backup back in mods/suspender", async () => {
    const { world, u } = await ready();
    const old = world.tree(LIVE);
    await u.update();
    world.notices.length = 0;
    // The rollback is pressed in the new version.
    const fresh = new Updater(world.deps("0.1.3"));
    await fresh.load();
    world.notices.length = 0;
    await fresh.rollback();
    assert.deepEqual(world.tree(LIVE), old);
    assert.deepEqual(world.tree(BACKUP), []);
    assert.deepEqual(world.tree(STAGING), []);
    assert.equal(fresh.state().outcome?.kind, "rolledBack");
    assert.equal(world.notices.length, 1);
    assert.equal(world.notices[0]?.title, "Suspender is back on 0.1.2");
    onlyOwnPlaces(world);
  });

  it("is refused with nothing to roll back to", async () => {
    const { world, u } = await ready();
    const before = rest(world);
    await u.rollback();
    assert.deepEqual(rest(world), before);
    assert.deepEqual(world.swaps, []);
    assert.equal(u.state().outcome?.reason, "noBackup");
  });
});

describe("after the swap", () => {
  it("the new version says it once, however the old one's task ended", async () => {
    const { world, u } = await ready();
    // Herdr reloads the mod as soon as the folder changes: the new build loads before the old task hears back.
    world.duringSwap = async () => {
      const next = new Updater(world.deps("0.1.3"));
      await next.load();
    };
    await u.update();
    assert.equal(world.notices.length, 1);
    assert.equal(world.notices[0]?.title, "Suspender updated to 0.1.3");
  });

  it("the new version says it when the old task never heard back", async () => {
    const { world, u } = await ready();
    world.duringSwap = () => new Promise(() => undefined);
    void u.update();
    for (let i = 0; i < 20; i++) {
      await Promise.resolve();
      await new Promise((r) => setImmediate(r));
    }
    assert.deepEqual(world.notices, []);
    const next = new Updater(world.deps("0.1.3"));
    await next.load();
    assert.equal(world.notices.length, 1);
    assert.equal(next.state().outcome?.kind, "updated");
    // And only once: another window of the new version says nothing.
    const again = new Updater(world.deps("0.1.3"));
    await again.load();
    assert.equal(world.notices.length, 1);
  });

  it("a job whose swap never happened is dropped and its staging cleaned", async () => {
    const { world } = await ready();
    // The old version starts again with the job still written (Herdr quit during the update).
    world.ports.files.set(`${STAGING}/suspender/main.js`, "half");
    const saved = JSON.parse(world.ports.files.get(STATE) ?? "{}") as object;
    const job = { kind: "update", from: "0.1.2", to: "0.1.3", at: world.now - JOB_STALE_MS - 1, keys: [] };
    world.ports.files.set(STATE, JSON.stringify({ ...saved, job }));
    const again = new Updater(world.deps("0.1.2"));
    await again.load();
    assert.equal(again.state().job, null);
    assert.deepEqual(world.tree(STAGING), []);
    assert.deepEqual(world.notices, []);
    assert.equal(world.tree(LIVE).find(([p]) => p === "main.js")?.[1], build("0.1.2").get("main.js"));
  });

  it("never says it is updating to another version than the one it is updating to", async () => {
    const { world, u } = await ready();
    world.ports.files.set(`${LIVE}/ui/panel.js`, "// mine");
    const seen: (string | null)[] = [];
    world.onNotify = () => seen.push(u.busy()?.to ?? null);
    await u.update();
    assert.equal(world.notices.length, 1);
    assert.ok(
      seen.every((to) => to === null || to === "0.1.3"),
      JSON.stringify(seen),
    );
  });

  it("a task Herdr ended mid-update does not hold the button for good", async () => {
    const { world, u } = await ready();
    world.checkHangs = true;
    void u.update();
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setImmediate(r));
    }
    assert.notEqual(u.busy(), null);
    await u.update();
    assert.equal(world.swaps.length, 0, "not while it may still be at work");
    world.now += JOB_STALE_MS + 1;
    assert.equal(u.busy(), null);
    world.checkHangs = false;
    await u.update();
    assert.equal(u.state().outcome?.kind, "updated");
  });

  it("staging left by a run that died is removed when the module loads", async () => {
    const { world } = await ready();
    world.ports.files.set(`${STAGING}/suspender/main.js`, "half");
    const again = new Updater(world.deps("0.1.2"));
    await again.load();
    assert.deepEqual(world.tree(STAGING), []);
  });

  it("a job another window is still at is left alone, and no second one starts beside it", async () => {
    const { world, u } = await ready();
    world.ports.files.set(`${STAGING}/suspender/main.js`, "being downloaded");
    const saved = JSON.parse(world.ports.files.get(STATE) ?? "{}") as object;
    const job = { kind: "update", from: "0.1.2", to: "0.1.3", at: world.now - 1000, keys: [] };
    world.ports.files.set(STATE, JSON.stringify({ ...saved, job }));
    const other = new Updater(world.deps("0.1.2"));
    await other.load();
    assert.deepEqual(world.tree(`${STAGING}/suspender`), [["main.js", "being downloaded"]]);
    assert.deepEqual(other.busy(), job);
    await u.update();
    assert.deepEqual(world.fetched, []);
    assert.deepEqual(world.swaps, []);
  });
});

describe("what's new", () => {
  it("opens the release page of the version found", async () => {
    const { world, u } = await ready();
    u.whatsNew();
    assert.deepEqual(world.opened, ["https://github.com/fakie-dev/herdr-suspender/releases/tag/v0.1.3"]);
  });
});
