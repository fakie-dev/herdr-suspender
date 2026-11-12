// A small simulated Herdr for the engine tests: terminals with an agent in
// them, tabs as ordered rows of panes, the app commands and the `hc`
// subcommands the engine uses, shared values and a clock that only moves
// when the engine waits. Geometry follows Herdr's rules as experiments.md E1
// measured them: a split halves the target's share and puts the new pane
// after it; a swap trades places but each slot keeps its size; a closed
// pane's share goes to the one before it in its row, else the next. A pane
// that ends at the terminal's index with its size holds its rectangle.

import type { AgentAdapter, TerminalView } from "../../src/adapters/contract.ts";
import type { AgentId, SessionInfo, SessionKey } from "../../src/core/model.ts";
import type { ExecResult, Ports } from "../../src/platform/ports.ts";
import type { Host, HostPane, HostTab, HostTerminal, NoticeLevel } from "../../src/runtime/host.ts";
import { type FakePorts, fakePorts } from "../fakePorts.ts";

export const SPACE = "sp1";
export const TAB = "tb1";
export const SHELL_ARGV = ["pwsh.exe", "-NoExit", "-Command", "$global:__hc_prompt = …"];
/** The title a shell gives its terminal (PowerShell: its own path). */
export const SHELL_TITLE = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
/** The title an agent gives its terminal while it runs (Claude: the conversation's). */
export const AGENT_TITLE = "Synthetic conversation";

interface SimTerminal extends HostTerminal {
  /** Listed by the app (`terminals()`): one started with `hc run` only once Herdr adopts it. */
  listed: boolean;
  /** The agent running in it, or null for a bare shell. */
  agent: AgentId | null;
  /** The agent process is the terminal's own (started by argv, not from a shell). */
  direct: boolean;
  screen: string;
  /** The agent's own process under the shell, while it runs there. */
  agentPid: number | null;
  /** What was typed to start the agent in the shell ("claude --resume s1"). */
  ran: string | null;
  /** What sits in the agent's prompt, not sent yet. */
  input: string;
  /** Every line the agent was sent (Enter on its prompt), in order. */
  submitted: string[];
}

interface SimPane extends HostPane {
  props: Record<string, unknown> | null;
  /** Its share of the row. */
  size: number;
}

const ok = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });
const fail = (stderr: string): ExecResult => ({ code: 1, stdout: "", stderr });

export class Sim implements Host {
  now = 1_800_000_000_000;
  terms = new Map<string, SimTerminal>();
  paneList: SimPane[] = [];
  tabList: HostTab[] = [{ id: TAB, space: SPACE, active: true, spaceActive: true }];
  sharedValues = new Map<string, unknown>();
  commands: { command: string; args: Record<string, unknown> }[] = [];
  hcCalls: string[][] = [];
  notices: { text: string; level: NoticeLevel }[] = [];
  confirms: SessionKey[] = [];
  isReady = true;
  focus: { pane: string | null; terminal: string | null } | null = null;
  /** The focus each tab not on screen keeps for when it is shown again. */
  tabFocus = new Map<string, { pane: string | null; terminal: string | null } | null>();
  /** Each tab the screen went to, in order (`select`). */
  screenChanges: string[] = [];
  /** How long the memory query (PowerShell) takes; it lists the processes as they are when it answers. */
  memoryQueryMs = 0;
  onShared: ((key: string) => void) | null = null;
  /** The person's answer to the question for a working agent, if the test gives one. */
  onConfirm: ((key: SessionKey) => void) | null = null;
  /** Called when an agent leaves its terminal (it may write its transcript on the way out). */
  onLeave: ((address: string) => void) | null = null;

