// The mod's one view. `props().role` says which copy this is: "sleep" (a
// sleeping tab, `props.key`), "confirm" (the question for a working agent),
// "popup" (the facts of a session, over a row or a strip), and "toggle" |
// "panel" | "pill" | "window" (the Sessions button, list and sleep pill, each
// drawn by its own module; no role at all is the window `mod.open` makes).
// Every copy runs an engine: one of them leads (binds sessions, recognises a
// restart), and whichever copy a person presses a button in carries the
// action out. Every copy that stays (not a popup or a dialog) also keeps
// layouts/suspender.json fresh against Herdr's main.json, and so does loading
// the module itself: Herdr loads it as soon as it sees the mod's folder (and
// `herdr-app check` does), so installing the mod is enough for the layout.
// The first such copy also makes sure the live copy of the tab bar
// (`mods/suspender-tabs`, runtime/tabsClone.ts) is right, and the layout is
// built around it, or around Herdr's own tab bar when the copy cannot be used.

import { type AsyncContext, type Context, div, type Element, View } from "gpui-kit";
import { appHome, props as herdrProps, layout, nextCommand, notify, run, updates, writeTextFile } from "herdr";
import { buildLivingLayout, LAYOUT_NAME, sessionsToggle } from "./core/layout.ts";
import type { SessionKey } from "./core/model.ts";
import { SHIPPED_MAIN, SHIPPED_MAIN_VERSION } from "./core/shippedMain.ts";
import { herdrPorts } from "./platform/ports.ts";
import { type Choice, Engine, newCoordinator, TICK_MS } from "./runtime/engine.ts";
import { herdrHost } from "./runtime/herdrHost.ts";
import { syncLayout } from "./runtime/layoutSync.ts";
import { CLONE_NAME, type TabsOutcome, tabsKeeper } from "./runtime/tabsClone.ts";
import { PanelView } from "./ui/panel.ts";
import { PillView } from "./ui/pill.ts";
import { PopupView } from "./ui/popup.ts";
import { ConfirmDialog, SleepPane } from "./ui/sleepPane.ts";
import { ToggleView } from "./ui/toggle.ts";

/** The question's answers as commands (`suspender.sleep-when-done`, …), for keys. */
const CHOICES: Readonly<Record<string, Choice>> = {
  "sleep-when-done": "sleepWhenDone",
  "interrupt-and-sleep": "interruptAndSleep",
  cancel: "cancel",
};

/** Shared by the copies of this build in this window (one module instance). */
const coordinator = newCoordinator();

/** Herdr versions the layout sync already warned about, shared by the copies of this window. */
const layoutWarned = new Set<string>();

/** The running Herdr's version, if it says. */
function herdrVersion(): string | null {
  try {
    return updates().app.version;
  } catch {
    return null;
  }
}

/**
 * Builds or refreshes layouts/suspender.json from Herdr's main.json, around
 * the tab bar the layout has; never throws (the layout is a convenience).
 */
async function keepLayout(toast: (text: string) => void): Promise<void> {
  try {
    await syncLayout({
      ports: herdrPorts(),
      appHome: appHome(),
      herdrVersion: herdrVersion() ?? "",
      toast,
      warned: layoutWarned,
    });
  } catch {
    // The mod works without its layout.
  }
}

/** The tab bar copy and the layout around it, for the copies of this window (made when one first shows). */
let keepTabs: ReturnType<typeof tabsKeeper> | null = null;

function tabsAndLayout(sleep: (ms: number) => Promise<void>, toast: (text: string) => void): Promise<TabsOutcome> {
  keepTabs ??= tabsKeeper({
    ports: herdrPorts(),
    appHome: appHome(),
    cloneMod: () => {
      run("mod.clone", { name: "tabs", as: CLONE_NAME });
    },
    herdrVersion: () => herdrVersion() ?? "",
    warned: layoutWarned,
    now: () => Date.now(),
  });
  return keepTabs(sleep, toast);
}

/**
 * The copies of one press arrive together. A press this old is over even for
 * the copies it never reached (they were not shown then), so a copy that only
 * came on screen since then does not take the next press for a copy of it.
 */
const PRESS_SPREAD_MS = 250;

/** The press of `suspender.panel` being handed out: the copies it has reached, and when the first one got it. */
let press: { copies: Set<string>; at: number } | null = null;

/**
 * The command `suspender.panel`, as copy `copy` received it: opens or closes
 * Sessions, the way its button in this layout does. Herdr hands each press to
 * every shown copy, once each: a copy that has not had the current press yet
 * is getting that press, and one that has had it is getting the next one. So
 * one press acts once however many copies are shown, and the second of two
 * quick presses still acts.
 */
export function togglePanel(copy: string): void {
  const now = Date.now();
  if (press !== null && !press.copies.has(copy) && now - press.at < PRESS_SPREAD_MS) {
    press.copies.add(copy);
    return;
  }
  press = { copies: new Set([copy]), at: now };
  for (const step of sessionsToggle(layout())) {
    run(step.command, step.args);
  }
}

/**
 * A layout when there is none yet, with nothing to wait for: built from the
 * main.json this Herdr ships, written at once and only if the file is absent.
 * `herdr-app check`, which installing the mod runs, lands this write and no
 * read (measured), so a clean install gets its layout. Settles when the
 * write does (landed or refused), so the rebuild from the main.json the person
 * really has comes after it and is not refused by it.
 */
