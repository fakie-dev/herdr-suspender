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
   context and tokens), and the engine saves `hc read` of the terminal as the last screen.
2. The sleeping panel is placed first: `pane.split` with `mod` and `props` next to the terminal, `pane.swap`
   with it, and only then the stop steps run. The split, swap and close sequence is always done in full: with
   the swap left out, the closed pane's share of the space goes to a neighbour unless the pane was first in
   its parent along the parent's axis. With it, the new panel has exactly the old slot and the same size,
   which was measured in several positions.
3. Stop steps from the adapter: Claude Code sends Escape, waits up to 10 seconds for the idle status, presses
   Ctrl+C and types `/exit`; Codex presses Ctrl+C and types `/quit`. Ctrl+C on an idle prompt empties it, so a
   draft is not sent together with the exit command. If the process is still alive 10 seconds after the last
   step the terminal is killed and the record says `forced`.
4. The terminal is closed and the record becomes `asleep` with the memory that was freed.

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
4. Labels are set, the new terminal is swapped into the slot and the sleeping panel is closed. A new pane's id
   is found by comparing the pane list before and after, because `pane.split` from a mod returns nothing.
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
copy of the 0.1.14 `main.json`) if it is missing, so a fresh install has a layout. Any shown copy then compares the hash of `main.json`, the Herdr version and the generator
version with the record inside the file, and rebuilds if they differ. The generator finds blocks by id and mod
name. If it cannot, the last working file stays and a toast says so. See
[ADR 2](adr/0002-living-layout.md). `scripts/build-layout.ts` renders the same generator against a fixture
`main.json` into `layout/`, the ready-made card, and `pnpm check` compares it.

## Cost

The mod is meant to cost almost nothing while nobody touches it.

- No timers for animation. Animations are Herdr's native `.transition`, `.loop`, `.frames` and `.spin`.
  `cx.timer` runs only the 5-second data round and the leader's 10-second stamp.
- Process memory is read only while the panel is open and at most every 30 seconds.
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

## Platforms

Everything that differs by OS is in `platform/`: process lists and memory (`tasklist` on Windows, `ps` on macOS
and Linux), file stat, the shell, and the path separator. Nothing in `core/` or `adapters/` names an OS.
CI runs the tests on Windows, macOS and Linux; the mod itself has been used on Windows only.

## Tests

Tests live in `test/`, run directly on the TypeScript with `node --test`, and use synthetic data only
(`test/adapters/synthetic.ts` builds transcripts that have the real record shapes but made-up text).
`test/runtime/sim.ts` is a simulated Herdr that the engine tests drive. `pnpm check` adds a build comparison
(the committed JavaScript must equal a fresh compile), a comparison of `layout/`, and the privacy scan.
