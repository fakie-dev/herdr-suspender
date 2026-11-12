// Which release is newer, and where a release's files come from. The URLs are
// built from constants and a version that parsed as one; nothing else reaches them.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { latestReleaseUrl, MOD_VERSION, rawFileUrl, releasePageUrl } from "../../src/core/release.ts";
import { compareVersions, isNewer, parseVersion } from "../../src/core/semver.ts";

describe("versions", () => {
  it("reads a release tag with or without its v", () => {
    assert.deepEqual(parseVersion("v0.1.3"), { major: 0, minor: 1, patch: 3 });
    assert.deepEqual(parseVersion("12.0.10"), { major: 12, minor: 0, patch: 10 });
  });

  it("refuses anything that is not three numbers", () => {
    for (const bad of ["", "0.1", "0.1.3-beta.1", "v0.1.3.4", "0.1.x", " 0.1.3", "0.1.3\n", "01.1.3", null, 3, {}]) {
      assert.equal(parseVersion(bad), null, JSON.stringify(bad));
    }
  });

  it("compares numbers, not text", () => {
    assert.ok(compareVersions("0.1.10", "0.1.9") > 0);
    assert.ok(compareVersions("0.2.0", "0.1.99") > 0);
    assert.ok(compareVersions("1.0.0", "0.99.99") > 0);
    assert.equal(compareVersions("v0.1.3", "0.1.3"), 0);
    assert.ok(compareVersions("0.1.2", "0.1.3") < 0);
  });

  it("calls a release newer only when it is", () => {
    assert.equal(isNewer("0.1.3", "0.1.2"), true);
    assert.equal(isNewer("0.1.2", "0.1.2"), false);
    assert.equal(isNewer("0.1.1", "0.1.2"), false);
    assert.equal(isNewer("0.1.10", "0.1.9"), true);
    assert.equal(isNewer("garbage", "0.1.2"), false);
  });
});

describe("this build", () => {
  it("is the version package.json names", () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "package.json"), "utf8")) as {
      version: string;
    };
    assert.equal(MOD_VERSION, pkg.version);
  });
});

describe("release URLs", () => {
  it("point at the mod's own repository only", () => {
    assert.equal(latestReleaseUrl(), "https://api.github.com/repos/fakie-dev/herdr-suspender/releases/latest");
    assert.equal(releasePageUrl("0.1.3"), "https://github.com/fakie-dev/herdr-suspender/releases/tag/v0.1.3");
    assert.equal(
      rawFileUrl("0.1.3", "runtime/engine.js"),
      "https://raw.githubusercontent.com/fakie-dev/herdr-suspender/v0.1.3/mods/suspender/runtime/engine.js",
    );
  });

  it("are never built from a version or a path that could leave that place", () => {
    for (const v of ["0.1.3/../../evil", "0.1.3?x", "../0.1.3", "main"]) {
      assert.throws(() => releasePageUrl(v), /not a release version/, v);
      assert.throws(() => rawFileUrl(v, "main.js"), /not a release version/, v);
    }
    for (const p of [
      "../keys.json",
      "/etc/passwd",
      "a/../../b.js",
      "C:\\x.js",
      "x.exe",
      "https://x/y.js",
      "a//b.js",
      "",
    ]) {
      assert.throws(() => rawFileUrl("0.1.3", p), p);
    }
  });
});
