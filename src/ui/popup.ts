// The popup over a row of the Sessions list or the strip of a sleeping tab:
// compact (~340 px), opened by hovering, with the facts of
// `sessionsModel.popupFacts`. `HoverPopup` decides when it opens and closes
// (about 350 ms after the pointer settles, at once when it moves to a
// neighbour, a moment after it leaves); `PopupView` draws it as an overlay.
//
// Colours only from theme(); the only motion is Herdr's own popup frame.

import { h_flex, v_flex } from "gpui-base";
import { type Context, div, type Element, type MouseMoveEvent } from "gpui-kit";
import { closeOverlay, openOverlay, settings } from "herdr";
import type { SessionKey } from "../core/model.ts";
import { scaleOf, type WindowPx, type WindowRect, type WindowSize, windowPx } from "../core/scale.ts";
import { t } from "../i18n/index.ts";
import type { Ports } from "../platform/ports.ts";
import { type Engine, MOD_NAME } from "../runtime/engine.ts";
import { agentIcon, icon, palette, stateMark, TONE_COLOR } from "./kit.ts";
import {
  FACT_GAP_PX,
  FACT_ROW_PX,
  POPUP_WIDTH,
  type PopupFacts,
  type PopupSize,
  popupFacts,
  popupPosition,
  popupSize,
  QUOTE_GAP_PX,
  QUOTE_LABEL_PX,
  QUOTE_LINE_PX,
  QUOTE_TEXT,
  TITLE_LINE_PX,
  TITLE_TEXT,
} from "./sessionsModel.ts";

/** How long the pointer rests on a row or a strip before its popup opens. */
export const SHOW_DELAY_MS = 350;
/** From one row to the next while a popup is open. */
const NEIGHBOUR_DELAY_MS = 60;
/** How long a popup stays after the pointer left its anchor, so the pointer can cross the gap to it. */
const HIDE_DELAY_MS = 180;
const FALLBACK_VIEWPORT: WindowSize = { width: windowPx(1600), height: windowPx(900) };

export interface PopupSpec {
  key: SessionKey;
  kind: "row" | "strip";
  /** The anchor's rectangle, in window px. */
  rect: WindowRect;
  /** A running session's memory, measured by whoever draws the list; null for the rest. */
  usedMb: number | null;
}

/** The anchor's rectangle from a mouse-move over it (Herdr reports it in window px). */
export function anchorRect(e: MouseMoveEvent): WindowRect {
  return {
    left: windowPx(e.position.x - e.local_position.x),
    top: windowPx(e.position.y - e.local_position.y),
    width: windowPx(e.bounds.width),
    height: windowPx(e.bounds.height),
  };
}

function viewport(): WindowSize {
  try {
    const size = window.viewport_size();
    return size.width > 0 && size.height > 0
      ? { width: windowPx(size.width), height: windowPx(size.height) }
      : FALLBACK_VIEWPORT;
  } catch {
    return FALLBACK_VIEWPORT;
  }
}

/** The zoom Herdr applies now. */
function scaleNow() {
  try {
    return scaleOf(settings());
  } catch {
    return scaleOf(null);
  }
}

/** One per window: who is hovered, which popup is open, and the timers between them. */
export class HoverPopup {
  private anchor: SessionKey | null = null;
  private overlay: string | null = null;
  private overPopup = false;
  /** Bumped by every pointer event: a pending open or close that finds it changed does nothing. */
  private epoch = 0;

  /** The pointer is over an anchor (called on every move; cheap when nothing changes). */
  enter(spec: PopupSpec, facts: () => PopupFacts | null, cx: Context): void {
    if (this.anchor === spec.key) {
      return;
    }
    this.anchor = spec.key;
    const mine = ++this.epoch;
    const room = viewport();
    const delay = this.overlay !== null ? NEIGHBOUR_DELAY_MS : SHOW_DELAY_MS;
    cx.spawn(async (task) => {
      await task.sleep(delay);
      if (mine !== this.epoch) {
        return;
      }
      const shown = facts();
      if (shown === null) {
        return;
      }
      const scale = scaleNow();
      const size = popupSize(shown, room, scale);
      this.close();
      this.overlay = openPopup(spec, popupPosition(spec.rect, spec.kind, size, room, scale), size);
    });
  }

