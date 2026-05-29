# Windows gateway launcher (Claude Code)

Run the TencentDB Agent Memory gateway as a **permanent, session-independent**
process on Windows, so Claude Code hooks always connect to a live gateway and
semantic search works across sessions.

## Why this exists

The plugin's built-in daemon spawn passes `TDAI_CC_PID`, which arms a watchdog
that kills the gateway ~15s after the spawning Claude Code session ends. On
Windows the spawn also goes through `cmd.exe -> npx`, so the tracked pid is a
transient wrapper and the gateway suicides almost immediately. These scripts
run the gateway directly with `node`, **without** `TDAI_CC_PID`, so it stays up
until you stop it or reboot.

## Secrets (important for semantic search)

Provider keys are **not** read from the Windows User environment, because a key
set with `setx` after a session (or the Task Scheduler context) has started is
**not** inherited by the running process. The symptom: the gateway logs
`embedding=disabled` / `embeddingService: false` and every search silently
falls back to keyword (`Strategy "hybrid" requested but EmbeddingService not
available, falling back to keyword`).

Instead, keys live in a local, gitignored file that the launcher injects
explicitly:

```powershell
copy gateway.secrets.env.example gateway.secrets.env
notepad gateway.secrets.env      # set OPENAI_API_KEY=sk-proj-...
```

`gateway.secrets.env` is in `.gitignore` and must never be committed.

## Usage

```powershell
# Start (idempotent: no-op if already healthy)
powershell -NoProfile -ExecutionPolicy Bypass -File .\start-gateway.ps1

# Stop
powershell -NoProfile -ExecutionPolicy Bypass -File .\stop-gateway.ps1

# Auto-start at logon (registers a hidden Scheduled Task, no admin needed)
powershell -NoProfile -ExecutionPolicy Bypass -File .\install-autostart.ps1
```

Defaults: port `8421`, data dir `%USERPROFILE%\.claude\plugins\data\tdai-memory-tdai-local`,
gateway entry `<repo>\dist\src\gateway\cli.mjs`. Override with `-Port`,
`-DataDir`, `-GatewayCli`, `-NodeExe`.

## Verify embeddings are live

```powershell
$t = Get-Content "$env:USERPROFILE\.claude\plugins\data\tdai-memory-tdai-local\token"
Invoke-RestMethod -Uri http://127.0.0.1:8421/health -Headers @{Authorization="Bearer $t"}
# stores.embeddingService should be True
```

The startup log (`gateway.out.log`) should show
`Store created: ... embedding=enabled` and, at query time,
`[searchMemories] ... embeddingAvailable=true, embeddingService=available`.

## Notes

- These scripts are **ASCII-only**. Windows PowerShell 5.1 reads BOM-less
  scripts as the system ANSI codepage, where a UTF-8 em dash (`U+2014`)
  misdecodes into a stray quote and breaks parsing. Keep them ASCII.
- `node-llama-cpp` (the bundled *local* embedding provider) and `sqlite-vec`
  ship no `win32-arm64` prebuilt binary; on ARM64 you must supply a remote
  embedding provider key and a compatible `vec0` extension build.
