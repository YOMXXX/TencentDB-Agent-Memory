<#
  start-gateway.ps1 - Launch the TDAI memory Gateway as an INDEPENDENT,
  permanent process that is NOT bound to any Claude Code session (Windows).

  WHY: the plugin's built-in spawn passes TDAI_CC_PID to the gateway, which
  arms a watchdog (gateway/cli.mjs) that self-exits ~15s after that pid dies.
  When a Claude Code hook spawns it from an ephemeral shell, the "parent" dies
  almost immediately and the gateway suicides. On Windows the spawn also goes
  through cmd.exe -> npx, so the tracked pid is a transient wrapper. This script
  runs the gateway directly with node, WITHOUT TDAI_CC_PID, so there is no
  watchdog and the process stays up until you stop it (stop-gateway.ps1) or
  reboot. The patched hooks (state.json ccPid=0) then just connect to it.

  SECRETS: provider API keys (e.g. OPENAI_API_KEY for embeddings) are loaded
  from a local, gitignored "gateway.secrets.env" next to this script and
  injected into the child process environment. This removes the dependency on
  fragile Windows User-env inheritance: a key set via `setx` AFTER a session or
  Task Scheduler context started does NOT reach an already-running process, so
  the gateway would otherwise initialise the embedding provider as disabled and
  semantic search would silently fall back to keyword. Copy
  gateway.secrets.env.example to gateway.secrets.env and fill in your keys.

  ASCII-ONLY: this file intentionally avoids non-ASCII characters (e.g. em
  dashes). Windows PowerShell 5.1 reads BOM-less scripts as the system ANSI
  codepage; a UTF-8 em dash misdecodes into a stray quote and breaks parsing.

  Idempotent: if a healthy gateway already answers on the port, it exits 0.
#>
[CmdletBinding()]
param(
  [int]$Port    = 8421,
  [string]$DataDir = (Join-Path $env:USERPROFILE '.claude\plugins\data\tdai-memory-tdai-local'),
  # Gateway entry point. Default resolves to the built dist of this repo
  # (<repo>\dist\src\gateway\cli.mjs); override for a global/npm install.
  [string]$GatewayCli = (Join-Path $PSScriptRoot '..\..\dist\src\gateway\cli.mjs'),
  # node.exe; leave blank to resolve from PATH.
  [string]$NodeExe = ''
)

$ErrorActionPreference = 'Stop'

function Test-GatewayHealth {
  param([int]$Port, [string]$Token)
  try {
    $resp = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/health" `
      -Headers @{ Authorization = "Bearer $Token" } -TimeoutSec 3 -UseBasicParsing
    return $resp.StatusCode -eq 200
  } catch { return $false }
}

# --- Resolve binaries ---
if ([string]::IsNullOrWhiteSpace($NodeExe) -or -not (Test-Path $NodeExe)) {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { $NodeExe = $cmd.Source } else { throw "node.exe not found (set -NodeExe)" }
}
if (-not (Test-Path $GatewayCli)) { throw "Gateway entry not found: $GatewayCli (build the repo or set -GatewayCli)" }
$GatewayCli = (Resolve-Path $GatewayCli).Path

New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
$tokenPath = Join-Path $DataDir 'token'
$statePath = Join-Path $DataDir 'state.json'

