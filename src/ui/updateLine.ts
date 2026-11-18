// The update line at the top of the Sessions panel and the switch at its
// bottom, as data: what they say and which buttons they hold, and how wide
// each part is drawn, so the panel folds labels to icons before anything
// meets its edge at any zoom and UI font size (G32). In the mod's own px; a
// reported width goes through `toMod` first (core/scale.ts).

import { type Scale, toMod, type WindowPx } from "../core/scale.ts";
import type { Job, UpdateState } from "../core/updateState.ts";
import { t } from "../i18n/index.ts";
import { keysText, type ManualCheck, updateDetail, whyText } from "../runtime/updater.ts";
import type { Measure } from "./textWidth.ts";

export type LineAction = "update" | "whatsNew" | "rollBack" | "page" | "dismiss";

export interface UpdateLine {
  text: string;
  /** The whole story (a refusal's how-to), shown as the text's tooltip. */
  detail: string | null;
  tone: "accent" | "done" | "warn" | "error";
  spinning: boolean;
  actions: LineAction[];
}

/** Padding on each side of the line and of the footer. */
export const LINE_PAD_X = 12;
export const FOOTER_PAD_X = 12;
/** Between the line's parts. */
export const LINE_GAP = 6;
/** The dot or spinner before the text. */
export const LINE_LEAD = 12;
export const LINE_TEXT = 12;
/** Room kept for the text before the buttons give up their labels (it truncates natively below). */
export const LINE_TEXT_LEAST = 48;
export const BUTTON_TEXT = 11.5;
export const BUTTON_PAD_X = 6;
export const BUTTON_ICON = 12;
/** A button drawn as its icon alone: the icon and 4 px around it. */
export const ICON_BUTTON = BUTTON_ICON + 8;
/** The footer's check box, and its gap to the label. */
export const FOOTER_BOX = 12;
export const FOOTER_TEXT = 11.5;
/** Room kept for "Suspender 0.1.2" before the switch shortens its label. */
const FOOTER_VERSION_LEAST = 40;

export const ACTION_LABEL: Readonly<Record<LineAction, Parameters<typeof t>[0]>> = {
  update: "update.action.update",
  whatsNew: "update.action.whatsNew",
  rollBack: "update.action.rollBack",
  page: "update.action.page",
  dismiss: "update.action.dismiss",
};

/** The line for this state, or null when there is nothing to say. `backup`: where a broken swap left the old folder. */
export function updateLine(
  s: UpdateState,
  version: string,
  available: string | null,
  busy: Job | null,
  backup = "suspender/update/backup/suspender",
): UpdateLine | null {
  if (busy !== null) {
    return {
      text: t(busy.kind === "update" ? "update.line.updating" : "update.line.rollingBack", { version: busy.to }),
      detail: null,
      tone: "accent",
      spinning: true,
      actions: [],
    };
  }
  const o = s.outcome;
  if (o !== null) {
    if ((o.kind === "updated" || o.kind === "rolledBack") && o.to === version) {
      return {
        text: t(o.kind === "updated" ? "update.line.updated" : "update.line.back", { version }),
        detail: o.keys.length > 0 ? keysText(o) : null,
        tone: "done",
        spinning: false,
        actions: o.kind === "updated" ? ["whatsNew", "rollBack", "dismiss"] : ["dismiss"],
      };
    }
    if ((o.kind === "refused" || o.kind === "failed") && o.from === version) {
      const reason = o.reason ?? "network";
      return {
        text: reason === "noBackup" ? whyText(reason) : t("update.not.line", { why: whyText(reason) }),
        detail: updateDetail(o, backup),
        tone: reason === "broken" ? "error" : "warn",
        spinning: false,
        actions: o.reason === "noBackup" ? ["dismiss"] : ["page", "dismiss"],
      };
    }
  }
  if (available !== null) {
    return {
      text: t("update.out.title", { version: available }),
      detail: null,
      tone: "accent",
      spinning: false,
      actions: ["whatsNew", "update"],
    };
  }
  return null;
}

/** A button's width: Dismiss is always its icon; the others their label, or their icon when folded. */
export function buttonWidth(action: LineAction, mode: "label" | "icon", measure: Measure): number {
  if (mode === "icon" || action === "dismiss") {
    return ICON_BUTTON;
  }
  return 2 * BUTTON_PAD_X + measure(t(ACTION_LABEL[action]), BUTTON_TEXT);
}

/** What the line takes besides its text's own room: pads, lead, buttons, and the text's least room with labels. */
export function lineDrawnWidth(line: UpdateLine, mode: "label" | "icon", measure: Measure): number {
  const buttons = line.actions.reduce((sum, a) => sum + LINE_GAP + buttonWidth(a, mode, measure), 0);
  return 2 * LINE_PAD_X + LINE_LEAD + LINE_GAP + (mode === "label" ? LINE_TEXT_LEAST : 0) + buttons;
}

/** Labels while they leave the text its least room; icons (labels in tooltips) after that. */
export function fitUpdateLine(line: UpdateLine, width: WindowPx, scale: Scale, measure: Measure): "label" | "icon" {
  return lineDrawnWidth(line, "label", measure) <= toMod(scale, width) ? "label" : "icon";
}

export type FooterMode = "full" | "short" | "icon";

/** The switch's label, and Check now as words or as its icon. */
export interface FooterFit {
  toggle: FooterMode;
  link: "label" | "icon";
}

/** What Check now says: the button itself (null), or what it is doing or found. */
export const LINK_LABEL: Readonly<Record<ManualCheck | "idle", Parameters<typeof t>[0]>> = {
  idle: "update.footer.checkNow",
  checking: "update.footer.checking",
  upToDate: "update.footer.upToDate",
  failed: "update.footer.failed",
};

export const FOOTER_LABEL: Readonly<Record<Exclude<FooterMode, "icon">, Parameters<typeof t>[0]>> = {
  full: "update.footer.checks",
  short: "update.footer.checksShort",
};

/** The switch's width: its box, and its label unless folded. */
export function footerToggleWidth(mode: FooterMode, measure: Measure): number {
  return mode === "icon" ? FOOTER_BOX : FOOTER_BOX + LINE_GAP + measure(t(FOOTER_LABEL[mode]), FOOTER_TEXT);
}

/**
 * Check now's width: its icon, and as words the longest thing it says, so the
 * footer keeps its place while it goes from Check now to Up to date.
 */
export function footerLinkWidth(mode: "label" | "icon", measure: Measure): number {
  if (mode === "icon") {
    return FOOTER_BOX;
  }
  const words = Math.max(...Object.values(LINK_LABEL).map((key) => measure(t(key), FOOTER_TEXT)));
  return FOOTER_BOX + LINE_GAP + Math.ceil(words);
}

/**
 * The longest labels that leave the version some room: the switch shortens
 * first, then goes to its box, then Check now to its icon (words in tooltips).
 */
export function fitFooter(width: WindowPx, scale: Scale, measure: Measure): FooterFit {
  const room = toMod(scale, width) - 2 * FOOTER_PAD_X;
  const tries: FooterFit[] = [
    { toggle: "full", link: "label" },
    { toggle: "short", link: "label" },
    { toggle: "icon", link: "label" },
  ];
  for (const fit of tries) {
    const used = footerToggleWidth(fit.toggle, measure) + LINE_GAP + footerLinkWidth(fit.link, measure);
    if (used + LINE_GAP + FOOTER_VERSION_LEAST <= room) {
      return fit;
    }
  }
  return { toggle: "icon", link: "icon" };
}
