# 16. A rebuild keeps the mods the person put in the layout's blocks

Status: accepted. Extends [ADR 2](0002-living-layout.md).

## Context

`layouts/suspender.json` is rebuilt from Herdr's `main.json` whenever `main.json`, Herdr's version, the generator
or the tab bar mode changes (ADR 2). People change that file: the first case was the spaces sidebar swapped for a
folders mod (`"mod": "spaces"` to `"mod": "herdr-folders"` in the block with id `spaces`), and others do the same
with other sidebar and panel mods. A rebuild put `spaces` back without a word.

What the person changed cannot be found by rebuilding from the `main.json` the file came from: the file keeps only
its hash. Comparing with the current `main.json` instead cannot tell a mod the person put in from a mod Herdr
changed in an update (the old one would be kept as if it were the person's, and the update lost).

## Decision

Each build records, in `suspender_generated.base`, the mod of every block of `main.json` by its id. A rebuild
compares the file on disk with that record: a block whose mod differs is the person's, and the new build's block
with the same id gets their content (mod and props). A file built before `base` was recorded is compared with the
current `main.json`.

- Suspender's own blocks are never carried over: our mods (`suspender`, `suspender-tabs`) are skipped, our blocks'
  ids are never in `main.json`, and a block the new build made ours (the tabs block showing the copy) is not
  replaced.
- A block `main.json` no longer has is dropped, and the copy whose write drops it says once which mod in which
  block is gone. No place is invented for it.
- A block the person added that `main.json` never had is not carried (no place to put it) and not reported.
- A file saved while it is being rebuilt makes the conditional write fail; the rebuild starts again from what was
  saved, so the newest edit is the one kept.

## Consequences

- Only a block's content is kept: sizes, order, and blocks the person added go with a rebuild, as before.
- A mod the person put in where Herdr later changed its own mod too keeps the person's.
- The record adds one small map to the file; no rebuild is forced to add it.
