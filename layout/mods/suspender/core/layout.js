// The "living" layout `layouts/suspender.json`: Herdr's current shipped
// `main.json` plus a few insertions, rebuilt whenever main.json changes, so a
// Herdr update reaches the person without cloning or editing any shipped
// layout. Two ways to show Sessions (TabsMode):
//
//  - clone (the usual one): the tabs block shows `suspender-tabs`, the live
//    copy of Herdr's tab bar with a "Sessions · N" button beside Files and
//    Changes (runtime/tabsClone.ts), and the Sessions list is the side panel
//    stack's third child, `suspender`, so it opens, switches and is remembered
//    per space exactly like Files and Changes;
//  - builtin (when the copy cannot be used): Herdr's own tab bar, our own
//    `suspender-toggle` button in a row left of it (its right edge holds the
//    window buttons) and our own hidden column `suspender-panel`, rightmost in
//    the work row.
//
// Both float `suspender-pill`, the "Sleep" drawer, over the tab block.
//
// Blocks are found by id or mod, never by position. A main.json the
// insertions do not fit is reported, not thrown: the caller keeps the last
// layout that worked.
import { sha256Hex } from "./sha256.js";
export const LAYOUT_NAME = "suspender";
/** Bumped when the insertions change, so existing living layouts are rebuilt. */
export const GENERATOR_VERSION = 3;
export const TOGGLE_ID = "suspender-toggle";
export const TOPBAR_ID = "suspender-topbar";
export const PANEL_ID = "suspender-panel";
export const PILL_ID = "suspender-pill";
/** The live copy of Herdr's tab bar with the Sessions button (runtime/tabsClone.ts). */
export const TABS_CLONE = "suspender-tabs";
/** The Sessions panel's id among the side panel's children (`panel-body`), and the copy's button id. */
export const SESSIONS_CHILD = "suspender";
const MOD = "suspender";
const TOGGLE_WIDTH_PX = 110;
const PANEL_SIZE = { px: 320 };
const PANEL_MIN_PX = 200;
const PANEL_MAX_PX = 700;
const PILL_PEEK_PX = 30;
const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const contentOf = (node) => (isObject(node.content) ? node.content : null);
/** The node and the chain of its ancestors (nearest last), for the first node that matches. */
function find(root, match) {
    const visit = (node, path) => {
        if (match(node)) {
            return { node, path };
        }
        if (Array.isArray(node.children)) {
            for (const child of node.children) {
                if (isObject(child)) {
                    const hit = visit(child, [...path, node]);
                    if (hit) {
                        return hit;
                    }
                }
            }
        }
        return null;
    };
    return visit(root, []);
}
function hasId(root, id) {
    return find(root, (node) => node.id === id) !== null;
}
/** The fingerprint of a main.json, as stored in `suspender_generated.from`. */
export function layoutHash(main) {
    return sha256Hex(JSON.stringify(main));
}
function insertToggle(root) {
    const hit = findTabs(root);
    const parent = hit?.path.at(-1);
    if (!(hit && parent && Array.isArray(parent.children))) {
        return "no tabs block";
    }
    const tabs = hit.node;
    const toggle = {
        id: TOGGLE_ID,
        type: "block",
        size: { px: TOGGLE_WIDTH_PX },
        content: { mod: MOD, props: { role: "toggle" } },
    };
    const siblings = parent.children;
    const at = siblings.indexOf(tabs);
    if (parent.type === "row") {
        siblings.splice(at, 0, toggle);
        return null;
    }
    // In a column: wrap the tabs block in a row that takes its place and size.
    const topbar = { id: TOPBAR_ID, type: "row", resizable: false };
    for (const field of ["size", "min", "max", "hidden"]) {
        if (field in tabs) {
            topbar[field] = tabs[field];
            delete tabs[field];
        }
    }
    tabs.size = { weight: 1 };
    topbar.children = [toggle, tabs];
    siblings[at] = topbar;
    return null;
}
function findTabs(root) {
    return (find(root, (node) => node.id === "tabs" && node.type === "block") ??
        find(root, (node) => contentOf(node)?.mod === "tabs"));
}
function insertPanel(root) {
    const hit = find(root, (node) => contentOf(node)?.tab === "active");
    if (!hit) {
        return "no tab block (content.tab: active)";
    }
    const row = [...hit.path].reverse().find((node) => node.type === "row" && Array.isArray(node.children));
    if (!row) {
        return "the tab block is in no row to put the Sessions column in";
    }
    row.children.push({
        id: PANEL_ID,
        type: "block",
        hidden: true,
        size: PANEL_SIZE,
        min: PANEL_MIN_PX,
        max: PANEL_MAX_PX,
        content: { mod: MOD, props: { role: "panel" } },
    });
    return null;
}
/** The copy in the tabs block, Sessions as the side panel stack's third child. */
function useClone(root) {
    const tabs = findTabs(root)?.node;
    const content = tabs ? contentOf(tabs) : null;
    if (!(tabs && content)) {
        return "no tabs block";
    }
    const body = find(root, (node) => node.id === "panel-body" && node.type === "stack");
    if (!(body && Array.isArray(body.node.children))) {
        return "no panel-body stack for Sessions";
    }
    content.mod = TABS_CLONE;
    body.node.children.push({
        id: SESSIONS_CHILD,
        type: "block",
        content: { mod: MOD, props: { role: "panel" } },
    });
    return null;
}
function insertPill(root) {
    const hit = find(root, (node) => contentOf(node)?.tab === "active");
    if (!hit) {
        return "no tab block (content.tab: active)";
    }
    const floating = Array.isArray(hit.node.floating) ? hit.node.floating : [];
    hit.node.floating = [
        ...floating,
        {
            id: PILL_ID,
            content: { mod: MOD, props: { role: "pill" } },
            edge: "right",
            align: "end",
            peek: PILL_PEEK_PX,
        },
    ];
    return null;
}
/** `main` with `cloned_from` right after `type`, as Herdr's own clones have it. */
function withOrigin(layout, mainVersion, hash, tabs) {
    const out = {};
    for (const [field, value] of Object.entries(layout)) {
        if (field === "cloned_from" || field === "suspender_generated") {
            continue;
        }
        out[field] = value;
        if (field === "type") {
            out.cloned_from = { name: "main", version: mainVersion };
        }
    }
    if (!("cloned_from" in out)) {
        out.cloned_from = { name: "main", version: mainVersion };
    }
    out.suspender_generated = { from: hash, generator: GENERATOR_VERSION, tabs };
    return out;
}
export function buildLivingLayout(main, mainVersion, tabs = "builtin") {
    if (!isObject(main) || typeof main.type !== "string" || !Array.isArray(main.children)) {
        return { ok: false, reason: "main.json is not a layout tree" };
    }
    // main came from JSON, so a JSON round trip is a full copy (and needs no runtime API).
    const layout = JSON.parse(JSON.stringify(main));
    for (const id of [TOGGLE_ID, TOPBAR_ID, PANEL_ID, PILL_ID, SESSIONS_CHILD]) {
        if (hasId(layout, id)) {
            return { ok: false, reason: `main.json already has a node "${id}"` };
        }
    }
    const problem = tabs === "clone"
        ? (useClone(layout) ?? insertPill(layout))
        : (insertToggle(layout) ?? insertPanel(layout) ?? insertPill(layout));
    if (problem !== null) {
        return { ok: false, reason: problem };
    }
    return { ok: true, layout: withOrigin(layout, mainVersion, layoutHash(main), tabs) };
}
/** The tab bar mode a living layout was built with (null: none, or not one of ours). */
export function tabsModeOf(current) {
    const generated = isObject(current) && isObject(current.suspender_generated) ? current.suspender_generated : null;
    const tabs = generated?.["tabs"];
    return tabs === "clone" || tabs === "builtin" ? tabs : null;
}
/**
 * Whether `current` (the living layout on disk, or null) is out of date for
 * this main.json, Herdr version and tab bar mode.
 */
