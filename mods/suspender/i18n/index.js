// Text lookup. All UI strings live in `en.ts`; `t` fills `{placeholders}`.
// A missing key or param stays visible on screen (`⟦key⟧`, `{name}`) instead
// of disappearing, so a gap shows up the first time it is drawn.
import { en } from "./en.js";
const messages = en;
export function hasMessage(key) {
    return Object.hasOwn(messages, key);
}
export function t(key, params) {
    if (!hasMessage(key)) {
        return `⟦${key}⟧`;
    }
    const text = messages[key] ?? "";
    if (params === undefined) {
        return text;
    }
    return text.replace(/\{(\w+)\}/g, (whole, name) => Object.hasOwn(params, name) ? String(params[name]) : whole);
}
