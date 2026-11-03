param(
  [string]$BaseApk = (Join-Path $PSScriptRoot "..\StudentVault-debug.apk"),
  [string]$UiDir = (Join-Path $PSScriptRoot "..\ui"),
  [string]$OutApk = (Join-Path $PSScriptRoot "..\StudentVault.apk")
)

$ErrorActionPreference = "Stop"
$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$BaseApk = [System.IO.Path]::GetFullPath($BaseApk)
$UiDir = [System.IO.Path]::GetFullPath($UiDir)
$OutApk = [System.IO.Path]::GetFullPath($OutApk)

$sdk = $env:ANDROID_HOME
if (-not $sdk) { $sdk = $env:ANDROID_SDK_ROOT }
if (-not $sdk) { $sdk = Join-Path $env:LOCALAPPDATA "Android\Sdk" }
$buildTools = Get-ChildItem (Join-Path $sdk "build-tools") -Directory | Sort-Object Name -Descending | Select-Object -First 1
if (-not $buildTools) { throw "Android build-tools not found under $sdk" }
$zipalign = Join-Path $buildTools.FullName "zipalign.exe"
$apksigner = Join-Path $buildTools.FullName "apksigner.bat"
$keytool = (Get-Command keytool.exe -ErrorAction SilentlyContinue).Source
if (-not $keytool) {
  $jdk = Get-ChildItem "C:\Program Files\Eclipse Adoptium" -Directory -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($jdk) { $keytool = Join-Path $jdk.FullName "bin\keytool.exe" }
}
if (-not $keytool -or -not (Test-Path $keytool)) { throw "keytool.exe not found. Install a JDK." }

$keystore = Join-Path $env:USERPROFILE ".android\debug.keystore"
if (-not (Test-Path $keystore)) {
  New-Item -ItemType Directory -Force (Split-Path $keystore) | Out-Null
  & $keytool -genkeypair -v -keystore $keystore -storepass android -alias androiddebugkey -keypass android -dname "CN=Android Debug,O=Android,C=US" -keyalg RSA -keysize 2048 -validity 10000 | Out-Null
}

$tmp = Join-Path $env:TEMP ("studentvault-build-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force $tmp | Out-Null
$unsigned = Join-Path $tmp "unsigned.apk"
$aligned = Join-Path $tmp "aligned.apk"

try {
  Write-Host "Packing web assets..."
  python (Join-Path $PSScriptRoot "pack_apk.py") --base $BaseApk --ui $UiDir --out $unsigned
  if ($LASTEXITCODE -ne 0) { throw "pack_apk.py failed" }

  Write-Host "Aligning APK..."
  & $zipalign -f -p 4 $unsigned $aligned
  if ($LASTEXITCODE -ne 0) { throw "zipalign failed" }

  Write-Host "Signing APK..."
  & $apksigner sign --ks $keystore --ks-pass pass:android --key-pass pass:android --ks-key-alias androiddebugkey --v1-signing-enabled false --v2-signing-enabled true --v3-signing-enabled false --out $OutApk $aligned
  if ($LASTEXITCODE -ne 0) { throw "apksigner failed" }

  & $apksigner verify --print-certs $OutApk
  if ($LASTEXITCODE -ne 0) { throw "APK verification failed" }

  $file = Get-Item $OutApk
  $hash = (Get-FileHash $OutApk -Algorithm SHA256).Hash
  Write-Host ""
  Write-Host ("Built: {0} ({1:N0} bytes)" -f $file.FullName, $file.Length)
  Write-Host ("SHA256: {0}" -f $hash)
} finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
