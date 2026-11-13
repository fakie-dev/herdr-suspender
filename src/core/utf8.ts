// Byte-exact cuts of text read as UTF-8. Herdr's runtime reads a file as text
// (`fs.readFile(path, "utf8")`) but has no TextDecoder, and its Buffer does
// not decode: so the head or tail of a file by bytes is cut from the text by
// counting each character's UTF-8 length. A cut that would split a character
// leaves that character out.
//
// Counting is done by the runtime's own regular expressions, not by a loop
// over every character: Herdr ran 1 MiB of such a loop in 316 ms (measured on
// 0.1.15) and ends a script that runs 0.5–0.7 s without a pause, so a count over
// a transcript of a few MB stopped the whole read without a trace.

/** UTF-8 bytes of the UTF-16 code unit at `i` (a surrogate pair counts 2 + 2 = 4). */
function unitBytes(text: string, i: number): number {
  const code = text.charCodeAt(i);
  if (code < 0x80) {
    return 1;
  }
  if (code < 0x800 || (code >= 0xd800 && code <= 0xdfff)) {
    return 2;
  }
  return 3;
}

const isHigh = (code: number): boolean => code >= 0xd800 && code <= 0xdbff;
const isLow = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff;

/** Units of two UTF-8 bytes (a surrogate counts two: a pair is four). */
const TWO = /[\u0080-߿\ud800-\udfff]/g;
/** Units of three. */
const THREE = /[ࠀ-퟿-￿]/g;

const count = (text: string, units: RegExp): number => text.length - text.replace(units, "").length;

/** The UTF-8 length of `text` in bytes. */
export function utf8Bytes(text: string): number {
  return text.length + count(text, TWO) + 2 * count(text, THREE);
}

/** Whether `i` falls between the two units of a surrogate pair. */
const insidePair = (text: string, i: number): boolean =>
  i > 0 && i < text.length && isLow(text.charCodeAt(i)) && isHigh(text.charCodeAt(i - 1));

/** The first `bytes` bytes of `text`'s UTF-8 encoding, as text. */
export function utf8Head(text: string, bytes: number): string {
  // A unit is at least one byte: the first `bytes` units hold at least that many bytes.
  let end = Math.min(text.length, Math.max(0, bytes));
  if (insidePair(text, end)) {
    end--;
  }
  let used = utf8Bytes(text.slice(0, end));
  while (used > bytes) {
    // A unit is at most three bytes: dropping a third of the excess in units drops at most two bytes too many.
    let next = end - Math.max(1, Math.ceil((used - bytes) / 3));
    if (insidePair(text, next)) {
      next--;
    }
    used -= utf8Bytes(text.slice(next, end));
    end = next;
  }
  // Back up to the most that fits, a character at a time (at most two).
  while (end < text.length) {
    const pair = isHigh(text.charCodeAt(end)) && isLow(text.charCodeAt(end + 1));
    const size = pair ? 4 : unitBytes(text, end);
    if (used + size > bytes) {
      break;
    }
    used += size;
    end += pair ? 2 : 1;
  }
  return text.slice(0, end);
}

/** The last `bytes` bytes of `text`'s UTF-8 encoding, as text. */
export function utf8Tail(text: string, bytes: number): string {
  let start = Math.max(0, text.length - Math.max(0, bytes));
  if (insidePair(text, start)) {
    start++;
  }
  let used = utf8Bytes(text.slice(start));
  while (used > bytes) {
    let next = start + Math.max(1, Math.ceil((used - bytes) / 3));
    if (insidePair(text, next)) {
      next++;
    }
    used -= utf8Bytes(text.slice(start, next));
    start = next;
  }
  while (start > 0) {
    const pair = isLow(text.charCodeAt(start - 1)) && isHigh(text.charCodeAt(start - 2));
    const size = pair ? 4 : unitBytes(text, start - 1);
    if (used + size > bytes) {
      break;
    }
    used += size;
    start -= pair ? 2 : 1;
  }
  return text.slice(start);
}
