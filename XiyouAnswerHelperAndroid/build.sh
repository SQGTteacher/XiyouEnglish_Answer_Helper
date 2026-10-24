#!/usr/bin/env bash
# Linux / CI 构建脚本（与 build.ps1 等价，不需要 Gradle）
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
APP="$ROOT/app/src/main"
BUILD="$ROOT/build"

SDK="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-}}"
if [ -z "$SDK" ]; then
  echo "ANDROID_SDK_ROOT / ANDROID_HOME 未设置" >&2
  exit 1
fi

BT="$(ls -d "$SDK"/build-tools/*/ 2>/dev/null | sort -V | tail -1)"
PLATFORM="$(ls -d "$SDK"/platforms/android-*/ 2>/dev/null | sort -V | tail -1)"
if [ -z "$BT" ] || [ -z "$PLATFORM" ]; then
  echo "找不到 build-tools 或 platform" >&2
  exit 1
fi

AAPT2="$BT/aapt2"
ANDROID_JAR="${PLATFORM}android.jar"
D8="$BT/d8"
ZIPALIGN="$BT/zipalign"
APKSIGNER="$BT/apksigner"

rm -rf "$BUILD"
mkdir -p "$BUILD/classes" "$BUILD/gen" "$BUILD/dex" "$BUILD/tools"

echo "[1/5] 编译资源"
"$AAPT2" compile --dir "$APP/res" -o "$BUILD/res.zip"

echo "[2/5] 链接资源"
"$AAPT2" link -o "$BUILD/app-unsigned.apk" \
  -I "$ANDROID_JAR" \
  --manifest "$APP/AndroidManifest.xml" \
  -R "$BUILD/res.zip" \
  --java "$BUILD/gen" \
  --min-sdk-version 26 \
  --target-sdk-version 34 \
  --auto-add-overlay

echo "[3/5] 编译 Java"
find "$APP/java" "$BUILD/gen" -name '*.java' > "$BUILD/sources.txt"
javac -encoding UTF-8 -source 1.8 -target 1.8 -nowarn \
  -classpath "$ANDROID_JAR" \
  -d "$BUILD/classes" @"$BUILD/sources.txt"

echo "[4/5] dex + 打包"
find "$BUILD/classes" -name '*.class' > "$BUILD/classes.txt"
"$D8" --min-api 26 --lib "$ANDROID_JAR" --output "$BUILD/dex" @"$BUILD/classes.txt"

javac -encoding UTF-8 -d "$BUILD/tools" "$ROOT/tools/PackApk.java"
java -cp "$BUILD/tools" PackApk \
  "$BUILD/app-unsigned.apk" "$BUILD/app-packed.apk" "$BUILD/dex/classes.dex" "$APP/assets"
mv "$BUILD/app-packed.apk" "$BUILD/app-unsigned.apk"

echo "[5/5] 对齐 + 签名"
"$ZIPALIGN" -f -p 4 "$BUILD/app-unsigned.apk" "$BUILD/app-aligned.apk"

KEYSTORE="$BUILD/ci.keystore"
keytool -genkeypair -keystore "$KEYSTORE" -alias ci -keyalg RSA -keysize 2048 \
  -validity 1000 -storepass ci123456 -keypass ci123456 -dname "CN=CI" >/dev/null 2>&1

"$APKSIGNER" sign --ks "$KEYSTORE" --ks-key-alias ci \
  --ks-pass pass:ci123456 --key-pass pass:ci123456 \
  --v1-signing-enabled true --v2-signing-enabled true --v3-signing-enabled true \
  --min-sdk-version 26 \
  --out "$ROOT/XiyouAnswerHelper.apk" "$BUILD/app-aligned.apk"

echo "APK: $ROOT/XiyouAnswerHelper.apk"