  // Agent behaviour.
  /** The agent leaves on its stop command. */
  exitsOnStop = true;
  /** A started agent reports its status after this long; null: never. */
  reportAfterMs: number | null = 500;
  /** `hc run` starts the default shell instead of the argv (the Git Bash `--argv` trap). */
  runStartsShell = false;
  /** Herdr adopts terminals started with `hc run` (lists them, gives them a pane). */
  adopts = true;
  /** Herdr carries out `terminal.park`; false: it fails in the background (a toast), the pane stays. */
  parks = true;
  /** Terminals `terminal.park` took out of their tab, in order. */
  parked: string[] = [];
  /** Terminals `terminal.kill` ended, and whether an agent still ran in each then. */
  killed: { address: string; agent: boolean }[] = [];
  /** A command typed into a shell starts nothing (a typo, a missing program). */
  typedStartsNothing = false;
  /** What the shell really runs for a typed line (a mangled line, an alias). */
  shellRewrites: ((line: string) => string) | null = null;
  /** Every command typed into a shell, in order; `shown`: the terminal had a pane in a tab then. */
  typed: { address: string; line: string; shown: boolean }[] = [];
  /**
   * Terminals Herdr adopted (gave a pane), in order; `agent`: an agent already
   * ran in it then; `reported`: it had reported its status (its screen is up).
   */
  adopted: { address: string; agent: boolean; reported: boolean }[] = [];
  /** When each of `adopted` got its pane (sim time). */
  adoptedAt: number[] = [];
  /**
   * How long each mod pane a split asks for takes to show in panes(), in the
   * order of the splits (a busy window can take seconds); 0 once used up.
   */
  modPaneDelays: number[] = [];
  /** Process listings asked for (PowerShell on Windows). */
  execCalls: { cmd: string; args: string[] }[] = [];

  private seq = 0;
  /** Counts the commands that change the screen, so they apply in order. */
  private screenOrder = 0;
  /** The last screen command that showed a tab of each space. */
  private spaceOrder = new Map<string, number>();
  private pidSeq = 1000;
  private timers: { at: number; fn: () => void }[] = [];

  // ---- building the world

  addTab(id: string, space = SPACE): void {
    const shownSpace = this.tabList.find((t) => t.spaceActive)?.space ?? SPACE;
    this.tabList.push({ id, space, active: false, spaceActive: space === shownSpace });
  }

  /** The tab on screen: the shown tab of the shown space. */
  shownTab(): string | null {
    return this.tabList.find((t) => t.active && t.spaceActive)?.id ?? null;
  }

  /**
   * Shows a tab and its space, as Herdr does on `tab.select`, on `pane.focus`
   * of a pane in it and for a new tab (measured on Herdr 0.1.15: `pane.split`,
   * `pane.swap`, `pane.close`, `terminal.park`, `terminal.kill` and adoption by
   * labels in a tab that is not shown leave the screen as it is). Each tab
   * keeps its own focus. Every change of the tab on screen is logged.
   */
  select(tab: string): void {
    const space = this.tabList.find((t) => t.id === tab)?.space;
    const from = this.shownTab();
    if (space === undefined) {
      return;
    }
    this.spaceOrder.set(space, ++this.screenOrder);
    if (from === tab) {
      return;
    }
    if (from !== null) {
      this.tabFocus.set(from, this.focus);
    }
    for (const t of this.tabList) {
      if (t.space === space) {
        t.active = t.id === tab;
      }
      t.spaceActive = t.space === space;
    }
    this.focus = this.tabFocus.get(tab) ?? null;
    this.screenChanges.push(tab);
  }

  addTerminal(opts: {
    agent?: AgentId | null;
    status?: string | null;
    tab?: string;
    space?: string;
    cwd?: string;
    labels?: Record<string, string>;
    direct?: boolean;
    pid?: number;
    /** Put its pane first in the row. */
    first?: boolean;
  }): { address: string; pane: string } {
    const address = `t${++this.seq}`;
    const agent = opts.agent === undefined ? "claude" : opts.agent;
    const tab = opts.tab ?? TAB;
    const term: SimTerminal = {
      address,
      state: "live",
      pid: opts.pid ?? this.pidSeq++,
      argv: opts.direct ? ["claude"] : [...SHELL_ARGV],
      cwd: opts.cwd ?? "C:\\work\\repo",
      labels: { "herdr.space": opts.space ?? SPACE, "herdr.tab": tab, ...(opts.labels ?? {}) },
      status: agent === null ? null : (opts.status ?? "idle"),
      app: agent === null ? null : appOf(agent),
      foreground: null,
      createdMs: this.now - 60_000,
      parent: null,
      title: agent === null ? SHELL_TITLE : AGENT_TITLE,
      agent,
      direct: opts.direct ?? false,
      screen: `screen of ${address}`,
      listed: true,
      agentPid: agent !== null && !opts.direct ? this.pidSeq++ : null,
      ran: null,
      input: "",
      submitted: [],
    };
    this.terms.set(address, term);
    const pane = this.newPane(tab, address, null, null);
    if (opts.first) {
      this.paneList.unshift(pane);
    } else {
      this.paneList.push(pane);
    }
    return { address, pane: pane.pane };
  }

