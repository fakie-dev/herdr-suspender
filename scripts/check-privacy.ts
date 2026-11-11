// Fails when the repository holds something that should not be public: an
// access token, a private key, an email address that is not a GitHub noreply
// one, a home-folder path of a real user, or a word from the maintainer's own
// list. `pnpm check` runs it over the working tree (tracked files and new
// files that are not ignored); `--history` also walks every commit: each diff
// and each author, committer and message, so a secret that a later commit
// removed still shows. Commit messages must carry no co-author trailer.
//
// The maintainer's words live in `.privacy.local`, one per line, `#` for
// comments. The file is ignored by git and never published.
//
//   node scripts/check-privacy.ts [--history] [--root <dir>]

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export interface Finding {
  where: string;
  kind: string;
  /** What matched, shortened and with secrets hidden. */
  sample: string;
}

interface Rule {
  kind: string;
  pattern: RegExp;
  /** Whether a match is fine after all. */
  allow?: (match: RegExpMatchArray) => boolean;
  /** Print the kind only: the match itself is a secret. */
  hide?: boolean;
}

// Names that stand in for a person in docs and tests. A real home folder,
// the maintainer's own included, is never one of them.
const STAND_IN_NAMES = new Set(["tester", "t", "user", "you", "me", "name", "username", "runner", "example"]);

/**
 * Commits made before the scan held the maintainer's own home folder to the
 * rule: their tests used it as a sample path. History is not rewritten (the
 * maintainer allowed their handle there: it is the repository's author
 * name), so each listed commit may keep home folders of the users named for
 * it. Every other commit is held to the rule.
 */
export const EARLIER_HOME_PATHS: Readonly<Record<string, readonly string[]>> = {
  // 🎉 chore: scaffold Suspender with its pure core: test/paths.test.ts, the home and a made-up sibling of it.
  "7d8d768104295a2802309ae1da49983915661146": ["fakie", "fakieother"],
};

const RULES: Rule[] = [
  { kind: "GitHub token", pattern: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/, hide: true },
  { kind: "GitHub token", pattern: /\bgithub_pat_[A-Za-z0-9_]{30,}\b/, hide: true },
  { kind: "cloud access key", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/, hide: true },
  { kind: "API token", pattern: /\b(?:sk|pk)-[A-Za-z0-9_-]{24,}\b/, hide: true },
  { kind: "chat token", pattern: /\bxox[abprs]-[A-Za-z0-9-]{20,}\b/, hide: true },
  { kind: "private key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, hide: true },
  {
    kind: "hard-coded credential",
    pattern: /\b(?:api[_-]?key|secret|passw(?:or)?d|token)\b["']?\s*[:=]\s*["'][A-Za-z0-9+/_=-]{16,}["']/i,
    hide: true,
  },
  {
    kind: "email address",
    // The last label must be letters: `typescript@7.0.2` is a package version.
    pattern: /[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})\b/,
    allow: (m) => {
      const domain = (m[1] ?? "").toLowerCase();
      return (
        domain === "users.noreply.github.com" ||
        domain === "example.com" ||
        domain === "example.org" ||
        domain.endsWith(".example")
      );
    },
  },
  {
    kind: "home-folder path",
    pattern: /(?:[A-Za-z]:\\{1,2}Users\\{1,2}|\/Users\/|\/home\/)([A-Za-z0-9._-]+)/,
    allow: (m) => STAND_IN_NAMES.has((m[1] ?? "").toLowerCase()) || /^[A-Z_]+$/.test(m[1] ?? ""),
  },
  { kind: "co-author line", pattern: /^co-authored-by:/im },
];

function shorten(text: string): string {
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}

/** Findings in one text. `where` names it in the report; `homes` are users whose home folders may appear. */
export function scanText(where: string, text: string, words: string[], homes: readonly string[] = []): Finding[] {
  const found: Finding[] = [];
  const lowered = text.toLowerCase();
  for (const word of words) {
    if (lowered.includes(word)) {
      found.push({ where, kind: "local word", sample: "(a word from .privacy.local)" });
    }
  }
  for (const line of text.split("\n")) {
    for (const rule of RULES) {
      const m = line.match(rule.pattern);
      if (!m || rule.allow?.(m)) {
        continue;
      }
      if (rule.kind === "home-folder path" && homes.includes((m[1] ?? "").toLowerCase())) {
        continue;
      }
      found.push({ where, kind: rule.kind, sample: rule.hide ? "(hidden)" : shorten(m[0]) });
    }
  }
  return found;
}

export function loadWords(root: string): string[] {
  const file = join(root, ".privacy.local");
  if (!existsSync(file)) {
    return [];
  }
  return readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .map((line) => line.toLowerCase());
}

const git = (root: string, args: string[]): string =>
  execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 1 << 30 });

export function scanTree(root: string, words: string[]): Finding[] {
  const listed = git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]).split("\0");
  const found: Finding[] = [];
  for (const path of listed) {
    if (path === "" || path === ".privacy.local") {
      continue;
    }
    let text: string;
    try {
      text = readFileSync(join(root, path), "utf8");
    } catch {
      continue; // deleted in the working tree but still in the index
    }
    if (text.includes("\0")) {
      continue; // binary
    }
    found.push(...scanText(path, text, words));
  }
  return found;
}

export function scanHistory(
  root: string,
  words: string[],
  earlier: Readonly<Record<string, readonly string[]>> = EARLIER_HOME_PATHS,
): Finding[] {
  const found: Finding[] = [];
  const SEP = "\x1e";
  const FIELD = "\x1f";
  const log = git(root, [
    "log",
    "--all",
    "-p",
    "-U0",
    "--no-color",
    `--format=${SEP}%H${FIELD}%an${FIELD}%ae${FIELD}%cn${FIELD}%ce${FIELD}%B${FIELD}`,
  ]);
  for (const entry of log.split(SEP)) {
    if (entry.trim() === "") {
      continue;
    }
    const [sha = "", an = "", ae = "", cn = "", ce = "", message = "", diff = ""] = entry.split(FIELD);
    const short = sha.slice(0, 8);
    const homes = earlier[sha] ?? [];
    found.push(...scanText(`commit ${short} author`, `${an} <${ae}>\n${cn} <${ce}>`, words));
    found.push(...scanText(`commit ${short} message`, message, words));
    // Only the lines a commit added, with the file each one is in. A removed line
    // was added by an earlier commit and is reported there: the commit that
    // takes it out is not to blame for it.
    let file = "?";
    for (const line of diff.split("\n")) {
      if (line.startsWith("+++ b/")) {
        file = line.slice(6);
      } else if (line.startsWith("+") && !line.startsWith("+++")) {
        found.push(...scanText(`commit ${short} ${file}`, line.slice(1), words, homes));
      }
    }
  }
  return found;
}

function main(argv: string[]): number {
  const history = argv.includes("--history");
  const at = argv.indexOf("--root");
  const root = at >= 0 ? (argv[at + 1] ?? ".") : process.cwd();
  const words = loadWords(root);
  const all = [...scanTree(root, words), ...(history ? scanHistory(root, words) : [])];
  // One line per place and kind, however many times it matched.
  const seen = new Set<string>();
  const unique = all.filter((f) => {
    const key = `${f.where}|${f.kind}|${f.sample}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
  if (unique.length === 0) {
    console.log(`privacy: clean (${history ? "tree and history" : "tree"}, ${words.length} local words)`);
    return 0;
  }
  console.error("privacy: found things that should not be public:");
  for (const f of unique) {
    console.error(`  ${f.where}: ${f.kind}: ${f.sample}`);
  }
  return 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
