// The Sessions panel (role "panel": in the living layout, the side panel's
// third child beside Files and Changes, or our own hidden right column when the
// tab bar is Herdr's own; role "window": the same list in a window, for a
// layout without it):
// every session of every space, grouped by space, running before asleep before
// interrupted, with "memory freed" on top and "Resume all in project" per
// group. A row shows what the approved mockup (session-info.html v4) shows and
// opens its popup on hover. Colours only from theme().
//
// Memory of running sessions is measured only while the panel is shown and at
// most every 30 s, inside the round every copy already runs (no timer here).
import { h_flex, v_flex } from "gpui-base";
import { div } from "gpui-kit";
import { closeOverlay, layout, settings, spaces } from "herdr";
import { SEPARATOR } from "../core/fit.js";
import { sessionsShown } from "../core/layout.js";
import { reportedSize, scaleOf, windowPx } from "../core/scale.js";
import { t } from "../i18n/index.js";
import { treesMemoryMb } from "../platform/proc.js";
import { agentTile, icon, palette, TONE_COLOR } from "./kit.js";
import { anchorRect, factsFor, hoverPopup } from "./popup.js";
import { fitRow, groupSessions, isSleeping, MemoryPolicy, memoryFreedText, ROW_ITEM_GAP, ROW_SMALL_TEXT, ROW_TEXT, rowMemory, stateWord, } from "./sessionsModel.js";
import { uiMeasure } from "./textWidth.js";
/** Running sessions' memory is read at most this often, and only while the panel is shown. */
export const MEMORY_EVERY_MS = 30_000;
/** The panel's width until Herdr reports it (window px at zoom 1). */
const DEFAULT_WIDTH = 320;
export class PanelView {
    /** As Herdr reports it: window px. */
    size = { width: windowPx(DEFAULT_WIDTH), height: windowPx(0) };
    /** What running sessions occupy now, in MB, as last measured. */
    used = new Map();
    sampling = false;
    policy = new MemoryPolicy(MEMORY_EVERY_MS);
    /** Running sessions' facts (name, branch, model…): read when shown, then at most every 30 s. */
    reading = false;
    facts = new MemoryPolicy(MEMORY_EVERY_MS);
    o;
    constructor(o) {
        this.o = o;
    }
    shown() {
        return this.o.mode === "window" || sessionsShown(layout());
    }
    /**
     * Every round (TICK_MS), while the panel is open: the running sessions'
     * facts and memory, each at most every 30 s (facts are read only when their
     * conversation changed).
     */
    tick(cx) {
        if (!this.reading && this.facts.due(this.o.ports.now(), this.shown())) {
            this.reading = true;
            cx.spawn(async (task) => {
                try {
                    await this.o.engine.refreshRunning();
                }
                catch {
                    // The rows keep what they had.
                }
                finally {
                    this.reading = false;
                }
                task.notify();
            });
        }
        if (this.sampling || !this.policy.due(this.o.ports.now(), this.shown())) {
            return;
        }
        this.sampling = true;
        cx.spawn(async (task) => {
            try {
                this.used = await this.measure();
            }
            catch {
                // A failed measurement leaves the last figures in place.
            }
            finally {
                this.sampling = false;
            }
            task.notify();
        });
    }
    /** What each running session's terminal and everything under it would give back, in MB: as freed at sleep. */
    async measure() {
        const pids = new Map(this.o.host.terminals().map((term) => [term.address, term.pid]));
        const roots = this.o.engine
            .records()
            .filter((r) => !isSleeping(r.state) && r.terminal !== null)
            .map((r) => [r.key, pids.get(r.terminal ?? "") ?? null])
            .filter((entry) => entry[1] !== null);
        const result = new Map();
        if (roots.length === 0) {
            return result;
        }
        const mb = await treesMemoryMb(this.o.ports, roots.map(([, root]) => root));
        for (const [key, root] of roots) {
            const used = mb.get(root);
            if (used !== undefined) {
                result.set(key, used);
            }
        }
        return result;
    }
    act(work, cx) {
        cx.spawn(async (task) => {
            await work();
            task.notify();
        });
    }
    render(_cx) {
        const color = palette();
        const scale = scaleOf(settings());
        const records = this.o.engine.records();
        const groups = groupSessions(records, spaces()
            .filter((s) => s.machine === null)
            .map((s) => ({ id: s.id, name: s.name })));
        const freed = memoryFreedText(records);
        const header = h_flex()
            .h(42)
            .flex_none()
            .px(14)
            .gap(8)
            .items_center()
            .border_b(1)
            .border_color(color("border"))
            .child(div().font_semibold().child(t("panel.title")))
            .child(div()
            .flex_1()
            .min_w(0)
            .truncate()
            .text_right()
            .text_size(12)
            .text_color(color("dim"))
            .child(freed ?? ""))
            .when(this.o.mode === "window", (el) => el.child(div()
            .id("panel-close")
            .flex_none()
            .p(4)
            .rounded(5)
            .cursor_pointer()
            .hover((s) => s.bg(color("hover")))
            .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
            .on_click(() => {
            if (this.o.overlay !== null) {
                closeOverlay(this.o.overlay);
            }
        })
            .child(icon("close", 12, color("dim")))));
        const body = v_flex()
            .id("panel-list")
            .flex_1()
            .min_h(0)
            .overflow_y_scrollbar()
            .py(6)
            .when(groups.length === 0, (el) => el.child(div().p(14).text_size(12).text_color(color("dim")).child(t("panel.empty"))))
            .children(groups.flatMap((g) => this.group(g, color, scale)));
        return v_flex()
            .id("panel-root")
            .size_full()
            .min_h(0)
            .rounded(10)
            .overflow_hidden()
            .bg(color("background"))
            .border(1)
            .border_color(color("border"))
            .text_color(color("foreground"))
            .text_size(13)
            .on_size_change((size, cx) => {
            this.size = reportedSize(size);
            cx.notify();
        })
            .child(header)
            .child(body);
    }
    group(g, color, scale) {
        const head = h_flex()
            .px(12)
            .pt(8)
            .pb(2)
            .gap(8)
            .items_center()
            .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(color("dim")).child(g.name.toUpperCase()))
            .when(g.resumable.length > 0, (el) => el.child(h_flex()
            .id(`resume-all-${g.spaceId}`)
            .flex_none()
            .h(20)
            .px(6)
            .gap(4)
            .items_center()
            .rounded(5)
            .text_size(11)
            .text_color(color("muted"))
            .cursor_pointer()
            .hover((s) => s.bg(color("hover")))
            .on_click((_e, cx) => this.act(() => this.o.engine.resumeAll(g.spaceId), cx))
            .child(icon("play", 10, color("muted")))
            .child(t("panel.resumeAll"))));
        return [head, ...g.rows.map((r) => this.row(r, color, scale))];
    }
    row(rec, color, scale) {
        const { engine, host, ports } = this.o;
        const agentName = engine.adapter(rec.agent).displayName;
        const used = this.used.get(rec.key) ?? null;
        const memory = rowMemory(rec, used);
        const fit = fitRow(rec, this.size.width, memory?.text ?? null, ports.sep, uiMeasure, scale);
        const tone = TONE_COLOR[rec.state === "interrupted"
            ? "warn"
            : isSleeping(rec.state)
                ? rec.state === "missing" || rec.state === "error"
                    ? "error"
                    : "sleep"
                : "live"];
        const title = rec.info.title ?? agentName;
        const items = [];
        fit.segs.forEach((seg, i) => {
            if (items.length > 0) {
                items.push(div().flex_none().text_color(color("dim")).child(SEPARATOR.trim()));
            }
            const glyph = seg.key === "branch" ? "branch" : seg.key === "folder" ? "folder" : null;
            // The last item gives way first: with a UI font wider than the widths fitRow
            // counted, it ends in "…" instead of being cut by the line's edge.
            const last = i === fit.segs.length - 1;
            items.push(h_flex()
                .when(!last, (el) => el.flex_none())
                .when(last, (el) => el.flex_shrink(1).min_w(0))
                .gap(4)
                .items_center()
                .text_color(color(seg.key === "id" ? "dim" : "muted"))
                .when(glyph !== null, (el) => el.child(icon(glyph ?? "folder", 12, color("dim"))))
                .child(div().min_w(0).truncate().child(seg.text)));
        });
        if (fit.hidden > 0) {
            items.push(div()
                .flex_none()
                .px(6)
                .rounded(8)
                .border(1)
                .border_color(color("border"))
                .text_size(ROW_SMALL_TEXT)
                .text_color(color("dim"))
                .child(`+${fit.hidden}`));
        }
        // Sleep for a running agent, Resume for a sleeping one; nothing while it is changing.
        const action = rec.state === "running" || rec.state === "working"
            ? { name: "moon", label: t("panel.sleep"), run: () => engine.sleep(rec.key) }
            : rec.state === "asleep" || rec.state === "interrupted" || rec.state === "error"
                ? {
                    name: "play",
                    label: t(rec.state === "error" ? "strip.retry" : "strip.resume"),
                    run: () => engine.resume(rec.key),
                }
                : null;
        return h_flex()
            .id(`row-${rec.key}`)
            .gap(8)
            .mx(4)
            .px(8)
            .py(6)
            .rounded(6)
            .items_start()
            .cursor_pointer()
            .hover((s) => s.bg(color("hover")))
            .on_click(() => {
            host.runOnScreen("space.select", { id: rec.spaceId });
            host.runOnScreen("tab.select", { id: rec.tabId });
        })
            .on_mouse_move((e, cx) => hoverPopup.enter({ key: rec.key, kind: "row", rect: anchorRect(e), usedMb: used }, () => factsFor(engine, ports, rec.key, used), cx))
            .on_hover((over, cx) => {
            if (!over) {
                hoverPopup.leave(cx);
            }
        })
            .child(agentTile(rec.agent, color))
            .child(v_flex()
            .flex_1()
            .min_w(0)
            .gap(1)
            .child(h_flex()
            .gap(8)
            .items_center()
            .child(div().flex_1().min_w(0).truncate().text_size(12.5).text_color(color("foreground")).child(title))
            .child(div().flex_none().whitespace_nowrap().text_size(11).text_color(color(tone)).child(stateWord(rec.state)))
            .when(action !== null, (el) => el.child(div()
            .id(`row-action-${rec.key}`)
            .flex_none()
            .p(3)
            .rounded(5)
            .cursor_pointer()
            .hover((s) => s.bg(color("selected")))
            .tooltip(action?.label ?? "")
            .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
            .on_click((_e, cx) => {
            cx.stop_propagation();
            const run = action?.run;
            if (run !== undefined) {
                this.act(run, cx);
            }
        })
            .child(icon(action?.name ?? "moon", 12, color("muted"))))))
            .child(h_flex()
            .gap(8)
            .items_center()
            .child(h_flex()
            .flex_1()
            .min_w(0)
            .gap(ROW_ITEM_GAP)
            .items_center()
            .overflow_hidden()
            .whitespace_nowrap()
            .text_size(ROW_TEXT)
            .children(items))
            .when(memory !== null, (el) => el.child(h_flex()
            .flex_none()
            .gap(4)
            .items_center()
            .text_size(ROW_SMALL_TEXT)
            .text_color(color(memory?.kind === "freed" ? "accent" : "muted"))
            .child(memory?.kind === "freed"
            ? icon("moon", 11, color("accent"))
            : div().size(6).flex_none().rounded(3).border(1.5).border_color(color("done")))
            .child(memory?.text ?? "")))));
    }
}
