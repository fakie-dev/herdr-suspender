# 15. A session is a terminal's only through its process tree

Status: accepted. Narrows [ADR 4](0004-session-ids-without-hooks.md): the files it reads stay, the folder match goes.

## Context

ADR 4 matched a session to a terminal by the folder the terminal's shell reported and by start time, and asked
the process tree only when that was ambiguous. A folder is not evidence:

- a new tab's shell starts where the focused pane was, and the agent is started after a `cd` (`cd Y; claude` on
  one line runs it in Y while the shell still says X);
- another space may run an agent of the same kind in that folder at the same time, and a mod that groups spaces
  by folder makes that the usual case;
- a Codex rollout can come from any terminal, or from a script's `codex exec`.

Each of these gave a tab another tab's session: Claude Code in 0.1.2 (fixed in 68b9fc7), Codex until this change
(one new rollout in the folder was taken unchecked, at binding and at every recheck). A wrong session then moves
records, sleeps the wrong conversation, or kills a terminal. The person who uses the mod asked that this class
of bug never come back, as they will add a mod that groups spaces by folder.

## Decision

A session is tied to a terminal only by evidence of that terminal's own processes, or by labels the mod put on
the terminal itself. Never by a folder, a space or tab name, or the order of anything.

- Claude Code: the pid file of the foreground process (POSIX: Claude itself), else the live session whose Claude
  runs under the terminal's shell, nearest to it (Windows: the shell is in front). Without a process of the
  terminal's own in front, nothing is taken. npm's Claude Code runs as `node` with its `cli.js`, and counts too.
- Codex: `resume <id>` on the command line of the Codex under the shell; else the newest rollout that only that
  Codex can have made. A rollout is a Codex's when it is the only live Codex running since before the rollout's
  birth (its id is a UUIDv7), or the only one that started within two seconds of it (a Codex makes its session
  when it starts). A rollout several could have made is nobody's: the terminal keeps the session it had.
- A recheck (at Sleep, at the end of a turn) uses a new rollout or a changed process only as the trigger; the
  same process evidence decides.
- The folder a session runs in is the agent's own (Claude Code's pid file, Codex's `session_meta`), and the
  record keeps it for Resume.
- A live terminal of Herdr whose processes run a session that sleeps elsewhere is where that session runs: the
  record moves there and the old sleeping pane closes. "Open elsewhere" is for holders outside Herdr's tabs.

## Consequences

- Every fix of this class has a test where the folder lies: a shell that still says X while its agent runs in Y,
  or another space running the same agent in the same folder.
- More process listings: Codex binding asks the process table once per new rollout (rollouts are rare: a start,
  a /new) instead of never when one rollout was in the folder. On Windows that is PowerShell, about a second.
- A Codex /new while another Codex that started earlier is still running cannot be told apart from that one's
  /new, so the tab keeps its old session id: Sleep then sleeps the conversation it had, and Resume brings that
  one back. A wrong session is worse than an old one.
- A Codex that has exited is not in the process table; a rollout it made, born after the terminal's own Codex
  started, is still credited by the rules above only when no other live Codex could have made it.
