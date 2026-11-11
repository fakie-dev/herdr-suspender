# 2. A generated layout instead of clones

Status: accepted. The toggle block beside `tabs` is replaced by [ADR 5](0005-live-copy-of-tabs.md), which
keeps it only as the fallback.

## Context

The Sessions button, panel and pill have to be placed in the window, and a mod cannot add to another mod's
block: the tab strip and the pane headers belong to Herdr's shipped mods. The obvious way, cloning `main` and
editing the clone, freezes the window at the Herdr version of the day: later changes to `main.json` never
arrive, and cloned shipped mods stop getting updates as well.

## Decision

`layouts/suspender.json` is generated from the current `layouts/main.json` by `core/layout.ts`. The generator
makes three insertions (a toggle block beside `tabs`, a hidden panel column in the row that holds the tab block,
a floating pill on the tab block) and records the hash of the `main.json` it used, its own version and Herdr's
version in the file. Any shown copy of the mod compares these on start and rebuilds the file when one changed.
Shipped mods are used as they are and never cloned.

The generator finds blocks by `id` and by the mod they hold, not by position. If an expected block is missing,
it reports instead of throwing, the last working file stays, and one toast per Herdr version says so.

For people who install without the mod, a snapshot made by the same generator on a fixture `main.json` is kept
in `layout/`, and the build check fails if it is stale.

## Consequences

- A Herdr update that only changes `main.json` reaches the window without action.
- A Herdr update that renames the blocks breaks the generator, visibly, and leaves the old window in place.
- The layout depends on a copy of the mod being shown to update; with the button always on screen that is
  always true.
- The button must follow `tabs` in its row: at its right edge the tab block draws the window buttons, and a
  block placed after them ends the strip behind them.
