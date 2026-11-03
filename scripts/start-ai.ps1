param(
  [string]$EnvFile = (Join-Path $PSScriptRoot "..\server\.env")
)

$ErrorActionPreference = "Stop"
$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if (-not $node) { throw "Node.js is not installed." }

if (Test-Path $EnvFile) {
  foreach ($line in Get-Content $EnvFile) {
    $trimmed = $line.Trim()
    if (-not $trimmed -or $trimmed.StartsWith("#")) { continue }
    $split = $trimmed.IndexOf("=")
    if ($split -lt 1) { continue }
    $name = $trimmed.Substring(0, $split).Trim()
    $value = $trimmed.Substring($split + 1).Trim().Trim('"').Trim("'")
    Set-Item -Path ("Env:" + $name) -Value $value
  }
}

# DeepSeek key can be supplied through either name, but is never printed.
if (-not $env:SV_AI_API_KEY -and $env:DEEPSEEK_API_KEY) {
  $env:SV_AI_API_KEY = $env:DEEPSEEK_API_KEY
}
if (-not $env:SV_AI_BASE_URL) { $env:SV_AI_BASE_URL = "https://api.deepseek.com/v1" }
if (-not $env:SV_AI_MODEL) { $env:SV_AI_MODEL = "deepseek-chat" }
if (-not $env:PORT) { $env:PORT = "4312" }

if (-not $env:SV_AI_API_KEY) {
  throw "No AI key found. Put a NEW key in server/.env as SV_AI_API_KEY. Do not paste it into chat."
}

Write-Host "Starting Student Vault AI proxy on port $env:PORT"
Write-Host "Provider key loaded: yes (value hidden)"
Write-Host "Base URL: $env:SV_AI_BASE_URL"
Write-Host "Model: $env:SV_AI_MODEL"
& $node (Join-Path $root "server\ai-proxy.mjs")
