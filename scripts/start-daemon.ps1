$ErrorActionPreference = "Stop"

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$server = Join-Path $root "src\server.js"
$token = $env:CODEX_FOUNDRY_BRIDGE_TOKEN

if ([string]::IsNullOrWhiteSpace($token)) {
  $token = [Environment]::GetEnvironmentVariable("CODEX_FOUNDRY_BRIDGE_TOKEN", "User")
}

if ([string]::IsNullOrWhiteSpace($token)) {
  throw "CODEX_FOUNDRY_BRIDGE_TOKEN is not set. Run scripts\new-token.ps1 first."
}

$listener = Get-NetTCPConnection -LocalPort 30123 -ErrorAction SilentlyContinue |
  Where-Object { $_.State -eq "Listen" } |
  Select-Object -First 1

if ($listener) {
  Write-Output "Codex Foundry Bridge daemon is already listening on 127.0.0.1:30123."
  return
}

$env:CODEX_FOUNDRY_BRIDGE_TOKEN = $token
Start-Process -FilePath "node" -ArgumentList @($server, "--daemon") -WindowStyle Hidden -WorkingDirectory $root
Start-Sleep -Milliseconds 700

$listener = Get-NetTCPConnection -LocalPort 30123 -ErrorAction SilentlyContinue |
  Where-Object { $_.State -eq "Listen" } |
  Select-Object -First 1

if (-not $listener) {
  throw "Codex Foundry Bridge daemon did not start on 127.0.0.1:30123."
}

Write-Output "Codex Foundry Bridge daemon is listening on 127.0.0.1:30123."
