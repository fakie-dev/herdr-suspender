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
import { buildManifest, installDiff, MANIFEST_FILE, missingKeys, parseManifest, } from "../core/manifest.js";
import { latestReleaseUrl, rawFileUrl, releasePageUrl } from "../core/release.js";
import { formatVersion, isNewer, parseVersion } from "../core/semver.js";
import { CHECK_EVERY_MS, checkDue, defaultUpdateState, jobAlive, parseUpdateState, REFUSALS, renderUpdateState, } from "../core/updateState.js";
import { t } from "../i18n/index.js";
export { CHECK_EVERY_MS };
/** The first check waits this long after the module loads. */
export const STARTUP_DELAY_MS = 30_000;
/** Files downloaded at once. */
const PARALLEL = 6;
/** Conditional writes of update.json retried when another copy wrote in between. */
const WRITE_ATTEMPTS = 5;
/** With checks off, how often the file is looked at again (another window may turn them on). */
const OFF_LOOK_MS = 10 * 60 * 1000;
/** The release's version from GitHub's latest-release answer, or null. */
function releaseVersion(text) {
    try {
        const raw = JSON.parse(text);
        if (typeof raw !== "object" || raw === null) {
            return null;
        }
        const r = raw;
        const v = parseVersion(r.tag_name);
        return v === null || r.draft === true || r.prerelease === true ? null : formatVersion(v);
    }
    catch {
        return null;
    }
}
const sameJob = (a, b) => a !== null && a.kind === b.kind && a.from === b.from && a.to === b.to && a.at === b.at;
/** Thrown inside an update to stop it with an outcome. */
class Stop {
    reason;
    count;
    constructor(reason, count = null) {
        this.reason = reason;
        this.count = count;
    }
}
export class Updater {
    s = defaultUpdateState();
    loadedAt;
    /** Before this, a tick does not even read the file. */
    nextLook = 0;
    checking = null;
    working = null;
    /** Bumped on every change the panel draws. */
    rev = 0;
    d;
    constructor(d) {
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
    get version() {
        return this.d.version;
    }
    /** Where a swap that could not put the old folder back left it. */
    get backupPath() {
        return this.backup;
    }
    /** Changes with everything the panel draws from this updater. */
    revision() {
        return this.rev;
    }
    path(...parts) {
        return [this.d.appHome, ...parts].join(this.d.files.sep);
    }
    get stateFile() {
        return this.path("suspender", "update.json");
    }
    get live() {
        return this.path("mods", "suspender");
    }
    get stagingRoot() {
        return this.path("suspender", "update", "staging");
    }
    get staging() {
        return this.path("suspender", "update", "staging", "suspender");
    }
    get backupRoot() {
        return this.path("suspender", "update", "backup");
    }
    get backup() {
        return this.path("suspender", "update", "backup", "suspender");
    }
    state() {
        return this.s;
    }
    /** A newer release to offer, while checks are on. */
    available() {
        const latest = this.s.latest;
        return this.s.checks && latest !== null && isNewer(latest, this.d.version) ? latest : null;
    }
    /** What is under way: in this window, or (young enough) in another one. */
    busy() {
        if (this.working !== null) {
            return this.s.job ?? { kind: this.working, from: this.d.version, to: this.d.version, at: 0, keys: [] };
        }
        return jobAlive(this.s.job, this.d.now()) ? this.s.job : null;
    }
    async read() {
        const text = await this.d.files.readText(this.stateFile);
        this.s = parseUpdateState(text);
        return { state: this.s, text };
    }
    /**
     * Writes `change` of the file's current state, only if nobody wrote in
     * between (read again and retried). `change` returning null writes nothing.
     * True when this call wrote.
     */
    async edit(change) {
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
    async load() {
        const { state } = await this.read();
        const job = state.job;
        if (job !== null) {
            const installed = parseManifest(await this.d.files.readText(this.manifestOf(this.live)));
            if (installed?.version === job.to && this.d.version === job.to) {
                await this.finish(job);
            }
            else if (installed?.version !== job.from || !jobAlive(job, this.d.now())) {
                // The swap never happened and nobody is at it any more (the window closed mid-update).
                await this.edit((s) => (sameJob(s.job, job) ? { ...s, job: null } : null));
                await this.d.files.removeTree(this.stagingRoot);
            }
        }
        else if ((await this.d.files.listFiles(this.stagingRoot)) !== null) {
            await this.d.files.removeTree(this.stagingRoot);
        }
        this.nextLook = 0;
        this.d.changed();
    }
    /** From every round of every copy: asks GitHub when a day has passed. Cheap when not due. */
    async tick() {
        const now = this.d.now();
        if (now < this.loadedAt + STARTUP_DELAY_MS || now < this.nextLook || this.checking !== null) {
            return;
        }
        this.checking = this.check().finally(() => {
            this.checking = null;
        });
        await this.checking;
    }
    async check() {
        const now = this.d.now();
        // The day is claimed in the file first: one copy in one window asks.
        const claimed = await this.edit((s) => (checkDue(s, now) ? { ...s, lastCheck: now } : null));
        if (!claimed) {
            const last = this.s.lastCheck;
            this.nextLook = this.s.checks && last !== null && last <= now ? last + CHECK_EVERY_MS : now + OFF_LOOK_MS;
            return;
        }
        this.nextLook = now + CHECK_EVERY_MS;
        let latest = null;
        try {
            const answer = await this.d.fetchText(latestReleaseUrl());
            latest = answer.status === 200 ? releaseVersion(answer.text) : null;
        }
        catch {
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
    async setChecks(on) {
        await this.edit((s) => (s.checks === on ? null : { ...s, checks: on }));
        this.nextLook = 0;
    }
    /** Forgets how the last update or rollback ended (the panel's line goes). */
    async dismiss() {
        await this.edit((s) => (s.outcome === null ? null : { ...s, outcome: null }));
    }
    /** The release page of the version the panel talks about. */
    whatsNew() {
        const version = this.available() ?? this.s.outcome?.to ?? this.d.version;
        try {
            this.d.openPage(releasePageUrl(version));
        }
        catch {
            // Not a version: nothing to open.
        }
    }
    manifestOf(dir) {
        return [dir, MANIFEST_FILE].join(this.d.files.sep);
    }
    /** The files of `dir` (path → text), or null when it is not there. */
    async readTree(dir) {
        const listed = await this.d.files.listFiles(dir);
        if (listed === null) {
            return null;
        }
        const out = new Map();
        for (const rel of listed) {
            const text = await this.d.files.readText([dir, ...rel.split("/")].join(this.d.files.sep));
            if (text !== null) {
                out.set(rel, text);
            }
        }
        return out;
    }
    /** The installed mod's manifest, when mods/suspender is this build and exactly as it was installed. */
    async ownInstall() {
        const installed = parseManifest(await this.d.files.readText(this.manifestOf(this.live)));
        if (installed === null || installed.version !== this.d.version) {
            throw new Stop("renamed");
        }
        const disk = await this.readTree(this.live);
        if (disk === null) {
            throw new Stop("renamed");
        }
        const diff = installDiff(installed, disk);
        const count = diff.changed.length + diff.missing.length + diff.extra.length;
        if (count > 0) {
            throw new Stop("edited", count);
        }
        return installed;
    }
    /** Starts a job in the file, unless one is under way somewhere; false then. */
    async claim(job) {
        if (this.working !== null) {
            return false;
        }
        this.working = job.kind;
        const now = this.d.now();
        const mine = await this.edit((s) => (jobAlive(s.job, now) ? null : { ...s, job, outcome: null }));
        if (!mine) {
            this.working = null;
        }
        this.d.changed();
        return mine;
    }
    /** Update to the release found by the last check. Never throws. */
    async update() {
        await this.read();
        const target = this.available();
        if (target === null) {
            return;
        }
        const job = { kind: "update", from: this.d.version, to: target, at: this.d.now(), keys: [] };
        if (!(await this.claim(job))) {
            return;
        }
        try {
            const installed = await this.ownInstall();
            const next = await this.stage(target);
            const keys = missingKeys(next.keys, installed.keys, this.d.bindings());
            const ready = { ...job, keys };
            await this.edit((s) => ({ ...s, job: ready }));
            await this.d.files.removeTree(this.backupRoot);
            await this.afterSwap(ready, await this.d.files.swap(this.live, this.staging, this.backup, false));
        }
        catch (e) {
            await this.d.files.removeTree(this.stagingRoot);
            await this.stop(job, e instanceof Stop ? e : new Stop("network"));
        }
        finally {
            this.working = null;
            this.d.changed();
        }
    }
    /** Downloads the release into staging and checks it; throws Stop when anything is off. */
    async stage(target) {
        const get = async (path) => {
            let answer;
            try {
                answer = await this.d.fetchText(rawFileUrl(target, path));
            }
            catch {
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
        let failed = null;
        const worker = async () => {
            for (let path = paths.shift(); path !== undefined && failed === null; path = paths.shift()) {
                try {
                    const text = await get(path);
                    if (buildManifest(target, {}, new Map([[path, text]])).files[path] !== next.files[path]) {
                        throw new Stop("mismatch");
                    }
                    const at = [this.staging, ...path.split("/")].join(this.d.files.sep);
                    if (!(await this.d.files.writeText(at, text, null))) {
                        throw new Stop("write");
                    }
                }
                catch (e) {
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
    async rollback() {
        await this.read();
        const back = parseManifest(await this.d.files.readText(this.manifestOf(this.backup)));
        const job = {
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
            const backupFiles = back === null ? null : await this.readTree(this.backup);
            if (back === null || backupFiles === null) {
                throw new Stop("noBackup");
            }
            const diff = installDiff(back, backupFiles);
            if (diff.changed.length + diff.missing.length + diff.extra.length > 0) {
                throw new Stop("noBackup");
            }
            await this.ownInstall();
            await this.d.files.removeTree(this.stagingRoot);
            await this.afterSwap(job, await this.d.files.swap(this.live, this.backup, this.staging, true));
        }
        catch (e) {
            await this.stop(job, e instanceof Stop ? e : new Stop("busy"));
        }
        finally {
            this.working = null;
            this.d.changed();
        }
    }
    async afterSwap(job, swap) {
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
    async finish(job) {
        const outcome = {
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
    async stop(job, why) {
        const outcome = {
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
export function updateNotice(o, backup) {
    const reason = o.reason ?? "network";
    const params = { version: o.to, from: o.from, count: o.count ?? 0, backup };
    const body = reason === "edited" || reason === "renamed" || reason === "noCheck" || reason === "busy" || reason === "broken"
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