  addModPane(tab: string, props: Record<string, unknown>): string {
    const pane = this.newPane(tab, null, "suspender", props);
    this.paneList.push(pane);
    return pane.pane;
  }

  term(address: string): SimTerminal {
    const t = this.terms.get(address);
    if (!t) {
      throw new Error(`no terminal ${address}`);
    }
    return t;
  }

  /** Each pane of a tab with its share, in order. */
  layout(tab = TAB): { pane: string; size: number }[] {
    return this.paneList.filter((p) => p.tab === tab).map((p) => ({ pane: p.pane, size: p.size }));
  }

  /** Pane ids of a tab, in order. */
  row(tab = TAB): string[] {
    return this.paneList.filter((p) => p.tab === tab).map((p) => p.pane);
  }

  pane(id: string): SimPane | undefined {
    return this.paneList.find((p) => p.pane === id);
  }

  setStatus(address: string, status: string | null): void {
    this.term(address).status = status;
  }

  /** Simulates the loss of a terminal (core crash, reboot): a shell in its place, same address and labels. */
  loseTerminal(address: string): void {
    const t = this.term(address);
    t.pid = this.pidSeq++;
    t.argv = [...SHELL_ARGV];
    t.agent = null;
    t.app = null;
    t.status = null;
    t.direct = false;
    t.title = SHELL_TITLE;
    t.screen = "PS C:\\work\\repo>";
  }

  /**
   * The agent's process is killed hard (taskkill /F, a crash): it is gone from
   * the process table and the shell's title is back, but Herdr keeps the last
   * status it reported ("claude-code idle"): nothing reports the exit.
   */
  killAgent(address: string): void {
    const t = this.term(address);
    t.agent = null;
    t.agentPid = null;
    t.ran = null;
    t.title = SHELL_TITLE;
  }

  // ---- Host

