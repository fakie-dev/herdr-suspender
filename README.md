# Suspender

A mod for [Herdr App](https://herdr.dev) that puts idle Claude Code and Codex sessions to sleep and wakes them
in the same tab, even after Herdr or the whole computer has restarted.

![A sleeping tab: the last screen of the agent, dimmed, with a strip under it](preview.png)

An idle Claude Code session holds somewhere between 0.6 and 0.9 GB of memory. With seven projects open that
adds up, but closing the agent means losing track of where the conversation stood. Suspender stops the agent
but keeps its tab. You press Sleep, the agent exits cleanly, and the tab stays where it was: the last screen
is still there, dimmed, with a strip at the bottom that says what the session was (title, branch, model,
folder) and a Resume button. Press it and the same conversation continues in the same tab.

It also remembers across restarts. After Herdr or the PC comes back, tabs that had an agent show a strip and
wait for you. Nothing starts by itself.

## What you get

You can put an agent to sleep from three places: a small pill that slides out over its tab, a button in the
Sessions list, or `Alt+Shift+S`. If the agent is in the middle of an answer, you choose: sleep when it is done,
interrupt it and sleep, or cancel.

The strip of a sleeping tab has Resume. While the agent starts, the strip shows each step (found session,
starting, ready); if the start fails, it says why and offers Retry. Nothing retries by itself.

With the layout, Sessions is the third button in the tab bar, right after Files and Changes and drawn the same
way (`+  Files  Changes  ☾ Sessions · 3  ─ □ ×`, the number counts sleeping sessions). Its list opens in the
same side panel, switches with Files and Changes, and each space remembers which one was open. It lists every
session of every project, grouped by space, with the memory each one freed or is using, and "Resume all in project" wakes a whole space one
session at a time. Hovering over a strip or a row opens a popup with the first prompt, the last reply, the
message count, context use, tokens, branch, model, folder and session id; the folder and the id can be copied.

A conversation is never opened twice. If the session is open somewhere else (another terminal, another
program), Resume stays disabled until it is closed there. If the conversation was deleted or has expired, the
strip says so and offers "Start new session" or "Forget". A field the agent does not store, such as tokens or
context, is left out rather than shown as zero.

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
by the mod itself. When the mod loads, and when `herdr-app check` runs on it, `layouts/suspender.json` is
created if it is missing (from a built-in copy of Herdr 0.1.14's `main.json`). The first copy of the mod that is
shown then rebuilds it from your live `main.json`, and again whenever that file or Herdr's version changes, so
a Herdr update reaches you without cloning any layout.

The Sessions button in the tab bar needs one copied mod. Herdr's tab bar is a shipped mod, and shipped mods
are not edited, so the mod makes its own copy with Herdr's `mod.clone`: `mods/suspender-tabs`. Its `main.js`
is Herdr's `tabs/main.js` with two small changes (Sessions added to the panels, and its button after Changes),
and its first line records which `tabs/main.js` it was made from. When a Herdr update changes the tab bar, the
next start writes the copy again from the new file. Herdr picks up whatever lands in `mods/` at once, so the new
file is first tried with `herdr-app check` in a folder of the mod's own (`suspender/tabs-check`), and only a file
that passed replaces the copy. If the changes no longer fit Herdr's tab bar, or the check fails, the copy stays
as it was, the layout goes back to Herdr's own tab bar with a Sessions button left of the tabs, and a short
notice says so.

Without the layout the mod still works. Sleep and Resume work, sleeping tabs are restored, and Sessions opens
as a window. One difference: the restart check runs when a copy of the mod is first shown, and with the layout
that happens at once because the Sessions button is always on screen.

## Using it

| Key            | What it does                                                               |
| -------------- | -------------------------------------------------------------------------- |
| `Ctrl+Shift+S` | Opens or closes the Sessions panel (a window if you do not use the layout) |
| `Alt+Shift+S`  | Sleeps the agent in the focused tab, or resumes the focused sleeping tab   |

Both come from `keys.json` and can be changed there. Commands for your own bindings: `suspender.panel` (what
`Ctrl+Shift+S` does in the layout), `suspender.toggle-focused`, `suspender.resume-all`, `suspender.forget`, `suspender.start-new`, and for the question dialog
`suspender.sleep-when-done`, `suspender.interrupt-and-sleep`, `suspender.cancel`.

Keys only reach a mod that is shown somewhere in the window. With the layout that is always so.

Sessions are stored in `~/.config/herdr-app/suspender/sessions.json`, outside the mod folder, so updating or
reinstalling the mod keeps them. Closing a sleeping tab or pressing Forget removes its entry; the agent's own
transcript is never touched.

If you bound `Ctrl+Shift+S` with an earlier version, your `keys.json` may still say
`{ "command": "layout.toggle", "args": { "id": "suspender-panel" } }` under `layout:suspender`. That column
exists only when the layout falls back to Herdr's own tab bar, so change it to `"suspender.panel"`, which works
both ways.

## Removing it

Herdr tells a mod nothing when its folder is deleted, so the mod cannot clean up after itself. Remove it in this
order:

1. Switch to another layout (`Ctrl+Shift+L`, or `herdr-app do layout.switch --name main`).
2. Delete `~/.config/herdr-app/layouts/suspender.json`.
3. Delete `~/.config/herdr-app/mods/suspender` and `~/.config/herdr-app/mods/suspender-tabs`.
4. Remove the `suspender.*` keys and the `layout:suspender` section from your `keys.json`.
5. If you want the saved sessions gone too, delete `~/.config/herdr-app/suspender/` (it also holds
   `tabs-check`, where the tab bar copy is tried before it is used).

Only `layouts/suspender.json` shows `suspender-tabs`, so no other layout gets a Sessions button that leads
nowhere. While the mod is installed it puts both back: the layout when it loads, the copy when one of its blocks
is shown. If you delete the mod folder but keep the layout and stay in it, the tab bar keeps a Sessions button
without its moon, and its panel says "suspender did not load" (seen on Herdr 0.1.15).

## How it works

Sleep stops the agent: Claude Code gets Esc, then Ctrl+C once it is idle, then `/exit`; Codex gets Ctrl+C and
`/quit`. Ctrl+C empties the prompt, so a half-typed message is dropped instead of going out with the exit
command. If the agent is still running ten seconds later, the terminal is killed and the strip says so. A panel
of the mod takes the terminal's place in the layout, pixel for pixel, and shows the last screen that was saved.
To wake it, Suspender checks that the transcript still exists and that nobody else has the session open, starts
a shell in the tab, types the resume command into it (`claude --resume <id>` or `codex resume <id>`), and
swaps the terminal in. After you leave the agent, you are in a normal shell.

The session id is found without hooks: for Claude Code from `~/.claude/sessions/<pid>.json`, for Codex from
the first line of the newest rollout file for that folder. Only a UUID is accepted as an id, because Resume
types it into a shell. Terminals carry labels (`suspender.agent`, `suspender.session`, `suspender.state`)
so they survive a lost terminal, and the store keeps everything else.

[`docs/architecture.md`](docs/architecture.md) has the details and [`docs/adr/`](docs/adr) the reasons behind
the five decisions that shaped it.

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

What has been tried by hand on Windows, with both agents in a throwaway folder:

- Claude Code: sleep and resume into the same conversation, the question for an agent that is answering, a
  session open elsewhere, a missing conversation with Start new session, Forget, Resume all, leaving with
  `/exit` (the shell stays), `claude.exe` killed from outside (the tab turns "interrupted" within about ten
  seconds, and Resume brings the conversation back), a draft left in the prompt at Sleep (the agent got only
  `/exit`), and Sleep pressed on two tabs within a second (both went to sleep).
- Codex: sleep and resume into the same conversation, "sleep when done", a session open elsewhere, a missing
  conversation with Start new session, Forget, Resume all skipping a session that is open elsewhere, `/quit`
  (no sleeping tab is made), and `codex.exe` killed from outside (interrupted).

Not tried by hand yet, covered by tests only: "updated after sleep" with Codex, a draft left in Codex's prompt,
and a real reboot of the PC.

One thing the mod cannot do: if an agent shows its own dialog when it starts (Codex asks about updates and about
trusting a new folder), the resumed agent waits behind that dialog until you answer it.

Known limits: Sleep does not warn about a draft in the prompt, it empties the prompt before the exit command.
Codex has no event for "closed elsewhere", so while its strip is on screen it is checked every five seconds.

## Developing

```
pnpm install
pnpm check      # biome, tsc, tests, fresh build, layout copy, privacy scan
pnpm build      # compiles src/ into mods/suspender/ and refreshes layout/
pnpm bench      # how fast a 50 MB transcript is read; kept out of check, where a busy machine fails it
```

The compiled JavaScript in `mods/suspender/` is committed because Herdr runs plain JS, and `pnpm check` fails
if it is behind `src/`. After a change to the interface, run `herdr-app check mods/suspender` too. The agent
notes in [`AGENTS.md`](AGENTS.md) describe the folders.

## License

MIT.
