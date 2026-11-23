#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
: "${ANDROID_HOME:?Set ANDROID_HOME to the Android SDK directory}"
: "${WFO_KEYSTORE:?Set WFO_KEYSTORE to the signing keystore}"
: "${WFO_KEY_PASSWORD:?Set WFO_KEY_PASSWORD to the signing password}"
export WFO_KEY_PASSWORD
build_tools="${WFO_BUILD_TOOLS:-$ANDROID_HOME/build-tools/34.0.0}"
platform="$ANDROID_HOME/platforms/android-34/android.jar"
target="${1:-./WFO.apk}"
build="$(mktemp -d)"
trap 'rm -rf "$build"' EXIT

python3 build-standalone.py
mkdir -p "$build/assets" "$build/classes" "$build/dex"
cp index.html "$build/assets/"
if [[ -n "${WFO_ECJ_JAR:-}" ]]; then
    java -jar "$WFO_ECJ_JAR" -8 -proc:none -classpath "$platform" -d "$build/classes" android/MainActivity.java
else
    javac --release 8 -classpath "$platform" -d "$build/classes" android/MainActivity.java
fi
mapfile -d '' classes < <(find "$build/classes" -name '*.class' -print0)
"$build_tools/d8" --lib "$platform" --min-api 23 --output "$build/dex" "${classes[@]}"
"$build_tools/aapt" package -M android/AndroidManifest.xml -S android/res \
    -A "$build/assets" -I "$platform" -F "$build/unsigned.apk"
zip -jq "$build/unsigned.apk" "$build/dex/classes.dex"
"$build_tools/zipalign" -f 4 "$build/unsigned.apk" "$build/aligned.apk"
"$build_tools/apksigner" sign --ks "$WFO_KEYSTORE" --ks-key-alias wfo \
    --ks-pass env:WFO_KEY_PASSWORD --out "$target" "$build/aligned.apk"
"$build_tools/apksigner" verify "$target"
