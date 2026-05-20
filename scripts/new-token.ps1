$ErrorActionPreference = "Stop"

$bytes = [byte[]]::new(32)
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
try {
  $rng.GetBytes($bytes)
} finally {
  $rng.Dispose()
}
$token = [Convert]::ToBase64String($bytes).TrimEnd("=").Replace("+", "-").Replace("/", "_")
[Environment]::SetEnvironmentVariable("CODEX_FOUNDRY_BRIDGE_TOKEN", $token, "User")
Write-Output "CODEX_FOUNDRY_BRIDGE_TOKEN has been generated and stored for the Windows user."
Write-Output "Restart Codex or this shell before relying on inherited environment variables."
