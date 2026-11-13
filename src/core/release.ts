// Which build this is, and where releases come from. Every address the mod
// fetches is built here from constants: the repository is fixed, a version
// must parse as three numbers, and a file path must be a plain relative path
// of the mod's own kinds of file. Nothing read from the network or a file
// chooses a host or a repository (ADR 12).

import { formatVersion, parseVersion } from "./semver.ts";

/** This build's version; `pnpm check` holds it equal to package.json's. */
export const MOD_VERSION = "0.1.4";

export const REPO = "fakie-dev/herdr-suspender";
const API = "https://api.github.com";
const RAW = "https://raw.githubusercontent.com";
const SITE = "https://github.com";

/**
 * A file of the mod as a release lists it: folders and a name of letters,
 * digits, `_` and `-`, ending in one of the kinds the mod is made of (all
 * text). No `..`, no drive, no leading or doubled slash.
 */
export const SAFE_PATH = /^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*\.(?:js|json|svg)$/;

function tag(version: string): string {
  const v = parseVersion(version);
  if (v === null) {
    throw new Error(`not a release version: ${version}`);
  }
  return `v${formatVersion(v)}`;
}

/** GitHub's newest release that is neither a draft nor a pre-release. */
export function latestReleaseUrl(): string {
  return `${API}/repos/${REPO}/releases/latest`;
}

/** The release's page: its notes, and its files for an update by hand. */
export function releasePageUrl(version: string): string {
  return `${SITE}/${REPO}/releases/tag/${tag(version)}`;
}

/** A file of `mods/suspender/` exactly as the release's tag holds it. */
export function rawFileUrl(version: string, path: string): string {
  if (!SAFE_PATH.test(path)) {
    throw new Error(`not a file of the mod: ${path}`);
  }
  return `${RAW}/${REPO}/${tag(version)}/mods/suspender/${path}`;
}