  terminals(): HostTerminal[] {
    return [...this.terms.values()]
      .filter((t) => t.listed)
      .map(
        ({ agent: _a, direct: _d, screen: _s, listed: _l, agentPid: _p, ran: _r, input: _i, submitted: _u, ...t }) => ({
          ...t,
          labels: { ...t.labels },
          argv: [...t.argv],
        }),
      );
  }
  panes(): HostPane[] {
    return this.paneList.map(({ props: _p, size: _s, ...p }) => ({ ...p }));
  }
  tabs(): HostTab[] {
    return this.tabList.map((t) => ({ ...t }));
  }
  ready(): boolean {
    return this.isReady;
  }
  focused(): { pane: string | null; terminal: string | null } | null {
    return this.focus;
  }
  run(command: string, args: Record<string, unknown>): void {
    this.commands.push({ command, args });
    const at = (id: unknown): number => this.paneList.findIndex((p) => p.pane === id);
    switch (command) {
      case "pane.split": {
        const i = at(args["pane"]);
        const target = this.paneList[i];
        if (!target) {
          return;
        }
        const mod = typeof args["mod"] === "string" ? args["mod"] : null;
        let terminal: string | null = null;
        if (mod === null) {
          const shell = this.addTerminal({ agent: null, tab: target.tab });
          this.paneList.pop();
          terminal = shell.address;
        }
        const pane = this.newPane(
          target.tab,
          terminal,
          mod,
          mod ? ((args["props"] as Record<string, unknown>) ?? {}) : null,
        );
        const show = (): void => {
          const j = this.paneList.indexOf(target);
          if (j === -1) {
            // Herdr split it before the target closed and only reports it late: it holds the tab's room.
            pane.size = Math.max(
              0,
              1 - this.paneList.filter((p) => p.tab === pane.tab).reduce((s, p) => s + p.size, 0),
            );
            this.paneList.push(pane);
            return;
          }
          target.size /= 2;
          pane.size = target.size;
          this.paneList.splice(j + 1, 0, pane);
        };
        const delay = mod !== null ? (this.modPaneDelays.shift() ?? 0) : 0;
        if (delay > 0) {
          this.later(delay, show);
        } else {
          show();
        }
        return;
      }
      case "pane.swap": {
        const a = at(args["pane"]);
        const b = at(args["target"]);
        const pa = this.paneList[a];
        const pb = this.paneList[b];
        if (pa && pb && pa.tab === pb.tab) {
          // Sizes stay with the slots.
          [pa.size, pb.size] = [pb.size, pa.size];
          this.paneList[a] = pb;
          this.paneList[b] = pa;
        }
        return;
      }
      case "pane.close": {
        const i = at(args["pane"]);
        const pane = this.paneList[i];
        if (pane) {
          this.removePane(pane.pane);
          if (pane.terminal) {
            this.finish(pane.terminal, "killed");
          }
        }
        return;
      }
      case "terminal.kill": {
        const address = String(args["terminal"]);
        this.killed.push({ address, agent: this.terms.get(address)?.agent != null });
        this.finish(address, "killed");
        this.removePaneOf(address);
        return;
      }
      case "terminal.park": {
        // Measured (Herdr 0.1.15): the pane goes as a closed one does (its share to the pane before it),
        // Herdr's labels go, the terminal keeps running and stays in terminals() with its status.
        const t = this.terms.get(String(args["terminal"]));
        if (!this.parks || t?.state !== "live") {
          return;
        }
        this.removePaneOf(t.address);
        delete t.labels["herdr.space"];
        delete t.labels["herdr.tab"];
        this.parked.push(t.address);
        return;
      }
      case "tab.new": {
        const id = `tb${++this.seq}`;
        const mod = typeof args["mod"] === "string" ? args["mod"] : null;
        const pane = this.newPane(id, null, mod, (args["props"] as Record<string, unknown>) ?? {});
        // Herdr shows the new tab (measured): it becomes its space's tab and the
        // tab on screen. Commands apply in order, so a later `tab.select` wins
        // even when the new tab is listed late.
        const space = String(args["space"] ?? SPACE);
        const order = ++this.screenOrder;
        const show = (): void => {
          this.addTab(id, space);
          this.paneList.push(pane);
          if (order === this.screenOrder) {
            this.select(id);
          } else if ((this.spaceOrder.get(space) ?? 0) < order) {
            for (const t of this.tabList) {
              if (t.space === space) {
                t.active = t.id === id;
              }
            }
          }
        };
        // A busy window shows a new tab late, as it does a split.
        const delay = mod !== null ? (this.modPaneDelays.shift() ?? 0) : 0;
        if (delay > 0) {
          this.later(delay, show);
        } else {
          show();
        }
        return;
      }
      case "pane.focus": {
        const pane = this.paneList.find((p) => p.pane === args["pane"]);
        if (pane) {
          this.select(pane.tab);
          this.focus = { pane: pane.pane, terminal: pane.terminal };
        }
        return;
      }
      case "tab.select": {
        this.select(String(args["id"]));
        return;
      }
      case "space.select": {
        const tab = this.tabList.find((t) => t.space === args["id"] && t.active);
        if (tab) {
          this.select(tab.id);
        }
        return;
      }
      default:
        return;
    }
  }
  runOnScreen(command: string, args: Record<string, unknown>): void {
    this.run(command, args);
  }
  shared(key: string): unknown {
    return this.sharedValues.get(key) ?? null;
  }
  setShared(key: string, value: unknown): void {
    this.sharedValues.set(key, value);
    this.onShared?.(key);
  }
  async sleep(ms: number): Promise<void> {
    await this.advance(ms);
  }
  notify(text: string, level: NoticeLevel): void {
    this.notices.push({ text, level });
  }
  askConfirm(key: SessionKey): void {
    this.confirms.push(key);
    const answer = this.onConfirm;
    if (answer !== null) {
      // The person answers a moment later.
      this.later(1_000, () => answer(key));
    }
  }

