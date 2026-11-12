# Architecture

Suspender is a Herdr App mod. Herdr runs the mod's JavaScript inside the app, one copy per place the mod is
shown, and gives it an API for terminals, panes, shared values and files. Everything below is how those pieces
are used to put an agent to sleep and bring it back.

## Layers

```
main.ts            one View; props().role picks what this copy draws
ui/                strip, panel, popup, pill, toggle      (import herdr, gpui-kit)
runtime/           engine: binds sessions, runs effects   (import herdr via Host)
adapters/          claude.ts, codex.ts                    (Ports only)
core/              state machine, store, layout, paths    (pure)
platform/          Ports for Herdr + OS, process code
```

The rule that holds it together: `core/` and `adapters/` import types and `Ports` only. The engine sees Herdr
through `Host` and the file system and processes through `Ports`, so the tests run the whole sleep and wake
flow on a simulated Herdr and in-memory files, with no process started.

## One View, many roles

There is one mod and one View class. `props().role` decides what a copy is: `toggle`, `panel`, `pill`, `sleep`
(a sleeping tab, with `props.key`), `confirm`, `popup`, and `window`. Each copy also runs an engine instance, but
only one of them leads. The leader is whichever copy holds `shared("suspender.leader")`; it stamps the value
every 10 seconds and any copy takes over after 15 seconds of silence. The leader binds sessions to terminals,
watches for restarts and writes the store. Every copy may carry out an action someone asked for in it, so a
press on Resume works in whatever copy contains the button. Store writes are conditional (see below), so two
copies never overwrite each other. See [ADR 1](adr/0001-roles-through-props.md).

## States

`core/machine.ts` is the only place states change. A session is one of `running`, `working`, `confirming`,
`stopping`, `asleep`, `interrupted`, `waking`, `elsewhere`, `missing`, `error`. The machine is one table over
every `(state, event)` pair; a pair that makes no sense changes nothing and has no effects, and a test checks
that every pair is listed. A transition returns the new state and a list of effects (`snapshot`, `sendStop`,
`kill`, `placeSleepPane`, `startAgent`, `removeRecord`, ...). The engine runs the effects; the machine never
touches Herdr.

## Sleeping

1. Snapshot: the adapter reads the transcript (title, first prompt, last reply, branch, model, message count,
   context and tokens), and the engine saves `hc read` of the terminal as the last screen. The listing for the
   memory figure starts here too. The record drops the last sleep's screen and figure at once, so a screen that
   cannot be read or a figure that cannot be taken shows as none, never as the one from an earlier sleep.
2. The sleeping panel is placed first: `pane.split` with `mod` and `props` next to the terminal, `pane.swap`
   with it, and in the same step `terminal.park` takes the terminal's pane away. The agent keeps running out
   of sight and the panel alone holds the slot, so the tab never shows the panel beside the live agent for
   longer than a few frames ([ADR 9](adr/0009-stop-out-of-sight.md)). When the session's tab has no pane left to split
   beside (its tab is gone), the panel gets a new tab of the space; Herdr shows a new tab, so in the same step the
   engine selects again the tab that space showed and the tab that was on screen. The split, swap and park sequence is
   always done in full: with the swap left out, the removed pane's share of the space goes to a neighbour
   unless the pane was first in its parent along the parent's axis. With it, the new panel has exactly the old
   slot and the same size, which was measured in several positions. Herdr lists the new panel only after its
   next update, so it is looked for every 16 ms. If it has not shown after the waits, the terminal is not
   parked and the agent is stopped in view.
3. Stop steps from the adapter, sent to the parked terminal by its address (it still takes keys and reports its
   status). Before the first one, the engine waits for the memory listing, at most `MEMORY_WAIT_MS` (5 seconds),
   because every step can end processes of the tree (Escape ends a tool the agent is running); a figure that comes
   in after that does not count ([ADR 11](adr/0011-the-stop-waits-for-the-memory-figure.md)): Claude Code sends Escape, waits up to 10 seconds for the idle status, presses Ctrl+C and types
   `/exit`; Codex presses Ctrl+C and types `/quit`. Ctrl+C on an idle prompt empties it, so a draft is not sent
   together with the exit command. If the process is still alive 10 seconds after the last step the terminal
   is killed and the record says `forced`.
