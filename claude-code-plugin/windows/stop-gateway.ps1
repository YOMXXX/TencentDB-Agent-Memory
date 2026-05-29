<#
  stop-gateway.ps1 - Stop the independent TDAI memory Gateway started by
  start-gateway.ps1 (Windows).

  Reads the pid from state.json, verifies it is really the gateway (node
  running gateway/cli.mjs) before killing, then stops it.

  state.json is left in place ON PURPOSE: it keeps ccPid=0, which tells the
  patched hooks "an externally-managed gateway exists but is down" so they
  skip silently instead of spawning a session-bound daemon that would
  self-exit on Windows. Re-run start-gateway.ps1 to bring it back.

  ASCII-ONLY (see start-gateway.ps1 header for why).
#>
[CmdletBinding()]
param(
  [string]$DataDir = (Join-Path $env:USERPROFILE '.claude\plugins\data\tdai-memory-tdai-local')
)

$ErrorActionPreference = 'Stop'

$statePath = Join-Path $DataDir 'state.json'
if (-not (Test-Path $statePath)) {
  Write-Host "No state.json in $DataDir - nothing registered."
  exit 0
}

$state = Get-Content -Raw -Path $statePath | ConvertFrom-Json
$gwPid = [int]$state.pid

$proc = Get-Process -Id $gwPid -ErrorAction SilentlyContinue
if (-not $proc) {
  Write-Host "Gateway PID $gwPid is not running (already stopped)."
  exit 0
}

# Safety: confirm the pid is actually our gateway before killing anything.
$cmdline = (Get-CimInstance Win32_Process -Filter "ProcessId=$gwPid" -ErrorAction SilentlyContinue).CommandLine
if ($cmdline -notmatch 'cli\.mjs') {
  throw "PID $gwPid is not the TDAI gateway (cmdline: $cmdline). Refusing to kill."
}

Stop-Process -Id $gwPid -Force
Write-Host "Stopped TDAI gateway (PID $gwPid). state.json left in place (ccPid=0)."
