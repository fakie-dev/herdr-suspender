// Expected strings were worked out by hand and cross-checked against the
// reference functions in the approved mockup (session-info.html v4:
// midEllipsis, repoPath, homePath, branchShort).

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { homePath, midId, repoPath, shortBranch, shortId } from "../src/core/paths.ts";

const WIN_HOME = "C:\\Users\\Fakie";
const WIN_REPO = `${WIN_HOME}\\Documents\\dev\\clients\\northwind-portal`;
const WIN_DEEP = `${WIN_REPO}\\apps\\web\\src\\auth`;

describe("repoPath", () => {
  it("shows the folder from the repository root when it fits (Windows)", () => {
    assert.equal(repoPath(WIN_DEEP, WIN_REPO, "\\", 34), "northwind-portal\\apps\\web\\src\\auth");
  });

  it("squeezes the middle and keeps the repository and the leaf (Windows)", () => {
    assert.equal(repoPath(WIN_DEEP, WIN_REPO, "\\", 24), "northwind-portal\\…\\auth");
  });

  it("shows only the repository name at the repository root", () => {
    assert.equal(repoPath(WIN_REPO, WIN_REPO, "\\", 24), "northwind-portal");
  });

  it("works the same with POSIX paths", () => {
    const repo = "/home/fakie/dev/clients/northwind-portal";
    assert.equal(repoPath(`${repo}/apps/web/src/auth`, repo, "/", 24), "northwind-portal/…/auth");
    assert.equal(repoPath(`${repo}/apps/web/src/auth`, repo, "/", 34), "northwind-portal/apps/web/src/auth");
    assert.equal(repoPath(repo, repo, "/", 10), "northwind-portal");
  });

  it("does not take a sibling folder with the same prefix for the repository", () => {
    assert.equal(repoPath("C:\\dev\\api-gateway", "C:\\dev\\api", "\\", 34), "C:\\dev\\api-gateway");
  });

  it("falls back to the whole folder, squeezed, without a repository", () => {
    assert.equal(repoPath(`${WIN_HOME}\\dev\\landing`, null, "\\", 24), "C:\\…\\Fakie\\dev\\landing");
    assert.equal(repoPath("/home/fakie/dev/landing", null, "/", 10), "/…/landing");
  });

  it("accepts forward slashes in Windows paths", () => {
    assert.equal(repoPath("C:/dev/app/src", "C:/dev/app", "\\", 34), "app\\src");
  });
});

describe("homePath", () => {
  it("starts from ~ under the home folder and squeezes the middle (Windows)", () => {
    assert.equal(homePath(WIN_DEEP, WIN_HOME, "\\", 40), "~\\…\\northwind-portal\\apps\\web\\src\\auth");
  });

  it("keeps the drive for a path outside ~ (Windows)", () => {
    assert.equal(homePath("D:\\work\\very\\long\\path\\to\\project", WIN_HOME, "\\", 20), "D:\\…\\path\\to\\project");
  });

  it("is ~ for the home folder itself", () => {
    assert.equal(homePath(WIN_HOME, WIN_HOME, "\\", 20), "~");
    assert.equal(homePath("/home/fakie", "/home/fakie", "/", 20), "~");
  });

  it("works the same with POSIX paths, inside and outside ~", () => {
    assert.equal(homePath("/home/fakie/dev/x", "/home/fakie", "/", 40), "~/dev/x");
    assert.equal(homePath("/opt/tools/bin", "/home/fakie", "/", 40), "/opt/tools/bin");
    assert.equal(homePath("/srv/data/projects/clients/portal/app", "/home/fakie", "/", 20), "/…/portal/app");
  });

  it("does not take a sibling user folder for home", () => {
    assert.equal(homePath("C:\\Users\\FakieOther\\x", WIN_HOME, "\\", 40), "C:\\Users\\FakieOther\\x");
  });
});

describe("shortBranch", () => {
  const branch = "feature/PORTAL-412-oauth-device-flow-for-tv";

  it("keeps the prefix and the task number and cuts the description from the front", () => {
    assert.equal(shortBranch(branch, 34), "feature/PORTAL-412…ice-flow-for-tv");
    assert.equal(shortBranch(branch, 28), "feature/PORTAL-412…ow-for-tv");
  });

  it("drops the whole description when fewer than 4 of its characters would fit", () => {
    assert.equal(shortBranch(branch, 22), "feature/PORTAL-412…");
  });

  it("leaves a short branch alone", () => {
    assert.equal(shortBranch("main", 22), "main");
    assert.equal(shortBranch(branch, 43), branch);
  });

  it("squeezes the middle of a branch without a task number", () => {
    assert.equal(shortBranch("fix/retry-backoff-for-rate-limited-requests", 20), "fix/retry-ba…equests");
  });
});

describe("ids", () => {
  const id = "8d65845f-73cb-4be6-aa62-4ab2279d0de0";

  it("shortId is the first 8 characters", () => {
    assert.equal(shortId(id), "8d65845f");
  });

  it("midId is the first 8 and the last 4", () => {
    assert.equal(midId(id), "8d65845f…0de0");
  });
});
