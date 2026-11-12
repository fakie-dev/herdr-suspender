# 13. Agent icons from Herdr's program table

Status: accepted.

## Context

The user asked for the agents' icons in Sessions, as Herdr's tab bar shows them, instead of the squares with C
and X: «может быть в панели получится использовать иконки агентов? Ведь сам Herdr использует иконки во вкладках,
я бы хотел так же сделать в моей боковой панели вместо квадратиков с буквами».

Herdr gives every pane, agent and terminal a `program` from one table (its built-in table with `programs.json` on
top): a name, an `icon` (a path in Herdr's home), `tint` (a one-colour glyph to draw in a colour, else a
picture), and a `tile` and `color` for layouts that want a coloured square. Its tab bar and Agents list draw
`svg(icon)` in a text colour when `tint`, else `image(icon)`, and neither draws the tile.

A row in Sessions is often a sleeping session, which has no pane and so no `program`. What the platform offers
for an agent without a terminal (measured on Herdr 0.1.15 in an isolated core):

- `knownAgents()` resolves with the table's agents as `Program & { run, installed }`: `claude` and `codex` both
  with `icons/claude.svg` and `icons/codex.svg` and `tint: false`. It checks which are installed with a process
  (`hc exec` of a shell), at most once a minute per machine, and rejects when the check fails; a failure is not
  kept.
- `programs.json` in Herdr's home holds only the person's overrides on top of the built-in table, so reading it
  does not give the table.

## Decision

The icon comes from `knownAgents()`, by the agent's id as the table's key. It is asked once per module load and
kept (`core/agentLook.ts`, shared by the copies of a window); after a failure it is asked again a minute later at
most. While it has not answered, a live pane whose program has that key gives the icon, which costs nothing.
With no icon known the letter tile stays. Drawing follows Herdr's Agents list: `image()` for a picture, `svg()`
in the theme's foreground for a glyph, no tile, 16 px, in the box the tile had.

## Consequences

- An icon the person changes in `programs.json` shows in Sessions after the mod's next load.
- One check process per load, made by Herdr; nothing per draw.
- The mod ships no copy of Herdr's icons; a Herdr without an icon for an agent shows the letter.
