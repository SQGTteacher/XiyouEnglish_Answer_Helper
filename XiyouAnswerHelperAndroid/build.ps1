# Xiyou Answer Helper - Android build script (no Gradle)
# Requires: JDK 8 (javac) + JDK 11+ (d8/apksigner) + Android build-tools + platform android.jar
# Usage: powershell -ExecutionPolicy Bypass -File build.ps1
$ErrorActionPreference = "Stop"

$Root   = Split-Path -Parent $MyInvocation.MyCommand.Path
$App    = Join-Path $Root "app\src\main"
$Build  = Join-Path $Root "build"
$Parent = Split-Path -Parent $Root

# ---- JDK 8 for javac ----
$JavaHome = "C:\Program Files\Android\jdk\jdk-8.0.302.8-hotspot\jdk8u302-b08"
if (-not (Test-Path $JavaHome)) { $JavaHome = $env:JAVA_HOME }
$Javac   = Join-Path $JavaHome "bin\javac.exe"
$Jar     = Join-Path $JavaHome "bin\jar.exe"
$Keytool = Join-Path $JavaHome "bin\keytool.exe"

# ---- JDK 17 for d8 / apksigner ----
$Java17Home = $null
foreach ($r in @((Join-Path $Parent ".toolchain\jdk17"), (Join-Path $Root "tools\jdk17"))) {
    if (-not (Test-Path $r)) { continue }
    $exe = Get-ChildItem $r -Recurse -Filter java.exe -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -notmatch '\\jre\\' } | Select-Object -First 1
    if ($exe) { $Java17Home = Split-Path -Parent (Split-Path -Parent $exe.FullName); break }
}
if (-not $Java17Home) { $Java17Home = $JavaHome }

# ---- Android toolchain ----
$searchRoots = @((Join-Path $Root "tools"), (Join-Path $Parent ".toolchain"))
$Aapt2 = $null
$AndroidJar = $null
foreach ($r in $searchRoots) {
    if (-not (Test-Path $r)) { continue }
    if (-not $Aapt2)     { $Aapt2 = (Get-ChildItem $r -Recurse -Filter aapt2.exe -ErrorAction SilentlyContinue | Select-Object -First 1).FullName }
    if (-not $AndroidJar) { $AndroidJar = (Get-ChildItem $r -Recurse -Filter android.jar -ErrorAction SilentlyContinue | Select-Object -First 1).FullName }
}
if (-not $Aapt2 -or -not $AndroidJar) { throw "Android build tools not found (aapt2.exe / android.jar)" }
$BuildTools = Split-Path -Parent $Aapt2
$D8        = Join-Path $BuildTools "d8.bat"
$ZipAlign  = Join-Path $BuildTools "zipalign.exe"
$ApkSigner = Join-Path $BuildTools "apksigner.bat"
if (-not (Test-Path $Javac)) { throw "javac not found: $Javac" }

$env:JAVA_HOME = $Java17Home
$env:Path = (Join-Path $Java17Home "bin") + ";" + (Join-Path $JavaHome "bin") + ";" + $env:Path

Write-Host "== Xiyou Answer Helper - Android build ==" -ForegroundColor Cyan
Write-Host "aapt2      : $Aapt2"
Write-Host "android.jar: $AndroidJar"
Write-Host "javac      : $Javac"
Write-Host "d8 java    : $Java17Home"

if (Test-Path $Build) { Remove-Item $Build -Recurse -Force }
New-Item -ItemType Directory -Force "$Build\classes", "$Build\gen", "$Build\dex" | Out-Null

Write-Host "[1/6] compile resources..." -ForegroundColor Yellow
& $Aapt2 compile --dir "$App\res" -o "$Build\res.zip"
if ($LASTEXITCODE -ne 0) { throw "aapt2 compile failed" }

