# 9. The agent is stopped out of sight

Status: accepted.

## Context

Sleep used to place the sleeping pane first (`pane.split` beside the terminal, `pane.swap` into its slot), then
run the stop steps (Escape, a wait of up to 10 seconds for idle, Ctrl+C, `/exit` or `/quit`, a kill after 10 more
seconds), and only then close the terminal's pane. The split and swap keep the slot's exact size (experiments.md
E1), but for the whole stop the tab showed the sleeping pane and the live agent side by side, each at half the
slot, and then the agent's pane closed by itself. Measured on 0.1.1 with Claude Code: about 2.5 seconds for an
idle agent, more for a busy one. To the person it looked like a second pane that sleeps while the first one is
still alive.

Herdr has `terminal.park {terminal}` (the pane menu's "Send back"): the terminal's pane goes, the terminal keeps
running. Measured on Herdr 0.1.15 in an isolated core:

- the pane goes as a closed one does, so after the swap its share goes to our pane, which then has the old slot
  at the old size (shots before and after compared, and the lone pane of a tab);
- Herdr's `herdr.space` / `herdr.tab` labels go and core keep is turned off; our own labels stay;
- the terminal stays in `terminals()` with its agent status, `hc keys` reaches it, and Claude Code stops there
  with the usual steps (Escape, Ctrl+C, `/exit`), reporting `working` and `idle` while hidden;
- a parked agent is in neither `agents()` nor the Agents list nor any tab: nothing shows it;
- `terminal.kill` ends a parked terminal.

## Decision

Right after the swap, in the same synchronous step, the engine parks the agent's terminal. The stop steps then
go to it by its address, as before. When the stop is over, a terminal that still has a pane (park failed: Herdr
shows a toast, the pane stays) is closed as before; one without a pane that is still alive (the shell the agent
ran in) is ended with `terminal.kill`, since nobody can see or close it. Then `hc rm` as before.

The terminal is parked only when our pane has been placed. If Herdr has not shown our pane after the waits, the
agent stays in its slot and is stopped in view, as before: a hole in the tab, or the late pane landing elsewhere,
would be worse.

Herdr lists a mod's new pane in `panes()` only after its next update, not when `pane.split` returns. The flow
looks for it every 16 ms (`FRAME_MS`) instead of every 250 ms, so the swap and the park follow the split within a
few frames (measured: 80 ms, down from 265 ms).

## What the person sees

Pressing Sleep (Claude Code idle, measured with `herdr-app shot` every ~150 ms): for a few frames the agent and
the sleeping pane share the slot; from then on the slot shows only the sleeping pane, at its old size, with
"Stopping…"; one to two seconds later it says when it fell asleep. The agent leaves the Agents list at the same
moment. A busy agent first gets the question, as before; after "Interrupt and sleep" it is the same.

## Rejected

- **Closing the pane at once and stopping the agent afterwards**: closing a terminal's pane ends the terminal, so
  the agent would be killed instead of exiting. Its last words (the transcript it writes on `/exit`) would be lost.
- **Removing Herdr's labels with `hc label`**: not tried. Its effect on a pane is not documented; park is the
  documented way to take a pane away and keep the terminal.
- **Splitting after parking**: parking first gives the terminal's share to a neighbour, and the slot is lost.

## Consequences

- If a copy of the mod is closed in the middle of a stop, the agent goes on running out of sight until the
  leader resolves the flow (`STALE_FLOW_MS`, 60 seconds): it is killed then and the record becomes asleep, as
  before, only without the agent visible meanwhile.
- A parked terminal is resized to the core's default (200 × 120). The last screen is read before the park, so the
  sleeping pane still shows what the person saw.

## Revisit when

Herdr returns the new pane from `pane.split` in a mod, or lists it at once: then the swap and the park follow the
split in the same step and no frame shows both.