  /** The pointer left an anchor: close the popup shortly, unless the pointer reaches it. */
  leave(cx: Context): void {
    this.anchor = null;
    this.hideSoon(cx);
  }

  /** The pointer is on the popup itself. */
  overPopupEnter(): void {
    this.overPopup = true;
    this.epoch++;
  }

  overPopupLeave(cx: Context): void {
    this.overPopup = false;
    this.hideSoon(cx);
  }

  /** The popup's overlay went (Esc, a click beside it, or our own close). */
  closed(overlay: string | null): void {
    if (overlay !== null && overlay === this.overlay) {
      this.overlay = null;
      this.overPopup = false;
    }
  }

  private hideSoon(cx: Context): void {
    const mine = ++this.epoch;
    cx.spawn(async (task) => {
      await task.sleep(HIDE_DELAY_MS);
      if (mine === this.epoch && !this.overPopup && this.anchor === null) {
        this.close();
      }
    });
  }

  private close(): void {
    if (this.overlay !== null) {
      closeOverlay(this.overlay);
      this.overlay = null;
      this.overPopup = false;
    }
  }
}

/** Shared by the copies of this build in one window. */
export const hoverPopup = new HoverPopup();

/** Opens the popup overlay for a spec at a place; its overlay id, or null. */
export function openPopup(spec: PopupSpec, at: { x: WindowPx; y: WindowPx }, size: PopupSize): string | null {
  try {
    return openOverlay({
      mod: MOD_NAME,
      props: { role: "popup", key: spec.key, usedMb: spec.usedMb, rows: size.rows },
      kind: "popup",
      at,
      width: size.width,
      height: size.height,
    });
  } catch {
    return null;
  }
}

/** The popup's facts for a session, as the drawing needs them. */
export function factsFor(engine: Engine, ports: Ports, key: SessionKey, usedMb: number | null): PopupFacts | null {
  const rec = engine.record(key);
  if (rec === null) {
    return null;
  }
  return popupFacts(rec, {
    agentName: engine.adapter(rec.agent).displayName,
    home: ports.home(),
    sep: ports.sep,
    now: ports.now(),
    usedMb,
    checking: engine.checking(key),
  });
}

/** Role "popup": the facts of one session, drawn in the overlay `hoverPopup` opened. */
export class PopupView {
  private copied: string | null = null;
  private readonly engine: Engine;
  private readonly ports: Ports;
  private readonly key: SessionKey;
  private readonly overlay: string | null;
  private readonly usedMb: number | null;
  /** Fact rows to draw (popupSize: the window's height); all of them by default. */
  private readonly rows: number;

  constructor(
    engine: Engine,
    ports: Ports,
    key: SessionKey,
    overlay: string | null,
    usedMb: number | null,
    rows = Number.POSITIVE_INFINITY,
  ) {
    this.engine = engine;
    this.ports = ports;
    this.key = key;
    this.overlay = overlay;
    this.usedMb = usedMb;
    this.rows = rows;
  }

  close(): void {
    hoverPopup.closed(this.overlay);
  }

