// Small pieces every view of the mod draws the same way: the theme's colours
// by name, the agent's tile, the tone colours of a state.
import { h_flex } from "gpui-base";
import { svg } from "gpui-kit";
import { theme } from "herdr";
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
export function agentTile(agent, color, size = 16) {
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
/** A tinted icon from the mod's own folder. */
export const icon = (name, size, tint) => svg(`${ICONS}/${name}.svg`).size(size).flex_none().text_color(tint);
