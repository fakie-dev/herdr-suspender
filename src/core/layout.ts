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

import { PILL_PEEK } from "./scale.ts";
import { sha256Hex } from "./sha256.ts";

export const LAYOUT_NAME = "suspender";
/** Bumped when the insertions change, so existing living layouts are rebuilt. */
export const GENERATOR_VERSION = 5;

export const TOGGLE_ID = "suspender-toggle";
export const TOPBAR_ID = "suspender-topbar";
export const PANEL_ID = "suspender-panel";
export const PILL_ID = "suspender-pill";
/** The live copy of Herdr's tab bar with the Sessions button (runtime/tabsClone.ts). */
export const TABS_CLONE = "suspender-tabs";
/** The Sessions panel's id among the side panel's children (`panel-body`), and the copy's button id. */
export const SESSIONS_CHILD = "suspender";

/**
 * clone: the tab bar is the live copy, and Sessions is the side panel's third
 * child beside Files and Changes. builtin: Herdr's own tab bar, with our own
 * button left of it and our own hidden column (when the copy cannot be used).
 */
export type TabsMode = "clone" | "builtin";

const MOD = "suspender";
/** "Sessions · N" for N up to 99 (122.4 px of Geist 12 with its icon and padding), with room to spare. */
export const TOGGLE_WIDTH_PX = 126;
const PANEL_SIZE = { px: 320 };
const PANEL_MIN_PX = 200;
const PANEL_MAX_PX = 700;

interface LayoutNode {
  id?: unknown;
  type?: unknown;
  size?: unknown;
  content?: unknown;
  children?: unknown;
  floating?: unknown;
  hidden?: unknown;
  active?: unknown;
  cloned_from?: unknown;
  suspender_generated?: unknown;
  [field: string]: unknown;
}

interface Fields {
  mod?: unknown;
  tab?: unknown;
  from?: unknown;
  generator?: unknown;
  version?: unknown;
  [field: string]: unknown;
}

export type BuildResult = { ok: true; layout: object } | { ok: false; reason: string };

const isObject = (value: unknown): value is LayoutNode =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const contentOf = (node: LayoutNode): Fields | null => (isObject(node.content) ? node.content : null);

