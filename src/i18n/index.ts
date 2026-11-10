// Text lookup. All UI strings live in `en.ts`; `t` fills `{placeholders}`.
// A missing key or param stays visible on screen (`⟦key⟧`, `{name}`) instead
// of disappearing, so a gap shows up the first time it is drawn.

import { en } from "./en.ts";

export type MessageKey = keyof typeof en;
export type MessageParams = Record<string, string | number>;

const messages: Readonly<Record<string, string>> = en;

export function hasMessage(key: string): key is MessageKey {
  return Object.hasOwn(messages, key);
}

export function t(key: MessageKey, params?: MessageParams): string {
  if (!hasMessage(key)) {
    return `⟦${key}⟧`;
  }
  const text = messages[key] ?? "";
  if (params === undefined) {
    return text;
  }
  return text.replace(/\{(\w+)\}/g, (whole, name: string) =>
    Object.hasOwn(params, name) ? String(params[name]) : whole,
  );
}