4. What is left of the terminal is ended: the shell the agent ran in, still running out of sight, with
   `terminal.kill`; a terminal that kept its pane (park failed and Herdr showed a toast) by closing the pane, as
   before. Then `hc rm`, and the record becomes `asleep` with the memory that was freed: the private working
   set of the terminal's process tree, taken right before the stop ([ADR 10](adr/0010-memory-is-the-private-working-set.md)).
   An agent that was not stopped (killed from outside) has only its shell left; the shell is ended here, after
   the same wait.

Stop commands are typed with `hc keys`, not `hc send`: `send` wraps text in a tag when `HC_TERMINAL_ID` is
inherited, and the agent would receive the tag.

## Waking

1. Checks: the adapter says whether the transcript still exists (otherwise `missing`) and whether another live
   process holds the session (otherwise `elsewhere`, and the button is disabled).
2. A terminal is started next to the sleeping panel in Herdr's default shell, and the resume command goes into
   it (`claude --resume <id>`, `codex resume <id>`) in the recorded folder. Quoting differs between shells
   (single quotes mean nothing to cmd.exe), so a command with any word a shell would act on is not typed at
   all and the wake fails with `reason.badId`; the adapters already take only UUIDs as session ids. `hc run`
   with the agent as the program was tried first and closed the pane when the agent exited; a shell keeps the
   tab.
3. The engine verifies with `hc get` that the command that is running is the one it asked for. Passing
   arguments through some shells changes them silently, so this is checked every time.
4. The record says `running` first. Then the labels are set, and Herdr adopts the terminal by splitting the
   tab's last pane; it lists the new pane only after its next update, so the pane is looked for every 16 ms,
   and in the same step, with nothing awaited, it is swapped into the slot and the sleeping panel is closed.
   The split is on screen for a frame or two, and the agent goes from the core's 200 columns to the slot's
   size within them (before, it stood at half its slot beside the sleeping panel for up to 0.8 s, and Claude
   Code drew its banner at that width). Closing the sleeping panel ends the copy that is that panel, so
   everything that waits comes before; if Herdr does not show the agent within 3 seconds, the record goes to
   `error` from `running` with the sleeping panel and Retry, as before.
   The agent gets the focus only when its tab is the one on screen. Herdr shows the tab of any pane that is
   focused, and its space with it, and its tab bar keeps the side panel per space, so focusing an agent woken
   from the Sessions panel in another space took the person there and closed the panel. Measured on Herdr
   0.1.15: `pane.split`, `pane.swap`, `pane.close`, `terminal.park`, `terminal.kill` and adoption by labels in a
   tab that is not shown leave the screen as it is; `pane.focus` there and `tab.new` do not. `Host` keeps the two
   apart: `run` takes only the first kind, and the others go through `runOnScreen`, which the engine uses for
   the focus above and for the one new tab a sleep may need.
5. If the agent has not shown up after 30 seconds, the record becomes `error` with a reason key and the strip
   offers Retry. Nothing is retried automatically.

"Resume all in project" runs the same steps for each sleeping or interrupted record of a space, one after
another, and leaves out those that are `elsewhere`.

## Remembering across restarts

A running agent's terminal is labelled `suspender.agent`, `suspender.session`, `suspender.state=running` and
`suspender.pid`. Labels survive a lost terminal, but the program's `argv` does not, so the command is rebuilt
from the adapter. After a restart a terminal that says `running` and no longer has the agent in it (the pid
differs, there is no agent status) is `interrupted`. The check errs on the side of doing nothing: with any
doubt the strip is drawn and no agent starts. When the engine sees an agent exit by itself the state label
becomes `exited`, so leaving an agent with `/exit` does not make a sleeping tab.

An agent killed hard (`taskkill /F`, a crash) leaves Herdr showing its last status. The engine looks at the
processes when a bound terminal's title or processes change: if the agent is gone and its status is still on
display `ABSENT_GRACE_MS` (3 seconds) later, the session is `interrupted`. After `/exit` the title comes back
first and the status goes out a moment later, so the grace keeps that from being taken for a kill.

The store is `~/.config/herdr-app/suspender/sessions.json`, outside `mods/` so reinstalling the mod keeps it.
It is written with `writeTextFile(path, text, expected)`: the write succeeds only if the file is still what was
read, and `updateStore` retries on a conflict. A broken file or one with another `version` reads as empty. See
[ADR 3](adr/0003-labels-and-store.md).

## Finding a session id

