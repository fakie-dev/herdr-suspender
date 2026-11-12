# 12. Updates by button, swapped in as one folder

Status: accepted.

## Context

People asked to hear when a new version is out and to update with one click, provided nothing else of theirs
is touched: not `keys.json`, `settings.json`, layouts, other mods, the sessions, nor a mod they changed by hand.
Herdr's own rules for installing a mod say the person is told when a mod reaches the network or runs programs.

What the platform gives a mod, measured on Herdr 0.1.15 in an isolated core:

- `fetch` returns text only (`text()`, `json()`; no bytes), so a release can come as its text files and not as an
  archive. GitHub's API answers 403 "Request forbidden by administrative rules" to Herdr's `fetch` without a
  `User-Agent`; with one it answers 200. raw.githubusercontent.com needs none. A refused connection rejects.
- `fs/promises` has `readdir` (with types), `mkdir`, `writeFile`, `unlink`, `rmdir` and `exists`, and no `rename`.
  A folder is renamed by a program.
- Herdr reloads a mod as soon as anything under its folder changes, and the reload ends the old build's tasks.
  A mod that renamed its own folder away and another one in, from one PowerShell run started by `exec`: the new
  build loaded about 0.6 s after the press, and the task that started the run never heard back. With a 2 s gap
  between the two renames, Herdr reported "does not exist" in `herdr-app status`, kept the old build running
  (and its task did hear back), then loaded the new one.
- Renaming the real `mods/suspender` while its panel, tab bar button and pill were on screen: no file was locked,
  each rename took 30 to 60 ms, Herdr showed no error and drew the new build.
- A rename of a folder that a process holds (its current folder inside it) fails on Windows. Tested on real
  folders in `test/update/swap.test.ts`.
- `herdr-app` is on the `PATH` that `exec` uses; a missing program rejects ("program not found").
- `import.meta.url` is undefined, so a mod cannot learn its own folder.
- The script's own sha256 (`core/sha256.ts`) took 450 ms for `engine.js` (84 KB) in Herdr's runtime, and hashing
  every file at once ended the task silently. `crypto.createHash("sha256")` gives the same digest, non-ASCII text
  included, in under a millisecond.

## Decision

**The check.** At most once a day, and never in the first 30 s after a load (a `herdr-app check` run loads the
mod too, and is over long before), one GET of `api.github.com/repos/fakie-dev/herdr-suspender/releases/latest`.
The releases API rather than the tag list: it names only published, non-draft, non-pre-release versions, so a tag
pushed before its release is written is not offered. Its `tag_name` must parse as three numbers and is compared
as numbers. The time and the answer go to `<app home>/suspender/update.json`, beside the sessions; writes are
conditional, so one copy in one window claims each day and each announcement. A failed request says nothing and
the next day asks again. A newer version gets one toast, once per version, whose click opens Sessions, and a
line at the top of Sessions with What's new (the release page in the browser) and Update. The switch at the
bottom of Sessions turns the check off; off means no request at all. Every URL is built in `core/release.ts` from
constants: the version must parse, a file path must be a plain relative path of a `.js`, `.json` or `.svg`.

**The manifest.** `mods/suspender/manifest.json` lists every file of the mod with the sha256 of its text (LF line
endings), the version and the key snippet from `keys.json`. `pnpm build` writes it and `pnpm check` fails when it
is stale, so every tag carries a current one with no extra release step. It is fetched raw from the tag, beside
the files, rather than as a release asset: an asset is a second upload that can be forgotten or differ from the
tag. The manifest is not a signature; it proves that what was downloaded is whole and is what the tag holds,
and the installed copy proves the install was not changed.

**The update.** Refused, with nothing fetched, when `mods/suspender/manifest.json` is not this mod at this
version (a copy renamed for a name clash, another mod or another version in that folder), or when any file
differs from it, is missing, or was added (an edit; files Herdr writes beside a mod do not count). Otherwise the
release's manifest and files are fetched from its tag, six at a time, and the first file whose hash differs, a
failed request or a refused write cancels it and removes the staging folder. The files go to
`<app home>/suspender/update/staging/suspender`: outside `mods/`, because Herdr loads whatever lands there, and on
the same disk as `mods/`, so the swap is a rename and not a copy (a temp folder may be on another disk). The
staged folder must pass `herdr-app check`; without `herdr-app` the update is refused rather than installed
unchecked. One process then renames `mods/suspender` to `.../update/backup/suspender` and the staged folder to
`mods/suspender`, and renames the old one back if the second rename fails. Each rename is retried for two seconds
when something holds the folder. Herdr therefore sees the whole old folder, no folder for a few milliseconds
(and keeps the loaded build), or the whole new one. Before the swap the job is written to `update.json`; the old
task may be ended by the reload, so whichever comes first, that task or the new build loading, records the
outcome and shows the success toast, once. A swap whose answer is lost is judged by the version in
`mods/suspender` afterwards. Roll back is the same swap the other way, and the version it replaces is removed.

New keys in the release are never written to `keys.json`: the toast says there are some and the Sessions line
names them.

**`mods/suspender-tabs`** is not part of the update. It is the mod's living copy of Herdr's tab bar, rewritten
from Herdr's own `tabs/main.js` by whichever build loads (ADR 5), and only after `herdr-app check` passed; a new
build with a new patch rewrites it the same way as after a manual update, and a rollback writes the older patch
back. The layout is rebuilt as usual when the generator or Herdr changed.

## Consequences

- The network is one request a day to api.github.com, and on Update about 60 small requests to
  raw.githubusercontent.com. Programs: `herdr-app check` and one PowerShell (`sh` elsewhere) per update or rollback,
  and the browser for What's new.
- 0.1.2 and older have no updater; the button works from the first release that has it.
- Rolling back to a version without the updater shows no "back on" toast (that version cannot say it); the folder
  is swapped all the same.
- Only one backup is kept: an update removes the previous one.
- An update another window started holds the button for up to ten minutes, and so does a task Herdr ended
  mid-update; after that the job is taken for dead and its staging is removed.
- `herdr-app check` of the staged folder loads the new build once, which may rebuild `layouts/suspender.json` with
  the new generator before the swap. If the update is then cancelled, the old build rebuilds it back on its next
  round (ADR 2).
- The manifest holds only text files: `pnpm check` fails on a file the button could not install.
