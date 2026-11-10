# Suspender

A mod for [Herdr App](https://herdr.dev) that puts idle Claude Code and Codex sessions to sleep and wakes them
in the same tab, even after Herdr or the whole computer has restarted.

![A sleeping tab: the last screen of the agent, dimmed, with a strip under it](preview.png)

An idle Claude Code session holds somewhere between 0.6 and 0.9 GB of memory. With seven projects open that
adds up, but closing the agent means losing track of where the conversation stood. Suspender takes a middle
road. You press Sleep, the agent exits cleanly, and its tab stays where it was: the last screen is still
there, dimmed, with a strip at the bottom that says what the session was (title, branch, model, folder) and a
Resume button. Press it and the same conversation continues in the same tab.

It also remembers across restarts. After Herdr or the PC comes back, tabs that had an agent show a strip and
wait for you. Nothing starts by itself.

## What you get

- **Sleep** from three places: a small pill that slides out over the tab, the button in the Sessions list, or
  a key. If the agent is in the middle of an answer, you get a choice: sleep when it is done, interrupt and
  sleep, or cancel.
- **Resume** on the strip of a sleeping tab. The strip shows each step (found session, starting, ready) and,
  if it fails, why, with a Retry button. Nothing retries by itself.
- **Sessions panel** on the right, like Files and Changes: every session of every project, grouped by space,
  with the memory each one freed or uses. "Resume all in project" wakes a whole space, one session at a time.
- **A popup on hover** over a strip or a row: first prompt, last reply, message count, context use, tokens,
  branch, model, folder and session id (both copyable).
- **Safe against double opening.** If the session is open somewhere else (another terminal, another program),
  Resume is disabled until it is closed there. Suspender never forks a conversation.
- **Honest about missing data.** If the conversation was deleted or expired, the strip says so and offers
  "Start new session" or "Forget". A field the agent does not store (tokens, context) is left out, not shown
  as zero.

It looks like part of Herdr because it only uses the theme's colors, Herdr's own fonts and native animations.
There are no redraw timers: in the idle state the mod starts no processes (measured over 60 seconds).

## Installing

If you use an agent with Herdr, tell it:

> Read ~/.config/herdr-app/AGENTS.md, then add this mod: herdr.dev/mods/fakie-dev/herdr-suspender

The agent copies `mods/suspender` into `~/.config/herdr-app/mods/`, merges `keys.json` into yours (asking
before it replaces a key you already use), runs `herdr-app check` on the mod and shows the result.

By hand it is the same thing: copy `mods/suspender` to `~/.config/herdr-app/mods/suspender`, add the keys from
`keys.json` to your own `keys.json`, and open Sessions with `Ctrl+Shift+S`.

For the whole window with the Sessions button and panel already in place there is a second card in this
repository, [`layout/`](layout/RECIPE.md): a layout and the mod together. The layout is also kept up to date
by the mod itself: it rebuilds `layouts/suspender.json` from Herdr's current `main.json` whenever that file
changes, so a Herdr update reaches you without cloning anything.

Without the layout the mod still works. Sleep and Resume work, sleeping tabs are restored, and Sessions opens
as a window. One difference: the restart check runs when a copy of the mod is first shown, and with the layout
that happens at once because the Sessions button is always on screen.

## Using it

| Key            | What it does                                                               |
| -------------- | -------------------------------------------------------------------------- |
| `Ctrl+Shift+S` | Opens or closes the Sessions panel (a window if you do not use the layout) |
| `Alt+Shift+S`  | Sleeps the agent in the focused tab, or resumes the focused sleeping tab   |

Both come from `keys.json` and can be changed there. Commands for your own bindings: `suspender.toggle-focused`,
`suspender.resume-all`, `suspender.forget`, `suspender.start-new`, and for the question dialog
`suspender.sleep-when-done`, `suspender.interrupt-and-sleep`, `suspender.cancel`.

Keys only reach a mod that is shown somewhere in the window. With the layout that is always so.

Sessions are stored in `~/.config/herdr-app/suspender/sessions.json`, outside the mod folder, so updating or
reinstalling the mod keeps them. Closing a sleeping tab or pressing Forget removes its entry; the agent's own
transcript is never touched.

## How it works

The short version: the agent is stopped politely (Claude Code: Esc, wait until idle, `/exit`; Codex: `/quit`;
after ten seconds the terminal is killed and the strip says so). A panel of the mod takes the terminal's place
in the layout, pixel for pixel, and shows the last screen that was saved. To wake it, Suspender checks that
the transcript still exists and that nobody else has the session open, starts a shell in the tab, types the
resume command into it (`claude --resume <id>` or `codex resume <id>`), and swaps the terminal in. After you
leave the agent, you are in a normal shell.

The session id is found without hooks: for Claude Code from `~/.claude/sessions/<pid>.json`, for Codex from
the first line of the newest rollout file for that folder. Terminals carry labels (`suspender.agent`,
`suspender.session`, `suspender.state`) so they survive a lost terminal, and the store keeps everything else.

[`docs/architecture.md`](docs/architecture.md) has the details and [`docs/adr/`](docs/adr) the reasons behind
the four decisions that shaped it.

### Adding an agent

An agent is one file in `src/adapters/` that implements `AgentAdapter` from `contract.ts`: how to recognize the
agent in a terminal, how to find its session id, how to read a transcript, how to stop it and how to resume
it. Add its id to `AgentId` in `src/core/model.ts` and one line to `src/adapters/index.ts`. The adapters see the
world only through `Ports`, so they are tested with in-memory files and no process runs. `claude.ts` and
`codex.ts` are the two examples.

### Adding a language

Every text the mod shows is in `src/i18n/en.ts`, behind `t(key, params)`. A translation is a file with the same
keys. What is missing is the choice of language: Herdr does not tell mods the locale yet, so `t` reads English
only. If you want to translate, open an issue and we will agree on how to pick the language (see the
[roadmap](ROADMAP.md)).

## Status

Tested on Windows. macOS and Linux should work, as nothing in the core is Windows-specific and the process and
path code sits in one module, but they have not been tried: testers are welcome, and CI runs the tests on all
three systems.

Claude Code has been tried by hand through sleep, resume, a session open elsewhere, a missing transcript, Forget
and Resume all. Recovery after a real reboot is covered by tests and has not been tried on a real restart yet. The Codex adapter is covered by tests on synthetic
rollout files; a full by-hand run on a real Codex session is still to be done.

Known limits: the strip cannot warn about unsent text in the prompt (neither adapter can see the prompt yet), and Codex has
no event for "closed elsewhere", so its check runs every five seconds while the strip is on screen.

## Developing

```
pnpm install
pnpm check      # biome, tsc, tests, fresh build, layout copy, privacy scan
pnpm build      # compiles src/ into mods/suspender/ and refreshes layout/
```

The compiled JavaScript in `mods/suspender/` is committed because Herdr runs plain JS, and `pnpm check` fails
if it is behind `src/`. After a change to the interface, run `herdr-app check mods/suspender` too. The agent
notes in [`AGENTS.md`](AGENTS.md) describe the folders.

## License

MIT.
