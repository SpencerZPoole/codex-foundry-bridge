$ErrorActionPreference = "Stop"

$token = $env:CODEX_FOUNDRY_BRIDGE_TOKEN
if ([string]::IsNullOrWhiteSpace($token)) {
  $token = [Environment]::GetEnvironmentVariable("CODEX_FOUNDRY_BRIDGE_TOKEN", "User")
}

if ([string]::IsNullOrWhiteSpace($token)) {
  throw "CODEX_FOUNDRY_BRIDGE_TOKEN is not set. Run scripts\new-token.ps1 first."
}

Set-Clipboard -Value $token
Write-Output "The local bridge token has been copied to the clipboard."
