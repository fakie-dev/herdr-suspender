// What the updater keeps in `<app home>/suspender/update.json`, beside the
// sessions and outside `mods/`: whether checks are on, when GitHub was last
// asked and what it said, which version was already announced, an update or
// rollback under way (`job`), and how the last one ended (`outcome`). Every
// copy and window of the mod shares the file; writes are conditional, so one
// of them claims each day's check and each announcement.
import { formatVersion, parseVersion } from "./semver.js";
/** At most this often GitHub is asked for the latest release. */
export const CHECK_EVERY_MS = 24 * 60 * 60 * 1000;
/** A job this old whose swap never happened is taken for one that died with its window. */
export const JOB_STALE_MS = 10 * 60 * 1000;
/** Why an update or a rollback did not happen (each has its toast in en.ts: `update.<reason>.title`). */
export const UPDATE_REASONS = [
    "edited",
    "renamed",
    "noCheck",
    "noBackup",
    "network",
    "manifest",
    "mismatch",
    "check",
    "write",
    "busy",
    "broken",
];
/** Reasons the button will not get past by trying again: the person updates by hand. */
export const REFUSALS = new Set(["edited", "renamed", "noCheck", "noBackup"]);
export function defaultUpdateState() {
    return {
        version: 1,
        checks: true,
        lastCheck: null,
        result: null,
        latest: null,
        notified: null,
        job: null,
        outcome: null,
    };
}
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const num = (value) => (typeof value === "number" && Number.isFinite(value) ? value : null);
const ver = (value) => {
    const v = parseVersion(value);
    return v === null ? null : formatVersion(v);
};
function keyList(value) {
    if (!Array.isArray(value)) {
        return [];
    }
    return value.filter((k) => isRecord(k) &&
        typeof k["section"] === "string" &&
        typeof k["keys"] === "string" &&
        typeof k["action"] === "string");
}
function job(value) {
    if (!isRecord(value)) {
        return null;
    }
    const kind = value["kind"];
    const from = ver(value["from"]);
    const to = ver(value["to"]);
    const at = num(value["at"]);
    if ((kind !== "update" && kind !== "rollback") || from === null || to === null || at === null) {
        return null;
    }
    return { kind, from, to, at, keys: keyList(value["keys"]) };
}
const KINDS = ["updated", "rolledBack", "refused", "failed"];
function outcome(value) {
    if (!isRecord(value)) {
        return null;
    }
    const kind = KINDS.find((k) => k === value["kind"]);
    const reason = UPDATE_REASONS.find((r) => r === value["reason"]) ?? null;
    const from = ver(value["from"]);
    const to = ver(value["to"]);
    const at = num(value["at"]);
    if (kind === undefined || from === null || to === null || at === null) {
        return null;
    }
    return { kind, from, to, reason, count: num(value["count"]), at, keys: keyList(value["keys"]) };
}
/** The file's state; anything missing or broken reads as the default (checks on, nothing known). */
export function parseUpdateState(text) {
    let raw;
    try {
        raw = text === null ? null : JSON.parse(text);
    }
    catch {
        raw = null;
    }
    const out = defaultUpdateState();
    if (!isRecord(raw) || raw["version"] !== 1) {
        return out;
    }
    const result = raw["result"];
    return {
        version: 1,
        checks: raw["checks"] !== false,
        lastCheck: num(raw["lastCheck"]),
        result: result === "ok" || result === "failed" ? result : null,
        latest: ver(raw["latest"]),
        notified: ver(raw["notified"]),
        job: job(raw["job"]),
        outcome: outcome(raw["outcome"]),
    };
}
export function renderUpdateState(s) {
    return `${JSON.stringify(s, null, 2)}\n`;
}
/** Whether GitHub is to be asked now: checks on, and no ask in the last day (or a clock that went back). */
export function checkDue(s, now) {
    return (s.checks && (s.lastCheck === null || now - s.lastCheck >= CHECK_EVERY_MS || s.lastCheck - now > CHECK_EVERY_MS));
}
/** Whether a job may still be at work in some window (young enough). */
export const jobAlive = (j, now) => j !== null && now - j.at < JOB_STALE_MS;
