# Suspender window

Herdr's standard window, plus the pieces [Suspender](../RECIPE.md) needs: a `Sessions · N` button in the tab
strip, the Sessions list in the side panel next to Files and Changes, and a small Sleep pill on the edge of the
tab area. Nothing from the standard window is removed or moved. Use it when you want Suspender and its
Sessions panel in place from the first minute; without it the mod still works, with Sessions as a window.

![The Suspender window](preview.png)

## What you see

The window is Herdr 0.1.14's `main` layout: the sidebar 268 px wide with Spaces and Agents, the work column,
the 28 px status bar at the bottom. In the work column the tab strip is 42 px tall. Three things are added.

Once the mod has run, the tab strip ends `+  Files  Changes  ☾ Sessions · N  ─ □ ×`: Sessions is a third panel
button, drawn exactly like Changes, and N counts sleeping sessions. The strip is the mod's copy of Herdr's tab
bar (see Built from).

Sessions opens in the side panel, the same 368 px column as Files and Changes: the three are pages of one
panel, a click on another button switches the page, a click on the open one closes the panel, and each space
remembers its page. The Sessions page lists spaces in upper case, each session on two lines with its state and
the memory it freed or uses, under a header with the total freed.

On the right edge of the tab area a drawer floats, 28 px tall, 30 px of it peeking out: a moon, and on hover
`Sleep · <agent>` for the agent that has focus. It is empty when no agent has focus.

The file in this card is the fallback the mod starts from: Herdr's own tab bar, with the mod's own
`Sessions · N` block, 110 px, left of the tabs, and a hidden Sessions column of its own, 320 px (200 to 700),
right of the Files/Changes column. The first copy of the mod that shows rebuilds it into the window above, and
returns to it whenever the copied tab bar cannot be used.

## How it behaves

The Sessions button opens and closes the panel on Sessions; `Ctrl+Shift+S` does the same. The pill sleeps the
agent in focus (asking first if it is answering). The strip that replaces a sleeping terminal, the popups and
everything else belong to the mod: see its [recipe](../RECIPE.md). The layout adds the places; the mod fills
them.

## Built from

`layouts/suspender.json` is `layouts/main.json` of Herdr 0.1.14 with its `cloned_from` set to
`{"name": "main", "version": "0.1.14"}` and a record `suspender_generated`: the hash of the `main.json` it was
made from, the generator version (3), and `tabs`, the tab bar it was built for. Insertions are found by block
id or mod name, never by position.

With the copied tab bar (`tabs: "clone"`, what the mod builds once the copy's text has passed `herdr-app check`,
which runs in `suspender/tabs-check` before anything under `mods/` is written):

- the `tabs` block shows `suspender-tabs` instead of `tabs`, everything else about it unchanged;
- the stack `panel-body` gets a third child after `files` and `changes`:
  `{id: "suspender", type: "block", content: {mod: "suspender", props: {role: "panel"}}}`;
- `suspender-pill`: on the node with `content.tab: "active"`, a `floating` entry with `edge: "right"`,
  `align: "end"`, `peek: 30`, `content: {mod: "suspender", props: {role: "pill"}}`.

With Herdr's own tab bar (`tabs: "builtin"`, the file in this card):

- `suspender-topbar`: a 42 px row that takes the place of the `tabs` block and holds `suspender-toggle`
  (`px: 110`, `content: {mod: "suspender", props: {role: "toggle"}}`) and then `tabs` (weight 1);
- `suspender-panel`: the last child of the row that holds the tab block, `hidden: true`, `size: {px: 320}`,
  `min: 200`, `max: 700`, `content: {mod: "suspender", props: {role: "panel"}}`;
- `suspender-pill`, as above.

The mod is `mods/suspender/`, a copy of the one in the first card. `mods/suspender-tabs/` is not in the card:
the mod makes it on your machine from your Herdr's own `tabs` with `mod.clone`, and writes it again after a
Herdr update. The other shipped mods (`spaces`, `agents`, `files`, `changes`, `pane`, `workspace-chrome`,
`workspace-status`) are used as they are.

The mod keeps this file current: whenever a copy of it runs it compares the hash of `layouts/main.json`,
Herdr's version and the tab bar with the record, and rebuilds `layouts/suspender.json` if any changed. If
Herdr's new `main.json` no longer has the blocks the insertions need, the last working file stays and one toast
says `Suspender couldn't update its layout for Herdr <version>`.

Keys come in `keys.json` next to this recipe, the mod's own snippet: merge it into yours. It adds
`layout:suspender` with `Ctrl+Shift+S` bound to `suspender.panel`, `Ctrl+Shift+S` opening the Sessions window in
any other layout, and `Alt+Shift+S` for Sleep and Resume of the tab in focus.

## Watch out

Our own button must stay left of the tabs block. Put it after `tabs` and it lands right of the window buttons,
which the tab block draws at its right edge. Whether the window can still be dragged and maximized by the strip
(a press, a double click) has not been checked by hand with the copied tab bar.

The layout is a snapshot for Herdr 0.1.14. A newer Herdr changes `main.json`, and the mod rebuilds the layout on
its own; if you install this layout without the mod, nothing will. Never clone `main` to get the same result:
the point is that Herdr updates still reach the window.

To remove it, switch to another layout first, then delete `layouts/suspender.json`, `mods/suspender` and
`mods/suspender-tabs`: Herdr tells a mod nothing when it is deleted, and a layout left pointing at the copied
tab bar keeps a Sessions button whose panel says the mod did not load.

The panel lists every session of every space, so on a shared screen it shows project names. `mod.json` is
`place: none`; do not change it to `place` something, or Herdr docks a copy of the mod into the window by
itself.

## Done when

- `herdr-app check mods/suspender` passes and `layout.switch suspender` shows the window with no errors in
  `herdr-app status`.
- Within a few seconds `mods/suspender-tabs/main.js` exists, its first line names the sha256 of
  `mods/tabs/main.js`, and the tab strip reads `+ Files Changes ☾ Sessions · 0 ─ □ ×`.
- Clicking Sessions opens the side panel on the Sessions list; Files and Changes switch away from it and back;
  clicking the open one closes the panel. `Ctrl+Shift+S` opens and closes it too.
- Focusing a terminal with Claude Code or Codex makes the Sleep drawer peek out; a plain shell does not.
- `layouts/main.json` and `mods/tabs/` are the same as before, and `Ctrl+Shift+L` switches back to `main`.
