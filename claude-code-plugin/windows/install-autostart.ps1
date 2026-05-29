<#
  install-autostart.ps1 - Register a Scheduled Task that starts the
  independent TDAI memory gateway at user logon (Windows).

  Runs start-gateway.ps1 (idempotent) hidden, as the current interactive
  user, no admin rights required. Re-run this script to update the task.
  Remove it with: Unregister-ScheduledTask -TaskName 'TDAI Memory Gateway' -Confirm:$false

  ASCII-ONLY (see start-gateway.ps1 header for why).
#>
[CmdletBinding()]
param(
  [string]$TaskName    = 'TDAI Memory Gateway',
  [string]$StartScript = (Join-Path $PSScriptRoot 'start-gateway.ps1')
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path $StartScript)) { throw "start script not found: $StartScript" }
$StartScript = (Resolve-Path $StartScript).Path

# DOMAIN\User of the current interactive user (reliable, no env-var parsing).
$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument ('-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}"' -f $StartScript)

$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user

$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited

$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
  -Principal $principal -Settings $settings `
  -Description 'Starts the independent TDAI memory gateway (port 8421) at logon. Idempotent.' | Out-Null

Write-Host "Registered scheduled task '$TaskName' for $user (AtLogOn, hidden, no admin)." -ForegroundColor Green
