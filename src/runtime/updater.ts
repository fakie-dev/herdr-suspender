// The mod's own updates (ADR 12).
//
// Check: once a day at most, and not in the first half minute after the
// module loads (a `herdr-app check` run loads it too, and never stays that
// long), one GET of GitHub's latest release of the mod's repository. A newer
// version is announced once, in one toast, and offered in the Sessions panel.
// With checks off nothing is fetched at all. A failed request says nothing;
// the next day tries again.
//
// Update: only `mods/suspender` changes, and only when it is still exactly
// what a release installed (its own manifest) and is this running version.
// The release's manifest and files come from its tag; every file must match
// the manifest's sha256 or nothing goes further. The new folder is put
// together in `<app home>/suspender/update/staging/suspender`, outside
// `mods/` (Herdr loads whatever lands there) and on the same disk (so the
// swap is a rename), tried with `herdr-app check`, then swapped in by one
// process with two renames; the old folder stays as the backup in
// `.../update/backup/suspender`. Herdr reloads the mod the moment its
// folder changes, which may end this task before it hears back, so the new
// version announces the result when it loads (the `job` in update.json).
// Rollback is the same swap the other way.

import {
  hashDiff,
  herdrWritten,
  type KeyBinding,
  MANIFEST_FILE,
  missingKeys,
  parseManifest,
} from "../core/manifest.ts";
import { latestReleaseUrl, rawFileUrl, releasePageUrl } from "../core/release.ts";
import { formatVersion, isNewer, parseVersion } from "../core/semver.ts";
import {
  CHECK_EVERY_MS,
  checkDue,
  defaultUpdateState,
  JOB_STALE_MS,
  type Job,
  jobAlive,
  type Outcome,
  parseUpdateState,
  REFUSALS,
  renderUpdateState,
  type UpdateReason,
  type UpdateState,
} from "../core/updateState.ts";
import { t } from "../i18n/index.ts";

export { CHECK_EVERY_MS };

/** The first check waits this long after the module loads. */
export const STARTUP_DELAY_MS = 30_000;
/** Files downloaded at once. */
const PARALLEL = 6;
/** Conditional writes of update.json retried when another copy wrote in between. */
const WRITE_ATTEMPTS = 5;
/** With checks off, how often the file is looked at again (another window may turn them on). */
const OFF_LOOK_MS = 10 * 60 * 1000;

export interface SwapResult {
  /**
   * swapped: the new folder is in mods/suspender, the old one parked.
   * unchanged: nothing moved. restored: the second rename failed and the old
   * folder is back. broken: neither folder is in mods/suspender.
   */
  result: "swapped" | "unchanged" | "restored" | "broken";
  detail: string;
}

/** What the updater needs of the disk and of programs; `platform/updateFiles.ts` on Herdr, a simulation in tests. */
export interface UpdateFiles {
  sep: "\\" | "/";
  readText(path: string): Promise<string | null>;
  /** Writes only if the file still holds `expected` (null: absent); without it, over anything. Creates folders. */
  writeText(path: string, text: string, expected?: string | null): Promise<boolean>;
  /** Every file under `dir`, relative with `/`; null when `dir` does not exist. */
  listFiles(dir: string): Promise<string[] | null>;
  /** Removes `dir` and everything in it; nothing when it is not there. */
  removeTree(dir: string): Promise<void>;
  /** `herdr-app check <dir>`; unavailable when herdr-app cannot be run. */
  checkMod(dir: string): Promise<"passed" | "failed" | "unavailable">;
  /** One process: `live` → `parked`, then `incoming` → `live`; on failure the old folder goes back. Never throws. */
  swap(live: string, incoming: string, parked: string, dropParked: boolean): Promise<SwapResult>;
}

export interface UpdateNotice {
  title: string;
  body?: string;
  level: "info" | "success" | "warning" | "error";
  action?: { name: string; args?: Record<string, unknown> };
}

