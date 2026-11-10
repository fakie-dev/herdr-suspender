// Host: the part of Herdr's live API the engine uses (terminals, panes, tabs,
// commands, shared values), behind one interface so the engine runs in tests
// on a fake. `herdrHost.ts` is the implementation on "herdr"; this file
// imports nothing from Herdr.
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value) => (typeof value === "string" ? value : null);
const num = (value) => (typeof value === "number" && Number.isFinite(value) ? value : null);
const strings = (value) => Array.isArray(value) ? value.filter((v) => typeof v === "string") : [];
/**
 * A terminal from `terminals()` or `hc get --json`, whichever shape: `status`
 * is a word there and `{app, state}` here; the agent's report is `report` or
 * `status`. Null for anything without an address.
 */
export function normalizeTerminal(raw) {
    if (!isRecord(raw)) {
        return null;
    }
    const address = str(raw["address"]);
    if (address === null || address === "") {
        return null;
    }
    const statusRaw = raw["status"];
    const report = isRecord(raw["report"]) ? raw["report"] : isRecord(statusRaw) ? statusRaw : null;
    const status = typeof statusRaw === "string" ? statusRaw : report !== null ? str(report["state"]) : null;
    const program = isRecord(raw["program"]) ? raw["program"] : null;
    const programAgent = program !== null && program["agent"] === true ? str(program["key"]) : null;
    const labels = {};
    if (isRecord(raw["labels"])) {
        for (const [k, v] of Object.entries(raw["labels"])) {
            if (typeof v === "string") {
                labels[k] = v;
            }
        }
    }
    const fg = isRecord(raw["foreground"]) ? raw["foreground"] : null;
    const fgPid = fg === null ? null : num(fg["pid"]);
    return {
        address,
        state: str(raw["state"]) ?? "live",
        pid: num(raw["pid"]),
        argv: strings(raw["argv"]),
        // The live folder is the foreground process's; the record's own is where it started.
        cwd: (fg !== null ? str(fg["cwd"]) : null) ?? str(raw["cwd"]) ?? "",
        labels,
        status: status === "" ? null : status,
        app: (report !== null ? str(report["app"]) : null) ?? programAgent,
        foreground: fg !== null && fgPid !== null ? { pid: fgPid, argv: strings(fg["argv"]), name: str(fg["name"]) ?? "" } : null,
        createdMs: num(raw["created_ms"]) ?? 0,
        parent: str(raw["parent"]),
    };
}
export function toTerminalView(t) {
    return {
        address: t.address,
        cwd: t.cwd,
        labels: { ...t.labels },
        status: t.status,
        app: t.app,
        foreground: t.foreground,
        createdMs: t.createdMs,
        state: t.state,
    };
}
/** A pane from `panes()`. */
export function normalizePane(raw) {
    if (!isRecord(raw)) {
        return null;
    }
    const pane = str(raw["pane"]);
    const tab = str(raw["tab"]);
    if (pane === null || tab === null) {
        return null;
    }
    return { pane, terminal: str(raw["terminal"]), mod: str(raw["mod"]), tab };
}
