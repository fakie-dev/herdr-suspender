# Changelog

All notable changes are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- A session's row in Sessions shows how full its context is, after the model: `ctx 29%`, or `ctx 68k` when the
  window is not known. On a narrow panel it stays after the model, folder and id have gone to `+N`.
- Claude Code models from the 5 generation on (Opus 5.5, Sonnet 5.5, …) get a percentage of their 1M window at
  any fill. Before, a percentage came only from a use above 200k or from `[1m]` in the model's name, which the
  transcript never holds. Haiku 4.5 gets its 200k. The 4.x models still show the tokens in use: their window is
  a setting the transcript does not keep.
  A session recorded by 0.1.2 with only the tokens gets its percentage too, though its transcript has not
  changed since.

### Fixed

- A running Claude Code session whose transcript has passed 64 MiB shows its context, model and last reply in
  Sessions again. Herdr reads no file over 64 MiB whole, the read came back empty, and the empty read was kept as
  if the transcript had been read, so the session stayed blank for good. A read that gives nothing now counts as
  no read, and a session kept blank that way by 0.1.2 is read again. Such a transcript is read from its two ends;
  the message count is left out, as it would need the whole file.
- A growing transcript is no longer read whole every 30 seconds while Sessions is open. Past 8 MiB only its new
  bytes are read, by one short process (Windows' own `curl` with a byte range, `tail` elsewhere).
- The agent's square in a Sessions row (C for Claude Code, X for Codex) is level with the title again. It sat
  at the top of the row, 1.5 px above the middle of the title's capitals in Geist and 2.5 px in Segoe UI
  Variable. It is now centred in a box as tall as the title's line, so it follows that line in any UI font and
  at any zoom; measured within 0.5 px of the middle of the capitals at zoom 1 in both fonts.
- Resume opens a Codex session even when Codex has an update waiting. Codex showed its "Update available"
  question first and loaded the session only once someone answered, so the wake did not find the session and
  could time out. The mod now starts Codex with `-c check_for_update_on_startup=false`, which skips that
  question for that run only; `config.toml` is not changed, and Codex started by hand still asks.

## [0.1.2] - 2026-11-12

### Changed

- The moon of the Sleep pill at the bottom right of a tab is a square button at every zoom (it was a little
  taller than wide). The pill now peeks 38 px instead of 30, as wide as Herdr's frame around it is tall, and the
  moon sits in its middle, with nothing of the "Sleep" label showing beside it at rest. Living layouts are
  rebuilt for it (generator 5).
- Sleep no longer shows the sleeping tab next to the live agent while the agent is stopped. The sleeping tab
  takes the agent's place at once, at the same size, and the agent is stopped out of sight (it is gone from the
  Agents list too). Before, both stood side by side for a few seconds and then the agent's pane closed by itself.

### Fixed

- Resume no longer shows the agent squeezed beside the sleeping tab. For up to 0.8 s the agent stood at half the
  slot next to the sleeping tab, and Claude Code drew its banner at that width. The agent now takes the slot
  within a frame or two of appearing, and the sleeping tab goes in the same step.
