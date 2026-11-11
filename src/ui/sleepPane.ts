// The sleeping tab (role "sleep", props.key): the agent's last screen, dimmed,
// and a strip at the bottom with what the session is and its button(s), as
// variant B of sleep-ui.html with the strip of session-info.html v4. Also the
// question for a working agent (role "confirm"), opened as a dialog.
//
// Colours only from theme(); the only motion is the native spinner.

import { h_flex, v_flex } from "gpui-base";
import { type AsyncContext, type Color, type Context, div, type Element, svg } from "gpui-kit";
import { closeOverlay, settings, theme } from "herdr";
import { badgeText, fitSegments, SEPARATOR } from "../core/fit.ts";
import type { SessionKey, SessionRecord } from "../core/model.ts";
import { t } from "../i18n/index.ts";
import type { Ports } from "../platform/ports.ts";
import type { Choice, Engine } from "../runtime/engine.ts";
import type { Host } from "../runtime/host.ts";
import { measureAt, screenLines, stripActions, stripSegments, stripStatus, wakeSteps } from "./format.ts";
import { anchorRect, factsFor, hoverPopup } from "./popup.ts";

const ICONS = "mods/suspender/icons";
const STRIP_TEXT = 12.5;
const STATUS_TEXT = 12;
/** Room the strip keeps for the moon, gaps and padding besides the info line and the buttons. */
const STRIP_CHROME_PX = 60;
const BUTTON_PX = 96;
/** Lines of the last screen when the pane's height is not known yet. */
const DEFAULT_LINES = 30;

/** A theme colour by name (theme() names every one the mod uses; a missing one draws nothing). */
function palette(): (name: string) => Color {
  const th = theme();
  return (name) => (th[name] ?? "#00000000") as Color;
}

const num = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

export class SleepPane {
  private size = { width: 0, height: 0 };
  private shown = false;
  private watching = false;
  private readonly engine: Engine;
  private readonly host: Host;
  private readonly ports: Ports;
  private readonly key: SessionKey;

  constructor(engine: Engine, host: Host, ports: Ports, key: SessionKey) {
    this.engine = engine;
    this.host = host;
    this.ports = ports;
    this.key = key;
  }

  private rec(): SessionRecord | null {
    return this.engine.record(this.key);
  }

  /** Whether this pane's tab is the one on screen. */
  private visible(): boolean {
    const pane = this.rec()?.pane;
    const tab = this.host.panes().find((p) => p.pane === pane)?.tab;
    return this.host.tabs().some((x) => x.id === tab && x.active && x.spaceActive);
  }

  /**
   * Every TICK_MS: once per show, re-read what changed ("+N"); while open
   * elsewhere, look again. Nothing watches the conversation while the strip
   * stays on screen: a session open in another window writes all the time,
   * and every read starts a process on Windows.
   */
  tick(cx: AsyncContext): void {
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
    if (rec.state !== "elsewhere") {
      return;
    }
    const adapter = this.engine.adapter(rec.agent);
    if (adapter.watchOpenness !== undefined) {
      // Claude: its sessions folder says when the other copy closed.
      if (!this.watching) {
        this.watching = true;
        cx.spawn(async (cx) => {
          try {
            while (this.rec()?.state === "elsewhere") {
              await adapter.watchOpenness?.(this.ports);
              await this.engine.recheckElsewhere(this.key);
            }
          } finally {
            this.watching = false;
          }
          cx.notify();
        });
      }
    } else if (visible) {
      // Codex: a process check, only while the strip is on screen (every TICK_MS = 5 s).
      cx.spawn(async (cx) => {
        await this.engine.recheckElsewhere(this.key);
        cx.notify();
      });
    }
  }

  private press(action: string, cx: Context): void {
    cx.spawn(async (cx) => {
      if (action === "resume" || action === "retry") {
        await this.engine.resume(this.key);
      } else if (action === "startNew") {
        await this.engine.startNew(this.key);
      } else if (action === "forget") {
        await this.engine.forget(this.key);
      }
      cx.notify();
    });
  }

  render(_cx: Context): Element {
    const color = palette();
    const rec = this.rec();
    const look = settings();
    const fontSize = num(look["font_size"], 14);
    const fontFamily = typeof look["font_family"] === "string" ? look["font_family"] : "monospace";
    const root = v_flex()
      .id("sleep-root")
      .size_full()
      .bg(color("background"))
      .on_size_change((size, cx) => {
        this.size = size;
        cx.notify();
      });
    if (rec === null) {
      return root;
    }

    const lineHeight = fontSize * 1.45;
    const rows = this.size.height > 0 ? Math.max(0, Math.floor((this.size.height - 70) / lineHeight)) : DEFAULT_LINES;
    const screen = v_flex()
      .flex_1()
      .min_h(0)
      .overflow_hidden()
      .px(14)
      .py(8)
      .font_family(fontFamily)
      .text_size(fontSize)
      .text_color(color("foreground"))
      .opacity(0.3)
      .children(
        screenLines(rec.lastScreen, rows).map((line) =>
          div()
            .whitespace_nowrap()
            .child(line === "" ? " " : line),
        ),
      );

    return root.child(screen).child(this.strip(rec));
  }