export interface UpdaterDeps {
  files: UpdateFiles;
  /** `~/.config/herdr-app` or `$HERDR_APP_HOME`. */
  appHome: string;
  /** The running build's version (MOD_VERSION). */
  version: string;
  /** A GET of one of release.ts's URLs; rejects when the network fails. */
  fetchText(url: string): Promise<{ status: number; text: string }>;
  notify(n: UpdateNotice): void;
  /** Herdr's key bindings (`keys()`), read only. */
  bindings(): KeyBinding[];
  /** sha256 of a file's text with LF line endings (manifest.ts's fileHash); Herdr's native one in the mod. */
  hash(text: string): string;
  /** Opens a page in the browser. */
  openPage(url: string): void;
  now(): number;
  /** Something the panel draws changed. */
  changed(): void;
}

/** The release's version from GitHub's latest-release answer, or null. */
function releaseVersion(text: string): string | null {
  try {
    const raw: unknown = JSON.parse(text);
    if (typeof raw !== "object" || raw === null) {
      return null;
    }
    const r = raw as { tag_name?: unknown; draft?: unknown; prerelease?: unknown };
    const v = parseVersion(r.tag_name);
    return v === null || r.draft === true || r.prerelease === true ? null : formatVersion(v);
  } catch {
    return null;
  }
}

const sameJob = (a: Job | null, b: Job): boolean =>
  a !== null && a.kind === b.kind && a.from === b.from && a.to === b.to && a.at === b.at;

/** Thrown inside an update to stop it with an outcome. */
class Stop {
  readonly reason: UpdateReason;
  readonly count: number | null;
  constructor(reason: UpdateReason, count: number | null = null) {
    this.reason = reason;
    this.count = count;
  }
}

export class Updater {
  private s: UpdateState = defaultUpdateState();
  private readonly loadedAt: number;
  /** Before this, a tick does not even read the file. */
  private nextLook = 0;
  private checking: Promise<void> | null = null;
  private working: Job["kind"] | null = null;
  /** When `working` was set: a task Herdr ended never clears it, so it lapses like a job. */
  private workingSince = 0;
  /** Bumped on every change the panel draws. */
  private rev = 0;
  private readonly d: UpdaterDeps;

  constructor(d: UpdaterDeps) {
    this.d = {
      ...d,
      changed: () => {
        this.rev++;
        d.changed();
      },
    };
    this.loadedAt = d.now();
  }

  /** The running build's version. */
  get version(): string {
    return this.d.version;
  }

  /** Where a swap that could not put the old folder back left it. */
  get backupPath(): string {
    return this.backup;
  }

  /** Changes with everything the panel draws from this updater. */
  revision(): number {
    return this.rev;
  }

  private path(...parts: string[]): string {
    return [this.d.appHome, ...parts].join(this.d.files.sep);
  }
  private get stateFile(): string {
    return this.path("suspender", "update.json");
  }
  private get live(): string {
    return this.path("mods", "suspender");
  }
  private get stagingRoot(): string {
    return this.path("suspender", "update", "staging");
  }
  private get staging(): string {
    return this.path("suspender", "update", "staging", "suspender");
  }
  private get backupRoot(): string {
    return this.path("suspender", "update", "backup");
  }
  private get backup(): string {
    return this.path("suspender", "update", "backup", "suspender");
  }

  state(): UpdateState {
    return this.s;
  }

  /** A newer release to offer, while checks are on. */
  available(): string | null {
    const latest = this.s.latest;
    return this.s.checks && latest !== null && isNewer(latest, this.d.version) ? latest : null;
  }

  /** What is under way: in this window, or (young enough) in another one. */
  busy(): Job | null {
    if (this.working !== null && this.d.now() - this.workingSince < JOB_STALE_MS) {
      return this.s.job ?? { kind: this.working, from: this.d.version, to: this.d.version, at: 0, keys: [] };
    }
    return jobAlive(this.s.job, this.d.now()) ? this.s.job : null;
  }

  private async read(): Promise<{ state: UpdateState; text: string | null }> {
    const text = await this.d.files.readText(this.stateFile);
    this.s = parseUpdateState(text);
    return { state: this.s, text };
  }

