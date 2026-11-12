# Suspender

A mod that puts a Claude Code or Codex session to sleep, giving its memory back, and resumes it in the same
tab. A sleeping tab keeps its place and shows the agent's last screen, dimmed, with a strip at the bottom:
session title, branch, model, folder, and a Resume button. Press Resume and the same conversation continues.
After Herdr restarts or the computer reboots, tabs that had an agent show the same strip and wait for you to
restore them; nothing starts by itself. The Sessions panel shows every session in every space.

![Suspender](preview.png)

## What you see

**The strip of a sleeping tab.** It fills the tab where the agent's terminal was, to the pixel. The upper part
is the last screen the agent had, read once when it went to sleep and drawn in the terminal's monospace font at
30% opacity. The strip at the bottom is on the `chrome` background with a 1 px `border` line above it, padded
12 px left, 10 right and 8 top and bottom. First line, from the left: a 14 px moon in the `accent` color (the
`working` color when the session was interrupted by a restart), then the title in the foreground color and
semibold, then branch, model and folder in the `muted` color, each behind its own small icon, all at 12.5 px.
The buttons close the line, 28 px tall with a 7 px radius: Resume is filled with `solid` and its text in
`solid_foreground`, the others have a 1 px `border` and `muted` text; a disabled button uses `raised` and
`dim`. When the line is too narrow, items leave from the end, whole, and a `+N` badge counts them; the title
stays at least half the line. Under it, indented 24 px, a 12 px status line.

The status line under it says one of: `Asleep since 14:05`, `Interrupted by restart · 14:05`, `Stopped
forcefully, conversation kept`, `This session is open elsewhere — close it there to resume here`,
`Conversation no longer exists on disk`. A session that was changed while it slept adds `Updated after sleep ·
<time> · +N messages`.

**The Sessions button.** The third panel button of the tab bar, right after Files and Changes and before the
window buttons: `+  Files  Changes  ☾ Sessions · N  ─ □ ×`, N being the number of sleeping sessions. It is drawn
by the tab bar's own `panelButton`, so it matches Changes to the pixel: 26 px tall, 8 px padding, 5 px between
a 14 px moon and the 12 px label, radius 6, `muted` on `chrome`, `foreground` on `selected` while Sessions is the
open panel, `hover` under the pointer. A click opens the side panel on Sessions, or closes it when Sessions is
already open. The moon has the label's color; the tab bar tints every panel icon that way.

When that tab bar cannot be used (see Watch out), the button is a block of the mod's own, 110 px wide, left of
the tabs, looking the same, and the moon turns `accent` while N is above zero.

**The Sessions panel.** The side panel's third page, beside Files and Changes, in the same column (368 px in
Herdr 0.1.14): switching between the three keeps the column open, and each space remembers which page it had
open. With Herdr's own tab bar it is a column of its own on the right, 320 px wide (200 to 700), hidden until
opened. A header with
`Sessions` and the total memory freed (`4.0 GB memory freed`). Below it the spaces in upper case, each with a
`Resume all in project` link. Each session is two lines: the title and a state word (`running`, `asleep`,
`interrupted`, `open elsewhere`, `conversation gone`), then branch, model, folder and a short id, cut from the
end with a `+N` badge, and on the right the memory: the moon and `1.5 GB` for sleeping sessions (freed), a dot
and the figure for running ones (used). Within a space: running sessions, then sleeping, then interrupted.
Empty: `No agent sessions yet — start Claude Code or Codex in any tab`.

**The popup.** About 344 px wide, 350 ms after the pointer rests on a strip or row (60 ms when moving to a
neighbouring row, 180 ms to hide). It holds the title, the first prompt and the last reply (two lines each),
state and time, message count, branch, model, folder and session id (each with a copy button), context use as
a percentage and a bar, tokens, and memory. Facts the agent does not store are left out.

**The pill.** A floating drawer 28 px tall on the right edge of the tab area, 30 px of it peeking out: a moon
at rest, and on hover `Sleep · Claude Code` (11.5 px) for the agent in focus. Draggable; Herdr remembers where.
It draws nothing when no agent has focus.

