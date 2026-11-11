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
import { div, View } from "gpui-kit";
import { appHome, props as herdrProps, nextCommand, notify, updates, writeTextFile } from "herdr";
import { buildLivingLayout, LAYOUT_NAME } from "./core/layout.js";
import { SHIPPED_MAIN, SHIPPED_MAIN_VERSION } from "./core/shippedMain.js";
import { herdrPorts } from "./platform/ports.js";
import { Engine, newCoordinator, TICK_MS } from "./runtime/engine.js";
import { herdrHost } from "./runtime/herdrHost.js";
import { syncLayout } from "./runtime/layoutSync.js";
import { PanelView } from "./ui/panel.js";
import { PillView } from "./ui/pill.js";
import { PopupView } from "./ui/popup.js";
import { ConfirmDialog, SleepPane } from "./ui/sleepPane.js";
import { ToggleView } from "./ui/toggle.js";
/** The question's answers as commands (`suspender.sleep-when-done`, …), for keys. */
const CHOICES = {
    "sleep-when-done": "sleepWhenDone",
    "interrupt-and-sleep": "interruptAndSleep",
    cancel: "cancel",
};
/** Shared by the copies of this build in this window (one module instance). */
const coordinator = newCoordinator();
/** Herdr versions the layout sync already warned about, shared by the copies of this window. */
const layoutWarned = new Set();
/** The running Herdr's version, if it says. */
function herdrVersion() {
    try {
        return updates().app.version;
    }
    catch {
        return null;
    }
}
/** Builds or refreshes layouts/suspender.json from Herdr's main.json; never throws (the layout is a convenience). */
async function keepLayout(toast) {
    try {
        const version = herdrVersion() ?? "";
        await syncLayout({ ports: herdrPorts(), appHome: appHome(), herdrVersion: version, toast, warned: layoutWarned });
    }
    catch {
        // The mod works without its layout.
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
function seedLayout() {
    try {
        const built = buildLivingLayout(SHIPPED_MAIN, herdrVersion() ?? SHIPPED_MAIN_VERSION);
        if (built.ok) {
            const path = [appHome(), "layouts", `${LAYOUT_NAME}.json`].join(herdrPorts().sep);
            return writeTextFile(path, `${JSON.stringify(built.layout, null, 2)}\n`, null).catch(() => null);
        }
    }
    catch {
        // The mod works without its layout.
    }
    return Promise.resolve();
}
// On load, with no copy on screen yet (a clean install has no layout that shows one).
void seedLayout().then(() => keepLayout((text) => {
    try {
        notify({ title: text, level: "warning" });
    }
    catch {
        // No window to show it in (a check run): the next copy that shows says it.
    }
}));
const copyId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
export default class Suspender extends View {
    engine = null;
    sleep = null;
    confirm = null;
    popup = null;
    panel = null;
    toggle = null;
    pill = null;
    init(_props, cx) {
        // Herdr hands the block's props through props(), not through init's argument.
        const raw = herdrProps();
        const props = (typeof raw === "object" && raw !== null ? raw : {});
        const host = herdrHost(cx);
        const ports = herdrPorts();
        // Beside the layouts it belongs with: another HERDR_APP_HOME is another window with its own sessions.
        const storePath = [appHome(), "suspender", "sessions.json"].join(ports.sep);
        const engine = new Engine({ host, ports, id: copyId(), coordinator, storePath });
        this.engine = engine;
        const key = typeof props.key === "string" ? props.key : null;
        if (props.role === "sleep" && key !== null) {
            this.sleep = new SleepPane(engine, host, ports, key);
        }
        else if (props.role === "confirm" && key !== null) {
            this.confirm = new ConfirmDialog(engine, key, typeof props.overlay === "string" ? props.overlay : null);
        }
        else if (props.role === "popup" && key !== null) {
            const used = typeof props.usedMb === "number" ? props.usedMb : null;
            this.popup = new PopupView(engine, ports, key, typeof props.overlay === "string" ? props.overlay : null, used);
        }
        else if (props.role === "toggle") {
            this.toggle = new ToggleView(engine);
        }
        else if (props.role === "pill") {
            this.pill = new PillView(engine, host);
        }
        else if (props.role === "panel") {
            this.panel = new PanelView({ engine, host, ports, mode: "panel", overlay: null });
        }
        else if (props.role === "window" || props.role === undefined) {
            // `mod.open` gives no role: the Sessions list in a window of its own.
            const overlay = typeof props.overlay === "string" ? props.overlay : null;
            this.panel = new PanelView({ engine, host, ports, mode: "window", overlay });
        }
        if (this.popup === null && this.confirm === null) {
            cx.spawn(async () => {
                await keepLayout((text) => host.notify(text, "warning"));
            });
        }
        // Redraw only for news: a write in this window already redraws every copy
        // (it sets a shared value); a round redraws when it read another window's.
        const round = async (cx) => {
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
                    if (command === "toggle-focused") {
                        await engine.toggleFocused();
                    }
                    else if (command === "resume-all") {
                        await engine.resumeAllShown();
                    }
                    else if (command === "forget") {
                        await engine.forgetFocused();
                    }
                    else if (command === "start-new") {
                        await engine.startNewFocused();
                    }
                    cx.notify();
                });
            }
        });
    }
    render(cx) {
        if (this.sleep !== null) {
            return this.sleep.render(cx);
        }
        if (this.confirm !== null) {
            return this.confirm.render(cx);
        }
        return (this.popup?.render(cx) ?? this.panel?.render(cx) ?? this.toggle?.render(cx) ?? this.pill?.render(cx) ?? div());
    }
    close(_cx) {
        this.confirm?.close();
        this.popup?.close();
        this.engine?.release();
    }
}
