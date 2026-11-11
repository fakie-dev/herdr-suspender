# Changelog

All notable changes are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed

- Sessions is now a third button in Herdr's tab bar, after Files and Changes and before the window buttons,
  drawn the same way, and its list is a third page of the same side panel, remembered per space. The tab bar is
  `mods/suspender-tabs`, a copy of Herdr's `tabs` made with `mod.clone` and kept equal to Herdr's own file plus
  the Sessions button; it is written again when Herdr's tab bar changes and checked with `herdr-app check`
  before the layout uses it.
- When the copy cannot be used, the layout keeps Herdr's own tab bar with the Sessions button left of the tabs
  (it used to sit right of the window buttons), and a short toast says so.
- `Ctrl+Shift+S` in the `suspender` layout is the new command `suspender.panel`. A `keys.json` that still
  toggles `suspender-panel` should switch to it.
- The 50 MB transcript speed test moved out of `pnpm check` into `pnpm bench`; the tests check what is read.

### Added

- README and recipes say how to remove the mod, its tab bar copy and its layout.

## [0.1.0] - 2026-11-11

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
- A popup on hover over a strip or a row with the first prompt, last reply, context use, tokens, branch,
  model, folder and session id.
- A check that the session is not open elsewhere before resuming, and a clear strip when the conversation is
  gone ("Start new session" or "Forget").
- A generated `layouts/suspender.json`, created when the mod loads and rebuilt from Herdr's own `main.json`
  whenever that changes, and a ready-made layout card in `layout/`.
- A privacy check (`scripts/check-privacy.ts`) that runs in `pnpm check` and, over the whole git history, in CI.
- `RECIPE.md` for the mod and for the layout, `ROADMAP.md`, architecture notes and decision records.

### Known limits

- Tested on Windows only. macOS and Linux are expected to work and are covered by CI tests.
- Recovery after a reboot of the PC is covered by tests but has not been tried on a real reboot.
- Sleep does not warn about text typed into the prompt but not sent. It empties the prompt before the exit
  command, so the draft is dropped instead of being sent.
- The interface is English only.

[0.1.0]: https://github.com/fakie-dev/herdr-suspender/releases/tag/v0.1.0
