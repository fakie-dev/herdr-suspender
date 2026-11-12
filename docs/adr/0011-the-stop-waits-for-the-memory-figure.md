# 11. The stop waits for the memory figure

Status: accepted.

## Context

The memory freed at Sleep ([ADR 10](0010-memory-is-the-private-working-set.md)) was listed alongside the stop, so
that a slow listing (PowerShell and tasklist took 7 to 8 seconds each on a busy machine) would not hold the stop
up. The listing and the stop raced. An idle Claude Code leaves about 1 to 1.5 seconds after Sleep is pressed, and
its shell is ended right after; the PowerShell call lists the processes about a second after it starts, more
when the machine is busy. Whatever was gone by then was not counted, and with the shell gone there was no tree
at all and no figure. A record without a new figure kept the one from its last sleep.

A person put two fresh sessions to sleep a second apart: one said 848 MB, the other 1470 MB, the figure it had
from a sleep under the old measure. Measured in an isolated core:

- Two listings a second apart, alone, under process churn, or six at once on a machine busy on every core: every
  one answered (1.1 to 3.4 seconds), and processes started a moment before were in both lists. A listing that
  fails or times out was not seen.
- Two sessions put to sleep 1.2 seconds apart, with the listing slowed by 2.5 seconds: both listings found
  nothing under the terminal, and both records kept the figures of their last sleep.
- Without the slowdown both were measured, with a margin of a few hundred milliseconds: the second listing
  already missed processes of the first session, which was exiting.

## Decision

Each sleep starts with no figure and no last screen. The stop waits for the listing before its first key (Escape
can end processes too: a tool the agent is running), at most `MEMORY_WAIT_MS`, 5 seconds; a figure that comes
in after that is dropped, because it may count half a tree. An agent killed from outside has only its shell
left, and the shell is ended after the same wait. The agent is out of sight during the wait (ADR 9): the
sleeping pane says "Stopping…" a little longer.

## What the person sees

Two idle sessions put to sleep a second apart, measured: asleep 2.9 to 3.2 seconds after the press, about one
second later than before, with both figures. With the listing slowed by 2.5 seconds, both still have their
figure, about 6 seconds after the press. A listing slower than 5 seconds gives no figure.

## Rejected

- **Keeping the old figure when there is no new one**: it is shown as this sleep's saving.
- **One listing shared by sleeps at the same time**: it cuts a PowerShell call, but a shared listing may have run
  before a just-woken agent had started its children. With the wait, each sleep's own listing is correct.
- **A retry**: within the wait there is rarely room for a second call, and after it the tree is gone.
