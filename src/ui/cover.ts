// The cover (role "cover"): the other child of the stack the living layout
// puts the tab block in (core/layout.ts). The engine shows it for the moment a
// Sleep or a Resume rearranges a tab's panes (Engine.raiseCover), so the split
// Herdr makes to place a pane is never on screen. It draws what the tab will
// show: the session's sleeping pane, in the frame Herdr gives a pane alone in
// its tab (the tab block's `pane` look: border, focus colour, radius, header).

import { h_flex, v_flex } from "gpui-base";
import { type Context, div, type Element } from "gpui-kit";
import { settings, theme } from "herdr";
import type { SessionKey, SessionRecord } from "../core/model.ts";
import { reportedSize, scaleOf, type WindowSize, windowPx } from "../core/scale.ts";
import type { Ports } from "../platform/ports.ts";
import { COVER_KEY, type Engine, settleCover } from "../runtime/engine.ts";
import type { Host } from "../runtime/host.ts";
import { paneSizes, SleepPane } from "./sleepPane.ts";

/** How often the cover looks whether its flow is through: every frame. */
const FRAME_MS = 16;

/** Herdr's look for a pane alone in its tab, from the tab block's `pane`; the shipped main.json's when unsaid. */
interface Frame {
  radius: number;
  background: string;
  border: { width: number; color: string };
  header: { height: number; position: "top" | "bottom" } | null;
}

const SHIPPED: Frame = {
  radius: 10,
  background: "background",
  // A pane put to sleep or woken had the focus: its border is the focus one.
  border: { width: 1, color: "accent" },
  header: { height: 30, position: "top" },
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const num = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
const word = (value: unknown, fallback: string): string => (typeof value === "string" ? value : fallback);

/** The tab block's `pane` look in a layout tree. */
export function frameOf(layout: unknown): Frame {
  let spec: Record<string, unknown> | null = null;
  const visit = (node: unknown): void => {
    if (spec !== null || !isObject(node)) {
      return;
    }
    const content = node["content"];
    if (isObject(content) && content["tab"] === "active") {
      spec = isObject(content["pane"]) ? content["pane"] : {};
      return;
    }
    const children = node["children"];
    if (Array.isArray(children)) {
      children.forEach(visit);
    }
  };
  visit(layout);
  const pane: Record<string, unknown> = spec ?? {};
  const focus = isObject(pane["focus"]) ? pane["focus"] : null;
  const border = isObject(pane["border"]) ? pane["border"] : null;
  const header = pane["header"];
  return {
    radius: num(pane["radius"], SHIPPED.radius),
    background: word(pane["background"], SHIPPED.background),
    border: {
      width: num(focus?.["width"] ?? border?.["width"], SHIPPED.border.width),
      color: word(focus?.["color"] ?? border?.["color"], SHIPPED.border.color),
    },
    header:
      spec === null
        ? SHIPPED.header
        : isObject(header)
          ? { height: num(header["height"], 30), position: header["position"] === "bottom" ? "bottom" : "top" }
          : null,
  };
}

export class CoverView {
  /** As Herdr reports it: window px. */
  private size: WindowSize = { width: windowPx(0), height: windowPx(0) };
  /** One sleeping pane drawing per session, so each keeps the size it measured. */
  private readonly panes = new Map<SessionKey, SleepPane>();
  /** This copy watches, every frame, for the flow it covers to be through (settleCover). */
  private watching = false;
  private readonly engine: Engine;
  private readonly host: Host;
  private readonly ports: Ports;

  constructor(engine: Engine, host: Host, ports: Ports) {
    this.engine = engine;
    this.host = host;
    this.ports = ports;
  }

  /** What a flow asked the cover to show: the session and its record as its pane draws it. */
  private held(): { key: SessionKey; rec: SessionRecord } | null {
    const value = this.host.shared(COVER_KEY);
    if (!isObject(value) || typeof value["key"] !== "string" || !isObject(value["rec"])) {
      return null;
    }
    return { key: value["key"] as SessionKey, rec: value["rec"] as unknown as SessionRecord };
  }

  render(cx: Context): Element {
    const th = theme();
    const color = (name: string) => (th[name] ?? "#00000000") as never;
    const frame = frameOf(this.host.windowLayout());
    const root = div()
      .id("cover-root")
      .size_full()
      .on_size_change((size, cx) => {
        this.size = reportedSize(size);
        cx.notify();
      });
    const held = this.held();
    if (held === null) {
      return root;
    }
    if (!this.watching) {
      this.watching = true;
      cx.spawn(async (task) => {
        try {
          // Herdr lists the tab's panes as they are after each update: once the flow's pane stands alone
          // there, the next frame may show the tabs again.
          while (this.held() !== null && !settleCover(this.host, this.ports.now())) {
            await task.sleep(FRAME_MS);
          }
        } finally {
          this.watching = false;
        }
      });
    }
    let pane = this.panes.get(held.key);
    if (pane === undefined) {
      pane = new SleepPane(this.engine, this.host, this.ports, held.key, () => this.held()?.rec ?? null);
      this.panes.set(held.key, pane);
    }
    // The body's size in window px, so the first frame already lays the screen out on its rows.
    const zoom = scaleOf(settings()).zoom;
    const chrome = (2 * frame.border.width + (frame.header?.height ?? 0)) * zoom;
    const bodySize = {
      width: windowPx(Math.max(0, this.size.width - 2 * frame.border.width * zoom)),
      height: windowPx(Math.max(0, this.size.height - chrome)),
    };
    pane.sizeTo(bodySize);
    if (this.size.height > 0) {
      paneSizes.set(held.key, bodySize);
    }
    const header =
      frame.header === null
        ? null
        : h_flex()
            .id("cover-header")
            .flex_none()
            .h(frame.header.height)
            .px(10)
            .gap(8)
            .items_center()
            .bg(color("background"))
            .when(frame.header.position === "top", (el) => el.border_b(1))
            .when(frame.header.position === "bottom", (el) => el.border_t(1))
            .border_color(color("border"))
            .text_size(12)
            // A mod pane's header names the mod (Herdr's `pane` header: the pane's title).
            .child(div().flex_none().truncate().font_medium().text_color(color("foreground")).child("suspender"));
    const body = div().flex_1().min_h(0).relative().child(pane.render(cx));
    return root.child(
      v_flex()
        .id("cover-frame")
        .size_full()
        .rounded(frame.radius)
        .border(frame.border.width)
        .border_color(color(frame.border.color))
        .bg(color(frame.background))
        .overflow_hidden()
        .when(header !== null && frame.header?.position === "top", (el) => el.child(header ?? div()))
        .child(body)
        .when(header !== null && frame.header?.position === "bottom", (el) => el.child(header ?? div())),
    );
  }
}
