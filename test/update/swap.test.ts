// The folder swap as it really runs: the same program and arguments the mod
// gives Herdr's `exec` (PowerShell on Windows, sh elsewhere), on real folders
// in a temporary directory. Locks are Windows' own: a process whose current
// folder is inside a directory keeps that directory from being renamed.

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { parseSwapOutput, swapCommand, utf16leBase64 } from "../../src/runtime/swap.ts";

const platform = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux";
const root = mkdtempSync(join(tmpdir(), "suspender swap 'q' "));
after(() => rmSync(root, { recursive: true, force: true }));

let n = 0;
function folders(): { live: string; incoming: string; parked: string } {
  const at = join(root, `case ${++n}`);
  const live = join(at, "mods", "suspender");
  const incoming = join(at, "update", "staging", "suspender");
  const parked = join(at, "update", "backup", "suspender");
  mkdirSync(join(live, "ui"), { recursive: true });
  mkdirSync(incoming, { recursive: true });
  writeFileSync(join(live, "main.js"), "old");
  writeFileSync(join(live, "ui", "panel.js"), "old panel");
  writeFileSync(join(incoming, "main.js"), "new");
  return { live, incoming, parked };
}

function run(live: string, incoming: string, parked: string, drop: boolean) {
  const { cmd, args } = swapCommand(platform, live, incoming, parked, drop);
  let out = "";
  try {
    out = execFileSync(cmd, args, { encoding: "utf8", timeout: 60_000 });
  } catch (e) {
    out = String((e as { stdout?: unknown }).stdout ?? "");
  }
  return parseSwapOutput(out);
}

const read = (path: string): string | null => (existsSync(path) ? readFileSync(path, "utf8") : null);

/** A process whose current folder is `dir` for as long as the returned stop is not called. */
function holdFolder(dir: string): () => void {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { cwd: dir, stdio: "ignore" });
  return () => child.kill();
}

describe("the swap", () => {
  it("puts the new folder in place and parks the old one", () => {
    const f = folders();
    assert.equal(run(f.live, f.incoming, f.parked, false).result, "swapped");
    assert.equal(read(join(f.live, "main.js")), "new");
    assert.equal(read(join(f.parked, "main.js")), "old");
    assert.equal(read(join(f.parked, "ui", "panel.js")), "old panel");
    assert.equal(existsSync(f.incoming), false);
  });

  it("removes the parked folder when asked (a rollback)", () => {
    const f = folders();
    assert.equal(run(f.live, f.incoming, f.parked, true).result, "swapped");
    assert.equal(read(join(f.live, "main.js")), "new");
    assert.equal(existsSync(f.parked), false);
  });

  it("moves nothing when the place for the old folder is taken", () => {
    const f = folders();
    mkdirSync(f.parked, { recursive: true });
    assert.equal(run(f.live, f.incoming, f.parked, false).result, "unchanged");
    assert.equal(read(join(f.live, "main.js")), "old");
    assert.equal(read(join(f.incoming, "main.js")), "new");
  });

  it("moves nothing when there is no new folder or no old one", () => {
    const f = folders();
    rmSync(f.incoming, { recursive: true });
    assert.equal(run(f.live, f.incoming, f.parked, false).result, "unchanged");
    assert.equal(read(join(f.live, "main.js")), "old");
    const g = folders();
    rmSync(g.live, { recursive: true });
    assert.equal(run(g.live, g.incoming, g.parked, false).result, "unchanged");
    assert.equal(read(join(g.incoming, "main.js")), "new");
  });

  it("takes folder names with spaces and quotes as they are (nothing in them is run)", () => {
    const f = folders();
    const odd = join(root, "x'; echo pwned; '$(echo hi) & y %PATH%", "suspender");
    mkdirSync(odd, { recursive: true });
    writeFileSync(join(odd, "main.js"), "odd");
    const out = run(f.live, odd, f.parked, false);
    assert.equal(out.result, "swapped", out.detail);
    assert.equal(read(join(f.live, "main.js")), "odd");
  });

  it("moves nothing while a program has its current folder inside mods/suspender (Windows)", {
    skip: platform !== "windows",
  }, () => {
    const f = folders();
    const release = holdFolder(join(f.live, "ui"));
    try {
      const out = run(f.live, f.incoming, f.parked, false);
      assert.equal(out.result, "unchanged", out.detail);
    } finally {
      release();
    }
    assert.equal(read(join(f.live, "main.js")), "old");
    assert.equal(existsSync(f.parked), false);
  });

  it("puts the old folder back when the new one cannot be moved in (Windows)", { skip: platform !== "windows" }, () => {
    const f = folders();
    const release = holdFolder(f.incoming);
    try {
      const out = run(f.live, f.incoming, f.parked, false);
      assert.equal(out.result, "restored", out.detail);
    } finally {
      release();
    }
    assert.equal(read(join(f.live, "main.js")), "old");
    assert.equal(existsSync(f.parked), false);
  });
});

describe("its output", () => {
  it("is read from the last line, and anything else is no swap", () => {
    assert.deepEqual(parseSwapOutput("noise\r\nswapped\r\n"), { result: "swapped", detail: "" });
    assert.deepEqual(parseSwapOutput("restored: in use\n"), { result: "restored", detail: "in use" });
    assert.equal(parseSwapOutput("").result, "unchanged");
    assert.equal(parseSwapOutput("swapped later\n").result, "unchanged");
  });
});

describe("the encoded command", () => {
  it("is the base64 of the script's UTF-16LE bytes, as PowerShell decodes it", () => {
    for (const text of ["", "a", "ab", "abc", "$x = 'C:Users\testermods'", "ünïcødé ☾ 𝄞"]) {
      assert.equal(utf16leBase64(text), Buffer.from(text, "utf16le").toString("base64"), text);
    }
  });
});
