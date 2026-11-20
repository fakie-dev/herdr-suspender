// The sleep pill (role "pill"): a floating drawer over the tab, right edge.
// At rest only its moon shows; on hover Herdr slides the rest out and it reads
// "Sleep · <agent>" for the agent in focus. With no agent in focus it draws
// nothing, but not while the pointer is on it: Herdr closes the drawer when the
// pointer leaves it, and a drawer that vanished under the pointer is never left,
// so it came back open and stayed open. Herdr frames it, lets people drag it and
// remembers the place; the slide is Herdr's own (`peek`), so there is no timer
// here. Colours only from theme().
import { h_flex } from "gpui-base";
import { div } from "gpui-kit";
import { detectAgent } from "../adapters/index.js";
import { PILL_EDGE_PAD, PILL_GAP, PILL_HEIGHT, PILL_ICON } from "../core/scale.js";
import { t } from "../i18n/index.js";
import { toTerminalView } from "../runtime/host.js";
import { icon, palette } from "./kit.js";
import { pillAgent } from "./sessionsModel.js";
export class PillView {
    engine;
    host;
    /** Whether the pointer is on the pill (Herdr's `placement().hovered`). */
    hovered;
    /** The terminal the pill offered last: a press must act on it even if focus moved by then. */
    offered = null;
    /** The agent whose row is drawn, kept while the pointer is on the pill. */
    shown = null;
    constructor(engine, host, hovered = () => false) {
        this.engine = engine;
        this.host = host;
        this.hovered = hovered;
    }
    render(_cx) {
        const focus = this.host.focused()?.terminal ?? null;
        const term = focus === null ? null : (this.host.terminals().find((x) => x.address === focus) ?? null);
        const agent = pillAgent(term, (x) => detectAgent(toTerminalView(x))?.id ?? null);
        this.offered = term === null || agent === null ? null : term.address;
        if (agent !== null && this.offered !== null) {
            this.shown = agent;
        }
        else if (!this.hovered()) {
            // Nothing to offer and the pointer is not on it: the drawer is closed, so it can go.
            this.shown = null;
        }
        // Still under the pointer: the same row, which a press no longer acts on (offered is null).
        return this.shown === null ? div() : this.row(this.shown);
    }
    row(agent) {
        const color = palette();
        // On the right edge the moon is on the edge side, so it is the part that peeks: centred in
        // the peek, which is as wide as the framed row is tall (a square button, core/scale.ts).
        return h_flex()
            .id("sleep-pill")
            .h(PILL_HEIGHT)
            .pl(10)
            .pr(PILL_EDGE_PAD)
            .gap(PILL_GAP)
            .items_center()
            .text_size(11.5)
            .whitespace_nowrap()
            .text_color(color("foreground"))
            .cursor_pointer()
            .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
            .on_click((_e, cx) => {
            const address = this.offered;
            if (address !== null) {
                cx.spawn(async (task) => {
                    await this.engine.sleepTerminal(address);
                    task.notify();
                });
            }
        })
            .child(t("pill.sleep", { agent: this.engine.adapter(agent).displayName }))
            .child(icon("moon", PILL_ICON, color("accent")));
    }
}
