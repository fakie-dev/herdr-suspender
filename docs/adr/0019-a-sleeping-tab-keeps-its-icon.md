# 19. A sleeping tab keeps its agent's icon

Status: accepted. Builds on [ADR 5](0005-live-copy-of-tabs.md).

## Context

Herdr's tab bar draws a tab's icon from the program of the tab's lead pane: an agent's pane if the tab has one,
else its first pane. A sleeping tab holds only our pane, and a mod pane has no program, so the tab lost its icon
while its session slept. The person: «Можно ли сделать так чтобы у вкладки со спящей сессией оставалась иконка ее
агента? Если да - сделай и выпусти релиз».

A mod cannot give its pane a program, and the tab bar cannot read the mod's records. The live copy of the tab bar
(ADR 5) is ours to patch, and Herdr's program table is readable with `knownAgents()`.

## Decision

- The engine publishes `shared("suspender.tabIcons")`: each session's tab with its agent's `{icon, tint}` from
  Herdr's program table, by the program key that is the agent's id (`claude`, `codex`). It is the table the
  Sessions list already draws agents with (`core/agentLook.ts`), now one per window in `runtime/looks.ts`:
  `knownAgents()` runs a check process, so it is asked once, and again a minute after a failure; until it answers,
  a live pane of that agent gives the icon. Neither: no icon.
- Running sessions are published too, so the icon is there the moment the agent gives its place to our pane. A tab
  with sessions of several agents shows the one whose pane is there, else the one running. The value is set after
  each round and each store write, only when it changes, like the tab label.
- The copy of the tab bar replaces `const program = lead?.program;` with a line that uses the published icon when
  the lead pane is ours (`lead.mod === "suspender"`), keyed by `lead.tab`, and the pane's own program otherwise.
  It names nothing else of the shipped file, so a renamed variable around it cannot break it.
- The change is optional: a shipped file without that line, with it twice, or with the change already in it is
  patched without the icon, never refused. `PATCH_VERSION` goes to 2, so existing copies are written again.

## Consequences

- On Herdr 0.1.16 with the Suspender layout a sleeping tab shows the same icon as when its agent ran, including
  an icon the person set in `programs.json`. Herdr 0.1.14 and 0.1.15 name the program another way: there the tab
  stays without an icon, as before.
- Herdr's own tab bar (the fallback of ADR 5, or a layout without ours) does not show it.
- A tab whose sleeping pane shares the tab with a terminal keeps that terminal's icon if the terminal is its first
  pane: the tab bar picks the lead pane before the icon.