/** The node and the chain of its ancestors (nearest last), for the first node that matches. */
function find(root: LayoutNode, match: (node: LayoutNode) => boolean): { node: LayoutNode; path: LayoutNode[] } | null {
  const visit = (node: LayoutNode, path: LayoutNode[]): { node: LayoutNode; path: LayoutNode[] } | null => {
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

function hasId(root: LayoutNode, id: string): boolean {
  return find(root, (node) => node.id === id) !== null;
}

/** The fingerprint of a main.json, as stored in `suspender_generated.from`. */
export function layoutHash(main: unknown): string {
  return sha256Hex(JSON.stringify(main));
}

function insertToggle(root: LayoutNode): string | null {
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
  const siblings = parent.children as unknown[];
  const at = siblings.indexOf(tabs);
  if (parent.type === "row") {
    siblings.splice(at, 0, toggle);
    return null;
  }
  // In a column: wrap the tabs block in a row that takes its place and size.
  const topbar: LayoutNode = { id: TOPBAR_ID, type: "row", resizable: false };
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

function findTabs(root: LayoutNode): { node: LayoutNode; path: LayoutNode[] } | null {
  return (
    find(root, (node) => node.id === "tabs" && node.type === "block") ??
    find(root, (node) => contentOf(node)?.mod === "tabs")
  );
}

function insertPanel(root: LayoutNode): string | null {
  const hit = find(root, (node) => contentOf(node)?.tab === "active");
  if (!hit) {
    return "no tab block (content.tab: active)";
  }
  const row = [...hit.path].reverse().find((node) => node.type === "row" && Array.isArray(node.children));
  if (!row) {
    return "the tab block is in no row to put the Sessions column in";
  }
  (row.children as unknown[]).push({
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
function useClone(root: LayoutNode): string | null {
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

function insertPill(root: LayoutNode): string | null {
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
      peek: PILL_PEEK,
    },
  ];
  return null;
}

/** Every block of a layout tree (in `children`, at any depth), the root included. */
function blocks(root: LayoutNode): LayoutNode[] {
  const out: LayoutNode[] = [];
  const visit = (node: LayoutNode): void => {
    out.push(node);
    if (Array.isArray(node.children)) {
      for (const child of node.children) {
        if (isObject(child)) {
          visit(child);
        }
      }
    }
  };
  visit(root);
  return out;
}

/** Each block's mod by its id, as main.json has them: what the person may replace (`keepPersonChanges`). */
function modsById(main: LayoutNode): Record<string, string> {
  const out: Record<string, string> = {};
  for (const node of blocks(main)) {
    const mod = contentOf(node)?.mod;
    if (typeof node.id === "string" && typeof mod === "string") {
      out[node.id] = mod;
    }
  }
  return out;
}

/** Suspender's own mods: never carried over from the layout on disk, always built as now. */
const ourMod = (mod: unknown): boolean => mod === MOD || mod === TABS_CLONE;

/** `main` with `cloned_from` right after `type`, as Herdr's own clones have it. */
function withOrigin(
  layout: LayoutNode,
  mainVersion: string,
  hash: string,
  tabs: TabsMode,
  base: Record<string, string>,
): LayoutNode {
  const out: LayoutNode = {};
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
  // `base`: the mods main.json had, so a later build can tell a mod the person put in from Herdr's own change.
  out.suspender_generated = { from: hash, generator: GENERATOR_VERSION, tabs, base };
  return out;
}

export function buildLivingLayout(main: unknown, mainVersion: string, tabs: TabsMode = "builtin"): BuildResult {
  if (!isObject(main) || typeof main.type !== "string" || !Array.isArray(main.children)) {
    return { ok: false, reason: "main.json is not a layout tree" };
  }
  // main came from JSON, so a JSON round trip is a full copy (and needs no runtime API).
  const layout = JSON.parse(JSON.stringify(main)) as LayoutNode;
  for (const id of [TOGGLE_ID, TOPBAR_ID, PANEL_ID, PILL_ID, SESSIONS_CHILD]) {
    if (hasId(layout, id)) {
      return { ok: false, reason: `main.json already has a node "${id}"` };
    }
  }
  const problem =
    tabs === "clone"
      ? (useClone(layout) ?? insertPill(layout))
      : (insertToggle(layout) ?? insertPanel(layout) ?? insertPill(layout));
  if (problem !== null) {
    return { ok: false, reason: problem };
  }
  return { ok: true, layout: withOrigin(layout, mainVersion, layoutHash(main), tabs, modsById(main)) };
}

/** A block whose mod the person put in and the new main.json has no block for. */
export interface LostBlock {
  id: string;
  mod: string;
}

/**
 * `built` (a fresh build from `main`) with what the person changed in
 * `current` (the living layout on disk): a block, by its id, whose mod they
 * replaced keeps their content (mod and props). "Replaced" is against the mods
 * main.json had when `current` was built (`base`); a layout from before that
 * was recorded is compared with `main` itself. Suspender's own blocks, and a
 * block of `built` that is ours (the tabs block showing the copy), are never
 * changed. A block `main` no longer has is dropped: no place is invented.
 */
export function keepPersonChanges(
  built: object,
  current: unknown,
  main: unknown,
): { layout: object; lost: LostBlock[] } {
  const lost: LostBlock[] = [];
  if (!isObject(current) || !isObject(main) || !isObject(built)) {
    return { layout: built, lost };
  }
  const generated = isObject(current.suspender_generated) ? current.suspender_generated : null;
  const recorded = isObject(generated?.["base"]) ? (generated["base"] as Record<string, unknown>) : null;
  const before = recorded ?? modsById(main);
  const layout = JSON.parse(JSON.stringify(built)) as LayoutNode;
  for (const node of blocks(current)) {
    const content = contentOf(node);
    const mod = content?.mod;
    const id = node.id;
    if (typeof id !== "string" || typeof mod !== "string" || content === null) {
      continue;
    }
    // Our own blocks (toggle, panel, pill) have ids main.json never has, so they are not in `before`.
    if (ourMod(mod) || !(id in before) || before[id] === mod) {
      continue;
    }
    const target = blocks(layout).find((x) => x.id === id);
    if (target === undefined) {
      lost.push({ id, mod });
      continue;
    }
    if (ourMod(contentOf(target)?.mod)) {
      continue;
    }
    target.content = JSON.parse(JSON.stringify(content));
  }
  return { layout, lost };
}

/** The tab bar mode a living layout was built with (null: none, or not one of ours). */
export function tabsModeOf(current: unknown): TabsMode | null {
  const generated = isObject(current) && isObject(current.suspender_generated) ? current.suspender_generated : null;
  const tabs = generated?.["tabs"];
  return tabs === "clone" || tabs === "builtin" ? tabs : null;
}

/**
 * Whether `current` (the living layout on disk, or null) is out of date for
 * this main.json, Herdr version and tab bar mode.
 */
export function needsRebuild(
  main: unknown,
  mainVersion: string,
  current: unknown | null,
  tabs: TabsMode = "builtin",
): boolean {
  if (!isObject(current)) {
    return true;
  }
  const generated: Fields | null = isObject(current.suspender_generated) ? current.suspender_generated : null;
  const origin: Fields | null = isObject(current.cloned_from) ? current.cloned_from : null;
  return (
    generated?.from !== layoutHash(main) ||
    generated.generator !== GENERATOR_VERSION ||
    tabsModeOf(current) !== tabs ||
    origin?.version !== mainVersion
  );
}

/** The node with this id in a live layout tree (`layout()`), or null. */
function nodeById(root: unknown, id: string): LayoutNode | null {
  return isObject(root) ? (find(root, (node) => node.id === id)?.node ?? null) : null;
}

/**
 * Whether the Sessions list is on screen in a live layout tree: our own
 * column shown (builtin), or the side panel shown with Sessions on top (clone).
 */
export function sessionsShown(layout: unknown): boolean {
  const column = nodeById(layout, PANEL_ID);
  if (column !== null) {
    return column.hidden !== true;
  }
  const panel = nodeById(layout, "panel");
  const body = nodeById(layout, "panel-body");
  return panel !== null && panel.hidden !== true && body?.active === SESSIONS_CHILD;
}

export interface LayoutCommand {
  command: string;
  args: Record<string, unknown>;
}

/**
 * The commands that open or close Sessions in a live layout tree, the way its
 * own button would: the copy's button opens the side panel on Sessions (or
 * closes it when Sessions is on top), ours toggles our column. Nothing for a
 * layout without Sessions.
 */
export function sessionsToggle(layout: unknown): LayoutCommand[] {
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
