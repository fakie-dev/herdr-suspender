// Byte-exact cuts of text read as UTF-8. Herdr's runtime reads a file as text
// (`fs.readFile(path, "utf8")`) but has no TextDecoder, and its Buffer does
// not decode: so the head or tail of a file by bytes is cut from the text by
// counting each character's UTF-8 length. A cut that would split a character
// leaves that character out.
/** UTF-8 bytes of the UTF-16 code unit at `i` (a surrogate pair counts 2 + 2 = 4). */
function unitBytes(text, i) {
    const code = text.charCodeAt(i);
    if (code < 0x80) {
        return 1;
    }
    if (code < 0x800 || (code >= 0xd800 && code <= 0xdfff)) {
        return 2;
    }
    return 3;
}
const isHigh = (code) => code >= 0xd800 && code <= 0xdbff;
const isLow = (code) => code >= 0xdc00 && code <= 0xdfff;
/** The first `bytes` bytes of `text`'s UTF-8 encoding, as text. */
export function utf8Head(text, bytes) {
    let used = 0;
    let i = 0;
    while (i < text.length) {
        const pair = isHigh(text.charCodeAt(i)) && isLow(text.charCodeAt(i + 1));
        const size = pair ? 4 : unitBytes(text, i);
        if (used + size > bytes) {
            break;
        }
        used += size;
        i += pair ? 2 : 1;
    }
    return text.slice(0, i);
}
/** The last `bytes` bytes of `text`'s UTF-8 encoding, as text. */
export function utf8Tail(text, bytes) {
    let used = 0;
    let i = text.length;
    while (i > 0) {
        const pair = isLow(text.charCodeAt(i - 1)) && isHigh(text.charCodeAt(i - 2));
        const size = pair ? 4 : unitBytes(text, i - 1);
        if (used + size > bytes) {
            break;
        }
        used += size;
        i -= pair ? 2 : 1;
    }
    return text.slice(i);
}
