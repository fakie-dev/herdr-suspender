// A simulated machine for the updater: the app's folder in memory (fakePorts),
// a fake GitHub that serves releases from a table, a fake `herdr-app check`,
// and the folder swap carried out on the same memory, so a test sees exactly
// which files moved where. Nothing touches the disk or the network.

import { buildManifest, fileHash, type KeyBinding, type KeyMap, renderManifest } from "../../src/core/manifest.ts";
import { latestReleaseUrl, rawFileUrl } from "../../src/core/release.ts";
import type { SwapResult, UpdateFiles, UpdateNotice, UpdaterDeps } from "../../src/runtime/updater.ts";
import { type FakePorts, fakePorts } from "../fakePorts.ts";

export const APP = "/home/tester/.config/herdr-app";
export const LIVE = `${APP}/mods/suspender`;
export const WORK = `${APP}/suspender/update`;
export const STATE = `${APP}/suspender/update.json`;
export const SESSIONS = `${APP}/suspender/sessions.json`;
export const DAY = 24 * 60 * 60 * 1000;

export const KEYS: KeyMap = {
  global: { "ctrl-shift-s": "mod.open:suspender", "alt-shift-s": "suspender.toggle-focused" },
  "layout:suspender": { "ctrl-shift-s": "suspender.panel" },
};

/** A build of the mod: a few files whose text names the version. */
export function build(version: string): Map<string, string> {
  return new Map([
    ["main.js", `// suspender ${version}\nexport default class {}\n`],
    ["mod.json", '{ "place": "none" }\n'],
    ["runtime/engine.js", `export const BUILD = "${version}";\n`],
    ["ui/panel.js", `// panel of ${version}: ✓ ☾\n`],
    ["icons/moon.svg", "<svg><title>moon</title></svg>\n"],
  ]);
}

export interface Served {
  status: number;
  text: string;
}

export class World {
  readonly ports: FakePorts = fakePorts({ sep: "/", home: "/home/tester" });
  now = 1_800_000_000_000;
  /** URL → what the fake GitHub answers; "fail" rejects like a network error. */
  readonly web = new Map<string, Served | "fail">();
  readonly fetched: string[] = [];
  readonly notices: UpdateNotice[] = [];
  readonly opened: string[] = [];
  readonly removed: string[] = [];
  readonly swaps: { live: string; incoming: string; parked: string; drop: boolean }[] = [];
  bindings: KeyBinding[] = Object.entries(KEYS).flatMap(([section, map]) =>
    Object.entries(map).map(([keys, action]) => ({ section, keys, action })),
  );
  /** What `herdr-app check` says; "unavailable": the program is not there. */
  checkResult: "passed" | "failed" | "unavailable" = "passed";
  readonly checked: string[] = [];
  /** `herdr-app check` never answers: the task waiting on it is as good as ended. */
  checkHangs = false;
  /** Makes the next swap fail before anything moves (a file in use). */
  swapBusy = false;
  /** The swap happens but its answer is lost (exec timed out, its output was garbled). */
  swapAnswerLost = false;
  /** Runs inside the swap, after the folders moved and before it returns (Herdr reloading the mod). */
  duringSwap: (() => Promise<void>) | null = null;
  redraws = 0;
  /** The texts hashed, in order (Herdr hashes natively: a hash in script time is too slow there). */
  readonly hashed: string[] = [];
  hash: (text: string) => string = fileHash;

  /** Puts `files` (and their manifest) at `dir`. */
  install(dir: string, version: string, files = build(version), keys: KeyMap = KEYS): void {
    for (const [path, text] of files) {
      this.ports.files.set(`${dir}/${path}`, text);
    }
    this.ports.files.set(`${dir}/manifest.json`, renderManifest(buildManifest(version, keys, files)));
  }

  /** Publishes a release on the fake GitHub: the latest-release answer, its manifest and its files. */
  publish(version: string, files = build(version), keys: KeyMap = KEYS): void {
    this.web.set(latestReleaseUrl(), {
      status: 200,
      text: JSON.stringify({ tag_name: `v${version}`, name: `v${version}`, draft: false, prerelease: false }),
    });
    this.web.set(rawFileUrl(version, "manifest.json"), {
      status: 200,
      text: renderManifest(buildManifest(version, keys, files)),
    });
    for (const [path, text] of files) {
      this.web.set(rawFileUrl(version, path), { status: 200, text });
    }
  }

  /** Every file under `dir`, relative, as a sorted list of [path, text]. */
  tree(dir: string): [string, string][] {
    const prefix = `${dir}/`;
    return [...this.ports.files]
      .filter(([p]) => p.startsWith(prefix))
      .map(([p, text]): [string, string] => [p.slice(prefix.length), text])
      .sort(([a], [b]) => (a < b ? -1 : 1));
  }

  /** Every path written, removed or moved, for "nothing else was touched". */
  touched(): string[] {
    return [
      ...this.ports.writes.filter((w) => w.ok).map((w) => w.path),
      ...this.removed,
      ...this.swaps.flatMap((s) => [s.live, s.incoming, s.parked]),
    ];
  }

  private move(from: string, to: string): void {
    for (const [path, text] of [...this.ports.files]) {
      if (path.startsWith(`${from}/`)) {
        this.ports.files.delete(path);
        this.ports.files.set(`${to}/${path.slice(from.length + 1)}`, text);
      }
    }
  }

  private exists(dir: string): boolean {
    return [...this.ports.files.keys()].some((p) => p.startsWith(`${dir}/`));
  }

  readonly files: UpdateFiles = {
    sep: "/",
    readText: (path) => this.ports.readText(path),
    writeText: (path, text, expected) => this.ports.writeText(path, text, expected),
    listFiles: async (dir) => {
      const all = this.tree(dir).map(([p]) => p);
      return all.length === 0 ? null : all;
    },
    removeTree: async (dir) => {
      this.removed.push(dir);
      for (const path of [...this.ports.files.keys()]) {
        if (path.startsWith(`${dir}/`)) {
          this.ports.files.delete(path);
        }
      }
    },
    checkMod: async (dir) => {
      this.checked.push(dir);
      if (this.checkHangs) {
        return new Promise<never>(() => undefined);
      }
      return this.checkResult;
    },
    swap: async (live, incoming, parked, drop): Promise<SwapResult> => {
      this.swaps.push({ live, incoming, parked, drop });
      if (this.swapBusy || this.exists(parked) || !this.exists(incoming)) {
        return { result: "unchanged", detail: "in use" };
      }
      this.move(live, parked);
      this.move(incoming, live);
      if (drop) {
        await this.files.removeTree(parked);
      }
      await this.duringSwap?.();
      return this.swapAnswerLost ? { result: "unchanged", detail: "" } : { result: "swapped", detail: "" };
    },
  };

  deps(version: string): UpdaterDeps {
    return {
      files: this.files,
      appHome: APP,
      version,
      fetchText: async (url) => {
        this.fetched.push(url);
        const answer = this.web.get(url) ?? { status: 404, text: "404: Not Found" };
        if (answer === "fail") {
          throw new Error(`fetching ${url} failed`);
        }
        return answer;
      },
      notify: (n) => {
        this.notices.push(n);
      },
      bindings: () => this.bindings,
      hash: (text) => {
        this.hashed.push(text);
        return this.hash(text);
      },
      openPage: (url) => {
        this.opened.push(url);
      },
      now: () => this.now,
      changed: () => {
        this.redraws++;
      },
    };
  }
}