  render(cx: Context): Element {
    const color = palette();
    const facts = factsFor(this.engine, this.ports, this.key, this.usedMb);
    const root = v_flex()
      .id("popup-root")
      .size_full()
      .p(12)
      .gap(9)
      // Every text names its size, so Herdr's UI font size cannot reflow the popup it measured.
      .text_size(12)
      .bg(color("popover"))
      .text_color(color("muted"))
      .on_hover((over, cx) => (over ? hoverPopup.overPopupEnter() : hoverPopup.overPopupLeave(cx)));
    if (facts === null) {
      return root;
    }
    const tone = color(TONE_COLOR[facts.tone]);
    // Whole lines, wrapped by sessionsModel, the last ending in "…" when the text goes on.
    const quote = (label: string, lines: string[]): Element =>
      h_flex()
        .gap(QUOTE_GAP_PX)
        .items_start()
        .text_size(QUOTE_TEXT)
        .child(div().w(QUOTE_LABEL_PX).flex_none().text_color(color("dim")).child(label))
        .child(
          v_flex()
            .flex_1()
            .min_w(0)
            .children(
              lines.map((line) => div().h(QUOTE_LINE_PX).line_height(`${QUOTE_LINE_PX}px`).truncate().child(line)),
            ),
        );

    root.child(
      h_flex()
        .gap(7)
        .items_center()
        .text_size(11.5)
        .child(agentIcon(facts.agent, color, cx, this.ports.now()))
        .child(div().child(facts.agentName))
        .child(stateMark(facts.state, tone, facts.moving).ml_auto().px(8).rounded(10).bg(color("raised"))),
    );
    if (facts.titleLines.length > 0) {
      // Whole lines, wrapped by sessionsModel (the popup's height counts them);
      // the full name in a tooltip when even three lines cut it.
      root.child(
        v_flex()
          .id("popup-title")
          .flex_none()
          .text_size(TITLE_TEXT)
          .font_semibold()
          .text_color(color("foreground"))
          .when(facts.titleCut && facts.title !== null, (el) => el.tooltip(facts.title ?? ""))
          .children(
            facts.titleLines.map((line) =>
              div().h(TITLE_LINE_PX).line_height(`${TITLE_LINE_PX}px`).truncate().child(line),
            ),
          ),
      );
    }
    if (facts.promptLines.length > 0) {
      root.child(quote(t("popup.prompt"), facts.promptLines));
    }
    if (facts.replyLines.length > 0) {
      root.child(quote(t("popup.reply"), facts.replyLines));
    }
    if (facts.context !== null || facts.tokens !== null) {
      const meter = POPUP_WIDTH - 24 - 2;
      root.child(
        v_flex()
          .gap(4)
          .text_size(11.5)
          .line_height("16px")
          .when(facts.context !== null, (el) =>
            el
              .child(
                h_flex()
                  .justify_between()
                  .gap(8)
                  .child(div().child(facts.context?.label ?? ""))
                  .child(
                    div()
                      .text_color(color("dim"))
                      .child(facts.context?.detail ?? ""),
                  ),
              )
              .when(facts.context?.pct !== null, (el) =>
                el.child(
                  div()
                    .h(4)
                    .rounded(2)
                    .bg(color("selected"))
                    .child(
                      div()
                        .h(4)
                        .rounded(2)
                        .bg(color("accent"))
                        .w((meter * (facts.context?.pct ?? 0)) / 100),
                    ),
                ),
              ),
          )
          .when(facts.tokens !== null, (el) =>
            el.child(
              h_flex()
                .justify_between()
                .gap(8)
                .child(div().child(t("popup.tokens")))
                .child(
                  div()
                    .text_color(color("dim"))
                    .child(facts.tokens ?? ""),
                ),
            ),
          ),
      );
    }
    root.child(
      v_flex()
        .gap(FACT_GAP_PX)
        .pt(8)
        .border_t(1)
        .border_color(color("border"))
        .text_size(11.5)
        .children(
          facts.rows.slice(0, this.rows).map((row) =>
            h_flex()
              .h(FACT_ROW_PX)
              .line_height(`${FACT_ROW_PX}px`)
              .gap(12)
              .items_center()
              .child(div().w(66).flex_none().text_color(color("dim")).child(row.label))
              .child(div().flex_1().min_w(0).truncate().child(row.value))
              .when(row.copy !== undefined, (el) => {
                const text = row.copy ?? "";
                const done = this.copied === row.id;
                return el.child(
                  div()
                    .id(`copy-${row.id}`)
                    .flex_none()
                    .p(2)
                    .rounded(4)
                    .cursor_pointer()
                    .hover((s) => s.bg(color("hover")))
                    .tooltip(
                      done ? t("popup.copied") : row.id === "folder" ? t("popup.copyFolder") : t("popup.copySession"),
                    )
                    .on_click((_e, cx) => {
                      cx.write_to_clipboard(text);
                      this.copied = row.id;
                      cx.notify();
                    })
                    .child(icon(done ? "check" : "copy", 12, color(done ? "done" : "dim"))),
                );
              }),
          ),
        ),
    );
    return root;
  }
}
