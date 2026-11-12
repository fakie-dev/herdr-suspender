# Suspender

A mod for [Herdr App](https://herdr.dev) that puts idle Claude Code and Codex sessions to sleep and wakes them
in the same tab later, even after Herdr or the whole computer has restarted.

![Suspender in Herdr: the Sessions panel next to Files and Changes, a session's details and a sleeping tab with Resume](preview.png)

An idle Claude Code session holds 0.6 to 0.9 GB of memory, and with seven projects open that adds up. Closing
the agent gets the memory back but loses your place. Suspender stops the agent and keeps the tab: the last
screen stays there, dimmed, with a strip that says what the session was and a Resume button that picks up the
same conversation.

- **Sleep** from a pill on the edge of the tab, from the Sessions list or with `Alt+Shift+S`. If the agent is
  in the middle of an answer, you choose: wait for it, interrupt it, or cancel.
- **Resume** continues the same conversation in the same tab, and never opens one that is already open
  somewhere else.
- **Restarts are covered.** When Herdr or the PC comes back, tabs that had an agent show the strip and wait
  for you. Nothing starts by itself.
- **Sessions** lists every session of every project with the memory it freed or uses, and wakes a whole
  project with one click. Hover a row to see the first prompt, the last reply, context use and tokens.

It draws with your theme's colors and Herdr's own animations, and while idle it starts no processes.

## Install

There are two ways to have it. **The mod alone** gives you Sleep, Resume, tabs restored after a restart, and
Sessions as a separate window. **The mod with its layout** is Herdr's standard window plus a Sessions button in
the tab bar right after Files and Changes, the list in the same side panel, and the Sleep pill. The layout is
the one to pick: the keys always work in it (without it they reach the mod only while a sleeping tab or the
Sessions window is on screen), and it follows Herdr updates by itself.

The easy way is to ask your agent in Herdr:

> Read ~/.config/herdr-app/AGENTS.md, then add this layout: herdr.dev/layouts/fakie-dev/herdr-suspender--layout

For the mod alone, say `add this mod: herdr.dev/mods/fakie-dev/herdr-suspender` instead. If the cards are not
in the catalog yet, give the agent the GitHub folder: `github.com/fakie-dev/herdr-suspender/tree/main/layout`
for the layout, `github.com/fakie-dev/herdr-suspender` for the mod. It copies the files, merges the keys
(asking before it replaces one you already use) and checks the mod.

By hand:

1. Copy `mods/suspender` from this repository into `~/.config/herdr-app/mods/`.
2. Add the keys from [`keys.json`](keys.json) to your `~/.config/herdr-app/keys.json`.
3. Run `herdr-app check ~/.config/herdr-app/mods/suspender`. Once loaded, the mod adds the Suspender layout.
4. To use the layout, press `Ctrl+Shift+L` until it shows, or run `herdr-app do layout.switch --name suspender`.

## Use

| Key            | What it does                                                                   |
| -------------- | ------------------------------------------------------------------------------ |
| `Ctrl+Shift+S` | Opens or closes Sessions: the side panel in the layout, a window anywhere else |
| `Alt+Shift+S`  | Sleeps the agent in the focused tab, or resumes the focused sleeping tab       |

Both live in `keys.json`. To bind your own, the commands are `suspender.panel`, `suspender.toggle-focused`,
`suspender.resume-all`, `suspender.forget`, `suspender.start-new`, and for the question about an agent that is
still answering `suspender.sleep-when-done`, `suspender.interrupt-and-sleep`, `suspender.cancel`.

Sessions are saved in `~/.config/herdr-app/suspender/sessions.json`, outside the mod folder, so updating the
mod keeps them. Closing a sleeping tab or pressing Forget removes its entry; the agent's own transcript is never
touched.

## Remove

Herdr tells a mod nothing when its folder is deleted, so the mod can't clean up after itself. Do it in this
order, or the mod puts its files back:

1. Switch to another layout with `Ctrl+Shift+L`.
2. In `~/.config/herdr-app`, delete `layouts/suspender.json`, `mods/suspender` and `mods/suspender-tabs`.
3. Remove the `suspender.*` keys and the `layout:suspender` section from your `keys.json`.
4. If you want the saved sessions gone too, delete `~/.config/herdr-app/suspender/`.

## More

[RECIPE.md](RECIPE.md) and [layout/RECIPE.md](layout/RECIPE.md) are the full briefs an agent installs or
rebuilds the mod and the layout from. [docs/architecture.md](docs/architecture.md) explains how sleep, wake,
restarts and the self-updating layout work, and [docs/adr/](docs/adr) holds the reasons behind the main
decisions. What comes next is in the [roadmap](ROADMAP.md), what changed in the [changelog](CHANGELOG.md).

Tested on Windows. macOS and Linux should work and CI runs the tests on all three, but nobody has tried the mod
there yet, so reports are very welcome.

To work on it: `pnpm install`, then `pnpm check`. [AGENTS.md](AGENTS.md) describes the folders and the rules.
Adding an agent takes one file in `src/adapters/`, see [Adding an agent](docs/architecture.md#adding-an-agent).

## License

MIT.

The icons in the preview images (the moon-and-stars mark, the puzzle piece, the prompt and the code
brackets) come from [Phosphor Icons](https://phosphoricons.com) (MIT), recoloured.
