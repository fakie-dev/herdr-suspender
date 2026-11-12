// The checksum manifest a release carries in mods/suspender/manifest.json:
// what it accepts, how a file is hashed, and how an install is told apart
// from the release it came from.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import {
  buildManifest,
  fileHash,
  herdrWritten,
  installDiff,
  type Manifest,
  missingKeys,
  parseManifest,
  renderManifest,
} from "../../src/core/manifest.ts";

const H = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

const files = new Map([
  ["main.js", "export default 1;\n"],
  ["mod.json", '{ "place": "none" }\n'],
  ["icons/moon.svg", "<svg>☾</svg>\n"],
]);
const keys = { global: { "alt-shift-s": "suspender.toggle-focused" } };
const sample = (): Manifest => buildManifest("0.1.3", keys, files);

describe("a file's hash", () => {
  it("is the sha256 of its UTF-8 text", () => {
    assert.equal(fileHash("<svg>☾</svg>\n"), H("<svg>☾</svg>\n"));
  });

  it("does not see a checkout's CRLF line endings", () => {
    assert.equal(fileHash("a\r\nb\r\n"), H("a\nb\n"));
  });
});

describe("files Herdr writes next to a mod", () => {
  it("are not the mod's", () => {
    for (const p of ["jsconfig.json", "gpui-kit.d.ts", "ui/gpui-kit.d.ts", "main.error", ".DS_Store", "ui/.x.js"]) {
      assert.equal(herdrWritten(p), true, p);
    }
    for (const p of ["main.js", "mod.json", "icons/moon.svg", "ui/kit.js"]) {
      assert.equal(herdrWritten(p), false, p);
    }
  });
});

describe("the manifest", () => {
  it("lists every file with its hash, the version and the keys", () => {
    const m = sample();
    assert.equal(m.mod, "suspender");
    assert.equal(m.version, "0.1.3");
    assert.deepEqual(m.keys, keys);
    assert.deepEqual(Object.keys(m.files), ["icons/moon.svg", "main.js", "mod.json"]);
    assert.equal(m.files["main.js"], H("export default 1;\n"));
  });

  it("reads back what it writes", () => {
    const text = renderManifest(sample());
    assert.ok(text.endsWith("}\n"));
    assert.deepEqual(parseManifest(text), sample());
  });

  it("refuses one that is not this mod's, or not whole", () => {
    const good = JSON.parse(renderManifest(sample())) as Record<string, unknown>;
    const bad = (patch: Record<string, unknown>): string => JSON.stringify({ ...good, ...patch });
    assert.notEqual(parseManifest(JSON.stringify(good)), null);
    assert.equal(parseManifest(null), null);
    assert.equal(parseManifest("{"), null);
    assert.equal(parseManifest(bad({ mod: "tabs" })), null, "another mod");
    assert.equal(parseManifest(bad({ version: "0.1" })), null, "not a version");
    assert.equal(parseManifest(bad({ files: {} })), null, "no files");
    assert.equal(parseManifest(bad({ files: { "main.js": "x".repeat(64) } })), null, "no mod.json, bad hash");
    const withFile = (path: string, hash = H("x")): string =>
      bad({ files: { ...(good["files"] as object), [path]: hash } });
    assert.equal(parseManifest(withFile("../keys.json")), null, "outside the folder");
    assert.equal(parseManifest(withFile("C:\\evil.js")), null, "a drive");
    assert.equal(parseManifest(withFile("tool.exe")), null, "a kind the mod has none of");
    assert.equal(parseManifest(withFile("ui/x.js", "abc")), null, "a hash that is none");
    assert.equal(parseManifest(bad({ keys: { global: { "ctrl-x": 3 } } })), null, "a key that is not a command");
  });
});

describe("an install against its manifest", () => {
  const m = sample();
  it("is unchanged when every file is as listed (and Herdr's own files are beside them)", () => {
    const disk = new Map([...files, ["jsconfig.json", "{}"], ["gpui-kit.d.ts", "declare"]]);
    assert.deepEqual(installDiff(m, disk), { changed: [], missing: [], extra: [] });
  });

  it("names a changed, a missing and an added file", () => {
    const disk = new Map(files);
    disk.set("main.js", "export default 2;\n");
    disk.delete("icons/moon.svg");
    disk.set("ui/mine.js", "// mine\n");
    assert.deepEqual(installDiff(m, disk), {
      changed: ["main.js"],
      missing: ["icons/moon.svg"],
      extra: ["ui/mine.js"],
    });
  });
});

describe("keys a new release adds", () => {
  const old = { global: { "alt-shift-s": "suspender.toggle-focused" } };
  const next = {
    global: { "alt-shift-s": "suspender.toggle-focused", "alt-shift-u": "suspender.updates" },
    "layout:suspender": { "ctrl-shift-s": "suspender.panel" },
  };

  it("are the new commands the person has no key for", () => {
    const bound = [{ section: "global", keys: "alt-shift-s", action: "suspender.toggle-focused" }];
    assert.deepEqual(missingKeys(next, old, bound), [
      { section: "global", keys: "alt-shift-u", action: "suspender.updates" },
      { section: "layout:suspender", keys: "ctrl-shift-s", action: "suspender.panel" },
    ]);
  });

  it("leave out a command already on some key of the person's, and one the old release had", () => {
    const bound = [{ section: "global", keys: "f9", action: "suspender.updates" }];
    // The person took suspender.panel off on purpose: the old release had it, so it is not asked for again.
    const hadPanel = { ...old, "layout:suspender": { "ctrl-shift-s": "suspender.panel" } };
    assert.deepEqual(missingKeys(next, hadPanel, bound), []);
  });
});
