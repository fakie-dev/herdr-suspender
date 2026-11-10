// The mod's one view. `props().role` says which copy this is: "sleep" (a
// sleeping tab, `props.key`), "confirm" (the question for a working agent),
// and "toggle" | "panel" | "pill" | "window" (the Sessions list and its
// buttons, drawn by their own modules). Every copy runs an engine: one of them
// leads (binds sessions, recognises a restart), and whichever copy a person
// presses a button in carries the action out.
import { div, View } from "gpui-kit";
import { props as herdrProps, nextCommand } from "herdr";
import { herdrPorts } from "./platform/ports.js";
import { Engine, newCoordinator, TICK_MS } from "./runtime/engine.js";
import { herdrHost } from "./runtime/herdrHost.js";
import { ConfirmDialog, SleepPane } from "./ui/sleepPane.js";
/** The question's answers as commands (`suspender.sleep-when-done`, …), for keys. */
const CHOICES = {
    "sleep-when-done": "sleepWhenDone",
    "interrupt-and-sleep": "interruptAndSleep",
    cancel: "cancel",
};
/** Shared by the copies of this build in this window (one module instance). */
const coordinator = newCoordinator();
const copyId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
export default class Suspender extends View {
    engine = null;
    sleep = null;
    confirm = null;
    init(_props, cx) {
        // Herdr hands the block's props through props(), not through init's argument.
        const raw = herdrProps();
        const props = (typeof raw === "object" && raw !== null ? raw : {});
        const host = herdrHost(cx);
        const ports = herdrPorts();
        const engine = new Engine({ host, ports, id: copyId(), coordinator });
        this.engine = engine;
        const key = typeof props.key === "string" ? props.key : null;
        if (props.role === "sleep" && key !== null) {
            this.sleep = new SleepPane(engine, host, ports, key);
        }
        else if (props.role === "confirm" && key !== null) {
            this.confirm = new ConfirmDialog(engine, key, typeof props.overlay === "string" ? props.overlay : null);
        }
        // Redraw only for news: a write in this window already redraws every copy
        // (it sets a shared value); a round redraws when it read another window's.
        const round = async (cx) => {
            const before = engine.revision();
            await engine.tick();
            this.sleep?.tick(cx);
            if (engine.revision() !== before) {
                cx.notify();
            }
        };
        cx.spawn(round);
        cx.timer.every(TICK_MS, (cx) => {
            cx.spawn(round);
        });
        cx.spawn(async (cx) => {
            for (;;) {
                const command = await nextCommand();
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
                else if (this.confirm !== null && command in CHOICES) {
                    this.confirm.answer(CHOICES[command] ?? "cancel");
                }
                cx.notify();
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
        return div();
    }
    close(_cx) {
        this.confirm?.close();
        this.engine?.release();
    }
}
