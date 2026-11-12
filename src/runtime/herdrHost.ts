// `Host` on Herdr's live API. Never loaded by the tests.

import { focused, machines, notify, openOverlay, panes, run, setShared, shared, spaces, terminals } from "herdr";
import type { SessionKey } from "../core/model.ts";
import { MOD_NAME } from "./engine.ts";
import { type Host, type HostPane, type HostTerminal, normalizePane, normalizeTerminal } from "./host.ts";

/** The question for a working agent, as a small dialog. */
const CONFIRM_SIZE = { width: 440, height: 132 };

const present = <T>(value: T | null): value is T => value !== null;

function runCommand(command: string, args: Record<string, unknown>): void {
  try {
    run(command, args);
  } catch {
    // A command Herdr refuses shows its own toast; the engine checks the outcome itself.
  }
}

/**
 * `clock` is the copy's own task context (init's): valid across awaits, and
 * its waits stop when the copy closes.
 */
export function herdrHost(clock: { sleep(ms: number): Promise<void> }): Host {
  return {
    terminals: (): HostTerminal[] => terminals().map(normalizeTerminal).filter(present),
    panes: (): HostPane[] => panes().map(normalizePane).filter(present),
    tabs: () =>
      spaces()
        .filter((s) => s.machine === null)
        .flatMap((s) => s.tabs.map((tab) => ({ id: tab.id, space: s.id, active: tab.active, spaceActive: s.active }))),
    spaces: () =>
      spaces()
        .filter((s) => s.machine === null)
        .map((s) => ({ id: s.id, name: s.name, named: s.named })),
    ready: () => machines().find((m) => m.name === null)?.layout === "ready",
    focused: () => {
      const f = focused();
      return f === null ? null : { pane: f.pane, terminal: f.terminal };
    },
    run: (command, args) => {
      runCommand(command, args);
    },
    runOnScreen: (command, args) => {
      runCommand(command, args);
    },
    shared: (key) => shared(key),
    setShared: (key, value) => {
      setShared(key, value);
    },
    sleep: (ms) => clock.sleep(ms),
    notify: (text, level) => {
      notify({ title: text, level });
    },
    askConfirm: (key: SessionKey) => {
      openOverlay({ mod: MOD_NAME, props: { role: "confirm", key }, kind: "dialog", ...CONFIRM_SIZE });
    },
  };
}