  // ---- hc

  async hc(args: string[]): Promise<ExecResult> {
    this.hcCalls.push([...args]);
    const [cmd, ...rest] = args;
    switch (cmd) {
      case "label": {
        const t = this.terms.get(rest[0] ?? "");
        if (!t) {
          return fail("no such terminal");
        }
        const unplaced = t.labels["herdr.tab"] === undefined;
        for (const kv of rest.slice(1)) {
          const cut = kv.indexOf("=");
          const k = kv.slice(0, cut);
          const v = kv.slice(cut + 1);
          if (v === "") {
            delete t.labels[k];
          } else {
            t.labels[k] = v;
          }
        }
        // A terminal that now has Herdr's labels shows up there (measured: `hc label` adopts it).
        if (unplaced && t.labels["herdr.tab"] !== undefined) {
          this.later(100, () => this.adopt(t));
        }
        return ok("{}");
      }
      case "keys": {
        const t = this.terms.get(rest[0] ?? "");
        const keys = rest.slice(1);
        if (t?.agent) {
          this.agentKeys(t, keys);
          return ok("{}");
        }
        // A command typed key by key into a shell, then Enter.
        const typed =
          keys.at(-1) === "enter"
            ? keys
                .slice(0, -1)
                .map((k) => (k === "space" ? " " : k))
                .join("")
            : "";
        if (t && t.state === "live" && typed !== "" && t.screen !== "") {
          // (A shell that has not shown its prompt yet loses what is typed.)
          this.typed.push({
            address: t.address,
            line: typed,
            shown: this.paneList.some((p) => p.terminal === t.address),
          });
          this.shellRuns(t, typed);
        }
        return t ? ok("{}") : fail("no such terminal");
      }
      case "send": {
        // Real `hc send` may wrap the text in an <hc from=…> tag: an agent reads a message, not a command.
        return this.terms.has(rest[0] ?? "") ? ok("{}") : fail("no such terminal");
      }
      case "read": {
        const t = this.terms.get(rest[0] ?? "");
        return t ? ok(t.screen) : fail("no such terminal");
      }
      case "get": {
        const t = this.terms.get(rest[0] ?? "");
        if (!t) {
          return fail("no such terminal");
        }
        return ok(
          JSON.stringify({
            address: t.address,
            argv: t.argv,
            pid: t.pid,
            cwd: t.cwd,
            labels: t.labels,
            state: t.state,
            created_ms: t.createdMs,
            title: t.title,
            status: t.status === null ? null : { app: t.app, state: t.status },
          }),
        );
      }
      case "kill": {
        const t = this.terms.get(rest[0] ?? "");
        if (!t) {
          return fail("no such terminal");
        }
        this.finish(t.address, "killed");
        this.removePaneOf(t.address);
        return ok("{}");
      }
      case "rm": {
        const t = this.terms.get(rest[0] ?? "");
        if (t && t.state !== "live") {
          this.terms.delete(t.address);
          return ok("{}");
        }
        return fail("not finished");
      }
      case "run":
        return this.hcRun(rest);
      default:
        return fail(`sim: no hc ${cmd}`);
    }
  }

  /** Ports on this world: in-memory files, `hc` answered here, the clock is the sim's. */
  ports(base: FakePorts = fakePorts({ sep: "\\", home: "C:\\Users\\tester" })): FakePorts {
    base.hc = (args) => this.hc(args);
    base.now = () => this.now;
    base.exec = async (cmd, args) => {
      this.execCalls.push({ cmd, args });
      if (/powershell/i.test(cmd)) {
        if (args.join(" ").includes("WorkingSetPrivate")) {
          const delay = this.memoryQueryMs;
          return delay > 0
            ? new Promise((resolve) => this.later(delay, () => resolve(ok(this.memoryTable()))))
            : ok(this.memoryTable());
        }
        return ok(this.processTable());
      }
      return /tasklist/i.test(cmd) ? ok(this.taskList()) : { code: 127, stdout: "", stderr: "sim: no such tool" };
    };
    return base;
  }

  // ---- internals

