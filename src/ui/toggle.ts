// "Sessions · N": our own button left of Herdr's tab bar (role "toggle", a block
// of the living layout when the live copy of the tab bar cannot be used; the
// copy draws its own button beside Files and Changes). N is how many sessions
// sleep. It opens and closes our right column, drawn like the tab bar's Files
// and Changes buttons. Colours only from theme().

import { h_flex } from "gpui-base";
import type { Context, Element } from "gpui-kit";
import { layout, run } from "herdr";
import { PANEL_ID } from "../core/layout.ts";
import { t } from "../i18n/index.ts";
import type { Engine } from "../runtime/engine.ts";
import { icon, palette } from "./kit.ts";
import { panelShown, sleepingCount } from "./sessionsModel.ts";

export class ToggleView {
  private readonly engine: Engine;

  constructor(engine: Engine) {
    this.engine = engine;
  }

  render(_cx: Context): Element {
    const color = palette();
    const open = panelShown(layout(), PANEL_ID);
    const count = sleepingCount(this.engine.records());
    return h_flex()
      .size_full()
      .min_w(0)
      .px(6)
      .items_center()
      .bg(color("chrome"))
      .border_b(1)
      .border_color(color("border"))
      .child(
        h_flex()
          .id("sessions-toggle")
          .h(26)
          .min_w(0)
          .px(8)
          .gap(5)
          .items_center()
          .rounded(6)
          .text_size(12)
          .whitespace_nowrap()
          .bg(color(open ? "selected" : "chrome"))
          .text_color(color(open ? "foreground" : "muted"))
          .cursor_pointer()
          .hover((s) => s.bg(color("hover")))
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click(() => {
            run("layout.toggle", { id: PANEL_ID });
          })
          .child(icon("moon", 14, color(count > 0 ? "accent" : "muted")))
          .child(t("toggle.label", { count })),
      );
  }
}