# --- Token: reuse the existing one (hooks read the same file), else mint a
#     32-byte base64url token to match daemon.ts generateToken(). ---
$token = $null
if (Test-Path $tokenPath) { $token = (Get-Content -Raw -Path $tokenPath).Trim() }
if ([string]::IsNullOrWhiteSpace($token)) {
  $bytes = New-Object byte[] 32
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $token = [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+','-').Replace('/','_')
  Set-Content -Path $tokenPath -Value $token -NoNewline -Encoding ascii
}

# --- Idempotency: already healthy? ---
if (Test-GatewayHealth -Port $Port -Token $token) {
  Write-Host "Gateway already running and healthy on http://127.0.0.1:$Port." -ForegroundColor Green
  exit 0
}

# --- Port held by something that is NOT a healthy gateway? Do not fight it. ---
$inUse = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($inUse) {
  throw "Port $Port is in use (PID $($inUse.OwningProcess)) but /health failed. Investigate before starting."
}

# --- Child environment ---
# CRITICAL: do NOT set TDAI_CC_PID - leaving it unset disables the parent
# watchdog so the gateway is permanent.
$env:TDAI_GATEWAY_PORT = "$Port"
$env:TDAI_TOKEN_PATH   = $tokenPath
$env:TDAI_DATA_DIR     = $DataDir
Remove-Item Env:\TDAI_CC_PID -ErrorAction SilentlyContinue

# --- Secrets: load a local, gitignored secrets file and inject its KEY=VALUE
#     pairs into THIS process's environment so the spawned gateway inherits
#     them deterministically (see header for the rationale). Without
#     OPENAI_API_KEY the embedding provider initialises as disabled and
#     semantic search silently degrades to keyword. gateway.secrets.env is
#     NEVER committed (see gateway.secrets.env.example).
$secretsPath = Join-Path $PSScriptRoot 'gateway.secrets.env'
if (Test-Path $secretsPath) {
  foreach ($line in (Get-Content -Path $secretsPath)) {
    $t = $line.Trim()
    if ($t -eq '' -or $t.StartsWith('#')) { continue }
    $eq = $t.IndexOf('=')
    if ($eq -lt 1) { continue }
    $name = $t.Substring(0, $eq).Trim()
    $val  = $t.Substring($eq + 1).Trim()
    if ($val.Length -ge 2 -and
        (($val[0] -eq '"' -and $val[$val.Length - 1] -eq '"') -or
         ($val[0] -eq "'" -and $val[$val.Length - 1] -eq "'"))) {
      $val = $val.Substring(1, $val.Length - 2)
    }
    Set-Item -Path ("Env:" + $name) -Value $val
  }
  Write-Host "Loaded gateway secrets from $secretsPath into the child environment."
} else {
  Write-Host "WARN: no gateway.secrets.env at $secretsPath - relying on inherited env. OPENAI_API_KEY may be unset, which disables embeddings (semantic search falls back to keyword)." -ForegroundColor Yellow
}

$outLog = Join-Path $DataDir 'gateway.out.log'
$errLog = Join-Path $DataDir 'gateway.err.log'

# Start-Process launches a process that is independent of this shell: it keeps
# running after PowerShell / the terminal exits.
$proc = Start-Process -FilePath $NodeExe -ArgumentList @($GatewayCli) `
  -WorkingDirectory $DataDir -WindowStyle Hidden -PassThru `
  -RedirectStandardOutput $outLog -RedirectStandardError $errLog

Write-Host "Launched gateway: PID $($proc.Id). Waiting for /health ..."

# --- Health poll (cold start inits SQLite + vec + pipeline + LLM runner) ---
$deadline = (Get-Date).AddSeconds(30)
$healthy = $false
while ((Get-Date) -lt $deadline) {
  if ($proc.HasExited) { throw "Gateway exited early (code $($proc.ExitCode)). See $errLog" }
  if (Test-GatewayHealth -Port $Port -Token $token) { $healthy = $true; break }
  Start-Sleep -Milliseconds 400
}
if (-not $healthy) { throw "Gateway did not become healthy on port $Port within 30s. See $errLog" }

# --- Register state.json with ccPid=0 (externally-managed sentinel) so the
#     patched hooks reuse this gateway for every session and never spawn. ---
$state = [ordered]@{
  pid       = $proc.Id
  port      = $Port
  ccPid     = 0
  startedAt = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
  tokenPath = $tokenPath
}
($state | ConvertTo-Json) | Set-Content -Path $statePath -Encoding ascii

Write-Host "Gateway healthy on http://127.0.0.1:$Port (PID $($proc.Id))." -ForegroundColor Green
Write-Host "state.json written with ccPid=0 (independent). Stays up until stop-gateway.ps1 or reboot."
