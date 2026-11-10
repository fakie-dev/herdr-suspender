import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

const SCRIPT = join(import.meta.dirname, "..", "scripts", "check-privacy.ts");

// Secrets are assembled here so this file never contains one whole.
const GITHUB_TOKEN = `${"ghp"}_${"a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"}`;
const AWS_KEY = `${"AKIA"}${"ABCDEFGHIJKLMNOP"}`;
const EMAIL = `jane.doe${"@"}corp-mail.test`;
const WIN_PATH = `C:\\${"Users"}\\jdoe\\work\\app`;
const POSIX_PATH = `/${"home"}/jdoe/work/app`;

let repo: string;

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" });
}

function commit(message: string, author = "fakie-dev <332286914+fakie-dev@users.noreply.github.com>"): void {
  git("add", "-A");
  git(
    "-c",
    "user.name=fakie-dev",
    "-c",
    "user.email=332286914+fakie-dev@users.noreply.github.com",
    "commit",
    "-q",
    "--author",
    author,
    "-m",
    message,
  );
}

function put(path: string, text: string): void {
  const full = join(repo, path);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, text);
}

function run(...args: string[]): { code: number; out: string } {
  const r = spawnSync(process.execPath, [SCRIPT, "--root", repo, ...args], { encoding: "utf8" });
  return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "privacy-"));
  git("init", "-q");
  put("README.md", "# Demo\n\nNothing private here. Home is ~/.config and C:\\Users\\tester is a stand-in.\n");
  commit("init");
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("check-privacy on the working tree", () => {
  it("passes a clean repo", () => {
    const r = run();
    assert.equal(r.code, 0, r.out);
  });

  it("flags a GitHub token and names the file", () => {
    put("src/a.ts", `const t = "${GITHUB_TOKEN}";\n`);
    const r = run();
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /src\/a\.ts/);
    assert.match(r.out, /token/i);
  });

  it("flags a cloud access key", () => {
    put("notes.txt", `key ${AWS_KEY}\n`);
    assert.equal(run().code, 1);
  });

  it("flags a personal email but not a GitHub noreply address", () => {
    put("a.md", "write to 332286914+fakie-dev@users.noreply.github.com\n");
    assert.equal(run().code, 0);
    put("b.md", `write to ${EMAIL}\n`);
    const r = run();
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /b\.md/);
    assert.match(r.out, /email/i);
  });

  it("flags a home-folder path of a real user, Windows and POSIX, but not stand-in names", () => {
    put("w.md", `cd ${WIN_PATH}\n`);
    assert.equal(run().code, 1);
    rmSync(join(repo, "w.md"));
    put("p.md", `cd ${POSIX_PATH}\n`);
    assert.equal(run().code, 1);
    rmSync(join(repo, "p.md"));
    put("ok.md", "cd /home/tester/app and C:\\Users\\tester\\app and /Users/you/app\n");
    assert.equal(run().code, 0);
  });

  it("flags a word from .privacy.local, ignoring case, and skips comments", () => {
    put(".privacy.local", "# words only the maintainer knows\nNorthwind\n");
    assert.equal(run().code, 0);
    put("c.md", "we shipped for NORTHWIND last year\n");
    const r = run();
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /c\.md/);
  });

  it("does not print the secret it found", () => {
    put("a.ts", `const t = "${GITHUB_TOKEN}";\n`);
    assert.ok(!run().out.includes(GITHUB_TOKEN));
  });

  it("scans files that are not committed yet, and skips ignored ones", () => {
    put(".gitignore", "ignored.txt\n");
    put("ignored.txt", `${GITHUB_TOKEN}\n`);
    assert.equal(run().code, 0);
    put("new.txt", `${GITHUB_TOKEN}\n`);
    assert.equal(run().code, 1);
  });
});

describe("check-privacy --history", () => {
  it("passes a clean history", () => {
    assert.equal(run("--history").code, 0);
  });

  it("finds a secret that a later commit removed", () => {
    put("old.ts", `const t = "${GITHUB_TOKEN}";\n`);
    commit("add");
    rmSync(join(repo, "old.ts"));
    commit("remove");
    assert.equal(run().code, 0, "the tree is clean");
    const r = run("--history");
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /old\.ts|token/i);
  });

  it("flags a personal email in the author metadata", () => {
    put("x.txt", "x\n");
    commit("add x", `Jane <${EMAIL}>`);
    const r = run("--history");
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /author/i);
  });

  it("flags an email in a commit message", () => {
    put("y.txt", "y\n");
    commit(`add y\n\nthanks ${EMAIL}`);
    assert.equal(run("--history").code, 1);
  });

  it("flags a co-author line in a commit message", () => {
    put("z.txt", "z\n");
    commit("add z\n\nCo-Authored-By: Someone <someone@noreply.example>");
    const r = run("--history");
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /co-author/i);
  });
});