function seedLayout(): Promise<unknown> {
  try {
    const built = buildLivingLayout(SHIPPED_MAIN, herdrVersion() ?? SHIPPED_MAIN_VERSION);
    if (built.ok) {
      const path = [appHome(), "layouts", `${LAYOUT_NAME}.json`].join(herdrPorts().sep);
      return writeTextFile(path, `${JSON.stringify(built.layout, null, 2)}\n`, null).catch(() => null);
    }
  } catch {
    // The mod works without its layout.
  }
  return Promise.resolve();
}

// On load, with no copy on screen yet (a clean install has no layout that shows one).
void seedLayout().then(() =>
  keepLayout((text) => {
    try {
      notify({ title: text, level: "warning" });
    } catch {
      // No window to show it in (a check run): the next copy that shows says it.
    }
  }),
);

const copyId = (): string => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

interface Props {
  role?: unknown;
  key?: unknown;
  overlay?: unknown;
  usedMb?: unknown;
}

export default class Suspender extends View {
  private engine: Engine | null = null;
  private sleep: SleepPane | null = null;
  private confirm: ConfirmDialog | null = null;
  private popup: PopupView | null = null;
  private panel: PanelView | null = null;
  private toggle: ToggleView | null = null;
  private pill: PillView | null = null;

  override init(_props: unknown, cx: AsyncContext): void {
    // Herdr hands the block's props through props(), not through init's argument.
    const raw: unknown = herdrProps();
    const props = (typeof raw === "object" && raw !== null ? raw : {}) as Props;
    const host = herdrHost(cx);
    const ports = herdrPorts();
    // Beside the layouts it belongs with: another HERDR_APP_HOME is another window with its own sessions.
    const storePath = [appHome(), "suspender", "sessions.json"].join(ports.sep);
    const id = copyId();
    const engine = new Engine({ host, ports, id, coordinator, storePath });
    this.engine = engine;
    const key = typeof props.key === "string" ? (props.key as SessionKey) : null;
    if (props.role === "sleep" && key !== null) {
      this.sleep = new SleepPane(engine, host, ports, key);
    } else if (props.role === "confirm" && key !== null) {
      this.confirm = new ConfirmDialog(engine, key, typeof props.overlay === "string" ? props.overlay : null);
    } else if (props.role === "popup" && key !== null) {
      const used = typeof props.usedMb === "number" ? props.usedMb : null;
      this.popup = new PopupView(engine, ports, key, typeof props.overlay === "string" ? props.overlay : null, used);
    } else if (props.role === "toggle") {
      this.toggle = new ToggleView(engine);
    } else if (props.role === "pill") {
      this.pill = new PillView(engine, host);
    } else if (props.role === "panel") {
      this.panel = new PanelView({ engine, host, ports, mode: "panel", overlay: null });
    } else if (props.role === "window" || props.role === undefined) {
      // `mod.open` gives no role: the Sessions list in a window of its own.
      const overlay = typeof props.overlay === "string" ? props.overlay : null;
      this.panel = new PanelView({ engine, host, ports, mode: "window", overlay });
    }

    if (this.popup === null && this.confirm === null) {
      cx.spawn(async (cx) => {
        const toast = (text: string): void => host.notify(text, "warning");
        await tabsAndLayout((ms) => cx.sleep(ms), toast);
      });
    }

    // Redraw only for news: a write in this window already redraws every copy
    // (it sets a shared value); a round redraws when it read another window's.
    const round = async (cx: AsyncContext): Promise<void> => {
      const before = engine.revision();
      await engine.tick();
      this.sleep?.tick(cx);
      this.panel?.tick(cx);
      if (engine.revision() !== before) {
        cx.notify();
      }
    };
    cx.spawn(round);
    cx.timer.every(TICK_MS, (cx) => {
      cx.spawn(round);
    });
    // Each command is taken as it comes and carried out on its own task: a copy
    // still busy with the last one (a Sleep takes seconds) must not pick a
    // press up late, after the window that dedupes one press across copies
    // has passed, and run it on whatever has the focus by then.
    cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();
        if (this.confirm !== null && command in CHOICES) {
          this.confirm.answer(CHOICES[command] ?? "cancel");
          cx.notify();
          continue;
        }
        cx.spawn(async (cx) => {
          if (command === "panel") {
            togglePanel(id);
          } else if (command === "toggle-focused") {
            await engine.toggleFocused();
          } else if (command === "resume-all") {
            await engine.resumeAllShown();
          } else if (command === "forget") {
            await engine.forgetFocused();
          } else if (command === "start-new") {
            await engine.startNewFocused();
          }
          cx.notify();
        });
      }
    });
  }

  override render(cx: Context): Element {
    if (this.sleep !== null) {
      return this.sleep.render(cx);
    }
    if (this.confirm !== null) {
      return this.confirm.render(cx);
    }
    return (
      this.popup?.render(cx) ?? this.panel?.render(cx) ?? this.toggle?.render(cx) ?? this.pill?.render(cx) ?? div()
    );
  }

  override close(_cx: AsyncContext): void {
    this.confirm?.close();
    this.popup?.close();
    this.engine?.release();
  }
}
