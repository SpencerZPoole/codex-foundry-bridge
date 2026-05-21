param(
  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string]$WorldId
)

$ErrorActionPreference = "Stop"

$running = Get-Process | Where-Object { $_.ProcessName -eq "Foundry Virtual Tabletop" }
if ($running) {
  throw "Foundry is running. Close Foundry before enabling modules with this offline helper."
}

$settingsPath = Join-Path $env:LOCALAPPDATA "FoundryVTT\Data\worlds\$WorldId\data\settings.db"
$settingsStorePath = Join-Path $env:LOCALAPPDATA "FoundryVTT\Data\worlds\$WorldId\data\settings"

if (Test-Path -LiteralPath $settingsStorePath -PathType Container) {
  throw "Refusing to edit legacy settings.db because this world uses migrated Foundry v14 storage at: $settingsStorePath. Enable codex-foundry-bridge through Foundry's Manage Modules UI or a live Foundry-supported API instead."
}

if (-not (Test-Path -LiteralPath $settingsPath)) {
  throw "settings.db not found: $settingsPath"
}

$backupPath = "$settingsPath.codex-foundry-bridge.$((Get-Date).ToString('yyyyMMdd-HHmmss')).bak"
Copy-Item -LiteralPath $settingsPath -Destination $backupPath

$lines = Get-Content -LiteralPath $settingsPath
$found = $false
$updated = foreach ($line in $lines) {
  if ([string]::IsNullOrWhiteSpace($line)) {
    $line
    continue
  }

  $row = $line | ConvertFrom-Json
  if ($row.key -eq "core.moduleConfiguration") {
    $found = $true
    $moduleConfiguration = $row.value | ConvertFrom-Json
    $moduleConfiguration | Add-Member -NotePropertyName "codex-foundry-bridge" -NotePropertyValue $true -Force
    $row.value = $moduleConfiguration | ConvertTo-Json -Compress
    $row | ConvertTo-Json -Compress
  } else {
    $line
  }
}

if (-not $found) {
  throw "core.moduleConfiguration was not found; backup left at $backupPath"
}

Set-Content -LiteralPath $settingsPath -Value $updated -Encoding UTF8
Write-Output "Enabled codex-foundry-bridge for world '$WorldId'. Backup: $backupPath"
