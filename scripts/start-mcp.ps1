$ErrorActionPreference = "Stop"

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$token = $env:CODEX_FOUNDRY_BRIDGE_TOKEN

if ([string]::IsNullOrWhiteSpace($token)) {
  $token = [Environment]::GetEnvironmentVariable("CODEX_FOUNDRY_BRIDGE_TOKEN", "User")
}

if ([string]::IsNullOrWhiteSpace($token)) {
  throw "CODEX_FOUNDRY_BRIDGE_TOKEN is not set. Run scripts\new-token.ps1 first."
}

$env:CODEX_FOUNDRY_BRIDGE_TOKEN = $token
& node (Join-Path $root "src\server.js")