**The question.** When you sleep an agent that is answering, a small dialog: `Claude Code is still answering`
with `Sleep when done`, `Interrupt and sleep`, `Cancel`.

## How it behaves

Agent statuses are not drawn by this mod; Herdr's own list shows them. A sleeping session is visible only in
Sessions, never in the Agents list.

**Sleep** (pill, row button, `Alt+Shift+S`): the last screen is saved, the agent is stopped (Claude Code: Esc,
wait up to 10 s for idle, Ctrl+C, `/exit`; Codex: Ctrl+C, `/quit`; if it is still alive 10 s later the terminal
is killed and the strip says so), a sleeping panel takes the terminal's slot in the layout, and the terminal is
closed. Ctrl+C empties the prompt, so a draft is dropped rather than sent with the exit command. The agent's
process and its shell are gone; memory is returned.

**Resume** (strip button, row button, `Alt+Shift+S` on a sleeping tab): checks that the transcript exists and
that no other process holds the session. Then it starts the default shell in a new terminal, types the
resume command into it (`claude --resume <id>`, `codex resume <id>`) in the original folder, checks with `hc
get` that Herdr started the shell it asked for, swaps it into the slot and closes the sleeping panel. The
strip shows `Found session`, `Starting`, `Ready` meanwhile. If the agent does not show up within 30 s, the strip
shows the reason and a Retry button; nothing is retried by itself. After you leave the agent you are in an
ordinary shell.

**Open elsewhere.** If another process has the session, Resume is disabled with the message above. It becomes
active as soon as the session is closed there: Claude Code is watched through its `sessions` folder; Codex is
checked every five seconds while the strip is on screen.

**Restart.** Terminals carry labels `suspender.agent`, `suspender.session` and `suspender.state` (`running` or
`exited`). A terminal that says `running` but holds no agent any more was interrupted by a restart: its strip
says so and waits. If there is any doubt the strip is shown and the agent is not started. An agent you left
yourself with `/exit` is marked `exited` and does not turn into a sleeping tab. An agent killed from outside
keeps the last status Herdr saw; when the terminal's title goes back to the shell's, one process list shows the
agent gone, and if its status is still on display a few seconds later the tab becomes interrupted. After
`/exit` the status goes out within that time, so the shell stays.

**Changed in the meantime.** If you used the session in another program while it slept, Resume continues the
latest state, and the strip says what changed (`Updated after sleep · <time> · +N messages`). That is read when
the tab is shown and right after the session is closed in the other place. Nothing watches the conversation
while the strip stays on screen, so work done elsewhere shows up the next time the tab is shown.

**Gone.** If the transcript is gone, the strip offers `Start new session` (a new agent in the same folder) and
`Forget`. `Forget`, or closing a sleeping tab, deletes the store entry and leaves the transcript alone.

**Resume all in project** wakes the sleeping and interrupted sessions of one space, one after another, and skips
those open elsewhere with a notice.

**Cost.** No redraw timers. Memory of running processes is read only while the panel is open and at most every
30 s. A transcript is read only when a session goes to sleep, when its strip is shown, and right after the
session is closed elsewhere, each time only if the file changed. A Codex whose session is not known yet is
looked up in the process list only when its terminal changes, and on Windows at most once a minute.

## Built from

One mod, `mods/suspender` (`main.js`, `mod.json`, `icons/*.svg`, compiled from `src/`), with one View whose
copy is chosen by `props.role`: `toggle` (our own button, only without the tab bar copy), `panel` (the list),
`pill`, `sleep` (a sleeping tab,
`props.key` is the session key), `confirm` (the question, an overlay), `popup`, and `window` (the list in a
window, also what `mod.open` gives with no role). `mod.json` is `{"place": "none", "title": "Sessions",
"overlay": {"kind": "window", "key": "suspender", "width": 400, "height": 560}}`: `place: none` keeps Herdr
from docking a copy by itself.

