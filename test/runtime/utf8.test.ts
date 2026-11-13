import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { utf8Bytes, utf8Head, utf8Tail } from "../../src/core/utf8.ts";

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

// Herdr's runtime ran 1 MiB of a by-character loop in 316 ms (measured on 0.1.15) and ends a script
// after 0.5–0.7 s: a whole transcript's length counted that way stopped the read without a trace.
describe("UTF-8 counts without a loop over every character", () => {
  const mixed = 'ascii {"ru":"Привет, мир"} 漢字 emoji 😀 end\n';

  it("counts UTF-8 bytes as the encoder does", () => {
    for (const s of ["", "abc", "Привет", "漢字", "😀", mixed, mixed.repeat(50)]) {
      assert.equal(utf8Bytes(s), Buffer.byteLength(s, "utf8"), JSON.stringify(s.slice(0, 20)));
    }
  });

  it("looks at only a few characters one by one, however long the text", () => {
    const big = `${mixed.repeat(30_000)}tail`;
    const charCodeAt = String.prototype.charCodeAt;
    let calls = 0;
    String.prototype.charCodeAt = function (this: string, i: number): number {
      calls++;
      return charCodeAt.call(this, i);
    };
    try {
      utf8Bytes(big);
      utf8Head(big, 700_000);
      utf8Tail(big, 700_000);
    } finally {
      String.prototype.charCodeAt = charCodeAt;
    }
    assert.ok(calls < 1_000, `${calls} characters looked at one by one`);
    assert.equal(utf8Head(big, 700_000), head(big, 700_000));
    assert.equal(utf8Tail(big, 700_000), tail(big, 700_000));
  });
});