  /**
   * Writes `change` of the file's current state, only if nobody wrote in
   * between (read again and retried). `change` returning null writes nothing.
   * True when this call wrote.
   */
  private async edit(change: (s: UpdateState) => UpdateState | null): Promise<boolean> {
    for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
      const { state, text } = await this.read();
      const next = change(state);
      if (next === null) {
        return false;
      }
      if (await this.d.files.writeText(this.stateFile, renderUpdateState(next), text)) {
        this.s = next;
        this.d.changed();
        return true;
      }
    }
    return false;
  }

  /**
   * Once per module load, from the first copy shown: reads the state, and
   * finishes a job the previous build started (it was replaced mid-task).
   */
  async load(): Promise<void> {
    const { state } = await this.read();
    const job = state.job;
    if (job !== null) {
      const installed = parseManifest(await this.d.files.readText(this.manifestOf(this.live)));
      if (installed?.version === job.to && this.d.version === job.to) {
        await this.finish(job);
      } else if (installed?.version !== job.from || !jobAlive(job, this.d.now())) {
        // The swap never happened and nobody is at it any more (the window closed mid-update).
        await this.edit((s) => (sameJob(s.job, job) ? { ...s, job: null } : null));
        await this.d.files.removeTree(this.stagingRoot);
      }
    } else if ((await this.d.files.listFiles(this.stagingRoot)) !== null) {
      await this.d.files.removeTree(this.stagingRoot);
    }
    this.nextLook = 0;
    this.d.changed();
  }

  /** From every round of every copy: asks GitHub when a day has passed. Cheap when not due. */
  async tick(): Promise<void> {
    const now = this.d.now();
    if (now < this.loadedAt + STARTUP_DELAY_MS || now < this.nextLook || this.checking !== null) {
      return;
    }
    this.checking = this.check().finally(() => {
      this.checking = null;
    });
    await this.checking;
  }

  private async check(): Promise<void> {
    const now = this.d.now();
    // The day is claimed in the file first: one copy in one window asks.
    const claimed = await this.edit((s) => (checkDue(s, now) ? { ...s, lastCheck: now } : null));
    if (!claimed) {
      const last = this.s.lastCheck;
      this.nextLook = this.s.checks && last !== null && last <= now ? last + CHECK_EVERY_MS : now + OFF_LOOK_MS;
      return;
    }
    this.nextLook = now + CHECK_EVERY_MS;
    let latest: string | null = null;
    try {
      const answer = await this.d.fetchText(latestReleaseUrl());
      latest = answer.status === 200 ? releaseVersion(answer.text) : null;
    } catch {
      // Silent: the next day asks again.
    }
    await this.edit((s) => ({ ...s, result: latest === null ? "failed" : "ok", latest: latest ?? s.latest }));
    if (latest !== null && isNewer(latest, this.d.version)) {
      const version = latest;
      if (await this.edit((s) => (s.checks && s.notified !== version ? { ...s, notified: version } : null))) {
        this.d.notify({
          title: t("update.out.title", { version }),
          body: t("update.out.body"),
          level: "info",
          action: { name: "suspender.updates" },
        });
      }
    }
  }

  async setChecks(on: boolean): Promise<void> {
    await this.edit((s) => (s.checks === on ? null : { ...s, checks: on }));
    this.nextLook = 0;
  }

  /** Forgets how the last update or rollback ended (the panel's line goes). */
  async dismiss(): Promise<void> {
    await this.edit((s) => (s.outcome === null ? null : { ...s, outcome: null }));
  }

  /** The release page of the version the panel talks about. */
  whatsNew(): void {
    const version = this.available() ?? this.s.outcome?.to ?? this.d.version;
    try {
      this.d.openPage(releasePageUrl(version));
    } catch {
      // Not a version: nothing to open.
    }
  }

  private manifestOf(dir: string): string {
    return [dir, MANIFEST_FILE].join(this.d.files.sep);
  }

  /**
   * The mod's files in `dir` (path → hash), or null when it is not there.
   * Each file is hashed as it is read, with the hash the deps give: Herdr's
   * native one. A sha256 in script time took 450 ms for engine.js in Herdr's
   * runtime, and Herdr ends a script that runs that long (measured).
   */
  private async hashTree(dir: string): Promise<Map<string, string> | null> {
    const listed = await this.d.files.listFiles(dir);
    if (listed === null) {
      return null;
    }
    const out = new Map<string, string>();
    for (const rel of listed) {
      if (rel === MANIFEST_FILE || herdrWritten(rel)) {
        continue;
      }
      const text = await this.d.files.readText([dir, ...rel.split("/")].join(this.d.files.sep));
      if (text !== null) {
        out.set(rel, this.d.hash(text));
      }
    }
    return out;
  }

  /** The installed mod's manifest, when mods/suspender is this build and exactly as it was installed. */
  private async ownInstall(): Promise<ReturnType<typeof parseManifest> & object> {
    const installed = parseManifest(await this.d.files.readText(this.manifestOf(this.live)));
    if (installed === null || installed.version !== this.d.version) {
      throw new Stop("renamed");
    }
    const disk = await this.hashTree(this.live);
    if (disk === null) {
      throw new Stop("renamed");
    }
    const diff = hashDiff(installed, disk);
    const count = diff.changed.length + diff.missing.length + diff.extra.length;
    if (count > 0) {
      throw new Stop("edited", count);
    }
    return installed;
  }

  /** Starts a job in the file, unless one is under way somewhere; false then. */
  private async claim(job: Job): Promise<boolean> {
    if (this.working !== null && this.d.now() - this.workingSince < JOB_STALE_MS) {
      return false;
    }
    this.working = job.kind;
    this.workingSince = this.d.now();
    const now = this.d.now();
    const mine = await this.edit((s) => (jobAlive(s.job, now) ? null : { ...s, job, outcome: null }));
    if (!mine) {
      this.working = null;
    }
    this.d.changed();
    return mine;
  }

  /** Update to the release found by the last check. Never throws. */
  async update(): Promise<void> {
    await this.read();
    const target = this.available();
    if (target === null) {
      return;
    }
    const job: Job = { kind: "update", from: this.d.version, to: target, at: this.d.now(), keys: [] };
    if (!(await this.claim(job))) {
      return;
    }
    try {
      const installed = await this.ownInstall();
      const next = await this.stage(target);
      const keys = missingKeys(next.keys, installed.keys, this.d.bindings());
      const ready: Job = { ...job, keys };
      await this.edit((s) => ({ ...s, job: ready }));
      await this.d.files.removeTree(this.backupRoot);
      await this.afterSwap(ready, await this.d.files.swap(this.live, this.staging, this.backup, false));
    } catch (e) {
      await this.d.files.removeTree(this.stagingRoot);
      await this.stop(job, e instanceof Stop ? e : new Stop("network"));
    } finally {
      this.working = null;
      this.d.changed();
    }
  }

  /** Downloads the release into staging and checks it; throws Stop when anything is off. */
  private async stage(target: string): Promise<NonNullable<ReturnType<typeof parseManifest>>> {
    const get = async (path: string): Promise<string> => {
      let answer: { status: number; text: string };
      try {
        answer = await this.d.fetchText(rawFileUrl(target, path));
      } catch {
        throw new Stop("network");
      }
      if (answer.status !== 200) {
        throw new Stop(path === MANIFEST_FILE ? "manifest" : "network");
      }
      return answer.text;
    };
    const manifestText = await get(MANIFEST_FILE);
    const next = parseManifest(manifestText);
    if (next === null || next.version !== target) {
      throw new Stop("manifest");
    }
    await this.d.files.removeTree(this.stagingRoot);
    const paths = Object.keys(next.files);
    let failed: Stop | null = null;
    const worker = async (): Promise<void> => {
      for (let path = paths.shift(); path !== undefined && failed === null; path = paths.shift()) {
        try {
          const text = await get(path);
          if (this.d.hash(text) !== next.files[path]) {
            throw new Stop("mismatch");
          }
          const at = [this.staging, ...path.split("/")].join(this.d.files.sep);
          if (!(await this.d.files.writeText(at, text, null))) {
            throw new Stop("write");
          }
        } catch (e) {
          failed ??= e instanceof Stop ? e : new Stop("network");
        }
      }
    };
    await Promise.all(Array.from({ length: PARALLEL }, worker));
    if (failed !== null) {
      throw failed;
    }
    if (!(await this.d.files.writeText(this.manifestOf(this.staging), manifestText, null))) {
      throw new Stop("write");
    }
    const checked = await this.d.files.checkMod(this.staging);
    if (checked !== "passed") {
      throw new Stop(checked === "unavailable" ? "noCheck" : "check");
    }
    return next;
  }

  /** Puts the backup back in mods/suspender; the version it replaces is removed. Never throws. */
  async rollback(): Promise<void> {
    await this.read();
    const back = parseManifest(await this.d.files.readText(this.manifestOf(this.backup)));
    const job: Job = {
      kind: "rollback",
      from: this.d.version,
      to: back?.version ?? this.d.version,
      at: this.d.now(),
      keys: [],
    };
    if (!(await this.claim(job))) {
      return;
    }
    try {
      const backupFiles = back === null ? null : await this.hashTree(this.backup);
      if (back === null || backupFiles === null) {
        throw new Stop("noBackup");
      }
      const diff = hashDiff(back, backupFiles);
      if (diff.changed.length + diff.missing.length + diff.extra.length > 0) {
        throw new Stop("noBackup");
      }
      await this.ownInstall();
      await this.d.files.removeTree(this.stagingRoot);
      await this.afterSwap(job, await this.d.files.swap(this.live, this.backup, this.staging, true));
    } catch (e) {
      await this.stop(job, e instanceof Stop ? e : new Stop("busy"));
    } finally {
      this.working = null;
      this.d.changed();
    }
  }

  private async afterSwap(job: Job, swap: SwapResult): Promise<void> {
    // The folder decides, not the answer: an exec that timed out may still have swapped.
    const now = parseManifest(await this.d.files.readText(this.manifestOf(this.live)));
    if (swap.result === "swapped" || (job.to !== job.from && now?.version === job.to)) {
      await this.finish(job);
      return;
    }
    await this.d.files.removeTree(this.stagingRoot);
    await this.stop(job, new Stop(swap.result === "broken" ? "broken" : "busy"));
  }

  /** The job is done: once, whoever gets here first (this task or the new build loading), says so. */
  private async finish(job: Job): Promise<void> {
    const outcome: Outcome = {
      kind: job.kind === "update" ? "updated" : "rolledBack",
      from: job.from,
      to: job.to,
      reason: null,
      count: null,
      at: this.d.now(),
      keys: job.keys,
    };
    if (!(await this.edit((s) => (sameJob(s.job, job) ? { ...s, job: null, outcome } : null)))) {
      return;
    }
    if (job.kind === "rollback") {
      this.d.notify({ title: t("update.back.title", { version: job.to }), level: "success" });
      return;
    }
    const keys = job.keys.map((k) => `"${k.keys}": "${k.action}" in ${k.section}`).join(", ");
    this.d.notify({
      title: t("update.done.title", { version: job.to }),
      body: [t("update.done.body"), ...(keys === "" ? [] : [t("update.done.keys", { keys })])].join(" "),
      level: "success",
    });
  }

  /** The job ended without a swap: recorded and said. */
  private async stop(job: Job, why: Stop): Promise<void> {
    const outcome: Outcome = {
      kind: REFUSALS.has(why.reason) ? "refused" : "failed",
      from: job.from,
      to: job.to,
      reason: why.reason,
      count: why.count,
      at: this.d.now(),
      keys: [],
    };
    await this.edit((s) => ({ ...s, job: sameJob(s.job, job) ? null : s.job, outcome }));
    const n = updateNotice(outcome, this.backup);
    this.d.notify(n);
  }
}

/** The toast for an update that did not happen. */
export function updateNotice(o: Outcome, backup: string): UpdateNotice {
  const reason = o.reason ?? "network";
  const params = { version: o.to, from: o.from, count: o.count ?? 0, backup };
  const body =
    reason === "edited" || reason === "renamed" || reason === "noCheck" || reason === "busy" || reason === "broken"
      ? t(`update.${reason}.body`, params)
      : reason === "noBackup"
        ? undefined
        : t("update.tryLater");
  return {
    title: t(`update.${reason}.title`, params),
    ...(body === undefined ? {} : { body }),
    level: reason === "broken" ? "error" : "warning",
  };
}
