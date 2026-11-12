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
import type { AsyncContext } from "gpui-kit";
import { type Context, div, type Element, svg } from "gpui-kit";
import { closeOverlay, layout, settings, spaces } from "herdr";
import { SEPARATOR } from "../core/fit.ts";
import { sessionsShown } from "../core/layout.ts";
import type { SessionKey, SessionRecord } from "../core/model.ts";
import { reportedSize, type Scale, scaleOf, type WindowSize, windowPx } from "../core/scale.ts";
import { t } from "../i18n/index.ts";
import type { Ports } from "../platform/ports.ts";
import { treesMemoryMb } from "../platform/proc.ts";
import type { Engine } from "../runtime/engine.ts";
import type { Host } from "../runtime/host.ts";
import type { Updater } from "../runtime/updater.ts";
import { agentIcon, ICONS, icon, type Palette, palette, stateMark, TONE_COLOR } from "./kit.ts";
import { anchorRect, factsFor, hoverPopup } from "./popup.ts";
import {
  fitRow,
  type Group,
  groupSessions,
  isSleeping,
  MemoryPolicy,
  memoryFreedText,
  ROW_ITEM_GAP,
  ROW_SMALL_TEXT,
  ROW_TEXT,
  ROW_TITLE_PX,
  rowMemory,
  shownState,
  type UsedFigure,
  usedNow,
} from "./sessionsModel.ts";
import { uiMeasure } from "./textWidth.ts";
import {
  ACTION_LABEL,
  BUTTON_ICON,
  BUTTON_PAD_X,
  BUTTON_TEXT,
  FOOTER_BOX,
  FOOTER_LABEL,
  FOOTER_PAD_X,
  FOOTER_TEXT,
  fitFooter,
  fitUpdateLine,
  LINE_GAP,
  LINE_LEAD,
  LINE_PAD_X,
  LINE_TEXT,
  type LineAction,
  updateLine,
} from "./updateLine.ts";

/** Running sessions' memory is read at most this often, and only while the panel is shown. */
export const MEMORY_EVERY_MS = 30_000;
/** The panel's width until Herdr reports it (window px at zoom 1). */
const DEFAULT_WIDTH = 320;

export interface PanelOptions {
  engine: Engine;
  host: Host;
  ports: Ports;
  /** "panel": a layout block; "window": an overlay window, closed with its own button. */
  mode: "panel" | "window";
  /** The window's overlay id (mode "window"). */
  overlay: string | null;
  /** The mod's own updates: the line on top and the switch at the bottom. Absent: neither is drawn. */
  updates?: Updater | null;
}

/** Each update button's icon when its label folds. */
const ACTION_ICON: Readonly<Record<LineAction, string>> = {
  update: "download",
  whatsNew: "notes",
  rollBack: "undo",
  page: "link",
  dismiss: "close",
};

export class PanelView {
  /** As Herdr reports it: window px. */
  private size: WindowSize = { width: windowPx(DEFAULT_WIDTH), height: windowPx(0) };
  /** What running sessions occupy now, in MB, as last measured. */
  private used = new Map<SessionKey, UsedFigure>();
  private sampling = false;
  private readonly policy = new MemoryPolicy(MEMORY_EVERY_MS);
  /** Running sessions' facts (name, branch, model…): read when shown, then at most every 30 s. */
  private reading = false;
  private readonly facts = new MemoryPolicy(MEMORY_EVERY_MS);
  /** The updater's revision this copy last drew. */
  private drawnUpdate = -1;
  private readonly o: PanelOptions;

  constructor(o: PanelOptions) {
    this.o = o;
  }

  private shown(): boolean {
    return this.o.mode === "window" || sessionsShown(layout());
  }

