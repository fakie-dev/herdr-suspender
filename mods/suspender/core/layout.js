// The "living" layout `layouts/suspender.json`: Herdr's current shipped
// `main.json` plus three insertions, rebuilt whenever main.json changes, so a
// Herdr update reaches the person without cloning or editing anything shipped.
//
//  - `suspender-toggle`: the "Sessions · N" button, in a row beside the tabs
//    block (left of it: the tab bar draws the window buttons at its right edge);
//  - `suspender-panel`: a hidden Sessions column, rightmost in the work row;
//  - `suspender-pill`: a floating "Sleep" drawer over the tab block.
//
// Blocks are found by id or mod, never by position. A main.json the
// insertions do not fit is reported, not thrown: the caller keeps the last
// layout that worked.
import { sha256Hex } from "./sha256.js";
export const LAYOUT_NAME = "suspender";
/** Bumped when the insertions change, so existing living layouts are rebuilt. */
export const GENERATOR_VERSION = 1;
export const TOGGLE_ID = "suspender-toggle";
export const TOPBAR_ID = "suspender-topbar";
export const PANEL_ID = "suspender-panel";
export const PILL_ID = "suspender-pill";
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
    const hit = find(root, (node) => node.id === "tabs" && node.type === "block") ??
        find(root, (node) => contentOf(node)?.mod === "tabs");
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
function insertPanelAndPill(root) {
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
function withOrigin(layout, mainVersion, hash) {
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
    out.suspender_generated = { from: hash, generator: GENERATOR_VERSION };
    return out;
}
export function buildLivingLayout(main, mainVersion) {
    if (!isObject(main) || typeof main.type !== "string" || !Array.isArray(main.children)) {
        return { ok: false, reason: "main.json is not a layout tree" };
    }
    // main came from JSON, so a JSON round trip is a full copy (and needs no runtime API).
    const layout = JSON.parse(JSON.stringify(main));
    for (const id of [TOGGLE_ID, TOPBAR_ID, PANEL_ID, PILL_ID]) {
        if (hasId(layout, id)) {
            return { ok: false, reason: `main.json already has a node "${id}"` };
        }
    }
    const problem = insertToggle(layout) ?? insertPanelAndPill(layout);
    if (problem !== null) {
        return { ok: false, reason: problem };
    }
    return { ok: true, layout: withOrigin(layout, mainVersion, layoutHash(main)) };
}
/** Whether `current` (the living layout on disk, or null) is out of date for this main.json and Herdr version. */
export function needsRebuild(main, mainVersion, current) {
    if (!isObject(current)) {
        return true;
    }
    const generated = isObject(current.suspender_generated) ? current.suspender_generated : null;
    const origin = isObject(current.cloned_from) ? current.cloned_from : null;
    return (generated?.from !== layoutHash(main) || generated.generator !== GENERATOR_VERSION || origin?.version !== mainVersion);
}
