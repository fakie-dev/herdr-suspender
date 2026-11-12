// Release versions: three numbers, `major.minor.patch`, with an optional `v`
// in front as tags have it. Nothing else counts as a version (no pre-releases:
// GitHub's "latest release" never is one).

export interface Version {
  major: number;
  minor: number;
  patch: number;
}

const VERSION = /^v?(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/;

export function parseVersion(text: unknown): Version | null {
  if (typeof text !== "string") {
    return null;
  }
  const m = VERSION.exec(text);
  if (m === null) {
    return null;
  }
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

export function formatVersion(v: Version): string {
  return `${v.major}.${v.minor}.${v.patch}`;
}

/** Negative when `a` is older than `b`, 0 when equal, positive when newer. A text that is no version sorts first. */
export function compareVersions(a: string, b: string): number {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  if (va === null || vb === null) {
    return va === null ? (vb === null ? 0 : -1) : 1;
  }
  return va.major - vb.major || va.minor - vb.minor || va.patch - vb.patch;
}

/** Whether `candidate` is a version and a newer one than `current`. */
export function isNewer(candidate: string, current: string): boolean {
  return parseVersion(candidate) !== null && compareVersions(candidate, current) > 0;
}