- Resume of a session in a tab you are not on no longer takes you there. Woken from the Sessions panel, a
  session in another tab of the same space switched to that tab, and one in another space switched the space and
  closed the side panel (Herdr's tab bar keeps the panel per space). The agent was focused when it came up, and
  focusing a pane of another tab shows that tab. Now it is focused only when its tab is the one on screen; Resume
  all in a space that is not shown leaves the screen alone too. A sleeping tab that needs a new tab of its own
  (its old tab is gone) gives the screen back the same way.
- "Memory freed" no longer shows the figure of an earlier sleep. A sleep whose figure could not be taken kept
  the old one, and on a busy machine (two sessions put to sleep at once) it often could not be taken: the
  processes were listed while the agent was being stopped, and by the time PowerShell got to them the agent
  and its shell were gone. The stop now waits for the listing before its first key, at most 5 seconds (usually
  about one second); a figure that cannot be taken in time is not shown. The same holds for the last screen and,
  after a wake, for "uses".
- "Memory freed" and "uses" on Windows were about twice what a session really gives back. They added up the
  working set of every process of the session (the shell, the agent and its MCP servers), which counts the
  memory those processes share once for each of them: a fresh Claude Code said 1.5 GB where 0.7 to 0.8 GB came
  back. Both now count the private working set, the figure Task Manager shows. Sessions put to sleep before
  keep their old figure until they sleep again.
- The popup of a session whose first prompt or last reply is long no longer says "This view could not be
  rendered · interrupted". Its text is now wrapped only as far as it is drawn (two lines), instead of all of it
  and then cut one character at a time, which took Herdr past its time limit for a script (about 110 ms per
  popup for a 400-character reply, now about 3 ms).

## [0.1.1] - 2026-11-12

Mostly fixes from an independent run on a clean 0.1.0 install, plus a shorter README.

### Added

- The sleeping tab follows Herdr's `terminal_line_height` setting (Herdr 0.1.16), so the dimmed last screen
  keeps the row height of the real terminal. At the default of 1 nothing changes.

### Changed

- The README is shorter and plainer: what the mod is, how to install it, the two keys and how to remove it.
  Install steps are given for Windows and for macOS / Linux (on a Mac the layout switch is `Cmd+Shift+L`).
  How it works inside moved to `docs/architecture.md`.
- `ROADMAP.md` has two new ideas: keep the text you typed in the prompt when the session goes to sleep, and
  don't sleep a session while it still has background work running.

### Fixed

- Waking a session no longer shows a bare shell with `claude --resume …` typed into it for several seconds. The
  sleeping tab stays in place with its "waking" steps until the agent is running, and only then gives way to
  it. The agent still starts in your default shell, so the tab keeps that shell after you exit the agent.
- A tab could end up with two sleeping panes, and one of them stayed next to the agent after Resume. It
  happened when Herdr took a moment to show the new pane: the mod then asked for a second one. It now waits
  for the first. If that pane shows up late, the sleeping tab takes it instead of losing the session, and a
  leftover sleeping pane that no session owns is closed.
- The mod no longer closes panes that are yours. Only its own sleeping panes are ever cleaned up, and a late
  pane is never taken from another tab.
- A sleeping session that you open in another tab (or another program) now shows "open elsewhere" and disables
  Resume within seconds, and again whenever you come back to its tab, not only after you press Resume.
- Running sessions in the Sessions list show their title, branch and model as soon as they are known, like
  sleeping ones. They are read while the list is open, and only when the conversation changed.
- The popup shows how much context is in use even when the context window is unknown (for example
  "53k in use"), instead of leaving the line out.
- In a narrow pane or at a large zoom, the strip's status wraps at words (two lines at most, then "…") instead
  of being cut mid-word, and the title is hidden rather than shown as a lone "…".
- The strip no longer says "Updated after sleep · +0 messages" when the conversation was opened elsewhere but
  nothing was added to it.

### Known limits

- The shell that wakes a session starts at 200×120 before it is shown, and the agent draws itself for that
  size first. Claude Code redraws to fit and looks right. Codex has not been checked.

## [0.1.0] - 2026-11-12

First release.

### Added

- Sleep and resume for Claude Code and Codex sessions: the agent is stopped cleanly, its tab stays and shows
  the last screen dimmed with a strip (title, branch, model, folder), and Resume continues the same
  conversation in the same tab.
- Sleep from a pill over the tab, from the Sessions list and from `Alt+Shift+S`. A working agent gets a choice
  first: sleep when done, interrupt and sleep, or cancel.
- Sessions that survive a restart of Herdr or the computer. Tabs that had an agent show an
  "interrupted by restart" strip and wait; nothing starts by itself.
- Sessions panel on the right, grouped by space, with memory freed or used per session and "Resume all in
  project".
- Sessions is a third button in Herdr's tab bar, after Files and Changes and before the window buttons, drawn
  the same way. Its list is a third page of the same side panel, remembered per space. The tab bar is a copy of
  Herdr's own with that one button added; it is rebuilt when Herdr's tab bar changes and checked before the
  layout uses it. If the copy can't be used, the layout falls back to Herdr's own tab bar with the Sessions
  button left of the tabs, and a short toast says so.
- `Ctrl+Shift+S` in the `suspender` layout toggles the Sessions panel.
- The mod's interface sits correctly at any Herdr zoom and window size: popups land where they should, row
  chips fold into "+N" instead of being cut, and the sleeping tab's last screen and Resume strip keep their
  proportions.
- Long text never gets clipped mid-letter. A long prompt or reply in the popup ends on "…", and the strip on a
  sleeping tab folds its buttons into a single icon (with a tooltip) when the tab is too narrow for them.
- Text is measured with Geist's real letter widths, so labels fit without guessing.
- A popup on hover over a strip or a row with the first prompt, last reply, context use, tokens, branch,
  model, folder and session id.
- A check that the session is not open elsewhere before resuming, and a clear strip when the conversation is
  gone ("Start new session" or "Forget").
- A generated `layouts/suspender.json`, created when the mod loads and rebuilt from Herdr's own `main.json`
  whenever that changes, and a ready-made layout card in `layout/`.
- A privacy check (`scripts/check-privacy.ts`) that runs in `pnpm check` and, over the whole git history, in CI.
- `RECIPE.md` for the mod and for the layout, with steps to remove the mod, its tab bar copy
  and its layout, `ROADMAP.md`, architecture notes and decision records.

### Known limits

- Tested on Windows only. macOS and Linux are expected to work and are covered by CI tests.
- Recovery after a reboot of the PC is covered by tests but has not been tried on a real reboot.
- Sleep does not warn about text typed into the prompt but not sent. It empties the prompt before the exit
  command, so the draft is dropped instead of being sent.
- The interface is English only.

[0.1.2]: https://github.com/fakie-dev/herdr-suspender/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/fakie-dev/herdr-suspender/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/fakie-dev/herdr-suspender/releases/tag/v0.1.0
