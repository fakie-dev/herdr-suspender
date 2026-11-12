# 4. Finding session ids without hooks

Status: accepted; how a file is matched to a terminal is replaced by [ADR 15](0015-identity-only-through-the-process-tree.md).

## Context

To resume a conversation the mod needs the agent's own session id, for a terminal that was started by someone
else, in any folder. Both agents have hook mechanisms that could report it. Hooks need a change to the person's
agent configuration, can be skipped (a hook that does not fire leaves a gap), and in Codex need approval.

## Decision

Read what the agents already write to disk.

Claude Code writes `~/.claude/sessions/<pid>.json` for each live process: pid, session id, folder, start time,
status. Because a file can outlive its process and a pid can be reused, liveness is always checked against the
process list.

Codex writes `~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl`; its first record, `session_meta`, has the
session id and folder. Codex's SQLite state is not read.

Which of these files is a terminal's is decided by the terminal's own process tree, never by its folder: see
[ADR 15](0015-identity-only-through-the-process-tree.md). (This record first matched by folder and start time,
and asked the process tree only when that was ambiguous.)

The same files answer "is this session open elsewhere": for Claude Code a live process with that session id, and
the `sessions` folder can be watched; for Codex the adapter checks the process list.

## Consequences

- Nothing to configure in either agent, and no dependency on hooks firing.
- The process tree is a slow listing on Windows (PowerShell), so it is asked only when something changed (a new
  file, a terminal that changed), never on a timer.
- The formats belong to the agents and can change. Each adapter is tested on synthetic files with the real
  record shapes, and each is one file to fix.
