param(
  [string]$UiDir = (Join-Path $PSScriptRoot "..\ui"),
  [string]$OutApk = (Join-Path $PSScriptRoot "..\StudentVault-native.apk")
)

$ErrorActionPreference = "Stop"
$sdk = $env:ANDROID_HOME
if (-not $sdk) { $sdk = $env:ANDROID_SDK_ROOT }
if (-not $sdk) { $sdk = Join-Path $env:LOCALAPPDATA "Android\Sdk" }
$androidJar = Join-Path $sdk "platforms\android-36\android.jar"
if (-not (Test-Path $androidJar)) { $androidJar = Join-Path $sdk "platforms\android-35\android.jar" }
$buildTools = Get-ChildItem (Join-Path $sdk "build-tools") -Directory | Sort-Object Name -Descending | Select-Object -First 1
$d8 = Join-Path $buildTools.FullName "d8.bat"
$aapt2 = Join-Path $buildTools.FullName "aapt2.exe"
$zipalign = Join-Path $buildTools.FullName "zipalign.exe"
$apksigner = Join-Path $buildTools.FullName "apksigner.bat"
$javac = (Get-Command javac.exe -ErrorAction SilentlyContinue).Source
if (-not $javac) {
  $jdk = Get-ChildItem "C:\Program Files\Eclipse Adoptium" -Directory -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($jdk) { $javac = Join-Path $jdk.FullName "bin\javac.exe" }
}
if (-not $jdk -and -not $javac) { throw "JDK not found" }

$build = Join-Path $PSScriptRoot "build"
Remove-Item -Recurse -Force $build -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force (Join-Path $build "classes") | Out-Null
New-Item -ItemType Directory -Force (Join-Path $build "dex") | Out-Null

Write-Host "Compiling Java..."
$sources = Get-ChildItem (Join-Path $PSScriptRoot "src") -Recurse -Filter *.java | Select-Object -ExpandProperty FullName
& $javac -source 11 -target 11 -cp $androidJar -d (Join-Path $build "classes") $sources
if ($LASTEXITCODE -ne 0) { throw "javac failed" }

Write-Host "Dexing..."
$classes = Get-ChildItem (Join-Path $build "classes") -Recurse -Filter *.class | Select-Object -ExpandProperty FullName
& $d8 --lib $androidJar --min-api 24 --output (Join-Path $build "dex") $classes
if ($LASTEXITCODE -ne 0) { throw "d8 failed" }

Write-Host "Linking manifest..."
& $aapt2 link -o (Join-Path $build "base.apk") -I $androidJar --manifest (Join-Path $PSScriptRoot "AndroidManifest.xml") --min-sdk-version 24 --target-sdk-version 36
if ($LASTEXITCODE -ne 0) { throw "aapt2 link failed" }

Write-Host "Packing assets..."
python (Join-Path $PSScriptRoot "pack_native.py") --base (Join-Path $build "base.apk") --ui $UiDir --dex (Join-Path $build "dex\classes.dex") --out (Join-Path $build "native-unsigned.apk")
if ($LASTEXITCODE -ne 0) { throw "pack failed" }

Write-Host "Aligning and signing..."
& $zipalign -f -p 4 (Join-Path $build "native-unsigned.apk") (Join-Path $build "native-aligned.apk")
if ($LASTEXITCODE -ne 0) { throw "zipalign failed" }
$keystore = Join-Path $env:USERPROFILE ".android\debug.keystore"
& $apksigner sign --ks $keystore --ks-pass pass:android --key-pass pass:android --ks-key-alias androiddebugkey --v1-signing-enabled false --v2-signing-enabled true --v3-signing-enabled false --out $OutApk (Join-Path $build "native-aligned.apk")
if ($LASTEXITCODE -ne 0) { throw "apksigner failed" }
& $apksigner verify --print-certs $OutApk
Write-Host ("Built: {0}" -f (Resolve-Path $OutApk))
