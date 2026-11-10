import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { sha256Hex } from "../src/core/sha256.ts";

describe("sha256Hex", () => {
  it("matches the published test vectors (FIPS 180-2)", () => {
    assert.equal(sha256Hex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    assert.equal(sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    assert.equal(
      sha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    );
  });

  it("matches Node's own hash on long and non-ASCII text (UTF-8)", () => {
    const samples = ["x".repeat(55), "x".repeat(56), "x".repeat(64), "y".repeat(1000), "Привет · 世界 · 🌙"];
    for (const text of samples) {
      assert.equal(sha256Hex(text), createHash("sha256").update(text, "utf8").digest("hex"), text.slice(0, 20));
    }
  });
});
