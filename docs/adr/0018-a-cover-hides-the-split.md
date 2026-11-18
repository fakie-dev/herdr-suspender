# 18. A cover hides the split while a tab is put to sleep or woken

Status: accepted. Builds on [ADR 2](0002-living-layout.md) and [ADR 9](0009-stop-out-of-sight.md).

## Context

A mod can put a pane in a tab only by splitting one (`pane.split {mod}`), and it learns the new pane's id only
when Herdr lists it. Measured on Herdr 0.1.16 in an isolated window, that is about 66 ms later. Until then the
agent stands at half its width beside the new pane, so every Sleep showed a split for about four frames, and a
Resume showed one when Herdr adopts the woken terminal. The person: «при нажатии sleep на время появляется split
и потом заменяется заснувшей вкладкой, можем ли мы это исправить?», then «А обойти, найти альтернативный вариант
для split нельзя?».

Ruled out, each measured or read in Herdr's API: `run` returns nothing, so no pane id in the step of the split;
mods get no pane bounds, so nothing can be drawn over the slot alone; `pane.zoom` does nothing to a pane alone
in its tab; parking the agent before the split closes a tab it was alone in; a new tab in place of the old one
changes the tab (its place, its name, what refers to it).

## Decision

- The living layout puts the tab block in a stack, `suspender-work`, with a Suspender block, `suspender-cover`,
  as its other child. The stack takes the tab block's place and size in its row.
- For a tab on screen with the agent alone in it, the engine shows the cover (`layout.select`) in the step of the
  split or the adoption. The cover draws the session's sleeping pane in the frame Herdr gives a lone pane (the
  tab block's `pane` look), from a record and wake step the flow hands it, so it looks like what comes next.
- The cover goes when Herdr lists the tab with only what the flow leaves there: our pane after a Sleep, the woken
  agent's terminal after a Resume. The cover's own copy checks every frame (`settleCover`). Put away with the
  park, measured, it showed the split again: the park lands a frame or two after the swap. A Resume's flow cannot
  put it away itself, as its copy may be the sleeping pane, which the close ends.
- A hold just made is waited for (the cover's copy redraws for it before Herdr shows the cover); one older than
  5 s, or a cover up with no hold (Herdr keeps a stack's child across a restart), is put away by every round.
- The cover records the size it drew at, and a new sleeping pane starts at it: a mod pane starts only when it
  first shows, and Herdr reports its size a frame later.
- Not used for a tab with other panes (the cover would hide them), a tab not on screen, or without the layout.

## Consequences

Measured with shots every 12 ms in an isolated window: in a warm window neither a Sleep nor a Resume shows the
split. The first Sleep after Herdr starts or the mod is updated may show a frame or two of other rows or an empty
slot, as the cover's copy and the new pane start on their first show. After a Resume, Claude Code redraws for its
new size within about 50 ms, as before.
