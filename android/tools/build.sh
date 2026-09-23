#!/usr/bin/env bash
# 构建 debug APK（本机工具链见 tools/env.sh）。用法：bash tools/build.sh [assembleDebug|test|install]
set -euo pipefail
cd "$(dirname "$0")/.."
source tools/env.sh
task="${1:-assembleDebug}"
./gradlew "$task" --console=plain
if [ "$task" = "assembleDebug" ]; then
  apk=app/build/outputs/apk/debug/app-debug.apk
  ls -lh "$apk"
  echo "装到手机：$ANDROID_HOME/platform-tools/adb install -r $apk"
fi
