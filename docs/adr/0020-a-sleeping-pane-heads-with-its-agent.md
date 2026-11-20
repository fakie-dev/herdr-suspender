# 20. A sleeping pane's header shows its agent

Status: accepted. Builds on [ADR 5](0005-live-copy-of-tabs.md) and [ADR 19](0019-a-sleeping-tab-keeps-its-icon.md).

## Context

Herdr frames each pane of a tab with a header drawn by its shipped `pane` mod: the program's icon, the agent's
name or the terminal's title, the folder. A mod pane has no program and its title is the mod's name, so a sleeping
pane was headed "suspender" where the agent had been. The person: «Давай еще добавим иконку агента как тут в
верхней части окна терминала и выпустим в релиз».

A mod cannot set its pane's title or program, and Herdr refuses a mod's import from another mod's folder (measured:
`herdr-app check` fails with "resolves outside the application directory"), so the shipped header cannot be
extended from outside. ADR 5's live copy works for the tab bar and works here.

## Decision

- `mods/suspender-pane` is a live copy of `pane/main.js`, kept like the tab bar's (made with `mod.clone`, checked
  with `herdr-app check` outside `mods/` before it is written, rewritten when the shipped file changes). Its patch
  replaces `const p = this.me();` with `const p = sleeping(this.me());` and appends `sleeping`, which imports
  `shared` itself (an import may stand anywhere at a module's top level), so nothing else of the shipped file is
  named.
- `sleeping` gives our sleeping pane the program `{key, name, icon, tint, agent: true}` and the folder the engine
  publishes in `shared("suspender.paneHeads")` by pane id, so the header draws it as it drew the agent. Every other
  pane goes through unchanged.
- The engine publishes each sleeping pane's agent name (the adapter's), icon (Herdr's program table, ADR 19) and
  folder after each round and each store write, only when it changes.
- The layout shows the copy where the tab block's pane header is Herdr's `pane` (recorded as
  `suspender_generated.header`); a header of the person's own mod is left. A copy that cannot be made or does not
  pass its check leaves Herdr's header, quietly: unlike the tab bar, nothing is lost but the name.
- The cover (ADR 18) heads its picture the same way when the layout uses the copy, so nothing changes in the frame
  where the cover goes away.

## Consequences

- A sleeping pane reads "Claude Code C:\path\to\project" with the agent's icon, as before it slept, and keeps the
  header's split, zoom and close buttons. It shows no status: a sleeping agent reports none.
- Herdr's own header (a layout without ours, or the fallback) still names the mod.
- One more `herdr-app check` per module load (about a second), after the tab bar's.
