// Small pieces every view of the mod draws the same way: the theme's colours
// by name, the agent's icon (or its letter tile), the tone colours of a state.
import { h_flex } from "gpui-base";
import { image, svg } from "gpui-kit";
import { knownAgents, panes, theme } from "herdr";
import { AgentLooks } from "../core/agentLook.js";
import { AGENT_ICON } from "../core/scale.js";
export const ICONS = "mods/suspender/icons";
/** A theme colour by name (theme() names every one the mod uses; a missing one draws nothing). */
export function palette() {
    const th = theme();
    return (name) => (th[name] ?? "#00000000");
}
/** Which theme colour a state's word is drawn in. */
export const TONE_COLOR = {
    live: "done",
    sleep: "accent",
    warn: "working",
    error: "blocked",
};
const GLYPH = { claude: "C", codex: "X" };
/** The agent's little square: a glyph on a raised tile (colours from the theme only). */
export function agentTile(agent, color, size = AGENT_ICON) {
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
export function agentMark(agent, look, color) {
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
export function agentIcon(agent, color, cx, now) {
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
export const icon = (name, size, tint) => svg(`${ICONS}/${name}.svg`).size(size).flex_none().text_color(tint);
