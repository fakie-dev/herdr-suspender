# 14. A sleeping space keeps its name

Status: accepted.

## Context

A person reported that after a sleep a space was sometimes called `~` and had to be renamed by hand.

Herdr names a space nobody named after where its first terminal is now (its repo, else its folder, `~` at home)
and keeps following it; a name given with `space.rename` stays, and renaming to `""` gives the space Herdr's name
again (`spaces()[i].named` says which). Sleep parks the agent's terminal (ADR 9), so a space whose only terminal
was the agent has no terminal left, and Herdr falls back to the space's own folder. Spaces are often made at home,
so that folder is `~`.

Measured on Herdr 0.1.15 in an isolated core and window:

- a space made at home, its terminal `cd`'d into a project folder: the space is called after the project; its
  `folder` stays home;
- a mod pane split beside the terminal and the terminal parked: the space is called `~` at once;
- `space.rename {id, name}` on a space that is not shown: the shown space, tab and focus stay (it is a quiet
  command, like the park);
- after a terminal is back in the space, `space.rename {id, name: ""}` gives Herdr's name again, and the name
  follows the terminal when it moves.

## Decision

At sleep, in the same synchronous step as the park and before it, the engine reads the session's space. If nobody
named it, the engine renames it to the name it shows right then, and the record keeps that pin (`spaceName`:
space id and name). A space someone named is never renamed.

When a session that holds the pin leaves the sleeping ones (woken, Start new session, forgotten, or gone because
its pane or space went), another session still sleeping in the same space takes the pin over, so the name holds
until the last of them wakes. With nobody left, the engine renames the space to `""`, but only if it still has
exactly the pinned name: a name given while it slept, by the person or by another mod, is theirs, and so is a
space already given back to Herdr's name. A space that no longer exists is not renamed.

At a wake the name is given back in the step that swaps the woken agent into the slot, so Herdr names the space
after that terminal at once and the space never shows `~` on the way back. A wake whose agent Herdr never shows
keeps the pin: the session is still asleep. The pin is in the store, so a copy started later (after a restart)
gives it back too.

Measured with the mod in the isolated window: the space stayed `proj-alpha` through the sleep (sampled every
250 ms); after Start new session, the shell left by `/exit` moved to another folder and the space followed it, so
it was Herdr's name again.

## Rejected

- **Renaming after the park**, once the name has changed: the space would show `~` for a moment, and the old name
  would have to be guessed from Herdr's rules.
- **Pinning only when the agent is the space's first terminal**: which terminal is first is Herdr's to decide and
  is not in the API; pinning every unnamed space costs nothing visible, as the name is the one it shows.
- **A pin per session, each given back at its own wake**: with two sessions asleep in one space, the first wake
  would give the name back while the other still has no terminal there.

## Consequences

- While a session sleeps, its space counts as named (`named: true`). A mod that treats named spaces differently
  sees it so until the wake.
- While it sleeps, the space's name no longer follows its other terminals, if it has any.
- If the person renames the space to exactly the pinned name while it sleeps, the wake gives it back to Herdr's
  name, which is the same as long as the agent comes back in the same folder.
- If a copy of the mod is closed between the rename and the store write (one await), the space keeps the name
  and nobody gives it back; renaming it to nothing in Herdr undoes it.
