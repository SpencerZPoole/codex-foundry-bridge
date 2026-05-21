param(
  [Parameter(Mandatory = $true)]
  [string]$WorldId,

  [Parameter(Mandatory = $true)]
  [string]$GmUserId,

  [string]$FoundryUrl = "http://127.0.0.1:30000",
  [string]$FoundryExecutable = "C:\Program Files\Foundry Virtual Tabletop\Foundry Virtual Tabletop.exe",
  [string]$AdminCredentialTarget = "FoundryCodexBridge/AdminPassword",
  [string]$GmCredentialTarget,
  [switch]$SkipAdminPassword,
  [switch]$AllowBlankGmPassword
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$configDir = Join-Path $root "config"
$configPath = Join-Path $configDir "lifecycle.json"

if ([string]::IsNullOrWhiteSpace($GmCredentialTarget)) {
  $GmCredentialTarget = "FoundryCodexBridge/World/$WorldId/GM"
}

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class BridgeCredentialManager {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
    public UInt32 Flags;
    public UInt32 Type;
    public string TargetName;
    public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public UInt32 CredentialBlobSize;
    public IntPtr CredentialBlob;
    public UInt32 Persist;
    public UInt32 AttributeCount;
    public IntPtr Attributes;
    public string TargetAlias;
    public string UserName;
  }

  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern bool CredWrite(ref CREDENTIAL credential, UInt32 flags);
}
"@

function Set-BridgeCredential {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Target,

    [Parameter(Mandatory = $true)]
    [string]$UserName,

    [Parameter(Mandatory = $true)]
    [securestring]$Secret
  )

  $bstr = [IntPtr]::Zero
  $blob = [IntPtr]::Zero
  try {
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Secret)
    $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
    $bytes = [Text.Encoding]::Unicode.GetBytes($plain)
    $blob = [Runtime.InteropServices.Marshal]::AllocHGlobal($bytes.Length)
    [Runtime.InteropServices.Marshal]::Copy($bytes, 0, $blob, $bytes.Length)

    $credential = New-Object BridgeCredentialManager+CREDENTIAL
    $credential.Flags = 0
    $credential.Type = 1
    $credential.TargetName = $Target
    $credential.Comment = "Foundry Codex Bridge lifecycle credential"
    $credential.CredentialBlobSize = $bytes.Length
    $credential.CredentialBlob = $blob
    $credential.Persist = 2
    $credential.AttributeCount = 0
    $credential.Attributes = [IntPtr]::Zero
    $credential.TargetAlias = $null
    $credential.UserName = $UserName

    if (-not [BridgeCredentialManager]::CredWrite([ref]$credential, 0)) {
      $errorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
      throw "CredWrite failed for target '$Target' with Win32 error $errorCode."
    }
  } finally {
    if ($blob -ne [IntPtr]::Zero) {
      for ($i = 0; $i -lt $bytes.Length; $i++) {
        [Runtime.InteropServices.Marshal]::WriteByte($blob, $i, 0)
      }
      [Runtime.InteropServices.Marshal]::FreeHGlobal($blob)
    }
    if ($bytes) {
      [Array]::Clear($bytes, 0, $bytes.Length)
    }
    if ($bstr -ne [IntPtr]::Zero) {
      [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    }
  }
}

function ConvertTo-Hashtable {
  param([object]$Value)
  if ($null -eq $Value) { return $null }
  if ($Value -is [System.Collections.IDictionary]) { return $Value }
  $hash = @{}
  foreach ($property in $Value.PSObject.Properties) {
    $hash[$property.Name] = $property.Value
  }
  return $hash
}

if (-not $SkipAdminPassword) {
  $adminPassword = Read-Host "Foundry administrator password" -AsSecureString
  Set-BridgeCredential -Target $AdminCredentialTarget -UserName "FoundryAdministrator" -Secret $adminPassword
  Write-Output "Stored administrator credential target: $AdminCredentialTarget"
}

if (-not $AllowBlankGmPassword) {
  $gmPassword = Read-Host "Foundry GM access key for world '$WorldId'" -AsSecureString
  Set-BridgeCredential -Target $GmCredentialTarget -UserName $GmUserId -Secret $gmPassword
  Write-Output "Stored GM credential target: $GmCredentialTarget"
}

New-Item -ItemType Directory -Force -Path $configDir | Out-Null
$existing = if (Test-Path -LiteralPath $configPath) {
  Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
} else {
  [pscustomobject]@{}
}

$worlds = ConvertTo-Hashtable $existing.worlds
if ($null -eq $worlds) { $worlds = @{} }
$credentials = ConvertTo-Hashtable $existing.credentials
if ($null -eq $credentials) { $credentials = @{} }
$credentials["adminTarget"] = $AdminCredentialTarget

$worldEntry = [ordered]@{
  gmUserId = $GmUserId
  allowBlankGmPassword = [bool]$AllowBlankGmPassword
}
if (-not $AllowBlankGmPassword) {
  $worldEntry["gmCredentialTarget"] = $GmCredentialTarget
}
$worlds[$WorldId] = $worldEntry

$config = [ordered]@{
  version = 1
  foundryUrl = $FoundryUrl
  foundryExecutable = $FoundryExecutable
  credentials = $credentials
  worlds = $worlds
}

$configJson = $config | ConvertTo-Json -Depth 10
[System.IO.File]::WriteAllText($configPath, $configJson + [Environment]::NewLine, [System.Text.UTF8Encoding]::new($false))
Write-Output "Wrote non-secret lifecycle config: $configPath"
