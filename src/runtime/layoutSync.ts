// Keeps `layouts/suspender.json` (the living layout) built from Herdr's current
// `layouts/main.json`. Any shown copy of the mod runs it once when it starts:
// a Herdr update that changed main.json (or its version) is picked up with no
// action from the person. When the insertions do not fit the new main.json,
// the last working file stays and one toast says so.

import { buildLivingLayout, LAYOUT_NAME, needsRebuild } from "../core/layout.ts";
import { t } from "../i18n/index.ts";
import type { Ports } from "../platform/ports.ts";

export interface LayoutSyncDeps {
  ports: Ports;
  /** `~/.config/herdr-app` (or wherever `HERDR_APP_HOME` points). */
  appHome: string;
  /** The Herdr version, written into `cloned_from`. */
  herdrVersion: string;
  toast(text: string): void;
  /** Versions already told about, shared by the copies of one window: one toast per version. */
  warned: Set<string>;
}

/**
 * fresh: already built from this main.json; rebuilt: written now; kept: left
 * as it was (the insertion does not fit, or another copy wrote it first);
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

export async function syncLayout(d: LayoutSyncDeps): Promise<SyncOutcome> {
  const dir = [d.appHome, "layouts"].join(d.ports.sep);
  const mainText = await d.ports.readText([dir, "main.json"].join(d.ports.sep));
  const main = parse(mainText);
  if (main === null) {
    return "no-main";
  }
  const livingPath = [dir, `${LAYOUT_NAME}.json`].join(d.ports.sep);
  const currentText = await d.ports.readText(livingPath);
  if (!needsRebuild(main, d.herdrVersion, parse(currentText))) {
    return "fresh";
  }
  const built = buildLivingLayout(main, d.herdrVersion);
  if (!built.ok) {
    if (!d.warned.has(d.herdrVersion)) {
      d.warned.add(d.herdrVersion);
      d.toast(t("notice.layoutOutdated", { version: d.herdrVersion }));
    }
    return "kept";
  }
  // Only if nobody changed the file since we read it: another copy may be doing the same.
  const written = await d.ports.writeText(livingPath, `${JSON.stringify(built.layout, null, 2)}\n`, currentText);
  return written ? "rebuilt" : "kept";
}
