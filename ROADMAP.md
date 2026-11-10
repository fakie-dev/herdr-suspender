# Roadmap

What is planned, roughly in the order it will happen. Nothing here is a promise with a date. If one of these
matters to you, open an issue and say so: that is how the order gets decided.

## Next

**OpenCode.** The first agent after the two we have. An adapter is one file (see "Adding an agent" in the
README), and OpenCode keeps its sessions in a place we can read without hooks.

**Other popular agents**, in no fixed order: Gemini CLI, Copilot CLI, Cursor CLI, Qwen Code, Amp, Kiro. Each
needs three things worked out before its adapter is worth writing: where it stores a session, how to resume
one by id, and how to stop it without losing the conversation.

**macOS and Linux confirmation.** The code is written for all three systems and CI runs the tests on them, but
the mod has only been used on Windows. Reports of what works and what does not are the most useful thing
anyone can send right now.

## Later

**Translations.** Every text is already in one file, `src/i18n/en.ts`. What is missing is the choice of
language, because Herdr does not tell mods the locale. Once there is a way to ask (or a setting of our own), a
translation will be a file with the same keys.

**Automatic sleep.** Putting a session to sleep after it has been idle for a while. Two shapes are possible:
a setting with a time, or a notification that offers Sleep and does nothing on its own. Which one comes first
depends on how people use the mod; the notification is the safer start. Nothing sleeps by itself today, on
purpose.

**Warn about unsent input.** If the prompt holds text that was typed but not sent, say so before sleeping.
Neither adapter can see the prompt yet.

## Waiting on Herdr

**An official extension API.** The Sleep pill, the Sessions button and the generated layout exist because a
mod cannot add a button to a pane header or to the tab strip. Herdr has open requests for this
([herdr-app #246](https://github.com/herdrdev/herdr-app/issues/246) and
[#520](https://github.com/herdrdev/herdr-app/issues/520)). When it lands, Sleep moves into the pane header,
and the layout card may no longer be needed.