Write-Host "[2/6] link resources..." -ForegroundColor Yellow
& $Aapt2 link -o "$Build\app-unsigned.apk" `
    -I $AndroidJar `
    --manifest "$App\AndroidManifest.xml" `
    -R "$Build\res.zip" `
    --java "$Build\gen" `
    --min-sdk-version 26 `
    --target-sdk-version 34 `
    --auto-add-overlay
if ($LASTEXITCODE -ne 0) { throw "aapt2 link failed" }

Write-Host "[3/6] compile java..." -ForegroundColor Yellow
$sources = @()
$sources += Get-ChildItem "$App\java" -Recurse -Filter *.java | ForEach-Object { $_.FullName }
$sources += Get-ChildItem "$Build\gen" -Recurse -Filter *.java -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName }
& $Javac -encoding UTF-8 -source 1.8 -target 1.8 -nowarn `
    -bootclasspath $AndroidJar `
    -classpath $AndroidJar `
    -d "$Build\classes" $sources
if ($LASTEXITCODE -ne 0) { throw "javac failed" }

Write-Host "[4/6] dex..." -ForegroundColor Yellow
$classes = Get-ChildItem "$Build\classes" -Recurse -Filter *.class | ForEach-Object { $_.FullName }
& $D8 --min-api 26 --lib $AndroidJar --output "$Build\dex" $classes
if ($LASTEXITCODE -ne 0) { throw "d8 failed" }

Write-Host "[4/6] pack apk (assets + dex)..." -ForegroundColor Yellow
# aapt2 在 Windows 下会把 assets 路径写成反斜杠，且 resources.arsc 必须 STORED，
# 这里用自带的 PackApk 重新打包成规范 APK
New-Item -ItemType Directory -Force "$Build\tools" | Out-Null
& $Javac -encoding UTF-8 -d "$Build\tools" "$Root\tools\PackApk.java"
if ($LASTEXITCODE -ne 0) { throw "PackApk compile failed" }
& (Join-Path $JavaHome "bin\java.exe") -cp "$Build\tools" PackApk `
    "$Build\app-unsigned.apk" "$Build\app-packed.apk" "$Build\dex\classes.dex" "$App\assets"
if ($LASTEXITCODE -ne 0) { throw "PackApk failed" }
Move-Item "$Build\app-packed.apk" "$Build\app-unsigned.apk" -Force

Write-Host "[5/6] zipalign..." -ForegroundColor Yellow
& $ZipAlign -f -p 4 "$Build\app-unsigned.apk" "$Build\app-aligned.apk"
if ($LASTEXITCODE -ne 0) { throw "zipalign failed" }

Write-Host "[6/6] sign..." -ForegroundColor Yellow
$ksDir = Join-Path $Root "keystore"
New-Item -ItemType Directory -Force $ksDir | Out-Null
$ks = Join-Path $ksDir "xyhelper.keystore"
if (-not (Test-Path $ks)) {
    & $Keytool -genkeypair -v -keystore $ks -alias xyhelper -keyalg RSA -keysize 2048 -validity 10000 `
        -storepass xyhelper2026 -keypass xyhelper2026 `
        -dname "CN=Xiyou Answer Helper, OU=Personal, O=Personal, L=Guangzhou, ST=Guangdong, C=CN"
    if ($LASTEXITCODE -ne 0) { throw "keytool failed" }
}
$OutApk = Join-Path $Build "XiyouAnswerHelper.apk"
# v1 + v2 + v3 全开：部分国产 ROM（华为/荣耀等）只认 v1 或需要 v1 兜底
& $ApkSigner sign --ks $ks --ks-key-alias xyhelper `
    --ks-pass pass:xyhelper2026 --key-pass pass:xyhelper2026 `
    --v1-signing-enabled true --v2-signing-enabled true --v3-signing-enabled true `
    --min-sdk-version 26 `
    --out $OutApk "$Build\app-aligned.apk"
if ($LASTEXITCODE -ne 0) { throw "apksigner failed" }

Copy-Item $OutApk (Join-Path $Root "XiyouAnswerHelper.apk") -Force
$size = [math]::Round((Get-Item $OutApk).Length / 1KB, 1)
Write-Host ""
Write-Host "BUILD OK: $OutApk ($size KB)" -ForegroundColor Green
Write-Host "Copied to: $(Join-Path $Root 'XiyouAnswerHelper.apk')" -ForegroundColor Green
