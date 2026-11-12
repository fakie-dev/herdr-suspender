// The folder swap of an update or a rollback, as one process (ADR 12).
//
// Herdr reloads a mod as soon as its folder changes, and that reload ends the
// tasks of the old build: the copy that started the swap may never hear back
// (measured on Herdr 0.1.15). So both renames are one program run by `exec`,
// which outlives the task, and the program puts the old folder back by itself
// when the second rename fails. Each step is a rename on one disk, so Herdr
// sees either the whole old folder, no folder for a few milliseconds (it keeps
// the loaded build and says so in `herdr-app status`), or the whole new one;
// never a half-written mod.
//
// Windows: PowerShell with the script in `-EncodedCommand`: no file to run,
// no execution policy, and the paths are single-quoted literals inside it, so
// nothing in a path is ever run. A rename blocked by a program that holds a
// folder (its current folder, an open file) is tried again for two seconds.
// Elsewhere: `sh -c` with the paths as arguments.
//
// The last line of output says what happened: `swapped`, `unchanged: why`,
// `restored: why` (the old folder is back), `broken: why` (neither is in
// place; only when even putting it back failed).

import type { SwapResult } from "./updater.ts";

const WINDOWS_SCRIPT = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
function Move-Folder([string]$from, [string]$to) {
  $why = ''
  for ($i = 0; $i -lt 10; $i++) {
    try { [System.IO.Directory]::Move($from, $to); return '' } catch { $why = $_.Exception.InnerException.Message; if (-not $why) { $why = $_.Exception.Message }; $why = ($why -replace '[\\r\\n]+', ' ').Trim() }
    Start-Sleep -Milliseconds 200
  }
  return $why
}
if (Test-Path -LiteralPath $parked) { 'unchanged: the place for the old folder is taken'; exit 2 }
if (-not (Test-Path -LiteralPath $incoming -PathType Container)) { 'unchanged: no new folder'; exit 2 }
if (-not (Test-Path -LiteralPath $live -PathType Container)) { 'unchanged: no folder to replace'; exit 2 }
try { New-Item -ItemType Directory -Force -Path (Split-Path -Parent $parked) | Out-Null } catch { 'unchanged: ' + $_.Exception.Message; exit 2 }
$out = Move-Folder $live $parked
if ($out) { 'unchanged: ' + $out; exit 2 }
$in = Move-Folder $incoming $live
if ($in) {
  $back = Move-Folder $parked $live
  if ($back) { 'broken: ' + $in + ' / ' + $back; exit 4 }
  'restored: ' + $in; exit 3
}
if ($drop) { Remove-Item -LiteralPath $parked -Recurse -Force -ErrorAction SilentlyContinue }
'swapped'
exit 0
`;

const SH_SCRIPT = `
live=$1; incoming=$2; parked=$3; drop=$4
if [ -e "$parked" ]; then echo "unchanged: the place for the old folder is taken"; exit 2; fi
if [ ! -d "$incoming" ]; then echo "unchanged: no new folder"; exit 2; fi
if [ ! -d "$live" ]; then echo "unchanged: no folder to replace"; exit 2; fi
mkdir -p "$(dirname "$parked")" || { echo "unchanged: no place for the old folder"; exit 2; }
mv "$live" "$parked" || { echo "unchanged: mods/suspender could not be moved"; exit 2; }
if [ ! -e "$live" ] && mv "$incoming" "$live"; then
  if [ "$drop" = 1 ]; then rm -rf "$parked"; fi
  echo swapped; exit 0
fi
if [ ! -e "$live" ] && mv "$parked" "$live"; then echo "restored: the new folder could not be moved in"; exit 3; fi
echo "broken: neither folder is in mods/suspender"; exit 4
`;

/** A PowerShell single-quoted literal: nothing inside it is expanded or run. */
export const psLiteral = (text: string): string => `'${text.replace(/'/g, "''")}'`;

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Base64 of the text's UTF-16LE bytes: what `-EncodedCommand` takes. Herdr's runtime has no Buffer that encodes. */
export function utf16leBase64(text: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    bytes.push(unit & 0xff, unit >> 8);
  }
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const [a = 0, b = 0, c = 0] = [bytes[i], bytes[i + 1], bytes[i + 2]];
    const word = (a << 16) | (b << 8) | c;
    out += B64[(word >> 18) & 63] ?? "";
    out += B64[(word >> 12) & 63] ?? "";
    out += i + 1 < bytes.length ? (B64[(word >> 6) & 63] ?? "") : "=";
    out += i + 2 < bytes.length ? (B64[word & 63] ?? "") : "=";
  }
  return out;
}

/** The program and arguments that swap `incoming` into `live`, parking `live` at `parked` (removed if `drop`). */
export function swapCommand(
  platform: "windows" | "macos" | "linux",
  live: string,
  incoming: string,
  parked: string,
  drop: boolean,
): { cmd: string; args: string[] } {
  if (platform === "windows") {
    const script = [
      `$live = ${psLiteral(live)}`,
      `$incoming = ${psLiteral(incoming)}`,
      `$parked = ${psLiteral(parked)}`,
      `$drop = ${drop ? "$true" : "$false"}`,
      WINDOWS_SCRIPT,
    ].join("\n");
    return {
      cmd: "powershell.exe",
      args: ["-NoProfile", "-NonInteractive", "-EncodedCommand", utf16leBase64(script)],
    };
  }
  return { cmd: "/bin/sh", args: ["-c", SH_SCRIPT, "suspender-swap", live, incoming, parked, drop ? "1" : "0"] };
}

const RESULTS = ["swapped", "unchanged", "restored", "broken"] as const;

/** What the swap's last line says; anything else counts as nothing moved. */
export function parseSwapOutput(out: string): SwapResult {
  const last =
    out
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== "")
      .pop() ?? "";
  const m = /^(swapped|unchanged|restored|broken)(?::\s*(.*))?$/.exec(last);
  const result = RESULTS.find((r) => r === m?.[1]);
  if (result === undefined) {
    return { result: "unchanged", detail: last };
  }
  return { result, detail: m?.[2] ?? "" };
}
