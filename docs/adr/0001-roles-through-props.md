# 1. One mod, roles chosen by props

Status: accepted.

## Context

Suspender draws five things in different places: a button in the tab strip, a panel in the work area, a pill
over the tab, a strip that replaces a terminal, and popups and dialogs. They share data (the session store, the
state of each session) and they all need to react when one of them acts.

## Decision

One mod and one View class. A copy learns what it is from `props().role` (`toggle`, `panel`, `pill`, `sleep`,
`confirm`, `popup`, `window`). The layout and `pane.split` pass the role and, for a sleeping tab, the session key.

## Consequences

- One copy of the code, one build, one folder to install. Herdr's catalog sees one mod.
- Copies do not share memory with each other beyond what Herdr offers: `shared` values and the files. So each
  copy runs its own engine, one of them leads (a stamped `shared` value, taken over after 15 seconds of silence),
  and state travels through the store and a revision value that makes the other copies redraw.
- A copy can be a dialog or a popup that lives for seconds. Those skip the leader election and the layout sync.
- Herdr passes props through `props()`, not through `init`'s argument; the entry point reads them there.

## Alternatives considered

Separate mods per role. Rejected: five folders to install and keep in step, and no common store without
writing the same coordination anyway.
