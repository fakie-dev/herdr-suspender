// The update line at the top of the Sessions panel and the switch at its
// bottom, as data: what they say and which buttons they hold, and how wide
// each part is drawn, so the panel folds labels to icons before anything
// meets its edge at any zoom and UI font size (G32). In the mod's own px; a
// reported width goes through `toMod` first (core/scale.ts).
import { toMod } from "../core/scale.js";
import { t } from "../i18n/index.js";
import { updateNotice } from "../runtime/updater.js";
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
export const ACTION_LABEL = {
    update: "update.action.update",
    whatsNew: "update.action.whatsNew",
    rollBack: "update.action.rollBack",
    page: "update.action.page",
    dismiss: "update.action.dismiss",
};
/** The line for this state, or null when there is nothing to say. `backup`: where a broken swap left the old folder. */
export function updateLine(s, version, available, busy, backup = "suspender/update/backup/suspender") {
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
                detail: null,
                tone: "done",
                spinning: false,
                actions: o.kind === "updated" ? ["whatsNew", "rollBack", "dismiss"] : ["dismiss"],
            };
        }
        if ((o.kind === "refused" || o.kind === "failed") && o.from === version) {
            const n = updateNotice(o, backup);
            return {
                text: n.title,
                detail: n.body ?? null,
                tone: n.level === "error" ? "error" : "warn",
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
export function buttonWidth(action, mode, measure) {
    if (mode === "icon" || action === "dismiss") {
        return ICON_BUTTON;
    }
    return 2 * BUTTON_PAD_X + measure(t(ACTION_LABEL[action]), BUTTON_TEXT);
}
/** What the line takes besides its text's own room: pads, lead, buttons, and the text's least room with labels. */
export function lineDrawnWidth(line, mode, measure) {
    const buttons = line.actions.reduce((sum, a) => sum + LINE_GAP + buttonWidth(a, mode, measure), 0);
    return 2 * LINE_PAD_X + LINE_LEAD + LINE_GAP + (mode === "label" ? LINE_TEXT_LEAST : 0) + buttons;
}
/** Labels while they leave the text its least room; icons (labels in tooltips) after that. */
export function fitUpdateLine(line, width, scale, measure) {
    return lineDrawnWidth(line, "label", measure) <= toMod(scale, width) ? "label" : "icon";
}
export const FOOTER_LABEL = {
    full: "update.footer.checks",
    short: "update.footer.checksShort",
};
/** The switch's width: its box, and its label unless folded. */
export function footerToggleWidth(mode, measure) {
    return mode === "icon" ? FOOTER_BOX : FOOTER_BOX + LINE_GAP + measure(t(FOOTER_LABEL[mode]), FOOTER_TEXT);
}
/** The longest label that leaves the version some room; the box alone (label in its tooltip) when none does. */
export function fitFooter(width, scale, measure) {
    const room = toMod(scale, width) - 2 * FOOTER_PAD_X;
    for (const mode of ["full", "short"]) {
        if (footerToggleWidth(mode, measure) + LINE_GAP + FOOTER_VERSION_LEAST <= room) {
            return mode;
        }
    }
    return "icon";
}