Without hooks. Claude Code writes `~/.claude/sessions/<pid>.json` for every live process (pid, session id,
folder, start time): the engine matches a terminal by folder and start time, and by the process tree when that
is ambiguous. Codex writes a rollout file per session whose first line names the session, folder and time: the
newest one for the terminal's folder that is not older than the process. See
[ADR 4](adr/0004-session-ids-without-hooks.md).

## The layout

`layouts/suspender.json` is generated from Herdr's `main.json` by `core/layout.ts` and kept current by
`runtime/layoutSync.ts`. Loading the module, and `herdr-app check`, creates the file from `core/shippedMain.ts` (a
copy of the 0.1.14 `main.json`) if it is missing, so a fresh install has a layout. Any shown copy then compares
the hash of `main.json`, the Herdr version, the generator version and the tab bar mode with the record inside
the file, and rebuilds if they differ. A write refused because another copy wrote first is read back and
retried, up to three times. The generator finds blocks by id and mod name. If it cannot, the last working file
stays and a toast says so. See [ADR 2](adr/0002-living-layout.md). `scripts/build-layout.ts` renders the same
generator against a fixture `main.json` into `layout/`, the ready-made card, and `pnpm check` compares it.

The tab bar mode comes from `runtime/tabsClone.ts`, run once per module load by the first copy that is shown.
Herdr's tab bar is a shipped mod, and shipped mods are not edited, so the mod keeps a copy of its own:
`mods/suspender-tabs` (made with `mod.clone`), equal to Herdr's `tabs/main.js` plus two insertions that add
Sessions to the panel buttons. The copy's first line records the sha256 of the `tabs/main.js` it was made from,
so a Herdr update that changes the tab bar is noticed on the next start and the copy is written again from the
new file. Herdr picks up whatever lands in `mods/` at once, so the new text is first tried with
`herdr-app check` in a folder of the mod's own, `<app home>/suspender/tabs-check`, and only a text that passed
replaces the copy.
When that works the layout shows the copy in the `tabs` block and puts the Sessions list in the side panel
stack `panel-body` as its third child. When it does not (the insertions no longer fit, or the check fails), the
copy stays as it was, the layout goes back to Herdr's own tab bar with our toggle block left of it and our own
column, and one toast says so. The copy reads
its label from `shared("suspender.tabLabel")`, which the engine sets after each round and each store write, only
when the text changes. `suspender.panel` opens and closes Sessions in either mode (`sessionsToggle`). See
[ADR 5](adr/0005-live-copy-of-tabs.md).

Without the layout the mod still works: Sleep and Resume, restored tabs, and Sessions as a window. Two things
depend on a copy of the mod being on screen, and the layout is what keeps one there. Keys reach only a mod that
is shown somewhere in the window, and the restart check runs when the first copy is shown. With the layout both
happen at once, because the Sessions button is always visible; without it they wait for a sleeping tab or the
Sessions window.

## Cost

The mod is meant to cost almost nothing while nobody touches it.

- No timers for animation. Animations are Herdr's native `.transition`, `.loop`, `.frames` and `.spin`.
  `cx.timer` runs only the 5-second data round and the leader's 10-second stamp.
- Process memory is read only while the panel is open and at most every 30 seconds, and once at Sleep: one
  PowerShell call on Windows (the tree and the private working sets together), one `ps` elsewhere. A "uses"
  figure is shown only for the terminal it was measured in, so after a wake the row has none until the next
  reading instead of the one from before the sleep.
- A transcript is read when a session goes to sleep, when its strip is shown, and right after the session is
  closed in another window, each time only if the file changed (size and modification time are compared
  first). Nothing watches it while the strip stays on screen: a session open elsewhere writes all the time,
  and each read would cost a `stat` process, so `+N` waits for the next show. Herdr's `fs/promises` has no
  partial read or `stat`, so a read is the whole file; `stat` is a spawned process (`robocopy /L` on Windows,
  which starts in about 20 ms, `stat` elsewhere), never PowerShell on a frequent path.
- Whether a Codex session is open elsewhere costs a `tasklist` call, made at most every 5 seconds and only
  while a strip that needs it is on screen. Claude Code is watched through its `sessions` folder instead.
- A Codex whose session is not known yet (no rollout written) is looked up in the process tree only when its
  terminal changes (foreground, title, status) or a new rollout appears in its folder, and on Windows at most
  once a minute. Idle at its prompt, it costs nothing.