  /** Every process as `processDetails` reads PowerShell: pid, ppid, start, name, command line. */
  private processTable(): string {
    const lines: string[] = [];
    for (const t of this.terms.values()) {
      if (t.state !== "live" || t.pid === null) {
        continue;
      }
      lines.push(`${t.pid}\t1\t\t${t.direct ? `${t.argv[0]}.exe` : "pwsh.exe"}\t${t.argv.join(" ")}`);
      if (t.agent !== null && t.agentPid !== null) {
        const name = `${t.agent}.exe`;
        lines.push(
          `${t.agentPid}\t${t.pid}\t\t${name}\t"C:\\bin\\${name}" ${(t.ran ?? t.agent).split(" ").slice(1).join(" ")}`,
        );
      }
    }
    return lines.join("\r\n");
  }

  /** Every process as `treesMemoryMb` reads PowerShell: P pid, ppid, start; M pid, private working set in bytes. */
  private memoryTable(): string {
    const MB = 1024 * 1024;
    const lines: string[] = [];
    for (const t of this.terms.values()) {
      if (t.state !== "live" || t.pid === null) {
        continue;
      }
      lines.push(`P\t${t.pid}\t1\t`, `M\t${t.pid}\t${40 * MB}`);
      if (t.agent !== null && t.agentPid !== null) {
        lines.push(`P\t${t.agentPid}\t${t.pid}\t`, `M\t${t.agentPid}\t${200 * MB}`);
      }
    }
    return lines.join("\r\n");
  }

  /** Every process as `tasklist /FO CSV /NH` prints it: name, pid, session, number, memory. */
  private taskList(): string {
    const row = (name: string, pid: number): string => `"${name}","${pid}","Console","1","10 000 K"`;
    const lines: string[] = [];
    for (const t of this.terms.values()) {
      if (t.state !== "live" || t.pid === null) {
        continue;
      }
      lines.push(row(t.direct ? `${t.argv[0]}.exe` : "pwsh.exe", t.pid));
      if (t.agent !== null && t.agentPid !== null) {
        lines.push(row(`${t.agent}.exe`, t.agentPid));
      }
    }
    return lines.join("\r\n");
  }

  /**
   * Keys pressed in an agent: characters go into its prompt, Enter sends the
   * prompt as one line, Esc stops a turn, Ctrl+C empties the prompt (or stops
   * a turn). A line that is exactly its exit command makes it leave.
   */
  private agentKeys(t: SimTerminal, keys: string[]): void {
    for (const key of keys) {
      if (key === "esc" || key === "ctrl+c") {
        if (t.status === "working") {
          this.later(200, () => {
            t.status = "idle";
          });
        } else if (key === "ctrl+c") {
          t.input = "";
        }
      } else if (key === "enter") {
        const line = t.input;
        t.input = "";
        t.submitted.push(line);
        if (/^\/(exit|quit)$/.test(line) && this.exitsOnStop) {
          this.later(300, () => this.agentLeaves(t.address));
        }
      } else if (key === "space") {
        t.input += " ";
      } else if ([...key].length === 1) {
        t.input += key;
      }
    }
  }

  /** A shell runs a typed line: `claude …` / `codex …` start that agent in it. */
  private shellRuns(t: SimTerminal, line: string): void {
    const agent: AgentId | null = /^claude\b/.test(line) ? "claude" : /^codex\b/.test(line) ? "codex" : null;
    if (agent === null || this.typedStartsNothing) {
      return;
    }
    t.agent = agent;
    t.agentPid = this.pidSeq++;
    t.ran = this.shellRewrites?.(line) ?? line;
    // A program sets its title when it starts, whether or not it reports a status.
    t.title = AGENT_TITLE;
    if (this.reportAfterMs !== null) {
      this.later(this.reportAfterMs, () => {
        if (t.state === "live" && t.agent === agent) {
          t.status = "idle";
          t.app = appOf(agent);
          t.title = AGENT_TITLE;
        }
      });
    }
  }

