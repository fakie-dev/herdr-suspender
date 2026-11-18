# 17. Sessions that were running wake by themselves after a restart, one at a time

Status: accepted. Changes what a restart leaves behind in [ADR 3](0003-labels-and-store.md).

## Context

Until 0.1.6 a session whose terminal a restart took (the PC, or Herdr's core) became `interrupted` and waited
for its Resume button. The first brief asked for that: restoring "not fully automatically", so the person keeps
control. In use it meant pressing Resume in every tab after each reboot. The person changed the rule on
2026-11-18: «сделай чтобы сесии после перезагрузки запускались сразу», and on the details: «Всегда, приницип
такой: сессия спала? - после перезапуска спит. Сессия работала? - после перезапуска работает», by turns («По
очереди»), only the ones that were running («Только работавшие»), and «при запуске пользователь должен это
видеть, не должен иметь возможность пока идет запуск что-то запустить сам или натыкать, все должно быть по
умному, с защитой от дурака».

Starting every agent at once is costly: each Claude Code reads its whole transcript at start (tens of MB, up to
half a minute measured) and takes 0.3 to 0.5 GB.

## Decision

- When the engine sees a running session's terminal come back without its agent (`lostOnRestart`), the record
  becomes `interrupted` as before and is also marked `restore: true` in the store. Sessions asleep at the
  restart, and ones interrupted before it (a crash), are not marked and keep waiting for their button.
- The leader keeps a restore line: the marked sessions, the one in the tab on screen first, then in tab order.
  It wakes one with the ordinary Resume, and the next only once that one has returned: Resume returns when the
  agent is at its prompt, or failed. Whatever it ends in, the mark goes in the next round. A failed one keeps its
  error and its Retry.
- The line starts only once the restart is recognised: no running session left that this run has not seen in its
  terminal, and none whose terminal is in its grace. Otherwise a tab whose shell Herdr lists a moment later would
  lose its turn.
- While marked, nothing a person presses acts on the session: Resume, Retry, Forget, Start new and the keyboard
  commands return without doing anything, Resume all leaves it out, and its tab and row draw no buttons. Its tab
  says "Resumes after the restart by itself · 2 of 3", its row says "in line", Sessions shows which one of how
  many is waking, and one toast says how many sessions are being resumed.
- The marks are in the store, so a Herdr restart in the middle carries on with the rest.

## Consequences

- No setting: the person chose «Всегда» over a switch.
- A session that was `working` at the restart comes back at its prompt; its answer was cut off by the restart and
  is not repeated.
- Measured in an isolated core on Herdr 0.1.16 with two Claude Code sessions and `hc server stop`: the tab on
  screen was back within 5 s, and the other one started after it, interrupted, then waking, then running.