  /**
   * Every round (TICK_MS), while the panel is open: the running sessions'
   * facts and memory, each at most every 30 s (facts are read only when their
   * conversation changed).
   */
  tick(cx: AsyncContext): void {
    const updates = this.o.updates;
    if (updates !== undefined && updates !== null && updates.revision() !== this.drawnUpdate) {
      cx.notify();
    }
    if (!this.reading && this.facts.due(this.o.ports.now(), this.shown())) {
      this.reading = true;
      cx.spawn(async (task) => {
        try {
          await this.o.engine.refreshRunning();
        } catch {
          // The rows keep what they had.
        } finally {
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
      } catch {
        // A failed measurement leaves the last figures in place.
      } finally {
        this.sampling = false;
      }
      task.notify();
    });
  }

  /**
   * What each running session's terminal and everything under it would give
   * back, in MB (as freed at sleep), with the terminal it was measured in.
   */
  private async measure(): Promise<Map<SessionKey, UsedFigure>> {
    const pids = new Map(this.o.host.terminals().map((term) => [term.address, term.pid]));
    const roots: { key: SessionKey; terminal: string; root: number }[] = [];
    for (const r of this.o.engine.records()) {
      const root = r.terminal === null ? null : (pids.get(r.terminal) ?? null);
      if (!isSleeping(r.state) && r.terminal !== null && root !== null) {
        roots.push({ key: r.key, terminal: r.terminal, root });
      }
    }
    const result = new Map<SessionKey, UsedFigure>();
    if (roots.length === 0) {
      return result;
    }
    const mb = await treesMemoryMb(
      this.o.ports,
      roots.map((r) => r.root),
    );
    for (const { key, terminal, root } of roots) {
      const used = mb.get(root);
      if (used !== undefined) {
        result.set(key, { terminal, mb: used });
      }
    }
    return result;
  }

  private act(work: () => Promise<unknown>, cx: Context): void {
    cx.spawn(async (task) => {
      await work();
      task.notify();
    });
  }

  render(cx: Context): Element {
    this.drawnUpdate = this.o.updates?.revision() ?? -1;
    const color = palette();
    const scale = scaleOf(settings());
    const records = this.o.engine.records();
    const groups = groupSessions(
      records,
      spaces()
        .filter((s) => s.machine === null)
        .map((s) => ({ id: s.id, name: s.name })),
    );
    const freed = memoryFreedText(records);
    const updateBar = this.updateBar(color, scale);
    const footer = this.footer(color, scale);
    const header = h_flex()
      .h(42)
      .flex_none()
      .px(14)
      .gap(8)
      .items_center()
      .border_b(1)
      .border_color(color("border"))
      .child(div().font_semibold().child(t("panel.title")))
      .child(
        div()
          .flex_1()
          .min_w(0)
          .truncate()
          .text_right()
          .text_size(12)
          .text_color(color("dim"))
          .child(freed ?? ""),
      )
      .when(this.o.mode === "window", (el) =>
        el.child(
          div()
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
            .child(icon("close", 12, color("dim"))),
        ),
      );

    const body = v_flex()
      .id("panel-list")
      .flex_1()
      .min_h(0)
      .overflow_y_scrollbar()
      .py(6)
      .when(groups.length === 0, (el) =>
        el.child(div().p(14).text_size(12).text_color(color("dim")).child(t("panel.empty"))),
      )
      .children(groups.flatMap((g) => this.group(g, color, scale, cx)));

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
      .when(updateBar !== null, (el) => el.child(updateBar ?? div()))
      .child(body)
      .when(footer !== null, (el) => el.child(footer ?? div()));
  }

  /** The line on top: a release to update to, an update under way, or how the last one ended. */
  private updateBar(color: Palette, scale: Scale): Element | null {
    const u = this.o.updates;
    if (u === undefined || u === null) {
      return null;
    }
    const line = updateLine(u.state(), u.version, u.available(), u.busy(), u.backupPath);
    if (line === null) {
      return null;
    }
    const mode = fitUpdateLine(line, this.size.width, scale, uiMeasure);
    const tone =
      line.tone === "accent" ? "accent" : line.tone === "done" ? "done" : line.tone === "error" ? "blocked" : "working";
    const run = (action: LineAction): Promise<unknown> => {
      if (action === "update") {
        return u.update();
      }
      if (action === "rollBack") {
        return u.rollback();
      }
      if (action === "dismiss") {
        return u.dismiss();
      }
      u.whatsNew();
      return Promise.resolve();
    };
    const button = (action: LineAction): Element => {
      const label = t(ACTION_LABEL[action]);
      const folded = mode === "icon" || action === "dismiss";
      return h_flex()
        .id(`update-${action}`)
        .flex_none()
        .h(20)
        .px(folded ? 4 : BUTTON_PAD_X)
        .items_center()
        .rounded(5)
        .text_size(BUTTON_TEXT)
        .text_color(color(action === "update" ? "accent" : "muted"))
        .cursor_pointer()
        .hover((s) => s.bg(color("hover")))
        .tooltip(label)
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => this.act(() => run(action), cx))
        .child(
          folded ? icon(ACTION_ICON[action], BUTTON_ICON, color(action === "update" ? "accent" : "muted")) : label,
        );
    };
    const lead = line.spinning
      ? svg(`${ICONS}/spinner.svg`).size(LINE_LEAD).flex_none().text_color(color(tone)).spin(900)
      : h_flex()
          .size(LINE_LEAD)
          .flex_none()
          .items_center()
          .justify_center()
          .child(div().size(6).rounded(3).bg(color(tone)));
    return h_flex()
      .id("update-line")
      .flex_none()
      .px(LINE_PAD_X)
      .py(6)
      .gap(LINE_GAP)
      .items_center()
      .border_b(1)
      .border_color(color("border"))
      .text_size(LINE_TEXT)
      .child(lead)
      .child(
        div()
          .id("update-text")
          .flex_1()
          .min_w(0)
          .truncate()
          .text_color(color("foreground"))
          .when(line.detail !== null, (el) => el.tooltip(line.detail ?? ""))
          .child(line.text),
      )
      .children(line.actions.map(button));
  }

