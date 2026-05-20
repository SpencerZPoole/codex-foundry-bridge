param(
  [string]$FoundryUrl = "http://127.0.0.1:30000",
  [string]$GmUserId = "EsLSDXk0uaa6U8wv"
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$client = Join-Path $root "scripts\headless-gm-client.mjs"
$logDir = Join-Path $root "logs"
$bundledNode = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
$bundledModules = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\node_modules"
$bundledPnpmModules = Join-Path $bundledModules ".pnpm\node_modules"
$browserCandidates = @(
  "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
  "C:\Program Files\Microsoft\Edge\Application\msedge.exe",
  "C:\Program Files\Google\Chrome\Application\chrome.exe",
  "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
)

if (-not (Test-Path -LiteralPath $client)) {
  throw "Headless GM client script not found: $client"
}

$token = $env:CODEX_FOUNDRY_BRIDGE_TOKEN
if ([string]::IsNullOrWhiteSpace($token)) {
  $token = [Environment]::GetEnvironmentVariable("CODEX_FOUNDRY_BRIDGE_TOKEN", "User")
}
if ([string]::IsNullOrWhiteSpace($token)) {
  throw "CODEX_FOUNDRY_BRIDGE_TOKEN is not set. Run scripts\new-token.ps1 first."
}

try {
  $status = Invoke-RestMethod -Uri "http://127.0.0.1:30123/status" -TimeoutSec 3
  if ($status.connectedSessions -gt 0) {
    Write-Output "A Foundry GM bridge client is already connected."
    return
  }
} catch {
  throw "Bridge daemon is not reachable on http://127.0.0.1:30123/status. Start it before launching the GM client."
}

$node = if (Test-Path -LiteralPath $bundledNode) { $bundledNode } else { "node" }
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$stdout = Join-Path $logDir "headless-gm-client-$stamp.out.log"
$stderr = Join-Path $logDir "headless-gm-client-$stamp.err.log"

$env:CODEX_FOUNDRY_BRIDGE_TOKEN = $token
$env:FOUNDRY_URL = $FoundryUrl
$env:FOUNDRY_GM_USER_ID = $GmUserId
$browser = $browserCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if ($browser) { $env:PLAYWRIGHT_BROWSER_EXECUTABLE = $browser }
$nodePathParts = @()
if (Test-Path -LiteralPath $bundledModules) { $nodePathParts += $bundledModules }
if (Test-Path -LiteralPath $bundledPnpmModules) { $nodePathParts += $bundledPnpmModules }
if ($nodePathParts.Count -gt 0) { $env:NODE_PATH = ($nodePathParts -join [System.IO.Path]::PathSeparator) }

$process = Start-Process -FilePath $node `
  -ArgumentList @($client) `
  -WindowStyle Hidden `
  -WorkingDirectory $root `
  -RedirectStandardOutput $stdout `
  -RedirectStandardError $stderr `
  -PassThru

$pidPath = Join-Path $logDir "headless-gm-client.pid"
Set-Content -LiteralPath $pidPath -Value $process.Id -Encoding ASCII

$deadline = (Get-Date).AddSeconds(180)
do {
  Start-Sleep -Seconds 2
  if ($process.HasExited) {
    $status = Invoke-RestMethod -Uri "http://127.0.0.1:30123/status" -TimeoutSec 3
    if ($status.connectedSessions -gt 0) {
      Write-Output "Headless GM bridge client connected. Setup process exited after launching the browser. Log: $stdout"
      return
    }
    $errorText = if (Test-Path -LiteralPath $stderr) { Get-Content -LiteralPath $stderr -Raw } else { "" }
    throw "Headless GM client exited early with code $($process.ExitCode). $errorText"
  }

  $status = Invoke-RestMethod -Uri "http://127.0.0.1:30123/status" -TimeoutSec 3
  if ($status.connectedSessions -gt 0) {
    Write-Output "Headless GM bridge client connected. PID: $($process.Id). Log: $stdout"
    return
  }
} while ((Get-Date) -lt $deadline)

throw "Timed out waiting for the headless GM bridge client to connect. Logs: $stdout ; $stderr"