  private hcRun(args: string[]): ExecResult {
    const dash = args.indexOf("--");
    const flags = dash === -1 ? args : args.slice(0, dash);
    const argv = dash === -1 ? [] : args.slice(dash + 1);
    const labels: Record<string, string> = {};
    let cwd = "";
    for (let i = 0; i < flags.length; i++) {
      if (flags[i] === "--label") {
        const kv = flags[++i] ?? "";
        const cut = kv.indexOf("=");
        labels[kv.slice(0, cut)] = kv.slice(cut + 1);
      } else if (flags[i] === "--cwd") {
        cwd = flags[++i] ?? "";
      }
    }
    const agent: AgentId | null = /claude/.test(argv[0] ?? "")
      ? "claude"
      : /codex/.test(argv[0] ?? "")
        ? "codex"
        : null;
    const address = `t${++this.seq}`;
    // No command: the machine's own shell, as a new tab gets.
    const shell = this.runStartsShell || argv.length === 0;
    const term: SimTerminal = {
      address,
      state: "live",
      pid: this.pidSeq++,
      argv: shell ? [...SHELL_ARGV] : [...argv],
      cwd,
      labels,
      status: null,
      app: null,
      foreground: null,
      createdMs: this.now,
      parent: null,
      title: shell ? SHELL_TITLE : AGENT_TITLE,
      agent: shell ? null : agent,
      direct: !shell,
      screen: "",
      listed: false,
      agentPid: null,
      ran: null,
      input: "",
      submitted: [],
    };
    this.terms.set(address, term);
    // A shell shows its prompt a moment after it starts, shown in a tab or not.
    this.later(100, () => {
      if (term.agent === null && term.state === "live" && term.screen === "") {
        term.screen = "PS C:\\work\\repo>";
      }
    });
    // With Herdr's labels Herdr adopts it on its next pass; without them it stays out of its screens (measured).
    if (labels["herdr.tab"] !== undefined) {
      this.later(100, () => this.adopt(term));
    }
    if (term.agent !== null && this.reportAfterMs !== null) {
      this.later(this.reportAfterMs, () => {
        if (term.state === "live" && term.agent) {
          term.status = "idle";
          term.app = appOf(term.agent);
        }
      });
    }
    return ok(JSON.stringify({ address, state: "live" }));
  }

  /** Herdr adopts a terminal: lists it, and gives it a pane right of the last pane of its tab. */
  private adopt(term: SimTerminal): void {
    if (!this.adopts || term.listed) {
      return;
    }
    term.listed = true;
    if (term.state !== "live") {
      return;
    }
    this.adopted.push({ address: term.address, agent: term.agent !== null, reported: term.status !== null });
    this.adoptedAt.push(this.now);
    const tab = term.labels["herdr.tab"] ?? TAB;
    let last = -1;
    this.paneList.forEach((p, i) => {
      if (p.tab === tab) {
        last = i;
      }
    });
    // Adoption splits the tab's last pane (src/window.rs: model.split(&target, Row)).
    const pane = this.newPane(tab, term.address, null, null);
    const target = this.paneList[last];
    if (target) {
      target.size /= 2;
      pane.size = target.size;
    }
    this.paneList.splice(last + 1, 0, pane);
  }

  private agentLeaves(address: string): void {
    const t = this.terms.get(address);
    if (t?.state !== "live") {
      return;
    }
    t.agent = null;
    t.app = null;
    t.status = null;
    t.agentPid = null;
    t.title = SHELL_TITLE;
    this.onLeave?.(address);
    if (t.direct) {
      // A program exiting closes its pane.
      this.finish(address, "exited");
      this.removePaneOf(address);
    }
  }

  private finish(address: string, _reason: string): void {
    const t = this.terms.get(address);
    if (t) {
      t.state = "finished";
      t.agent = null;
      t.app = null;
      t.status = null;
      t.pid = null;
    }
  }

  private newPane(
    tab: string,
    terminal: string | null,
    mod: string | null,
    props: Record<string, unknown> | null,
  ): SimPane {
    return { pane: `p${++this.seq}`, terminal, mod, tab, props, size: 1 };
  }

