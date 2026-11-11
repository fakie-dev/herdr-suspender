// Two kinds of pixels, and the one place that converts between them.
//
// Herdr draws every length a mod gives (text sizes, widths, paddings, an
// overlay's width and height) multiplied by the person's zoom. What it reports
// back is in window pixels: on_size_change, the pointer and an element's
// bounds in a mouse event, window.viewport_size(), and where an overlay opens
// (`at`). Measured on Herdr 0.1.15: at zoom 2 the Sessions panel, 368 of the
// mod's px wide, reports 736; a popup asked for 344 wide is drawn 688 wide, at
// exactly the window point it was given.
//
// The display's own scaling (Windows "Scale", macOS Retina) sits below both:
// GPUI's logical pixels already include it, for the pointer and for drawing
// alike. The UI font size (`ui_font_size`) does not touch a mod's lengths:
// every text of this mod names its size in px.
//
// So a length the mod defines is `ModPx`, a length Herdr reports is
// `WindowPx`, and the only way from one to the other is through a `Scale`.
// The brands make the compiler refuse a reported width where a mod length is
// expected, which is how the popup and the row widths went wrong at zoom 2.
/** Herdr's zoom range (settings.json `zoom`). */
export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 3;
/** The scale from `settings()` (its `zoom`); anything unreadable is zoom 1. */
export function scaleOf(settings) {
    const zoom = typeof settings === "object" && settings !== null ? settings.zoom : undefined;
    if (typeof zoom !== "number" || !Number.isFinite(zoom) || zoom <= 0) {
        return { zoom: 1 };
    }
    return { zoom: Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, zoom)) };
}
/** A length the mod defines. */
export const modPx = (px) => px;
/** A length or position Herdr reported. */
export const windowPx = (px) => px;
/** A mod length as the window sees it. */
export const toWindow = (s, px) => (px * s.zoom);
/** A reported length in the mod's px. */
export const toMod = (s, px) => (px / s.zoom);
/** What on_size_change reported, typed as what it is. */
export const reportedSize = (size) => ({
    width: windowPx(size.width),
    height: windowPx(size.height),
});
