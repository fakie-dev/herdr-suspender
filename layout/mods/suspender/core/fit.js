// Priority cut-off for one line of "title · item · item · …" (the strip of a
// sleeping tab, a row of the Sessions list). Whole items go, least important
// first, until the line fits and the title keeps at least half of it while
// there is anything left to drop; a `+N` badge counts what went. Behaviour
// follows `fit()` in the approved mockup (session-info.html v4). The title
// itself is never cut here: the UI truncates it natively with an ellipsis.
/** The fewest letters of a title drawn before its "…" (fewer: no title at all). */
export const TITLE_LEAST = 3;
/** What stands between two items of the line. */
export const SEPARATOR = " · ";
/** The badge for `n` dropped items, with its leading gap. */
export const badgeText = (n) => ` +${n}`;
export function fitSegments(title, segs, widthPx, measure, drawing = {}) {
    const hasTitle = title !== null && title !== "";
    const measureTitle = drawing.title ?? measure;
    const titleWidth = hasTitle ? measureTitle(title) : 0;
    // A title cut to "…" alone says nothing: it is drawn only with its first letters at least.
    const titleLeast = hasTitle ? Math.min(titleWidth, measureTitle(`${[...title].slice(0, TITLE_LEAST).join("")}…`)) : 0;
    const sepWidth = drawing.separator ?? measure(SEPARATOR);
    const badgeWidth = drawing.badge ?? ((n) => measure(badgeText(n)));
    const shown = new Set(segs.map((_, i) => i));
    // Everything but the title, which shrinks into whatever room is left.
    const fixedWidth = () => {
        let width = 0;
        let items = hasTitle ? 1 : 0;
        segs.forEach((seg, i) => {
            if (shown.has(i)) {
                width += (items > 0 ? sepWidth : 0) + measure(seg.text) + (seg.extra ?? 0);
                items++;
            }
        });
        const hidden = segs.length - shown.size;
        return width + (hidden > 0 ? badgeWidth(hidden) : 0);
    };
    const tooTight = () => {
        const fixed = fixedWidth();
        if (fixed > widthPx) {
            return true;
        }
        const room = widthPx - fixed;
        return hasTitle && titleWidth > room && room < widthPx * 0.5;
    };
    // Least important first; among equals, the later one goes first.
    const dropOrder = segs
        .map((_, i) => i)
        .sort((a, b) => {
        const byPriority = (segs[b]?.priority ?? 0) - (segs[a]?.priority ?? 0);
        return byPriority === 0 ? b - a : byPriority;
    });
    for (const i of dropOrder) {
        if (!tooTight()) {
            break;
        }
        shown.delete(i);
    }
    const room = widthPx - fixedWidth();
    return {
        title: hasTitle && room >= titleLeast,
        shown: segs.filter((_, i) => shown.has(i)).map((seg) => seg.key),
        hidden: segs.length - shown.size,
    };
}
