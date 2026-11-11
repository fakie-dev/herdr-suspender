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
before `.when(w?.buttons,`. Paths are not rewritten: the window-button icons stay `mods/tabs/...`. The label is
the shared value `suspender.tabLabel`, which the engine sets only when its text changes.

The first line of the copy is `// suspender-tabs: from tabs/main.js sha256=<sha> patch=<n>`. On each module load
the first copy of the mod that is shown (`runtime/tabsClone.ts`):

1. reads the shipped `tabs/main.js` and builds the patch; an anchor missing or repeated means fallback;
2. runs `mod.clone` if the copy does not exist and waits up to 5 s for its `main.js`;
3. writes the patch with `writeTextFile(path, text, expected)` when the copy differs. A copy that is neither
   ours (no mark line) nor a clone of `tabs` (its `mod.json` has no `cloned_from.name: "tabs"`) is left alone,
   which means fallback. A refused write is read back: if another copy of the mod already wrote the same text,
   that counts as done; otherwise it writes again, up to three times;
4. runs `herdr-app check` on the copy through `exec`. Not passing, or not being able to run it, means fallback.

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
- Writing a file under `mods/` reloads that mod, so the copy is written only when it differs.
- `herdr-app check` costs one process (about a second) per module load. If `herdr-app` is not on the `PATH`
  that `exec` sees, the check cannot run and the layout stays on Herdr's own tab bar.
- Herdr has no uninstall hook. A layout still pointing at the copy after `mods/suspender` is deleted keeps a
  Sessions button whose panel says the mod did not load; removing the mod means switching layouts and deleting
  `layouts/suspender.json`, `mods/suspender` and `mods/suspender-tabs`.
- The key `Ctrl+Shift+S` in the `suspender` layout is the mod's own command `suspender.panel`, which knows both
  tab bars; `layout.toggle {id: "suspender-panel"}` only works with the fallback. Every shown copy receives a
  key's command, so it acts at most once per second.
