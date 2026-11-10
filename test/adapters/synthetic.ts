// Synthetic agent data for the adapter tests. Every text here is made up:
// nothing is copied from real transcripts (`~/.claude/projects`,
// `~/.codex/sessions`), only the record shapes (field names) are real.

import type { TerminalView } from "../../src/adapters/contract.ts";
import type { ExecResult } from "../../src/platform/ports.ts";
import type { FakePorts } from "../fakePorts.ts";

export const jsonl = (...records: object[]): string => records.map((r) => `${JSON.stringify(r)}\n`).join("");

let counter = 0;
const nextId = (): string => `id-${++counter}`;

// ---- Claude Code transcript records (`~/.claude/projects/<dir>/<id>.jsonl`)

interface ClaudeCommon {
  sessionId?: string;
  cwd?: string;
  branch?: string;
  ts?: string;
  sidechain?: boolean;
}

const common = (o: ClaudeCommon) => ({
  parentUuid: null,
  isSidechain: o.sidechain ?? false,
  uuid: nextId(),
  timestamp: o.ts ?? "2027-01-15T08:00:00.000Z",
  cwd: o.cwd ?? "/home/tester/dev/app",
  sessionId: o.sessionId ?? "s",
  version: "2.1.321",
  gitBranch: o.branch ?? "main",
});

export const claude = {
  prompt: (text: string, o: ClaudeCommon & { origin?: string; meta?: boolean } = {}) => ({
    ...common(o),
    type: "user",
    ...(o.meta ? { isMeta: true } : {}),
    ...(o.origin ? { origin: { kind: o.origin } } : {}),
    message: { role: "user", content: text },
  }),
  promptBlocks: (text: string, o: ClaudeCommon = {}) => ({
    ...common(o),
    type: "user",
    message: { role: "user", content: [{ type: "text", text }] },
  }),
  toolResult: (o: ClaudeCommon = {}) => ({
    ...common(o),
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "synthetic output" }] },
  }),
  reply: (
    text: string,
    o: ClaudeCommon & {
      model?: string;
      id?: string;
      usage?: { input: number; cacheRead?: number; cacheCreate?: number; output: number };
    } = {},
  ) => ({
    ...common(o),
    type: "assistant",
    message: {
      model: o.model ?? "claude-synthetic-1",
      id: o.id ?? nextId(),
      type: "message",
      role: "assistant",
      content: [{ type: "text", text }],
      usage: o.usage
        ? {
            input_tokens: o.usage.input,
            cache_read_input_tokens: o.usage.cacheRead ?? 0,
            cache_creation_input_tokens: o.usage.cacheCreate ?? 0,
            output_tokens: o.usage.output,
          }
        : undefined,
    },
  }),
  toolUse: (o: ClaudeCommon & { model?: string } = {}) => ({
    ...common(o),
    type: "assistant",
    message: {
      model: o.model ?? "claude-synthetic-1",
      id: nextId(),
      role: "assistant",
      content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }],
    },
  }),
  aiTitle: (aiTitle: string) => ({ type: "ai-title", aiTitle, sessionId: "s" }),
  customTitle: (customTitle: string) => ({ type: "custom-title", customTitle, sessionId: "s" }),
  noise: (n: number) => ({ type: "attachment", attachment: { type: "synthetic", body: "x".repeat(n) } }),
};

/** A live-session file as Claude Code writes it to `~/.claude/sessions/<pid>.json`. */
export function claudePidFile(o: { pid: number; sessionId: string; cwd: string; startedAt: number; name?: string }) {
  return JSON.stringify({
    pid: o.pid,
    sessionId: o.sessionId,
    cwd: o.cwd,
    startedAt: o.startedAt,
    procStart: "134000000000000000",
    version: "2.1.321",
    kind: "interactive",
    entrypoint: "cli",
    name: o.name ?? "synthetic-name",
    nameSource: "derived",
    status: "idle",
  });
}

// ---- Codex rollout records (`~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`)

export const codex = {
  meta: (id: string, cwd: string, timestamp: string) => ({
    timestamp,
    type: "session_meta",
    payload: {
      id,
      session_id: id,
      timestamp,
      cwd,
      originator: "codex-tui",
      cli_version: "0.163.0",
      base_instructions: { text: "synthetic instructions ".repeat(50) },
    },
  }),
  turn: (model: string) => ({ type: "turn_context", payload: { cwd: "/x", model, effort: "medium" } }),
  user: (text: string) => ({
    type: "response_item",
    payload: { type: "message", role: "user", content: [{ type: "input_text", text }] },
  }),
  assistant: (text: string) => ({
    type: "response_item",
    payload: { type: "message", role: "assistant", content: [{ type: "output_text", text }] },
  }),
  developer: (text: string) => ({
    type: "response_item",
    payload: { type: "message", role: "developer", content: [{ type: "input_text", text }] },
  }),
  tokens: (o: { input: number; output: number; lastTotal: number; window: number }) => ({
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          input_tokens: o.input,
          cached_input_tokens: 0,
          output_tokens: o.output,
          total_tokens: o.input + o.output,
        },
        last_token_usage: { input_tokens: o.lastTotal, output_tokens: 0, total_tokens: o.lastTotal },
        model_context_window: o.window,
      },
    },
  }),
};

/** A UUIDv7 (as Codex uses) whose time part is `ms`; `tail` makes it unique. */
export function uuidV7(ms: number, tail: string): string {
  const hex = ms.toString(16).padStart(12, "0");
  const rest = tail.padStart(12, "0").slice(-12);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7000-8000-${rest}`;
}

export function terminal(o: Partial<TerminalView> = {}): TerminalView {
  return {
    address: "t1",
    cwd: "/home/tester/dev/app",
    labels: {},
    status: "idle",
    app: null,
    foreground: null,
    createdMs: 1_799_999_000_000,
    state: "live",
    ...o,
  };
}

/** Replaces the fake's exec with a script and records calls, like `fakePorts` does. */
export function scriptExec(ports: FakePorts, script: (cmd: string, args: string[]) => ExecResult): FakePorts {
  ports.exec = async (cmd, args) => {
    ports.execCalls.push({ cmd, args });
    return script(cmd, args);
  };
  return ports;
}

export const ok = (stdout: string, code = 0): ExecResult => ({ code, stdout, stderr: "" });

/**
 * Counts what the adapter reads and lets a test move a file's mtime. Reads by
 * string slicing: the synthetic files are ASCII, so characters are bytes, and a
 * 50 MB file is not re-encoded on every call.
 */
export function metered(ports: FakePorts) {
  const meter = { bytes: 0, whole: 0, mtimes: new Map<string, number>() };
  ports.readText = async (path) => {
    const text = ports.files.get(path);
    if (text !== undefined) {
      meter.bytes += text.length;
      meter.whole++;
    }
    return text ?? null;
  };
  ports.readHead = async (path, n) => {
    const text = ports.files.get(path);
    if (text === undefined) {
      return null;
    }
    const part = text.slice(0, n);
    meter.bytes += part.length;
    return part;
  };
  ports.readTail = async (path, n) => {
    const text = ports.files.get(path);
    if (text === undefined) {
      return null;
    }
    const part = text.slice(Math.max(0, text.length - n));
    meter.bytes += part.length;
    return part;
  };
  ports.stat = async (path) => {
    const text = ports.files.get(path);
    return text === undefined ? null : { size: text.length, mtimeMs: meter.mtimes.get(path) ?? 1_800_000_000_000 };
  };
  return meter;
}
