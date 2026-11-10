import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { utf8Head, utf8Tail } from "../../src/runtime/utf8.ts";

// Expected cuts come from Node's own encoder, not from the code under test.
const bytes = (s: string): Buffer => Buffer.from(s, "utf8");
const head = (s: string, n: number): string => bytes(s).subarray(0, n).toString("utf8");
const tail = (s: string, n: number): string =>
  bytes(s)
    .subarray(Math.max(0, bytes(s).length - n))
    .toString("utf8");

describe("cutting text by UTF-8 bytes (Herdr reads files only as text)", () => {
  const text = 'ascii {"ru":"Привет, мир"} 漢字 emoji 😀 end\n';

  it("the last n bytes, at every character boundary", () => {
    const size = bytes(text).length;
    for (let n = 0; n <= size + 3; n++) {
      const want = tail(text, n);
      if (!want.includes("\uFFFD")) {
        assert.equal(utf8Tail(text, n), want, `n=${n}`);
      }
    }
  });

  it("the first n bytes, at every character boundary", () => {
    const size = bytes(text).length;
    for (let n = 0; n <= size + 3; n++) {
      const want = head(text, n);
      if (!want.includes("\uFFFD")) {
        assert.equal(utf8Head(text, n), want, `n=${n}`);
      }
    }
  });

  it("never splits a character: a cut inside one leaves it out", () => {
    assert.equal(utf8Tail("aП", 1), "");
    assert.equal(utf8Head("Пa", 1), "");
    assert.equal(utf8Tail("x😀", 3), "");
  });
});