  private strip(rec: SessionRecord): Element {
    const color = palette();
    const agentName = this.engine.adapter(rec.agent).displayName;
    const busy = this.engine.busy(this.key) || rec.state === "waking" || rec.state === "stopping";
    const actions = stripActions(rec, busy);

    // Line 1: title · branch · model · folder (+N), cut from the end as in the mockup.
    const segs = stripSegments(rec.info, this.ports.sep);
    const width = this.size.width - STRIP_CHROME_PX - actions.length * BUTTON_PX;
    const fit = fitSegments(rec.info.title, segs, Math.max(0, width), measureAt(STRIP_TEXT));
    const icon: Record<string, string> = { branch: "branch", model: "chip", folder: "folder" };
    const items: Element[] = [];
    if (fit.title && rec.info.title) {
      items.push(
        div().flex_shrink(1).min_w(0).truncate().font_semibold().text_color(color("foreground")).child(rec.info.title),
      );
    }
    for (const seg of segs.filter((s) => fit.shown.includes(s.key))) {
      if (items.length > 0) {
        items.push(div().flex_none().text_color(color("dim")).child(SEPARATOR.trim()));
      }
      items.push(
        h_flex()
          .flex_none()
          .gap(4)
          .items_center()
          .child(
            svg(`${ICONS}/${icon[seg.key] ?? "folder"}.svg`)
              .size(12)
              .text_color(color("dim")),
          )
          .child(seg.text),
      );
    }
    if (fit.hidden > 0) {
      items.push(
        div()
          .flex_none()
          .px(6)
          .rounded(8)
          .border(1)
          .border_color(color("border"))
          .text_size(11)
          .text_color(color("dim"))
          .child(badgeText(fit.hidden).trim()),
      );
    }

    // Line 2: the state, the wake's steps, or the error.
    const status =
      rec.state === "waking"
        ? h_flex()
            .gap(8)
            .items_center()
            .child(svg(`${ICONS}/spinner.svg`).size(12).text_color(color("accent")).spin(900))
            .children(
              wakeSteps(this.engine.progress(this.key)).map((s) =>
                div()
                  .text_color(color(s.state === "now" ? "foreground" : s.state === "done" ? "muted" : "dim"))
                  .child(s.label),
              ),
            )
        : div()
            .truncate()
            .text_color(color(rec.state === "error" || rec.state === "missing" ? "blocked" : "dim"))
            .child(
              this.engine.sleepingWhenDone(this.key)
                ? t("strip.sleepingWhenDone", { agent: agentName })
                : stripStatus(rec, {
                    now: this.ports.now(),
                    agentName,
                    progress: this.engine.progress(this.key),
                    fresh: this.engine.freshness(this.key),
                  }),
            );

    const buttons = actions.map((a, i) =>
      h_flex()
        .id(`strip-${a.action}`)
        .flex_none()
        .h(28)
        .px(12)
        .gap(7)
        .items_center()
        .rounded(7)
        .text_size(STRIP_TEXT)
        .font_semibold()
        .when(i === 0, (el) =>
          el.bg(color(a.enabled ? "solid" : "raised")).text_color(color(a.enabled ? "solid_foreground" : "dim")),
        )
        .when(i > 0, (el) =>
          el
            .border(1)
            .border_color(color("border"))
            .text_color(color(a.enabled ? "muted" : "dim")),
        )
        .when(a.enabled, (el) =>
          el
            .cursor_pointer()
            .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
            .on_click((_e, cx) => this.press(a.action, cx)),
        )
        .when(i === 0 && a.action === "resume", (el) => el.child(svg(`${ICONS}/play.svg`).size(11)))
        .child(a.label),
    );

    return (
      v_flex()
        .id("strip")
        // Hovering the strip opens the session's popup (popup.ts decides when).
        .on_mouse_move((e, cx) =>
          hoverPopup.enter(
            { key: this.key, kind: "strip", rect: anchorRect(e), usedMb: null },
            () => factsFor(this.engine, this.ports, this.key, null),
            cx,
          ),
        )
        .on_hover((over, cx) => {
          if (!over) {
            hoverPopup.leave(cx);
          }
        })
        .flex_none()
        .bg(color("chrome"))
        .border_t(1)
        .border_color(color("border"))
        .pl(12)
        .pr(10)
        .py(8)
        .gap(3)
        .child(
          h_flex()
            .gap(10)
            .items_center()
            .child(
              svg(`${ICONS}/moon.svg`)
                .size(14)
                .flex_none()
                .text_color(color(rec.state === "interrupted" ? "working" : "accent")),
            )
            .child(
              h_flex()
                .flex_1()
                .min_w(0)
                .gap(8)
                .items_center()
                .overflow_hidden()
                .whitespace_nowrap()
                .text_size(STRIP_TEXT)
                .text_color(color("muted"))
                .children(items),
            )
            .children(buttons),
        )
        .child(h_flex().pl(24).text_size(STATUS_TEXT).child(status))
    );
  }
}

/** "{agent} is still answering": Sleep when done / Interrupt and sleep / Cancel. Closing it any other way is Cancel. */
export class ConfirmDialog {
  private answered = false;
  private readonly engine: Engine;
  private readonly key: SessionKey;
  private readonly overlay: string | null;

  constructor(engine: Engine, key: SessionKey, overlay: string | null) {
    this.engine = engine;
    this.key = key;
    this.overlay = overlay;
  }

  /**
   * The answer, from a click or a command. Only recorded: the dialog closes at
   * once, and with it its tasks; the copy that asked carries the answer out.
   */
  answer(choice: Choice): void {
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
  close(): void {
    this.answer("cancel");
  }

  render(_cx: Context): Element {
    const color = palette();
    const rec = this.engine.record(this.key);
    const agent = rec === null ? "" : this.engine.adapter(rec.agent).displayName;
    const button = (id: Choice, label: string, primary: boolean): Element =>
      h_flex()
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
      .child(
        h_flex()
          .gap(8)
          .justify_end()
          .child(button("cancel", t("confirm.cancel"), false))
          .child(button("interruptAndSleep", t("confirm.interruptAndSleep"), false))
          .child(button("sleepWhenDone", t("confirm.sleepWhenDone"), true)),
      );
  }
}