- The snapshot of a sleeping session is taken once, at sleep.
- Drawing costs what is drawn. Herdr runs a mod in QuickJS and interrupts a script that runs too long ("This
  view could not be rendered"), so text is measured only as far as it shows: `wrapLines` makes lines one at a
  time, stops at the first line past the ones the popup draws, and never measures much more than a line. The
  adapters keep a prompt and a reply to 400 characters and a title to 200 (`oneLine`). The other measuring
  loops (`statusWords`, `fitSegments`, the path and branch shorteners) work on short or already shortened
  text.

## Platforms

Everything that differs by OS is in `platform/`: process lists and memory (`tasklist` and
PowerShell on Windows, where a session's memory is its private working set; `ps` and the resident size on macOS
and Linux), file stat, the shell, and the path separator. Nothing in `core/` or `adapters/` names an OS.
CI runs the tests on Windows, macOS and Linux; the mod itself has been used on Windows only.

### Tried by hand

On Windows, with both agents in a throwaway folder:

- Claude Code: sleep and resume into the same conversation, the question for an agent that is answering, a
  session open elsewhere, a missing conversation with Start new session, Forget, Resume all, leaving with
  `/exit` (the shell stays), `claude.exe` killed from outside (the tab turns "interrupted" within about ten
  seconds, and Resume brings the conversation back), a draft left in the prompt at Sleep (the agent got only
  `/exit`), and Sleep pressed on two tabs within a second (both went to sleep).
- Codex: sleep and resume into the same conversation, "sleep when done", a session open elsewhere, a missing
  conversation with Start new session, Forget, Resume all skipping a session that is open elsewhere, `/quit`
  (no sleeping tab is made), and `codex.exe` killed from outside (interrupted).
- Stopping out of sight (ADR 9), Claude Code only: an idle agent beside another pane and alone in its tab, and
  a working one stopped with "Interrupt and sleep". Each time the slot showed only the sleeping pane from
  about half a second after the press, the hidden agent left on `/exit`, and nothing was left in the core.

Covered by tests only so far: "updated after sleep" with Codex, a draft left in Codex's prompt, a real reboot
of the PC, Codex stopped out of sight, and an agent stopped out of sight that ignores its exit command (the
kill of a parked terminal itself was tried by hand).

## Limits

- If an agent shows its own dialog when it starts (Codex asks about updates and about trusting a new folder),
  the resumed agent waits behind that dialog until you answer it. The mod cannot see or answer it.
- Sleep does not warn about a draft in the prompt: it empties the prompt before the exit command.
- For a few frames after Sleep (about 80 ms measured) the agent and the sleeping pane share the slot: Herdr
  lists the new pane only after its next update, and it cannot be swapped in before that (ADR 9).
- Codex has no event for "closed elsewhere", so while its strip is on screen it is checked every five seconds
  (see Cost).

## Adding an agent

An agent is one file in `src/adapters/` that implements `AgentAdapter` from `contract.ts`: how to recognize the
agent in a terminal, how to find its session id, how to read a transcript, how to stop it and how to resume it.
Add its id to `AgentId` in `src/core/model.ts` and one line to `src/adapters/index.ts`. The adapters see the
world only through `Ports`, so they are tested with in-memory files and no process runs. `claude.ts` and
`codex.ts` are the two examples.

## Adding a language

Every text the mod shows is in `src/i18n/en.ts`, behind `t(key, params)`. A translation is a file with the same
keys. What is missing is the choice of language: Herdr does not tell mods the locale yet, so `t` reads English
only. If you want to translate, open an issue so the way to pick the language can be agreed first (see the
[roadmap](../ROADMAP.md)).

## Tests

Tests live in `test/`, run directly on the TypeScript with `node --test`, and use synthetic data only
(`test/adapters/synthetic.ts` builds transcripts that have the real record shapes but made-up text).
`test/runtime/sim.ts` is a simulated Herdr that the engine tests drive. `pnpm check` adds a build comparison
(the committed JavaScript must equal a fresh compile), a comparison of `layout/`, and the privacy scan.
Nothing in `pnpm check` is timed by the clock: how fast a 50 MB transcript is read is `pnpm bench`
(`test/**/*.bench.ts`), and the tests check what is read instead. The tab bar patch is tested against verbatim
copies of two Herdr releases' `tabs/main.js` in `test/fixtures/`.
