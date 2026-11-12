// The sleeping tab (role "sleep", props.key): the agent's last screen, dimmed,
// and a strip at the bottom with what the session is and its button(s), as
// variant B of sleep-ui.html with the strip of session-info.html v4. Also the
// question for a working agent (role "confirm"), opened as a dialog.
//
// The last screen is laid out on the terminal's own cell grid (format.ts:
// screenLook / screenMarks), so it lines up with the live terminal it replaced,
// and the strip lies over its bottom rows, as in the mockup. Colours only from
// theme(); the only motion is the native spinner.
import { h_flex, v_flex } from "gpui-base";
import { div, svg } from "gpui-kit";
import { closeOverlay, settings, theme } from "herdr";
import { badgeText, SEPARATOR } from "../core/fit.js";
import { reportedSize, scaleOf, windowPx } from "../core/scale.js";
import { t } from "../i18n/index.js";
import { fitStrip, mixColor, SCREEN_DIM, STRIP_ACTION_ICON, STRIP_BADGE_TEXT, STRIP_BUTTON_PAD, STRIP_GAP, STRIP_ICON_BUTTON_PAD, STRIP_ITEM_GAP, STRIP_MOON_PX, STRIP_PAD_LEFT, STRIP_PAD_RIGHT, STRIP_PLAY_GAP, STRIP_PLAY_PX, STRIP_STATUS_INDENT, STRIP_STATUS_TEXT, STRIP_TEXT, screenGrid, screenLines, screenLook, screenMarks, statusWidth, statusWords, stripActions, stripStatus, wakeSteps, } from "./format.js";
import { anchorRect, factsFor, hoverPopup } from "./popup.js";
import { uiMeasure } from "./textWidth.js";
const ICONS = "mods/suspender/icons";
/** States in which a session may be opened, or closed, in another tab or program. */
const WATCHED = ["asleep", "interrupted", "elsewhere"];
/** The wake's steps: the spinner and the gap before each step. */
const SPINNER_PX = 12;
const STEP_GAP = 8;
/** The wake's spinner, turned natively (only while drawn). */
const spinner = (tint) => svg(`${ICONS}/spinner.svg`).size(SPINNER_PX).flex_none().text_color(tint).spin(900);
/** A theme colour by name (theme() names every one the mod uses; a missing one draws nothing). */
function palette() {
    const th = theme();
    return (name) => (th[name] ?? "#00000000");
}
/** One piece of the last screen, placed in px from the first cell. */
function markElement(m, l, shade) {
    const at = div().absolute().left(m.x).top(m.y);
    switch (m.kind) {
        case "text":
            return at.h(l.cellH).line_height(`${l.cellH}px`).text_size(m.size).whitespace_nowrap().child(m.text);
        case "fill":
            return at.w(m.w).h(m.h).bg(shade(m.shade));
        case "arc": {
            const el = at.w(m.w).h(m.h).border_color(shade(1));
            if (m.corner === "tl") {
                return el.border_t(l.stroke).border_l(l.stroke).rounded_tl(m.radius);
            }
            if (m.corner === "tr") {
                return el.border_t(l.stroke).border_r(l.stroke).rounded_tr(m.radius);
            }
            if (m.corner === "bl") {
                return el.border_b(l.stroke).border_l(l.stroke).rounded_bl(m.radius);
            }
            return el.border_b(l.stroke).border_r(l.stroke).rounded_br(m.radius);
        }
    }
}
export class SleepPane {
    /** As Herdr reports it: window px. */
    size = { width: windowPx(0), height: windowPx(0) };
    shown = false;
    watching = false;
    engine;
    host;
    ports;
    key;
    constructor(engine, host, ports, key) {
        this.engine = engine;
        this.host = host;
        this.ports = ports;
        this.key = key;
    }
    rec() {
        return this.engine.record(this.key);
    }
    /** Whether this pane's tab is the one on screen. */
    visible() {
        const pane = this.rec()?.pane;
        const tab = this.host.panes().find((p) => p.pane === pane)?.tab;
        return this.host.tabs().some((x) => x.id === tab && x.active && x.spaceActive);
    }
    /**
     * Every TICK_MS: once per show, re-read what changed ("+N") and whether the
     * session is open elsewhere; while it sleeps, Claude's sessions folder is
     * watched for it being opened or closed elsewhere (Codex: looked at again
     * while shown and open elsewhere). Nothing watches the conversation while the strip
     * stays on screen: a session open in another window writes all the time,
     * and every read starts a process on Windows.
     */
    tick(cx) {
        const rec = this.rec();
        if (rec === null) {
            return;
        }
        const visible = this.visible();
        if (visible && !this.shown) {
            cx.spawn(async (cx) => {
                await this.engine.refreshOnShow(this.key);
                cx.notify();
            });
        }
        this.shown = visible;
        const adapter = this.engine.adapter(rec.agent);
        if (adapter.watchOpenness !== undefined) {
            // Claude: its sessions folder changes when the session is opened in
            // another tab or program, and when it is closed there (no timer).
            if (!this.watching && WATCHED.includes(rec.state)) {
                this.watching = true;
                cx.spawn(async (cx) => {
                    try {
                        while (WATCHED.includes(this.rec()?.state ?? "running")) {
                            await adapter.watchOpenness?.(this.ports);
                            await this.engine.recheckOpen(this.key);
                            cx.notify();
                        }
                    }
                    finally {
                        this.watching = false;
                    }
                    cx.notify();
                });
            }
        }
        else if (visible && rec.state === "elsewhere") {
            // Codex: a process check, only while the strip is on screen (every TICK_MS = 5 s).
            cx.spawn(async (cx) => {
                await this.engine.recheckElsewhere(this.key);
                cx.notify();
            });
        }
    }
    press(action, cx) {
        cx.spawn(async (cx) => {
            if (action === "resume" || action === "retry") {
                await this.engine.resume(this.key);
            }
            else if (action === "startNew") {
                await this.engine.startNew(this.key);
            }
            else if (action === "forget") {
                await this.engine.forget(this.key);
            }
            cx.notify();
        });
    }
    render(_cx) {
        const color = palette();
        const rec = this.rec();
        const root = div()
            .id("sleep-root")
            .relative()
            .size_full()
            .overflow_hidden()
            .bg(color("background"))
            // Every text names its size, so Herdr's UI font size cannot reflow what fitStrip measured.
            .text_size(STRIP_TEXT)
            .on_size_change((size, cx) => {
            this.size = reportedSize(size);
            cx.notify();
        });
        if (rec === null) {
            return root;
        }
        return root.child(this.screen(rec)).child(this.strip(rec));
    }
    /**
     * The last screen, dimmed, where the terminal had it: the same cells, the
     * same padding, its first row where the terminal's was. Rows that no longer
     * fit go from the top, as in a terminal made shorter. `hc read` gives text
     * only, so the screen keeps no colours.
     */
    screen(rec) {
        const color = palette();
        const shade = (share) => mixColor(color("background"), color("foreground"), SCREEN_DIM * share);
        const look = screenLook(settings());
        const grid = screenGrid(this.size.height, look);
        const marks = screenMarks(screenLines(rec.lastScreen, grid.rows), look);
        return div()
            .absolute()
            .top(0)
            .left(0)
            .size_full()
            .child(div()
            .absolute()
            .left(look.padX)
            .top(grid.top)
            .font_family(look.font)
            .text_color(shade(1))
            .children(marks.map((m) => markElement(m, look, shade))));
    }
    strip(rec) {
        const color = palette();
        const agentName = this.engine.adapter(rec.agent).displayName;
        const busy = this.engine.busy(this.key) || rec.state === "waking" || rec.state === "stopping";
        const actions = stripActions(rec, busy);
        // Line 1: title · branch · model · folder (+N), cut from the end as in the mockup.
        const fit = fitStrip(rec.info, actions, this.size.width, this.ports.sep, scaleOf(settings()));
        const icon = { branch: "branch", model: "chip", folder: "folder" };
        const items = [];
        if (fit.title && rec.info.title) {
            items.push(div().flex_shrink(1).min_w(0).truncate().font_semibold().text_color(color("foreground")).child(rec.info.title));
        }
        fit.segs.forEach((seg, i) => {
            if (items.length > 0) {
                items.push(div().flex_none().text_color(color("dim")).child(SEPARATOR.trim()));
            }
            // The last item gives way first: with a UI font wider than the widths fitStrip
            // counted, it ends in "…" instead of being cut by the line's edge.
            const last = i === fit.segs.length - 1;
            items.push(h_flex()
                .when(!last, (el) => el.flex_none())
                .when(last, (el) => el.flex_shrink(1).min_w(0))
                .gap(4)
                .items_center()
                .child(svg(`${ICONS}/${icon[seg.key] ?? "folder"}.svg`)
                .size(12)
                .flex_none()
                .text_color(color("dim")))
                .child(div().min_w(0).truncate().child(seg.text)));
        });
        if (fit.hidden > 0) {
            items.push(div()
                .flex_none()
                .px(6)
                .rounded(8)
                .border(1)
                .border_color(color("border"))
                .text_size(STRIP_BADGE_TEXT)
                .text_color(color("dim"))
                .child(badgeText(fit.hidden).trim()));
        }
        // Line 2: the state, the wake's steps, or the error. In a narrow pane (or
        // at a large zoom) it wraps at words, two lines at most, then ends in "…":
        // never cut in the middle of a word (gpui would break a word to wrap it).
        const room = statusWidth(this.size.width, scaleOf(settings()));
        const measure = (text) => uiMeasure(text, STRIP_STATUS_TEXT);
        const steps = wakeSteps(this.engine.progress(this.key));
        const stepsWidth = steps.reduce((sum, s) => sum + STEP_GAP + measure(s.label), SPINNER_PX);
        const status = rec.state === "waking" && stepsWidth <= room
            ? h_flex()
                .gap(STEP_GAP)
                .items_center()
                .child(spinner(color("accent")))
                .children(steps.map((s) => div()
                .flex_none()
                .whitespace_nowrap()
                .text_color(color(s.state === "now" ? "foreground" : s.state === "done" ? "muted" : "dim"))
                .child(s.label)))
            : v_flex()
                .text_color(color(rec.state === "waking"
                ? "foreground"
                : rec.state === "error" || rec.state === "missing"
                    ? "blocked"
                    : "dim"))
                .children(statusWords(this.engine.sleepingWhenDone(this.key)
                ? t("strip.sleepingWhenDone", { agent: agentName })
                : stripStatus(rec, {
                    now: this.ports.now(),
                    agentName,
                    progress: this.engine.progress(this.key),
                    fresh: this.engine.freshness(this.key),
                }), rec.state === "stopping" ? Math.max(0, room - SPINNER_PX - STEP_GAP) : room, measure).map((line) => div().whitespace_nowrap().child(line)));
        // Falling asleep turns the same spinner before its lines (they have that much less room).
        const statusLine = rec.state === "stopping"
            ? h_flex()
                .gap(STEP_GAP)
                .items_center()
                .child(spinner(color("accent")))
                .child(status)
            : status;
        // In a pane too narrow for the labels, each button folds to its icon, its label in a tooltip.
        const folded = fit.buttons === "icon";
        const buttons = actions.map((a, i) => h_flex()
            .id(`strip-${a.action}`)
            .flex_none()
            .h(28)
            .px(folded ? STRIP_ICON_BUTTON_PAD : STRIP_BUTTON_PAD)
            .gap(STRIP_PLAY_GAP)
            .items_center()
            .rounded(7)
            .text_size(STRIP_TEXT)
            .font_semibold()
            .when(i === 0, (el) => el.bg(color(a.enabled ? "solid" : "raised")).text_color(color(a.enabled ? "solid_foreground" : "dim")))
            .when(i > 0, (el) => el
            .border(1)
            .border_color(color("border"))
            .text_color(color(a.enabled ? "muted" : "dim")))
            .when(a.enabled, (el) => el
            .cursor_pointer()
            .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
            .on_click((_e, cx) => this.press(a.action, cx)))
            .when(folded, (el) => el.tooltip(a.label).child(svg(`${ICONS}/${STRIP_ACTION_ICON[a.action] ?? "play"}.svg`).size(STRIP_PLAY_PX)))
            .when(!folded && i === 0 && a.action === "resume", (el) => el.child(svg(`${ICONS}/play.svg`).size(STRIP_PLAY_PX)))
            .when(!folded, (el) => el.child(a.label)));
        return (v_flex()
            .id("strip")
            .absolute()
            .left(0)
            .right(0)
            .bottom(0)
            // Hovering the strip opens the session's popup (popup.ts decides when).
            .on_mouse_move((e, cx) => hoverPopup.enter({ key: this.key, kind: "strip", rect: anchorRect(e), usedMb: null }, () => factsFor(this.engine, this.ports, this.key, null), cx))
            .on_hover((over, cx) => {
            if (!over) {
                hoverPopup.leave(cx);
            }
        })
            .flex_none()
            .bg(color("chrome"))
            .border_t(1)
            .border_color(color("border"))
            .pl(STRIP_PAD_LEFT)
            .pr(STRIP_PAD_RIGHT)
            .py(8)
            .gap(3)
            .child(h_flex()
            .gap(STRIP_GAP)
            .items_center()
            .when(fit.moon, (el) => el.child(svg(`${ICONS}/moon.svg`)
            .size(STRIP_MOON_PX)
            .flex_none()
            .text_color(color(rec.state === "interrupted" ? "working" : "accent"))))
            .child(h_flex()
            .flex_1()
            .min_w(0)
            .gap(STRIP_ITEM_GAP)
            .items_center()
            .overflow_hidden()
            .whitespace_nowrap()
            .text_size(STRIP_TEXT)
            .text_color(color("muted"))
            .children(items))
            .children(buttons))
            .child(h_flex().pl(STRIP_STATUS_INDENT).text_size(STRIP_STATUS_TEXT).child(statusLine)));
    }
}
/** "{agent} is still answering": Sleep when done / Interrupt and sleep / Cancel. Closing it any other way is Cancel. */
export class ConfirmDialog {
    answered = false;
    engine;
    key;
    overlay;
    constructor(engine, key, overlay) {
        this.engine = engine;
        this.key = key;
        this.overlay = overlay;
    }
    /**
     * The answer, from a click or a command. Only recorded: the dialog closes at
     * once, and with it its tasks; the copy that asked carries the answer out.
     */
    answer(choice) {
        if (this.answered) {
            return;
        }
        this.answered = true;
        this.engine.answer(this.key, choice);
        if (this.overlay !== null) {
            closeOverlay(this.overlay);
        }
    }
    /** The dialog went (Esc, a click beside it) without an answer: that is Cancel, and it must not be lost. */
    close() {
        this.answer("cancel");
    }
    render(_cx) {
        const color = palette();
        const rec = this.engine.record(this.key);
        const agent = rec === null ? "" : this.engine.adapter(rec.agent).displayName;
        const button = (id, label, primary) => h_flex()
            .id(`confirm-${id}`)
            .h(30)
            .px(12)
            .items_center()
            .rounded(7)
            .cursor_pointer()
            .text_size(12.5)
            .when(primary, (el) => el.bg(color("solid")).text_color(color("solid_foreground")).font_semibold())
            .when(!primary, (el) => el.border(1).border_color(color("border")).text_color(color("muted")))
            .hover((s) => s.opacity(0.9))
            .on_click(() => this.answer(id))
            .child(label);
        return v_flex()
            .id("confirm-root")
            .size_full()
            .p(16)
            .gap(14)
            .bg(color("popover"))
            .child(div().text_size(14).font_semibold().text_color(color("foreground")).child(t("confirm.title", { agent })))
            .child(h_flex()
            .gap(8)
            .justify_end()
            .child(button("cancel", t("confirm.cancel"), false))
            .child(button("interruptAndSleep", t("confirm.interruptAndSleep"), false))
            .child(button("sleepWhenDone", t("confirm.sleepWhenDone"), true)));
    }
}
