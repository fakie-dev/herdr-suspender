# 10. Memory freed is the private working set

Status: accepted.

## Context

A session's memory, freed at Sleep and in use while it runs, was the sum of tasklist's "Mem Usage" over the
terminal's process and everything under it. That column is the working set: every page a process has in RAM,
including the pages it shares with other processes (system DLLs, the `node.exe` image, mapped files), counted
again for each process. A Claude Code session is not one process: the shell, `claude.exe` and its MCP servers
(`cmd`, `node`, `bun`, `pnpm`, each with its `conhost`) made 31 processes in the case below.

A person noticed that a chat with one message said 1.5 GB and 1.7 GB freed. Measured on Windows in an isolated
core, a fresh Claude Code in a made-up folder after one short message, in MB, summed over the same 31
processes (the tree was checked: every child started after its parent, no foreign process in it):

| Run | Working set (old figure) | Private working set | Private bytes | Came back when it ended                           |
| --- | ------------------------ | ------------------- | ------------- | ------------------------------------------------- |
| 1   | 1442                     | 702                 | 1727          | +878 available                                    |
| 2   | 1562                     | 739                 | 1739          | +1087 available (noisy: the machine was busy)     |
| 3   | 1486                     | 753                 | 1710          | +846 available: +771 free and zeroed, +74 standby |

- Working set: tasklist's "Mem Usage" (the old figure). Private working set: the part of it no other process
  shares (`Win32_PerfRawData_PerfProc_Process.WorkingSetPrivate`), Task Manager's memory column. Private bytes:
  memory committed (much of it not in RAM). "Came back": `\Memory\Available MBytes` (in run 3 also split into
  the free and zeroed list and the standby cache), averaged over 3 s before `/exit` and 4 s after the shell was
  killed.
- The free and zeroed pages that came back (771) match the private working set (753): those are the pages
  that are really released. The rest of "available" is file pages that went from the working sets to the
  standby cache, still cached, and other activity on the machine.
- The shell, `claude.exe` and each `node.exe` show 37 to 90 MB of shared pages each; 31 of them make the
  working-set sum about twice the private one. On a machine running other Claude Code and Node processes,
  those shared pages stay in RAM after the session ends.

## Decision

The memory of a session is the sum of the private working sets of its terminal's process tree, on Windows.
Freed (measured at Sleep, right before the stop) and in use (the Sessions panel, while it is open) come from the
same function, `treesMemoryMb`, so the two figures compare.

It is one PowerShell call: `Win32_Process` for the tree and `Win32_PerfRawData_PerfProc_Process` for the
private working sets. Measured: about 1.1 to 1.3 s and one process, where `processDetails` and `tasklist` side
by side took 1.0 to 1.1 s and two processes. When Windows gives no private working set, no figure is shown:
the working set instead would put the old number back beside the new ones.

The tree also leaves out a process that started before the process now holding its parent's id. Windows reuses
ids, so the children of a process that has ended could otherwise be counted under an unrelated new process. It
was not the cause here, but nothing else would catch it.

On macOS and Linux the figure stays the resident size (`ps` rss), now taken in the same `ps` call as the tree.
Shared pages are counted there too, but less so; nobody has measured it yet.

## Rejected

- **The working set (tasklist)**: counts shared pages once per process, about twice what comes back.
- **Private bytes** (`PrivateMemorySize64`): memory committed, not memory in RAM; 1.7 GB here, more than the
  working set.
- **"Available" before and after**: the true result, but known only after the stop, and as noisy as whatever
  else the machine is doing.

## Consequences

- Records written before this keep their old, larger figure until the session sleeps again.
- The figure is a little low rather than high: pages shared only inside the tree (the `claude.exe` image when no
  other one runs) also go back and are not counted.
