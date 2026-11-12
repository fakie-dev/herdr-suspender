# 6. "Open elsewhere" noticed by watching, all the time a tab sleeps

Status: accepted. Extends [ADR 4](0004-session-ids-without-hooks.md), which named the `sessions` folder as the
way to tell whether a Claude Code session is open elsewhere.

## Context

A sleeping session can be opened somewhere else: by hand in another tab, in another terminal program, in an
IDE. Resuming it then would start a second copy of one conversation, so Resume is disabled while it is open
elsewhere. In 0.1.0 the mod looked only when Resume was pressed: for about a minute the strip said "Asleep" with
an active Resume, and the lock and its text came only after the press (found by the blind review).

The strip has to say so within seconds, without a timer running while nothing happens (R34: in idle the mod
starts no processes, and `cx.timer` is only for data at the intervals the spec names).

## Decision

Three triggers, none of them a timer:

1. **The leader binds a terminal.** When the agent it finds in a terminal runs a session that sleeps in another
   tab, that session is marked open elsewhere at once (`Engine.bind`). This covers another Herdr tab, for
   Claude Code and Codex alike.
2. **Claude Code's `~/.claude/sessions` folder changes.** Every sleeping Claude Code tab keeps a `watchFolder`
   on that folder for as long as it is asleep, interrupted or open elsewhere (`SleepPane.tick`). Each change runs
   `Engine.recheckOpen`: `load()` (the store, only if another copy wrote it), one listing of the folder and a
   read of each `<pid>.json` in it, and only when one of them names this session, one process list
   (`tasklist` / `ps`) to check that its process is alive. This covers any program, not only Herdr.
3. **The strip is shown.** `refreshOnShow` asks the same question once per show (for Codex this is the only
   check outside Herdr's own tabs, one `tasklist`).

## What it costs

- One `watchFolder` per sleeping Claude Code tab, for the whole sleep: N sleeping tabs are N watches of the same
  folder, and one change wakes all of them.
- The folder changes whenever any running Claude Code changes its status (each turn starts and ends with a write
  of its `<pid>.json`). Each wake is a folder listing and a few small file reads per sleeping tab: no process,
  unless the session in question really is open somewhere.
- Measured in the sleeping-pane test: writing to the conversation itself (a different folder) wakes nothing.

## Rejected

- **A timer** (look every few seconds while a tab sleeps): the simplest, and what R34 rules out: it costs
  processes and wake-ups when nothing happens, all day for a tab that sleeps all day.
- **Look only when Resume is pressed**: what 0.1.0 did; the person sees an active button that then refuses.
- **One watch for the whole window, owned by the leader**: cheaper with many sleeping tabs, but a watch is a
  task of one copy and ends when that copy closes; the leader changes hands (after 15 s of silence), so the
  watch would have to be handed over and could be missing in between. A sleeping tab owns exactly what it
  needs, for exactly as long as it exists. Worth revisiting if people keep dozens of tabs asleep.
- **Watching Codex's folders**: Codex writes its rollout files continuously while it runs and keeps no
  per-process session file, so a watch would wake on every token; Codex keeps the check on show and the
  5-second check while the strip is on screen and the session is open elsewhere (spec, story 22).