export function needsRebuild(main, mainVersion, current, tabs = "builtin") {
    if (!isObject(current)) {
        return true;
    }
    const generated = isObject(current.suspender_generated) ? current.suspender_generated : null;
    const origin = isObject(current.cloned_from) ? current.cloned_from : null;
    return (generated?.from !== layoutHash(main) ||
        generated.generator !== GENERATOR_VERSION ||
        tabsModeOf(current) !== tabs ||
        origin?.version !== mainVersion);
}
/** The node with this id in a live layout tree (`layout()`), or null. */
function nodeById(root, id) {
    return isObject(root) ? (find(root, (node) => node.id === id)?.node ?? null) : null;
}
/**
 * Whether the Sessions list is on screen in a live layout tree: our own
 * column shown (builtin), or the side panel shown with Sessions on top (clone).
 */
export function sessionsShown(layout) {
    const column = nodeById(layout, PANEL_ID);
    if (column !== null) {
        return column.hidden !== true;
    }
    const panel = nodeById(layout, "panel");
    const body = nodeById(layout, "panel-body");
    return panel !== null && panel.hidden !== true && body?.active === SESSIONS_CHILD;
}
/**
 * The commands that open or close Sessions in a live layout tree, the way its
 * own button would: the copy's button opens the side panel on Sessions (or
 * closes it when Sessions is on top), ours toggles our column. Nothing for a
 * layout without Sessions.
 */
export function sessionsToggle(layout) {
    if (nodeById(layout, PANEL_ID) !== null) {
        return [{ command: "layout.toggle", args: { id: PANEL_ID } }];
    }
    if (nodeById(layout, SESSIONS_CHILD) === null || nodeById(layout, "panel") === null) {
        return [];
    }
    if (sessionsShown(layout)) {
        return [{ command: "layout.hide", args: { id: "panel" } }];
    }
    return [
        { command: "layout.select", args: { stack: "panel-body", child: SESSIONS_CHILD } },
        { command: "layout.show", args: { id: "panel" } },
    ];
}
