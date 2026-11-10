# 4. Finding session ids without hooks

Status: accepted.

## Context

To resume a conversation the mod needs the agent's own session id, for a terminal that was started by someone
else, in any folder. Both agents have hook mechanisms that could report it. Hooks need a change to the person's
agent configuration, can be skipped (a hook that does not fire leaves a gap), and in Codex need approval.

## Decision

Read what the agents already write to disk.

Claude Code writes `~/.claude/sessions/<pid>.json` for each live process: pid, session id, folder, start time,
status. The adapter lists them, keeps those whose process is alive and named `claude`, and picks the one whose
folder matches the terminal and whose start time is not before the terminal's. If more than one fits, the
process tree decides (the candidate must descend from the terminal's processes). Because a file can outlive its
process and a pid can be reused, liveness is always checked against the process list.

Codex writes `~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl`; its first record, `session_meta`, has the
session id and folder. The adapter takes the newest rollout for the terminal's folder that is not older than the
terminal's process. Codex's SQLite state is not read.

The same files answer "is this session open elsewhere": for Claude Code a live process with that session id, and
the `sessions` folder can be watched; for Codex the adapter checks the process list.

## Consequences

- Nothing to configure in either agent, and no dependency on hooks firing.
- The match is a heuristic and can be ambiguous (two agents started in one folder within moments). Ambiguity is
  resolved by the process tree, which costs a slow process listing, so it is used only then.
- The formats belong to the agents and can change. Each adapter is tested on synthetic files with the real
  record shapes, and each is one file to fix.
