# 3. Terminal labels plus a store outside the mod

Status: accepted.

## Context

After a restart of Herdr or the machine, a tab has to remember which agent conversation it held, and a sleeping
tab has to remember everything that is shown on its strip. Two kinds of facts are involved: facts about a live
terminal, and facts about a session that has no terminal.

Measured on herdr-core: a lost terminal comes back with the same address and labels, as a shell, and its
original command (`argv`) is replaced. Labels survive a core restart. A terminal does not remember what
program ran in it.

## Decision

Terminals carry labels: `suspender.agent`, `suspender.session`, `suspender.state` (`running` or `exited`) and
`suspender.pid`. Everything else (the snapshot of the session, the last screen, state, folder, space and tab,
memory freed, forced stop) goes into one JSON file, `~/.config/herdr-app/suspender/sessions.json`.

The file lives outside `mods/suspender/` so that reinstalling or updating the mod keeps it. Writes use
`writeTextFile(path, text, expected)`: they succeed only if the file is what the writer read, and the store code
retries a few times on a conflict. A file that is damaged, or of another `version`, is read as empty rather than
crashing.

A terminal whose label says `running`, but which no longer holds an agent process, is `interrupted`. The label
`exited` is set when the engine sees the agent leave by itself; that is how leaving with `/exit` is told apart
from a restart.

## Consequences

- No hooks in the agents, nothing to install or approve in them.
- The command to start is rebuilt by the adapter from the session id and folder, never read from `argv`.
- Several copies of the mod, in one or more windows, can write the store without losing each other's changes.
- The recognition errs towards doing nothing: with doubt, the strip is drawn and no agent is started.
