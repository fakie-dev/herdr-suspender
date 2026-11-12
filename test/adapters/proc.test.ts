import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExecResult } from "../../src/platform/ports.ts";
import { descendsFrom, memoryKb, processDetails, statFile, treesMemoryMb } from "../../src/platform/proc.ts";
import { type FakePorts, fakePorts } from "../fakePorts.ts";

type Script = (cmd: string, args: string[]) => ExecResult;

function scripted(ports: FakePorts, script: Script): FakePorts {
  ports.exec = async (cmd, args) => {
    ports.execCalls.push({ cmd, args });
    return script(cmd, args);
  };
  return ports;
}

const ok = (stdout: string, code = 0): ExecResult => ({ code, stdout, stderr: "" });

describe("memoryKb", () => {
  it("reads a set of pids on Windows with one tasklist call, whatever the digit grouping", async () => {
    const p = scripted(fakePorts({ sep: "\\" }), () =>
      ok(
        [
          '"System Idle Process","0","Services","0","8 K"',
          '"claude.exe","4242","Console","1","396\u00a0412 K"',
          '"node.exe","5151","Console","1","1,024 K"',
          '"claude.exe","6000","Console","1","200 000 K"',
        ].join("\r\n"),
      ),
    );
    const mem = await memoryKb([4242, 5151, 7777], p);
    assert.equal(p.execCalls.length, 1);
    assert.equal(p.execCalls[0]?.cmd, "tasklist");
    assert.deepEqual([...mem.entries()].sort(), [
      [4242, 396_412],
      [5151, 1024],
    ]);
  });

  it("reads a set of pids on POSIX with one ps call", async () => {
    const p = scripted(fakePorts({ sep: "/" }), () => ok("  4242 396412\n 5151   1024\n"));
    const mem = await memoryKb([4242, 5151], p);
    assert.equal(p.execCalls.length, 1);
    assert.equal(p.execCalls[0]?.cmd, "ps");
    assert.ok(p.execCalls[0]?.args.includes("4242,5151"));
    assert.equal(mem.get(4242), 396_412);
    assert.equal(mem.get(5151), 1024);
  });

  it("starts nothing for an empty set and survives a failing tool", async () => {
    const p = scripted(fakePorts({ sep: "/" }), () => {
      throw new Error("not installed");
    });
    assert.equal((await memoryKb([], p)).size, 0);
    assert.equal(p.execCalls.length, 0);
    assert.equal((await memoryKb([1], p)).size, 0);
  });
});

describe("processDetails", () => {
  it("parses parent, start time and command line on POSIX", async () => {
    const p = scripted(fakePorts({ sep: "/", now: 1_800_000_000_000 }), () =>
      ok(
        "    1     0 3-01:00:00 /sbin/init\n  900     1    01:05 /bin/zsh -l\n  901   900       07 codex resume abc\n",
      ),
    );
    const list = await processDetails(p);
    const codex = list.find((d) => d.pid === 901);
    assert.equal(codex?.ppid, 900);
    assert.equal(codex?.startMs, 1_800_000_000_000 - 7_000);
    assert.equal(codex?.commandLine, "codex resume abc");
    assert.equal(list.find((d) => d.pid === 900)?.startMs, 1_800_000_000_000 - 65_000);
    assert.equal(list.find((d) => d.pid === 1)?.startMs, 1_800_000_000_000 - (3 * 86_400 + 3600) * 1000);
    assert.ok(descendsFrom(list, 901, 1));
    assert.ok(!descendsFrom(list, 900, 901));
  });

  it("parses the tab-separated Windows listing", async () => {
    const p = scripted(fakePorts({ sep: "\\" }), () =>
      ok("10\t4\t1800000000000\tpwsh.exe\tpwsh.exe -NoLogo\r\n11\t10\t\tcodex.exe\t\r\n"),
    );
    const list = await processDetails(p);
    assert.deepEqual(list[0], {
      pid: 10,
      ppid: 4,
      startMs: 1_800_000_000_000,
      name: "pwsh.exe",
      commandLine: "pwsh.exe -NoLogo",
    });
    assert.deepEqual(list[1], { pid: 11, ppid: 10, startMs: null, name: "codex.exe", commandLine: null });
  });
});

