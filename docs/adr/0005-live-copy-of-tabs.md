# 5. A live copy of the tab bar instead of a clone

Status: accepted. Replaces the part of [ADR 2](0002-living-layout.md) that placed our own button block beside
`tabs`.

## Context

The Sessions button should sit inside Herdr's tab bar, after Files and Changes and before the window buttons,
and look like them. The tab bar is the shipped `tabs` mod: one block that draws the tabs, `+`, the panel
buttons and the window buttons. A block of our own can only go left of it, or right of the window buttons. A
mod cannot add a child to another mod's block, and `tabs` builds its panel buttons from a fixed list
(`shared("workspace.panels") ?? ["files", "changes"]`) that a mod cannot extend: `workspace.panels` is Herdr's
setting, and setting it would change the shipped bar for every layout.

A plain `mod.clone` of `tabs` freezes the tab bar at the day's version, which is what ADR 2 avoided for the
layout.

## Decision

The mod keeps `mods/suspender-tabs`, made once with Herdr's own `mod.clone {name: "tabs", as:
"suspender-tabs"}` (so `mod.json` and the icons come from Herdr), and owns its `main.js`: the shipped
`tabs/main.js`, unchanged except for two insertions, each at an anchor that must occur exactly once. The panel
list gets `"suspender"` appended, and `panelButton("suspender", <label>, "mods/suspender/icons/moon.svg")` goes
before `.when(w?.buttons,`. Both are made on the whole file, whichever anchor comes first, and a result that does
not hold each change exactly once is refused like a missing anchor. Paths are not rewritten: the window-button icons stay `mods/tabs/...`. The label is
the shared value `suspender.tabLabel`, which the engine sets only when its text changes.

The first line of the copy is `// suspender-tabs: from tabs/main.js sha256=<sha> patch=<n>`. On each module load
the first copy of the mod that is shown (`runtime/tabsClone.ts`):

1. reads the shipped `tabs/main.js` and builds the patch; an anchor missing or repeated means fallback. A copy
   that is neither ours (no mark line) nor a clone of `tabs` (its `mod.json` has no `cloned_from.name: "tabs"`)
   is left alone, which means fallback;
2. writes the patch and the shipped `tabs/mod.json` to `<app home>/suspender/tabs-check/suspender-tabs` and runs
   `herdr-app check` there through `exec`, with a 60 s timeout. Not passing, or not being able to run it, means
   fallback, and nothing under `mods/` has been touched. The check runs outside `mods/` because Herdr reloads a
   mod as soon as a file under `mods/` changes: with the layout already on the copy (the case after every Herdr
   update) a text written there first would be on screen, unchecked, until the check failed;
3. runs `mod.clone` if the copy does not exist and waits up to 5 s for its `main.js`;
4. writes the checked text with `writeTextFile(path, text, expected)` when the copy differs. A refused write is
   read back: if another copy of the mod already wrote the same text, that counts as done; otherwise it writes
   the same checked text again, up to three times.

One run serves every copy of the mod in the window. A run whose copy closed half way (its `mod.clone` wait was a
task of that copy) is started again once it has shown no sign of life for 90 s; a run inside `herdr-app check`
counts as alive until that check's own timeout has passed too, so a hung check never gets a second one beside
it.

The layout is then built for one of two tab bars (`TabsMode` in `core/layout.ts`, recorded as
`suspender_generated.tabs`). `clone`: the `tabs` block shows `suspender-tabs`, and Sessions is a third child,
`suspender`, of the side panel stack `panel-body`, so the copy's own code opens, switches and remembers it per
space exactly like Files and Changes. `builtin` (fallback): Herdr's `tabs`, our own toggle block left of it, and
our own hidden column. A change of mode rebuilds the layout like a change of `main.json` does. When the module
loads, before any copy has looked at the tab bar, the layout keeps the mode it has. A `main.json` with no
`panel-body` stack also gets `builtin`.

A fallback says so once per module load and Herdr version, in a toast short enough not to be cut.

## Consequences

- The button is drawn by the tab bar's own `panelButton`, so it matches Changes pixel for pixel, including the
  selected and hover states.
- A Herdr update that changes `tabs/main.js` reaches the copy at the next start; one that removes an anchor
  puts the button back left of the tabs instead of breaking the bar.
- `panelButton` tints its icon with the label color. The moon cannot turn `accent` while sessions sleep
  without a second change to the copy.
- Writing a file under `mods/` reloads that mod, so the copy is written only when it differs, and only with
  text that passed the check.
- Only `main.js` is kept in step with Herdr. The copy's other files (`mod.json`, the window-button icons) are
  the ones `mod.clone` made on the first day and are never updated; the icons are not even used, since the copy's
  paths point at `mods/tabs/`. If a Herdr update gives `tabs` a second module (`import ... from "./x.js"`), the
  candidate folder has no such file and the check fails, so the layout falls back to Herdr's own tab bar with the
  toast instead of loading a copy that cannot resolve its import (checked: `herdr-app check` on a folder whose
  `main.js` imports a missing `./helper.js` fails with "cannot resolve module"). Following such a change means
  teaching the mod to copy that file into the candidate folder and into the copy.
- The check passes on the shipped `mod.json`; the copy's own `mod.json` differs from it only by `cloned_from`.
- `herdr-app check` costs one process (about a second) per module load. If `herdr-app` is not on the `PATH`
  that `exec` sees, the check cannot run and the layout stays on Herdr's own tab bar.
- Herdr has no uninstall hook. A layout still pointing at the copy after `mods/suspender` is deleted keeps a
  Sessions button whose panel says the mod did not load; removing the mod means switching layouts and deleting
  `layouts/suspender.json`, `mods/suspender` and `mods/suspender-tabs`.
- The key `Ctrl+Shift+S` in the `suspender` layout is the mod's own command `suspender.panel`, which knows both
  tab bars; `layout.toggle {id: "suspender-panel"}` only works with the fallback. Every shown copy receives each
  press once, and a command carries no id, so a press is told from its copies by the copy that got it: a copy
  that already had the current press is getting the next one. The copies of one press arrive together; after
  250 ms a press is over even for copies it never reached, so a copy shown only since then acts on its first
  press. Two quick presses therefore open and close.
