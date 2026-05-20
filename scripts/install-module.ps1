$ErrorActionPreference = "Stop"

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$source = Join-Path $root "module"
$destination = Join-Path $env:LOCALAPPDATA "FoundryVTT\Data\modules\codex-foundry-bridge"

if (-not (Test-Path -LiteralPath $source)) {
  throw "Module source not found: $source"
}

New-Item -ItemType Directory -Force -Path $destination | Out-Null
Copy-Item -Path (Join-Path $source "*") -Destination $destination -Recurse -Force
Write-Output "Installed Codex Foundry Bridge module to $destination"