The layout it needs is [`layout/`](layout/RECIPE.md); the mod writes `layouts/suspender.json` itself: it creates the file
when the mod loads or `herdr-app check` runs (from a built-in copy of Herdr 0.1.14's `main.json`), and the first
shown copy rebuilds it from the live `layouts/main.json`, again whenever that changes. No layout is cloned.

The tab bar is a copy of the shipped `tabs` mod, `mods/suspender-tabs`, made by the mod with
`mod.clone {name: "tabs", as: "suspender-tabs"}` the first time a copy of the mod is shown. Its `main.js` is
the shipped `tabs/main.js` with paths left as they are (the window-button icons stay `mods/tabs/...`) and two
changes, each at an anchor that must occur exactly once:

1. `const enabled = shared("workspace.panels") ?? ["files", "changes"];` becomes
   `const enabled = [...(shared("workspace.panels") ?? ["files", "changes"]), "suspender"];`
2. before `.when(w?.buttons,` goes
   `.child(panelButton("suspender", String(shared("suspender.tabLabel") ?? "Sessions"), "mods/suspender/icons/moon.svg"))`

The first line is `// suspender-tabs: from tabs/main.js sha256=<sha of the shipped file> patch=1`. On every load
the mod builds the patch of the current shipped file and runs `herdr-app check` on it in
`<app home>/suspender/tabs-check/suspender-tabs` (the patched `main.js` and the shipped `mod.json`), outside
`mods/`, because Herdr reloads anything written under `mods/` and would show it at once. Only when that passes
does it write the copy, and only when the copy differs. Only `main.js` is ever written: the copy's other files
stay as `mod.clone` made them. In the layout the `tabs` block shows `suspender-tabs` instead of `tabs`, and
the side panel stack `panel-body` gets a third child, `{id: "suspender", content: {mod: "suspender", props:
{role: "panel"}}}`; `suspender_generated.tabs` records which tab bar the layout was built for (`clone` or
`builtin`). The label comes from the engine as the shared value `suspender.tabLabel`, set only when its text
changes (every set redraws every mod).

Herdr calls it makes: `pane.split` (with `mod` and `props`), `pane.swap`, `pane.close`, `terminal.kill`,
`tab` and `terminal` reads, `shared` values (`suspender.leader`, `suspender.rev`, `suspender.progress`,
`suspender.tabLabel`), `watchFolder`, `writeTextFile` with an expected value, `openOverlay`, `mod.clone`,
`layout.select`, `layout.show`, `layout.hide`, `layout.toggle`, and `hc` (`get`, `read`, `label`, `keys`, `run`).
Commands: `suspender.panel`, `toggle-focused`, `resume-all`, `forget`, `start-new`, `sleep-when-done`,
`interrupt-and-sleep`, `cancel`. Programs it starts: `hc`, `herdr-app check` on the tab bar copy once per load;
for process memory and liveness on Windows `tasklist`
and `robocopy /L` (file size and time), on macOS and Linux `ps` and `stat`; PowerShell only in rare cases of
ambiguity. It reads `~/.claude/projects`, `~/.claude/sessions`, `~/.codex/sessions` and Herdr's
`layouts/main.json` and `mods/tabs/main.js`. It writes three files: `~/.config/herdr-app/suspender/sessions.json`,
`~/.config/herdr-app/layouts/suspender.json`, which it creates when missing and rebuilds when `main.json` or
Herdr's version changes, and `~/.config/herdr-app/mods/suspender-tabs/main.js`. No network.

One of the copies of the mod leads (a `suspender.leader` stamp, taken over after 15 s of silence): it binds
sessions to terminals and recognizes restarts; the others only draw.

Keys, merged into `keys.json`: `Ctrl+Shift+S` opens the Sessions window (`mod.open:suspender`, `global`) or, in
the `suspender` layout, opens and closes the panel (`suspender.panel`: the side panel on Sessions with the tab bar
copy, our own column without it); `Alt+Shift+S` is `suspender.toggle-focused`. A `keys.json` from an earlier
version may still bind `Ctrl+Shift+S` under `layout:suspender` to
`{ "command": "layout.toggle", "args": { "id": "suspender-panel" } }`. That column exists only when the layout
falls back to Herdr's own tab bar, so replace it with `"suspender.panel"`, which works in both.

## Watch out

Herdr gives a mod its props through `props()`, not through `init`. `Buffer` does not decode text and
`fs/promises` has no `stat` and no partial read, so transcripts are read whole and sized with a spawned
`stat`. `hc send` wraps text in a `<hc from=...>` tag when `HC_TERMINAL_ID` is inherited, so stop commands are
typed with `hc keys`. From Git Bash `--argv` is changed by the shell: pass arguments as one JSON object.
After starting an agent check with `hc get` that the command that runs is the one you asked for.

Always do the whole `split`, `swap`, `close` sequence; without the swap the closed pane's share goes to a
neighbour. Insert the sleeping panel before stopping the agent and close the terminal last.

Keys reach only a mod that is shown somewhere in the window. The restart check runs when the first copy of the
mod is shown. Every shown copy gets a key's command, once each, so `suspender.panel` acts once per press: a
copy that has not had the current press yet is getting that one, and a copy that has had it is getting the next
press. Two quick presses open and close.

The tab bar copy falls back to Herdr's own tab bar, with the mod's button left of the tabs and its own column,
when the shipped `tabs/main.js` is missing, an anchor is gone or there twice, `mod.clone` makes nothing within
5 s, a `suspender-tabs` is there that is neither a clone of `tabs` nor ours, the write keeps being refused, or
`herdr-app check` of the new text fails or cannot run (the copy is then left as it was). One toast says `Sessions moved left of the tabs` (a toast title is cut
at about 280 px). Two copies of the mod writing the copy at once is normal: a refused write is read back, and
if it already holds the patch that counts as done. There is one check per load for the whole window; a check
whose copy of the mod closed half way is started again, but never while its `herdr-app check` may still be
running (before that check's 60 s timeout has passed). Put the button right of the tab bar block and it lands
after the window buttons.

Herdr has no uninstall hook. Removing the mod means switching layouts first, then deleting
`layouts/suspender.json`, `mods/suspender` and `mods/suspender-tabs`, and taking the `suspender.*` keys and the
`layout:suspender` section out of `keys.json`. The saved sessions are in `<app home>/suspender/`, which also
holds `tabs-check`; delete it only if they should go too. The order matters: while the mod is installed it puts
both files back (the layout when it loads, the copy when one of its blocks is shown). Only
`layouts/suspender.json` shows `suspender-tabs`, so no other layout gets a Sessions button that leads nowhere,
but a layout left pointing at the copy keeps a Sessions button without its moon whose panel says the mod did
not load (seen on Herdr 0.1.15).

Limits: Claude Code and Codex only. Sleep does not warn about a draft in the prompt; it empties the prompt before
the exit command. The text of the last screen is the screen at the moment of sleep, not a live view. The UI is
English only; all texts are in `src/i18n/en.ts`.

## Done when

- After Sleep, `hc ls` shows no process of that tab's agent, and a panel of the same size is in its place.
- The strip shows the title, branch, model and folder from the transcript, and Resume.
- Resume brings the same conversation back in the same tab: the agent knows what was said before.
- With the session open in another terminal, Resume is disabled and says why; closing that terminal enables it.
- With the transcript renamed away, Resume turns into `Conversation no longer exists on disk`, `Start new
  session` opens a new agent in the same folder, `Forget` removes the entry.
- Sleeping an agent that is answering asks first; `Sleep when done` sleeps it after the answer.
- `Forget`, or closing a sleeping tab, removes its entry from `sessions.json`.
- Sessions groups by space, shows freed memory, and `Resume all in project` skips a session that is open
  elsewhere.
- The tab bar reads `+ Files Changes ☾ Sessions · N ─ □ ×`; the Sessions button's height, background, text color
  and corners match Changes pixel for pixel; Files, Changes and Sessions switch the same side panel, and each space
  reopens the page it had.
- After a change to the shipped `tabs/main.js`, the copy's first line carries the new sha; with an anchor
  removed the layout shows Herdr's own tab bar with the button left of the tabs and one toast.
- `herdr-app check mods/suspender` passes and with the panel closed and the strips idle the mod starts no
  process in 60 seconds.
