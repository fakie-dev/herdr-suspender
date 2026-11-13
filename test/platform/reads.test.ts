// How Herdr's ports read a file's head and tail: from a whole read when it is
// cheap, else (or when the whole read is refused) by a short process that reads
// only those bytes. A whole read that gives nothing must not end the read: in
// Herdr, `fs/promises` can refuse a file and Herdr's own text read stops at 1 MiB.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PART_FROM, partReaders } from "../../src/platform/reads.ts";

const TEXT = `${"a".repeat(100)}\n${"b".repeat(100)}\n`;

function readers(whole: string | null) {
  const parts: string[] = [];
  return {
    parts,
    r: partReaders({
      whole: async () => whole,
      part: async (_path, end, bytes) => {
        parts.push(end);
        return end === "head" ? TEXT.slice(0, bytes) : TEXT.slice(TEXT.length - bytes);
      },
    }),
  };
}

describe("a file's head and tail in Herdr", () => {
  it("a small file's tail is cut from the whole read, with no process", async () => {
    const { r, parts } = readers(TEXT);
    assert.equal(await r.tail("/f", 10, TEXT.length), TEXT.slice(-10));
    assert.deepEqual(parts, []);
  });

  it("a small file whose whole read is refused is read by the process instead", async () => {
    const { r, parts } = readers(null);
    assert.equal(await r.tail("/f", 10, TEXT.length), TEXT.slice(-10));
    assert.deepEqual(parts, ["tail"]);
  });

  it("a big file's tail is read by the process, never whole", async () => {
    const { r, parts } = readers(null);
    assert.equal(await r.tail("/f", 10, PART_FROM + 1), TEXT.slice(-10));
    assert.deepEqual(parts, ["tail"]);
  });

  it("a head comes from the whole read, else from the process", async () => {
    const whole = readers(TEXT);
    assert.equal(await whole.r.head("/f", 10), TEXT.slice(0, 10));
    assert.deepEqual(whole.parts, []);
    const refused = readers(null);
    assert.equal(await refused.r.head("/f", 10), TEXT.slice(0, 10));
    assert.deepEqual(refused.parts, ["head"]);
  });
});
