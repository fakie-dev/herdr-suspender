// Keeps `layouts/suspender.json` (the living layout) built from Herdr's current
// `layouts/main.json`. Any shown copy of the mod runs it once when it starts:
// a Herdr update that changed main.json (or its version) is picked up with no
// action from the person. When the insertions do not fit the new main.json,
// the last working file stays and one toast says so.
//
// The tab bar mode (core/layout.ts, TabsMode) comes from the copy's check of
// the live tab bar copy (runtime/tabsClone.ts). Without one (the module just
// loaded, no copy has looked yet) the layout keeps the mode it has. A main.json
// with no place for Sessions beside Files and Changes gets the shipped tab bar.

import { buildLivingLayout, LAYOUT_NAME, needsRebuild, type TabsMode, tabsModeOf } from "../core/layout.ts";
import { t } from "../i18n/index.ts";
import type { Ports } from "../platform/ports.ts";

/** Writes refused because another copy wrote in between, before leaving the file to it. */
export const SYNC_ATTEMPTS = 3;

export interface LayoutSyncDeps {
  ports: Ports;
  /** `~/.config/herdr-app` (or wherever `HERDR_APP_HOME` points). */
  appHome: string;
  /** The Herdr version, written into `cloned_from`. */
  herdrVersion: string;
  toast(text: string): void;
  /** Versions already told about, shared by the copies of one window: one toast per version. */
  warned: Set<string>;
  /** The tab bar to build around; omitted: the one the layout on disk has (none: Herdr's own). */
  tabs?: TabsMode;
}

/**
 * fresh: already built from this main.json; rebuilt: written now; kept: left
 * as it was (the insertion does not fit, or other copies kept writing first);
 * no-main: there is no readable main.json to build from.
 */
export type SyncOutcome = "fresh" | "rebuilt" | "kept" | "no-main";

function parse(text: string | null): unknown {
  if (text === null) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Says something once per Herdr version and kind, across the copies of one window. */
function once(d: Pick<LayoutSyncDeps, "herdrVersion" | "toast" | "warned">, kind: string, text: string): void {
  const key = `${kind}:${d.herdrVersion}`;
  if (!d.warned.has(key)) {
    d.warned.add(key);
    d.toast(text);
  }
}

/** The one short toast for "Sessions is back left of the tabs" (the copy cannot be used). */
export function tabsFallbackNotice(d: Pick<LayoutSyncDeps, "herdrVersion" | "toast" | "warned">): void {
  once(d, "tabs", t("notice.tabsFallback"));
}

export async function syncLayout(d: LayoutSyncDeps): Promise<SyncOutcome> {
  const dir = [d.appHome, "layouts"].join(d.ports.sep);
  const mainText = await d.ports.readText([dir, "main.json"].join(d.ports.sep));
  const main = parse(mainText);
  if (main === null) {
    return "no-main";
  }
  const livingPath = [dir, `${LAYOUT_NAME}.json`].join(d.ports.sep);
  for (let attempt = 0; attempt < SYNC_ATTEMPTS; attempt++) {
    const currentText = await d.ports.readText(livingPath);
    const current = parse(currentText);
    let tabs: TabsMode = d.tabs ?? tabsModeOf(current) ?? "builtin";
    let built = buildLivingLayout(main, d.herdrVersion, tabs);
    if (!built.ok && tabs === "clone") {
      // No place for Sessions beside Files and Changes: Herdr's own tab bar, our own button.
      tabs = "builtin";
      built = buildLivingLayout(main, d.herdrVersion, tabs);
      if (built.ok) {
        tabsFallbackNotice(d);
      }
    }
    if (!needsRebuild(main, d.herdrVersion, current, tabs)) {
      return "fresh";
    }
    if (!built.ok) {
      once(d, "layout", t("notice.layoutOutdated", { version: d.herdrVersion }));
      return "kept";
    }
    // Only if nobody changed the file since we read it: another copy may be doing the same.
    if (await d.ports.writeText(livingPath, `${JSON.stringify(built.layout, null, 2)}\n`, currentText)) {
      return "rebuilt";
    }
  }
  return "kept";
}
