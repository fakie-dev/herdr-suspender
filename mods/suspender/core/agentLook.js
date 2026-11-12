// Which icon Herdr draws for an agent. Herdr keeps one program table
// (programs.json on top of its built-in one) and gives every pane its row as
// `program`; its tab bar and Agents list draw `program.icon` from it. A
// sleeping session has no pane, so its row comes from `knownAgents()`, the
// table's agents, which Herdr checks with a process: asked once per load and
// kept, never on every draw. Nothing here imports Herdr; ui/kit.ts wires it.
/** A failed lookup is asked again after this long (Herdr does not keep a failed check). */
export const LOOK_RETRY_MS = 60_000;
/** A Program's icon, or null when it names none (or is not a Program). */
export function lookOf(program) {
    if (typeof program !== "object" || program === null) {
        return null;
    }
    const { icon, tint } = program;
    return typeof icon === "string" && icon !== "" ? { icon, tint: tint === true } : null;
}
const keyOf = (program) => typeof program === "object" && program !== null ? program.key : undefined;
export class AgentLooks {
    sources;
    /** The table's icons by agent key, once knownAgents() answered. */
    table = null;
    asking = false;
    failedAt = null;
    constructor(sources) {
        this.sources = sources;
    }
    /**
     * Starts the lookup when it is due (never done, none under way, the last
     * failure at least LOOK_RETRY_MS old) and resolves true when it changed what
     * `look` answers; null when nothing was started.
     */
    start(now) {
        if (this.table !== null || this.asking || (this.failedAt !== null && now - this.failedAt < LOOK_RETRY_MS)) {
            return null;
        }
        this.asking = true;
        return this.ask(now);
    }
    async ask(now) {
        try {
            const answer = await this.sources.known();
            if (!Array.isArray(answer)) {
                throw new Error("knownAgents() gave no list");
            }
            const table = new Map();
            for (const program of answer) {
                const key = keyOf(program);
                const look = lookOf(program);
                if (typeof key === "string" && look !== null) {
                    table.set(key, look);
                }
            }
            this.table = table;
            return true;
        }
        catch {
            this.failedAt = now;
            return false;
        }
        finally {
            this.asking = false;
        }
    }
    /** The agent's icon: from the program table once it is known, else from a pane running that agent. */
    look(agent) {
        const known = this.table?.get(agent);
        if (known !== undefined) {
            return known;
        }
        for (const program of this.sources.live()) {
            const look = keyOf(program) === agent ? lookOf(program) : null;
            if (look !== null) {
                return look;
            }
        }
        return null;
    }
}
