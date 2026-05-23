param(
  [string]$Version = "",
  [string]$OutDir = ""
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$moduleManifestPath = Join-Path $root "module\module.json"
$moduleScriptPath = Join-Path $root "module\scripts\bridge.js"
$packagePath = Join-Path $root "package.json"

if (-not (Test-Path -LiteralPath $moduleManifestPath)) {
  throw "Missing module manifest: $moduleManifestPath"
}

if (-not (Test-Path -LiteralPath $moduleScriptPath)) {
  throw "Missing module script: $moduleScriptPath"
}

$moduleManifest = Get-Content -LiteralPath $moduleManifestPath -Raw | ConvertFrom-Json
$packageJson = Get-Content -LiteralPath $packagePath -Raw | ConvertFrom-Json

if ([string]::IsNullOrWhiteSpace($Version)) {
  $Version = $moduleManifest.version
}

if ($Version -ne $moduleManifest.version) {
  throw "Requested version $Version does not match module manifest version $($moduleManifest.version)."
}

if ($packageJson.version -ne $moduleManifest.version) {
  throw "package.json version $($packageJson.version) does not match module manifest version $($moduleManifest.version)."
}

if ([string]::IsNullOrWhiteSpace($OutDir)) {
  $OutDir = Join-Path $root "dist"
}

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$resolvedRoot = (Resolve-Path -LiteralPath $root).Path.TrimEnd("\")
$resolvedOutDir = (Resolve-Path -LiteralPath $OutDir).Path.TrimEnd("\")
if (-not $resolvedOutDir.StartsWith("$resolvedRoot\", [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Release output directory must be inside the repository root: $root"
}

$zipPath = Join-Path $resolvedOutDir "codex-foundry-bridge-v$Version.zip"
if (Test-Path -LiteralPath $zipPath) {
  Remove-Item -LiteralPath $zipPath -Force
}

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [System.IO.Compression.ZipFile]::Open($zipPath, [System.IO.Compression.ZipArchiveMode]::Create)
try {
  [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
    $archive,
    $moduleManifestPath,
    "module.json"
  ) | Out-Null
  [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
    $archive,
    $moduleScriptPath,
    "scripts/bridge.js"
  ) | Out-Null
} finally {
  $archive.Dispose()
}

$entries = @()
$zip = [System.IO.Compression.ZipFile]::OpenRead($zipPath)
try {
  $entries = $zip.Entries | ForEach-Object { $_.FullName.Replace("\", "/") } | Sort-Object
} finally {
  $zip.Dispose()
}

$expectedEntries = @("module.json", "scripts/bridge.js")
if (Compare-Object -ReferenceObject $expectedEntries -DifferenceObject $entries) {
  throw "Release zip entries did not match expected flat Foundry module shape."
}

Write-Host "Created $zipPath"
Write-Host "Entries:"
$entries | ForEach-Object { Write-Host "  $_" }