  /** The bottom: this build's version and the switch for the daily check. */
  private footer(color: Palette, scale: Scale): Element | null {
    const u = this.o.updates;
    if (u === undefined || u === null) {
      return null;
    }
    const on = u.state().checks;
    const mode = fitFooter(this.size.width, scale, uiMeasure);
    const box = h_flex()
      .size(FOOTER_BOX)
      .flex_none()
      .items_center()
      .justify_center()
      .rounded(3)
      .border(1)
      .border_color(color(on ? "accent" : "border"))
      .when(on, (el) => el.bg(color("accent")).child(icon("check", FOOTER_BOX - 2, color("accent_foreground"))));
    return h_flex()
      .id("update-footer")
      .flex_none()
      .h(28)
      .px(FOOTER_PAD_X)
      .gap(LINE_GAP)
      .items_center()
      .border_t(1)
      .border_color(color("border"))
      .text_size(FOOTER_TEXT)
      .text_color(color("dim"))
      .child(
        div()
          .flex_1()
          .min_w(0)
          .truncate()
          .child(t("update.footer.version", { version: u.version })),
      )
      .child(
        h_flex()
          .id("update-checks")
          .flex_none()
          .gap(LINE_GAP)
          .items_center()
          .cursor_pointer()
          .tooltip(t("update.footer.checks"))
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click((_e, cx) => this.act(() => u.setChecks(!on), cx))
          .child(box)
          .when(mode !== "icon", (el) => el.child(mode === "icon" ? "" : t(FOOTER_LABEL[mode]))),
      );
  }