describe("statFile", () => {
  it("takes size and UTC time from robocopy on Windows, without reading the file", async () => {
    const p = scripted(fakePorts({ sep: "\\" }), () =>
      ok("\r\n\t  \t\t            1019 2026/11/10 12:31:39\tC:\\dev\\app\\package.json\r\n", 1),
    );
    const st = await statFile("C:\\dev\\app\\package.json", "windows", p.exec);
    assert.deepEqual(st, { size: 1019, mtimeMs: Date.UTC(2026, 10, 10, 12, 31, 39) });
    const call = p.execCalls[0];
    assert.equal(call?.cmd, "robocopy");
    assert.equal(call?.args[0], "C:\\dev\\app");
    assert.equal(call?.args[2], "package.json");
    assert.ok(call?.args.includes("/L"), "list only, never copy");
    assert.ok(!p.execCalls.some((c) => /powershell|pwsh/i.test(c.cmd)));
  });

  it("is null for a missing file or folder on Windows", async () => {
    const missing = scripted(fakePorts({ sep: "\\" }), () => ok("\r\n", 0));
    assert.equal(await statFile("C:\\dev\\x.jsonl", "windows", missing.exec), null);
    const noDir = scripted(fakePorts({ sep: "\\" }), () =>
      ok("2026/11/10 16:53:56 ERROR 2 (0x00000002) Accessing Source Directory C:\\nope\\\r\n", 16),
    );
    assert.equal(await statFile("C:\\nope\\x.jsonl", "windows", noDir.exec), null);
    // A failed run (exit 8+) is not trusted even if a listing line slipped out.
    const failed = scripted(fakePorts({ sep: "\\" }), () =>
      ok("\t\t\t   1019 2026/11/10 12:31:39\tC:\\dev\\x.jsonl\r\nERROR 5 Access is denied.\r\n", 8),
    );
    assert.equal(await statFile("C:\\dev\\x.jsonl", "windows", failed.exec), null);
  });

  it("uses stat on Linux and macOS with their own format flags", async () => {
    const linux = scripted(fakePorts({ sep: "/" }), () => ok("52428800 1800000000\n"));
    assert.deepEqual(await statFile("/home/t/a.jsonl", "linux", linux.exec), {
      size: 52_428_800,
      mtimeMs: 1_800_000_000_000,
    });
    assert.deepEqual(linux.execCalls[0], { cmd: "stat", args: ["-c", "%s %Y", "/home/t/a.jsonl"] });
    const mac = scripted(fakePorts({ sep: "/" }), () => ok("12 1800000001\n"));
    assert.deepEqual(await statFile("/Users/t/a.jsonl", "macos", mac.exec), { size: 12, mtimeMs: 1_800_000_001_000 });
    assert.deepEqual(mac.execCalls[0], { cmd: "stat", args: ["-f", "%z %m", "/Users/t/a.jsonl"] });
    const gone = scripted(fakePorts({ sep: "/" }), () => ({ code: 1, stdout: "", stderr: "No such file" }));
    assert.equal(await statFile("/home/t/b.jsonl", "linux", gone.exec), null);
  });
});

describe("memory a session gives back (user: «1.5 GB freed for a chat with one message?»)", () => {
  // Measured on Windows, a fresh Claude Code with its MCP servers: 31 processes, working sets adding up to
  // 1442 MB, private working sets to 702 MB; ending them made 878 MB available. The working set counts the
  // pages a process shares with others (node.exe, system DLLs) once per process; the private working set is
  // what Task Manager shows as a process's memory and what goes back when it ends.
  const windows = (perfOk = true) =>
    scripted(fakePorts({ sep: "\\" }), (cmd) => {
      if (cmd !== "powershell.exe") {
        return ok('"pwsh.exe","10","Console","1","120 000 K"\r\n"claude.exe","11","Console","1","280 000 K"');
      }
      return ok(
        [
          "P\t10\t4\t1800000000000",
          "P\t11\t10\t1800000001000",
          "P\t12\t11\t1800000002000",
          "P\t13\t11\t1800000002000",
          "P\t20\t4\t1800000000000",
          ...(perfOk
            ? [
                `M\t0\t${8 * 1024}`,
                `M\t10\t${37 * 1024 * 1024}`,
                `M\t11\t${194 * 1024 * 1024}`,
                `M\t12\t${54 * 1024 * 1024}`,
                `M\t13\t${1 * 1024 * 1024}`,
                `M\t20\t${500 * 1024 * 1024}`,
              ]
            : []),
        ].join("\r\n"),
      );
    });

  it("on Windows is the private working set of the terminal's tree, from one PowerShell call", async () => {
    const p = windows();
    const mb = await treesMemoryMb(p, [10, 11, 99]);
    assert.equal(mb.get(10), 37 + 194 + 54 + 1);
    assert.equal(mb.get(11), 194 + 54 + 1);
    assert.equal(mb.has(99), false);
    assert.equal(p.execCalls.length, 1);
    assert.equal(p.execCalls[0]?.cmd, "powershell.exe");
    assert.match(p.execCalls[0]?.args.join(" ") ?? "", /WorkingSetPrivate/);
  });

  it("is unknown, not the working set, when Windows gives no private working set", async () => {
    const p = windows(false);
    assert.equal((await treesMemoryMb(p, [10])).has(10), false);
  });

  it("on macOS and Linux is the resident size, from one ps call", async () => {
    const p = scripted(fakePorts({ sep: "/", now: 1_800_000_000_000 }), () =>
      ok("  900     1    01:05  2048\n  901   900       07 204800\n  950     1    01:00 999999\n"),
    );
    const mb = await treesMemoryMb(p, [900]);
    assert.equal(mb.get(900), 202);
    assert.equal(p.execCalls.length, 1);
    assert.equal(p.execCalls[0]?.cmd, "ps");
  });

  it("starts nothing without a tree to measure, and is empty when the tool fails", async () => {
    const p = scripted(fakePorts({ sep: "\\" }), () => {
      throw new Error("no PowerShell");
    });
    assert.equal((await treesMemoryMb(p, [])).size, 0);
    assert.equal(p.execCalls.length, 0);
    assert.equal((await treesMemoryMb(p, [10])).size, 0);
  });
});
