// Priority cut-off for one line of "title · item · item · …" (the strip of a
// sleeping tab, a row of the Sessions list). Whole items go, least important
// first, until the line fits and the title keeps at least half of it while
// there is anything left to drop; a `+N` badge counts what went. Behaviour
// follows `fit()` in the approved mockup (session-info.html v4). The title
// itself is never cut here: the UI truncates it natively with an ellipsis.

export interface Segment {
  key: string;
  text: string;
  /** Lower is more important. */
  priority: number;
}

export interface FitResult {
  /** Whether to draw the title (absent, or no room for even an ellipsis: false). */
  title: boolean;
  /** Keys of the items to draw, in the order they were given. */
  shown: string[];
  /** How many items went (the `+N` badge; none when 0). */
  hidden: number;
}

/** What stands between two items of the line. */
export const SEPARATOR = " · ";
/** The badge for `n` dropped items, with its leading gap. */
export const badgeText = (n: number): string => ` +${n}`;

export function fitSegments(
  title: string | null,
  segs: Segment[],
  widthPx: number,
  measure: (text: string) => number,
): FitResult {
  const hasTitle = title !== null && title !== "";
  const titleWidth = hasTitle ? measure(title) : 0;
  const sepWidth = measure(SEPARATOR);
  const shown = new Set(segs.map((_, i) => i));

  // Everything but the title, which shrinks into whatever room is left.
  const fixedWidth = (): number => {
    let width = 0;
    let items = hasTitle ? 1 : 0;
    segs.forEach((seg, i) => {
      if (shown.has(i)) {
        width += (items > 0 ? sepWidth : 0) + measure(seg.text);
        items++;
      }
    });
    const hidden = segs.length - shown.size;
    return width + (hidden > 0 ? measure(badgeText(hidden)) : 0);
  };
  const tooTight = (): boolean => {
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
    title: hasTitle && room >= measure("…"),
    shown: segs.filter((_, i) => shown.has(i)).map((seg) => seg.key),
    hidden: segs.length - shown.size,
  };
}