  private group(g: Group, color: Palette, scale: Scale, cx: Context): Element[] {
    const head = h_flex()
      .px(12)
      .pt(8)
      .pb(2)
      .gap(8)
      .items_center()
      .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(color("dim")).child(g.name.toUpperCase()))
      .when(g.resumable.length > 0, (el) =>
        el.child(
          h_flex()
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
            .child(t("panel.resumeAll")),
        ),
      );
    return [head, ...g.rows.map((r) => this.row(r, color, scale, cx))];
  }

  private row(rec: SessionRecord, color: Palette, scale: Scale, cx: Context): Element {
    const { engine, host, ports } = this.o;
    const agentName = engine.adapter(rec.agent).displayName;
    const used = usedNow(rec, this.used);
    const memory = rowMemory(rec, used);
    const fit = fitRow(rec, this.size.width, memory?.text ?? null, ports.sep, uiMeasure, scale);
    const checking = engine.checking(rec.key);
    const shown = shownState(rec, checking);
    const title = rec.info.title ?? agentName;

    const items: Element[] = [];
    fit.segs.forEach((seg, i) => {
      if (items.length > 0) {
        items.push(div().flex_none().text_color(color("dim")).child(SEPARATOR.trim()));
      }
      const glyph = seg.key === "branch" ? "branch" : seg.key === "folder" ? "folder" : null;
      // The last item gives way first: with a UI font wider than the widths fitRow
      // counted, it ends in "…" instead of being cut by the line's edge.
      const last = i === fit.segs.length - 1;
      items.push(
        h_flex()
          .when(!last, (el) => el.flex_none())
          .when(last, (el) => el.flex_shrink(1).min_w(0))
          .gap(4)
          .items_center()
          .text_color(color(seg.key === "id" ? "dim" : "muted"))
          .when(glyph !== null, (el) => el.child(icon(glyph ?? "folder", 12, color("dim"))))
          .child(div().min_w(0).truncate().child(seg.text)),
      );
    });
    if (fit.hidden > 0) {
      items.push(
        div()
          .flex_none()
          .px(6)
          .rounded(8)
          .border(1)
          .border_color(color("border"))
          .text_size(ROW_SMALL_TEXT)
          .text_color(color("dim"))
          .child(`+${fit.hidden}`),
      );
    }

    // Sleep for a running agent, Resume for a sleeping one; nothing while it is changing or not known yet.
    const action = checking
      ? null
      : rec.state === "running" || rec.state === "working"
        ? { name: "moon", label: t("panel.sleep"), run: () => engine.sleep(rec.key) }
        : rec.state === "asleep" || rec.state === "interrupted" || rec.state === "error"
          ? {
              name: "play",
              label: t(rec.state === "error" ? "strip.retry" : "strip.resume"),
              run: () => engine.resume(rec.key),
            }
          : null;
    // The agent's icon is centred on the title's line, not put at the row's top: a box
    // as tall as that line, beside it (the second line stays indented under the title).
    const tile = h_flex()
      .h(ROW_TITLE_PX)
      .flex_none()
      .items_center()
      .child(agentIcon(rec.agent, color, cx, ports.now()));

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
        // Where it is now, not where the record last said: a tab moves between spaces, or is gone.
        const place = engine.placeNow(rec.key);
        if (place === null) {
          host.notify(t("notice.tabGone"), "info");
          return;
        }
        host.runOnScreen("space.select", { id: place.spaceId });
        host.runOnScreen("tab.select", { id: place.tabId });
      })
      .on_mouse_move((e, cx) =>
        hoverPopup.enter(
          { key: rec.key, kind: "row", rect: anchorRect(e), usedMb: used },
          () => factsFor(engine, ports, rec.key, used),
          cx,
        ),
      )
      .on_hover((over, cx) => {
        if (!over) {
          hoverPopup.leave(cx);
        }
      })
      .child(tile)
      .child(
        v_flex()
          .flex_1()
          .min_w(0)
          .gap(1)
          .child(
            h_flex()
              .h(ROW_TITLE_PX)
              .gap(8)
              .items_center()
              .child(div().flex_1().min_w(0).truncate().text_size(12.5).text_color(color("foreground")).child(title))
              .child(stateMark(shown.word, color(TONE_COLOR[shown.tone]), shown.moving).text_size(11))
              .when(action !== null, (el) =>
                el.child(
                  div()
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
                    .child(icon(action?.name ?? "moon", 12, color("muted"))),
                ),
              ),
          )
          .child(
            h_flex()
              .gap(8)
              .items_center()
              .child(
                h_flex()
                  .flex_1()
                  .min_w(0)
                  .gap(ROW_ITEM_GAP)
                  .items_center()
                  .overflow_hidden()
                  .whitespace_nowrap()
                  .text_size(ROW_TEXT)
                  .children(items),
              )
              .when(memory !== null, (el) =>
                el.child(
                  h_flex()
                    .flex_none()
                    .gap(4)
                    .items_center()
                    .text_size(ROW_SMALL_TEXT)
                    .text_color(color(memory?.kind === "freed" ? "accent" : "muted"))
                    .child(
                      memory?.kind === "freed"
                        ? icon("moon", 11, color("accent"))
                        : div().size(6).flex_none().rounded(3).border(1.5).border_color(color("done")),
                    )
                    .child(memory?.text ?? ""),
                ),
              ),
          ),
      );
  }
}
