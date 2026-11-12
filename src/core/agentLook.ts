// Which icon Herdr draws for an agent. Herdr keeps one program table
// (programs.json on top of its built-in one) and gives every pane its row as
// `program`; its tab bar and Agents list draw `program.icon` from it. A
// sleeping session has no pane, so its row comes from `knownAgents()`, the
// table's agents, which Herdr checks with a process: asked once per load and
// kept, never on every draw. Nothing here imports Herdr; ui/kit.ts wires it.

import type { AgentId } from "./model.ts";

/** What drawing an agent's icon takes from Herdr's `Program`. */
export interface AgentLook {
  /** A path in Herdr's home as Herdr gives it ("icons/claude.svg"); `svg()` and `image()` read it there. */
  icon: string;
  /** A one-colour glyph, drawn with `svg()` in a text colour; else a picture, drawn with `image()`. */
  tint: boolean;
}

/** A failed lookup is asked again after this long (Herdr does not keep a failed check). */
export const LOOK_RETRY_MS = 60_000;

/** A Program's icon, or null when it names none (or is not a Program). */
export function lookOf(program: unknown): AgentLook | null {
  if (typeof program !== "object" || program === null) {
    return null;
  }
  const { icon, tint } = program as { icon?: unknown; tint?: unknown };
  return typeof icon === "string" && icon !== "" ? { icon, tint: tint === true } : null;
}

const keyOf = (program: unknown): unknown =>
  typeof program === "object" && program !== null ? (program as { key?: unknown }).key : undefined;

export interface LookSources {
  /** Herdr's `knownAgents()`: the program table's agents. May reject, or throw. */
  known(): Promise<unknown> | unknown;
  /** The programs of the panes there are now (no process). */
  live(): unknown[];
}

export class AgentLooks {
  private readonly sources: LookSources;
  /** The table's icons by agent key, once knownAgents() answered. */
  private table: ReadonlyMap<string, AgentLook> | null = null;
  private asking = false;
  private failedAt: number | null = null;

  constructor(sources: LookSources) {
    this.sources = sources;
  }

  /**
   * Starts the lookup when it is due (never done, none under way, the last
   * failure at least LOOK_RETRY_MS old) and resolves true when it changed what
   * `look` answers; null when nothing was started.
   */
  start(now: number): Promise<boolean> | null {
    if (this.table !== null || this.asking || (this.failedAt !== null && now - this.failedAt < LOOK_RETRY_MS)) {
      return null;
    }
    this.asking = true;
    return this.ask(now);
  }

  private async ask(now: number): Promise<boolean> {
    try {
      const answer = await this.sources.known();
      if (!Array.isArray(answer)) {
        throw new Error("knownAgents() gave no list");
      }
      const table = new Map<string, AgentLook>();
      for (const program of answer) {
        const key = keyOf(program);
        const look = lookOf(program);
        if (typeof key === "string" && look !== null) {
          table.set(key, look);
        }
      }
      this.table = table;
      return true;
    } catch {
      this.failedAt = now;
      return false;
    } finally {
      this.asking = false;
    }
  }

  /** The agent's icon: from the program table once it is known, else from a pane running that agent. */
  look(agent: AgentId): AgentLook | null {
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
