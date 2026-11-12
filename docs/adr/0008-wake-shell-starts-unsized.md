# 8. The shell a wake starts has no size until Herdr adopts it

Status: accepted.

## Context

A wake starts the agent as a new tab would: Herdr's default shell in the session's folder, started with
`hc run --bg --keep` and without `herdr.space` / `herdr.tab` labels, so that Herdr keeps it out of its screens
until the agent runs in it (nobody sees a bare shell with the resume command typed into it). The resume command
is typed at the shell's prompt; once the agent runs and has reported, the labels are added and Herdr adopts the
terminal into the session's tab, in the slot of the sleeping pane (`Engine.start`).

The agent should come back at the size of that pane (spec §17, R16). It does not start at it:

- `hc run` and `hc attach` take no size. Until Herdr adopts the terminal, the core gives it its default,
  200 columns by 120 rows, and the agent draws its first screen at that size.
- The core can be told a size: `terminal.run` takes `size`, but only as a request sent to `hc connect` on its
  stdin. A mod has `hc(args)` and `exec(command, args)`, neither with a way to write to the program's stdin.

## Decision

The shell starts unsized, and the agent gets the pane's size when Herdr adopts the terminal (Herdr resizes it to
its pane as it does any terminal it shows). Nothing is sent to fix the size before that.

## Rejected

- **A wrapper through `exec`**, e.g. `pwsh -c "<request json> | hc connect"`: it would carry the size, but
  `hc connect` finds its core through its environment (`HC_SESSION`), and the environment `exec` gives a program
  may point at another core than this window's. The session would then start where nobody sees it. `hc(args)`
  is the mod's own channel to this window's core.
- **Showing the shell in its pane first, to size it, and typing the command then**: what 0.1.0 did; the person
  sees a bare shell with the command typed into it (blind review, finding 4).

## What the person sees

- **Claude Code** draws on the alternate screen and redraws itself when its terminal is resized: once adopted,
  it fills the pane at the pane's size. Seen live at zoom 1.6: no history laid out for 200 columns is left
  behind.
- **Codex** draws in the normal screen, so its lines printed before the resize keep the 200-column layout in the
  scrollback. Not checked live.

## Revisit when

`hc run` gets a size flag, or a mod can send `hc connect` a request on its stdin: then the shell starts at the
pane's size (the sleeping pane's size is known when Resume is pressed).
