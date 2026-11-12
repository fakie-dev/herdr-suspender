# 7. Which panes are sleeping panes, when Herdr does not say

Status: accepted.

## Context

The mod opens its sleeping pane with `pane.split {mod: "suspender", props: {role: "sleep", key}}` and finds it
by comparing `panes()` before and after. Herdr may show the pane later than the flow waits for it (a busy
window): in 0.1.0 that made a second split, and one of the two panes stayed beside the agent after Resume.

Two things follow: a pane that shows late must still go to its session, and a pane left over all the same
should be closed. Closing needs to know that a pane is a sleeping pane and whose. Herdr's `panes()` gives a mod
pane's name (`mod`), its tab and title, but not its `props`: the role and the session key cannot be read from
it. A pane of this mod may also be something else, for example a Sessions list someone split in by hand.

## Decision

The window keeps what it knows (`Coordinator.splits`, `Coordinator.sleepPanes`):

- each split a flow asked for and has not seen yet: its session, its tab, the panes and tabs there were before,
  and when. A pane of the mod that appears in that tab after it, and is nobody's yet, is that split's pane, for
  up to 60 seconds (`LATE_PANE_MS`). A split that had to open a new tab (nothing left in the session's tab to
  split beside) takes only a pane in a tab that was not there before: a pane of the mod in any older tab is
  someone else's. The flow waits for it twice (`PANE_WAIT_MS` each) and never splits again;
  after that the leader gives it to its session if the session sleeps without a pane, and meanwhile does not
  drop that session as gone;
- the pane of every record, as the leader sees it.

`sweepStrays` closes only a pane known this way whose session no longer owns it, once it has stayed so
`GONE_GRACE_MS` while nothing is being slept or woken, and only in a tab where a session lives (so it is never
a tab's last pane).

## Consequences

- A Suspender pane the window did not split and no record owns is never closed: a Sessions list split in by
  hand, or a sleeping pane left from before Herdr was opened. The latter shows an empty pane until it is
  closed by hand; it has no record, so it never had a Resume.
- One exception, which `panes()` cannot rule out: while a split's pane is late (Herdr has not shown it after
  the flow's two waits, up to `LATE_PANE_MS`), a Suspender pane someone splits in by hand **into that same tab**
  before the late pane shows is taken for it. It becomes the session's pane, so Resume closes it; the real
  sleeping pane, when it shows, is then nobody's and stays until closed by hand. Nothing in `panes()` tells the
  two apart (no props, the mod's name as the title), and the sleeping pane's own copy cannot vouch for itself:
  a copy starts only when its pane is first shown, and it does not know its pane's id. Not taking a late pane
  at all would instead drop the sleeping session as gone, which costs more than one Sessions pane. In practice
  Sessions opens as a window (`mod.open`) or as the layout's side panel, neither of which is a pane of a tab;
  a Suspender pane in a tab needs a hand-made `pane.split {mod: "suspender"}`.
- A late pane whose tab has no other session (its session was forgotten before it showed) is left in place.
- If Herdr starts giving `props` in `panes()`, the role and key can be read instead, and the window's memory
  goes.
