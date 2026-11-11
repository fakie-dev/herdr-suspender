// Loads the mod's module (src/main.ts) the way Herdr does, with no copy of the
// mod on screen, in a temporary Herdr home that holds only Herdr's own
// layouts/main.json. "herdr", "gpui-kit" and "gpui-base" are Herdr's modules;
// here they are stand-ins over the real files of that home. With `readsHang`,
// no read ever finishes, as under `herdr-app check`, which loads the module,
// renders once and exits: only what the module starts without waiting lands.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SRC = new URL("../src/", import.meta.url);
const STANDING_IN = ["herdr", "gpui-kit", "gpui-base", "fs/promises"];

/** Every value name the sources import from a module (type-only names are erased). */
function importedNames(module: string): Set<string> {
  const names = new Set<string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
      } else if (path.endsWith(".ts")) {
        const text = readFileSync(path, "utf8");
        for (const match of text.matchAll(new RegExp(`import\\s*\\{([^}]*)\\}\\s*from\\s*"${module}"`, "g"))) {
          for (const part of (match[1] ?? "").split(",")) {
            const name = part.trim();
            if (name !== "" && !name.startsWith("type ")) {
              names.add(name.split(/\s+as\s+/)[0] ?? name);
            }
          }
        }
      }
    }
  };
  walk(SRC.pathname.replace(/^\/([A-Za-z]:)/, "$1"));
  return names;
}

export interface LoadedMod {
  appHome: string;
  /** Resolves true once `path` exists (polled), false after `ms`. */
  appears(path: string, ms: number): Promise<boolean>;
  cleanup(): void;
}

/** `main`: the home's layouts/main.json (default: Herdr 0.1.14's own). */
export async function loadMod(options: { readsHang: boolean; main?: string }): Promise<LoadedMod> {
  const home = mkdtempSync(join(tmpdir(), "suspender-boot-"));
  const appHome = join(home, ".config", "herdr-app");
  mkdirSync(join(appHome, "layouts"), { recursive: true });
  writeFileSync(
    join(appHome, "layouts", "main.json"),
    options.main ?? readFileSync(new URL("./fixtures/main-0.1.14.json", import.meta.url), "utf8"),
  );
  const hang = "new Promise(() => undefined)";
  const bodies: Record<string, string> = {
    herdr: `
import * as fs from "node:fs";
export const appHome = () => ${JSON.stringify(appHome)};
export const home = () => ${JSON.stringify(home)};
export const updates = () => ({ app: { version: "0.1.14", ready: null, updates: false } });
export const window = () => { throw new Error("no window while loading"); };
export const notify = () => null;
export const readTextFile = ${options.readsHang ? `() => ${hang}` : `async (path) => (fs.existsSync(path) ? fs.readFileSync(path, "utf8") : null)`};
// Herdr writes off its UI thread: the write lands a moment after the call.
export const writeTextFile = async (path, text, expected) => {
  await new Promise((resolve) => setTimeout(resolve, 30));
  const now = fs.existsSync(path) ? fs.readFileSync(path, "utf8") : null;
  if (now !== expected) throw new Error("The file changed outside Herdr");
  fs.writeFileSync(path, text);
  return null;
};
`,
    "fs/promises": `
export * from "node:fs/promises";
${options.readsHang ? `export const readFile = () => ${hang};\nexport const readdir = () => ${hang};` : ""}
`,
  };
  const inert = "(() => { const f = new Proxy(function () {}, { get: () => f, apply: () => f }); return f; })()";
  const source = (module: string): string => {
    const real = bodies[module] ?? "";
    if (module === "fs/promises") {
      return real;
    }
    const defined = new Set([...real.matchAll(/export const (\w+)/g)].map((m) => m[1]));
    const rest = [...importedNames(module)]
      .filter((name) => !defined.has(name))
      .map((name) => (name === "View" ? "export class View {}" : `export const ${name} = ${inert};`));
    return `${real}\n${rest.join("\n")}\n`;
  };
  registerHooks({
    resolve(specifier, context, next) {
      return STANDING_IN.includes(specifier)
        ? { url: `stand-in:${specifier}`, shortCircuit: true }
        : next(specifier, context);
    },
    load(url, context, next) {
      return url.startsWith("stand-in:")
        ? { format: "module", source: source(url.slice("stand-in:".length)), shortCircuit: true }
        : next(url, context);
    },
  });
  await import(new URL("main.ts", SRC).href);
  return {
    appHome,
    appears: async (path, ms) => {
      const end = Date.now() + ms;
      while (Date.now() < end && !existsSync(path)) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return existsSync(path);
    },
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
}
