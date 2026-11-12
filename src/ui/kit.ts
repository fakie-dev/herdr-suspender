// Small pieces every view of the mod draws the same way: the theme's colours
// by name, the agent's icon (or its letter tile), the tone colours of a state.

import { h_flex } from "gpui-base";
import { type Color, type Context, type Element, image, svg } from "gpui-kit";
import { knownAgents, panes, theme } from "herdr";
import { type AgentLook, AgentLooks } from "../core/agentLook.ts";
import type { AgentId } from "../core/model.ts";
import { AGENT_ICON } from "../core/scale.ts";
import type { Tone } from "./sessionsModel.ts";

export const ICONS = "mods/suspender/icons";

export type Palette = (name: string) => Color;

/** A theme colour by name (theme() names every one the mod uses; a missing one draws nothing). */
export function palette(): Palette {
  const th = theme();
  return (name) => (th[name] ?? "#00000000") as Color;
}

/** Which theme colour a state's word is drawn in. */
export const TONE_COLOR: Readonly<Record<Tone, string>> = {
  live: "done",
  sleep: "accent",
  warn: "working",
  error: "blocked",
};

const GLYPH: Readonly<Record<AgentId, string>> = { claude: "C", codex: "X" };

/** The agent's little square: a glyph on a raised tile (colours from the theme only). */
export function agentTile(agent: AgentId, color: Palette, size: number = AGENT_ICON): Element {
  return h_flex()
    .size(size)
    .flex_none()
    .items_center()
    .justify_center()
    .rounded(4)
    .bg(color("raised"))
    .border(1)
    .border_color(color("border"))
    .text_size(size - 6)
    .text_color(color("muted"))
    .child(GLYPH[agent]);
}

/**
 * Herdr's program table, shared by every copy of the mod in this window: asked
 * once (knownAgents() runs a check process), and live panes' programs until it
 * answers.
 */
const looks = new AgentLooks({
  known: () => knownAgents(),
  live: () => panes().map((p) => p.program),
});

/**
 * The agent's icon as Herdr's own Agents list draws `program.icon`: a picture
 * with `image()`, a one-colour glyph with `svg()` in the text colour. No
 * `tile`: Herdr's lists draw none. The letter tile when no icon is known.
 */
export function agentMark(agent: AgentId, look: AgentLook | null, color: Palette): Element {
  if (look === null) {
    return agentTile(agent, color);
  }
  return look.tint
    ? svg(look.icon).size(AGENT_ICON).flex_none().text_color(color("foreground"))
    : image(look.icon).w(AGENT_ICON).h(AGENT_ICON).flex_none();
}

/**
 * The agent's icon for a view that draws it now: what is known of Herdr's
 * program table, and the one lookup started when it is due (the copy that
 * started it redraws when it answers).
 */
export function agentIcon(agent: AgentId, color: Palette, cx: Context, now: number): Element {
  const answered = looks.start(now);
  if (answered !== null) {
    cx.spawn(async (task) => {
      if (await answered) {
        task.notify();
      }
    });
  }
  return agentMark(agent, looks.look(agent), color);
}

/** A tinted icon from the mod's own folder. */
export const icon = (name: string, size: number, tint: Color): Element =>
  svg(`${ICONS}/${name}.svg`).size(size).flex_none().text_color(tint);
