// The sleep pill (role "pill"): a floating drawer over the tab, right edge.
// At rest only its moon shows; on hover Herdr slides the rest out and it reads
// "Sleep · <agent>" for the agent in focus. With no agent in focus it draws
// nothing. Herdr frames it, lets people drag it and remembers the place; the
// slide is Herdr's own (`peek`), so there is no timer here. Colours only from
// theme().

import { h_flex } from "gpui-base";
import { type Context, div, type Element } from "gpui-kit";
import { detectAgent } from "../adapters/index.ts";
import { PILL_EDGE_PAD, PILL_HEIGHT, PILL_ICON } from "../core/scale.ts";
import { t } from "../i18n/index.ts";
import type { Engine } from "../runtime/engine.ts";
import { type Host, toTerminalView } from "../runtime/host.ts";
import { icon, palette } from "./kit.ts";
import { pillAgent } from "./sessionsModel.ts";

export class PillView {
  private readonly engine: Engine;
  private readonly host: Host;
  /** The terminal the pill offered last: a press must act on it even if focus moved by then. */
  private offered: string | null = null;

  constructor(engine: Engine, host: Host) {
    this.engine = engine;
    this.host = host;
  }

  render(_cx: Context): Element {
    const focus = this.host.focused()?.terminal ?? null;
    const term = focus === null ? null : (this.host.terminals().find((x) => x.address === focus) ?? null);
    const agent = pillAgent(term, (x) => detectAgent(toTerminalView(x))?.id ?? null);
    if (term === null || agent === null) {
      this.offered = null;
      return div();
    }
    this.offered = term.address;
    const color = palette();
    // On the right edge the moon is on the edge side, so it is the part that peeks: centred in
    // the peek, which is as wide as the framed row is tall (a square button, core/scale.ts).
    return h_flex()
      .id("sleep-pill")
      .h(PILL_HEIGHT)
      .pl(10)
      .pr(PILL_EDGE_PAD)
      .gap(8)
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
