// Shortening of folders, branches and ids so no line turns into a sheet.
// Behaviour follows the approved mockup (session-info.html v4): folders are
// squeezed in the middle and keep their first part and their leaf; branches
// keep their prefix and task number (`feature/PORTAL-412…`).
const ELLIPSIS = "…";
/** Splits a path into its parts; on Windows forward slashes count as separators too. */
function splitPath(path, sep) {
    return sep === "\\" ? path.split(/[\\/]/) : path.split("/");
}
function trimTrailingSep(path, sep) {
    const pattern = sep === "\\" ? /[\\/]+$/ : /\/+$/;
    const trimmed = path.replace(pattern, "");
    return trimmed === "" ? path : trimmed;
}
/**
 * The part of `path` below `root`, as path parts, or null when `path` is not
 * inside `root`. A sibling with the same prefix (`api-gateway` against `api`)
 * is not inside. Windows paths compare without case and with either slash.
 */
function relativeParts(path, root, sep) {
    const normalize = (p) => {
        const trimmed = trimTrailingSep(p, sep);
        return sep === "\\" ? trimmed.replace(/\//g, "\\").toLowerCase() : trimmed;
    };
    const p = normalize(path);
    const r = normalize(root);
    if (p === r) {
        return [];
    }
    if (!p.startsWith(r + sep)) {
        return null;
    }
    const rest = trimTrailingSep(path, sep).slice(trimTrailingSep(root, sep).length);
    return splitPath(rest, sep).filter((part) => part !== "");
}
/** Joins parts; when longer than `max`, keeps the first part and as many trailing parts as fit around `…`. */
function midEllipsis(parts, sep, max) {
    const whole = parts.join(sep);
    if (whole.length <= max || parts.length <= 2) {
        return whole;
    }
    const head = parts[0] ?? "";
    const tail = [parts.at(-1) ?? ""];
    for (let i = parts.length - 2; i > 0; i--) {
        const part = parts[i] ?? "";
        const candidate = [head, ELLIPSIS, part, ...tail].join(sep);
        if (candidate.length > max) {
            break;
        }
        tail.unshift(part);
    }
    return [head, ELLIPSIS, ...tail].join(sep);
}
/** Cuts the middle of a plain string: about 60 % of the room for its start. */
function midText(text, max) {
    if (text.length <= max) {
        return text;
    }
    const front = Math.ceil((max - 1) * 0.6);
    const back = max - 1 - front;
    return text.slice(0, front) + ELLIPSIS + text.slice(text.length - back);
}
/**
 * A working folder as the strip and the list show it: from the repository
 * root (`northwind-portal\…\auth`). Outside a repository, or when the folder
 * is not inside `repoRoot`, the whole folder, squeezed the same way.
 */
export function repoPath(cwd, repoRoot, sep, max) {
    const below = repoRoot === null ? null : relativeParts(cwd, repoRoot, sep);
    if (repoRoot === null || below === null) {
        return midEllipsis(splitPath(trimTrailingSep(cwd, sep), sep), sep, max);
    }
    const name = splitPath(trimTrailingSep(repoRoot, sep), sep).at(-1) ?? repoRoot;
    return midEllipsis([name, ...below], sep, max);
}
/** A folder as the popup shows it: from `~` when under the home folder, else whole; squeezed in the middle. */
export function homePath(p, home, sep, max) {
    const below = relativeParts(p, home, sep);
    const parts = below === null ? splitPath(trimTrailingSep(p, sep), sep) : ["~", ...below];
    return midEllipsis(parts, sep, max);
}
/** A branch: the prefix and the task number (`feature/PORTAL-412`) are never cut; the description gives way. */
export function shortBranch(b, max) {
    if (b.length <= max) {
        return b;
    }
    const match = b.match(/^((?:[^/]+\/)?[A-Za-z]+-\d+)(.*)$/);
    const keep = match?.[1];
    if (keep !== undefined) {
        const room = max - keep.length - 1;
        if (room >= 4) {
            return keep + ELLIPSIS + (match?.[2] ?? "").slice(-room);
        }
        if (keep.length + 1 <= max) {
            return keep + ELLIPSIS;
        }
    }
    return midText(b, max);
}
/** A session id in a list: its first 8 characters. */
export function shortId(id) {
    return id.slice(0, 8);
}
/** A session id in the popup: first 8 and last 4 (`8d65845f…0de0`). */
export function midId(id) {
    if (id.length <= 12) {
        return id;
    }
    return `${id.slice(0, 8)}${ELLIPSIS}${id.slice(-4)}`;
}