  /** Closes a pane: its share goes to the pane before it in its row, else the next. */
  removePane(id: string): void {
    const i = this.paneList.findIndex((p) => p.pane === id);
    const pane = this.paneList[i];
    if (!pane) {
      return;
    }
    const row = this.paneList.filter((p) => p.tab === pane.tab);
    const j = row.indexOf(pane);
    const heir = row[j - 1] ?? row[j + 1];
    if (heir) {
      heir.size += pane.size;
    }
    this.paneList.splice(i, 1);
  }

  private removePaneOf(address: string): void {
    const pane = this.paneList.find((p) => p.terminal === address);
    if (pane) {
      this.removePane(pane.pane);
    }
  }

  private later(ms: number, fn: () => void): void {
    this.timers.push({ at: this.now + ms, fn });
  }

  async advance(ms: number): Promise<void> {
    const end = this.now + ms;
    for (;;) {
      this.timers.sort((a, b) => a.at - b.at);
      const next = this.timers[0];
      if (!next || next.at > end) {
        break;
      }
      this.timers.shift();
      this.now = Math.max(this.now, next.at);
      next.fn();
    }
    // Two waits may overlap (two copies at work): the clock never goes back.
    this.now = Math.max(this.now, end);
    await Promise.resolve();
  }
}

const appOf = (agent: AgentId): string => (agent === "claude" ? "claude-code" : "codex");

// ---- a scriptable adapter

export interface FakeAdapterState {
  /** Session id `discoverSession` finds per terminal address. */
  sessions: Map<string, string>;
  /** Sessions whose conversation is gone from disk. */
  missing: Set<string>;
  /** Sessions open elsewhere, with where. */
  elsewhere: Map<string, string>;
  /** What `snapshot` returns per session (merged over a default). */
  info: Map<string, Partial<SessionInfo>>;
  snapshots: string[];
  openChecks: string[];
  /** Terminal addresses `discoverSession` was asked about, in order. */
  discovers: string[];
  /** The views it was given, in order. */
  views: TerminalView[];
}

export function fakeAdapter(
  id: AgentId,
  state: FakeAdapterState = {
    sessions: new Map(),
    missing: new Set(),
    elsewhere: new Map(),
    info: new Map(),
    snapshots: [],
    openChecks: [],
    discovers: [],
    views: [],
  },
): AgentAdapter & { state: FakeAdapterState } {
  const app = appOf(id);
  return {
    state,
    id,
    displayName: id === "claude" ? "Claude Code" : "Codex",
    // As the real adapters: by what the agent reported, or by its process.
    matches: (t: TerminalView) => t.app === app || new RegExp(`^${id}(.exe)?$`, "i").test(t.foreground?.name ?? ""),
    discoverSession: async (t: TerminalView, _p: Ports) => {
      state.discovers.push(t.address);
      state.views.push(t);
      return state.sessions.get(t.address) ?? null;
    },
    snapshot: async (sessionId: string, cwd: string, _p: Ports, prev?: SessionInfo) => {
      state.snapshots.push(sessionId);
      return {
        title: `title of ${sessionId}`,
        firstPrompt: "first",
        lastReply: "last",
        messages: 10,
        branch: "main",
        model: "opus",
        cwd,
        repoRoot: null,
        sessionId,
        contextPct: null,
        contextText: null,
        tokensText: null,
        transcriptMtimeMs: 1_700_000_000_000,
        transcriptSize: 1000,
        ...(prev ?? {}),
        ...(state.info.get(sessionId) ?? {}),
      };
    },
    transcriptExists: async (sessionId: string) => !state.missing.has(sessionId),
    openElsewhere: async (sessionId: string) => {
      state.openChecks.push(sessionId);
      const where = state.elsewhere.get(sessionId);
      return where === undefined ? { open: false } : { open: true, where };
    },
    stopSteps: () =>
      id === "claude"
        ? [{ key: "esc" }, { waitIdleMs: 10_000 }, { key: "ctrl+c" }, { send: "/exit" }, { waitExitMs: 10_000 }]
        : [{ key: "ctrl+c" }, { send: "/quit" }, { waitExitMs: 10_000 }],
    resumeArgv: (sessionId: string) =>
      id === "claude" ? ["claude", "--resume", sessionId] : ["codex", "resume", sessionId],
    newArgv: () => [id],
  };
}
