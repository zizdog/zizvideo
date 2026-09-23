#!/usr/bin/env bash
# ============================================================================
#  emu-smoke.sh —— 安卓端冒烟：启动模拟器 → 装 APK → 走原生登录 → 截图存档
#
#  为什么要有：真机只能用户点，但"登录能不能上、网页能不能载、返回键对不对"这些
#  在模拟器上就能抓 90% 的错。收尾一定要关掉模拟器（跟 Playwright 那条纪律同理：
#  放着不管会一直吃 CPU/内存）—— 所以用 trap 保证无论怎么退出都杀干净。
#
#  用法：bash tools/emu-smoke.sh [host:port] [用户名] [口令] [截图前缀]
#        默认 10.0.2.2:17771（模拟器→宿主的回环），截图默认 /tmp/zv-emu-*
# ============================================================================
set -uo pipefail
cd "$(dirname "$0")/.."
source tools/env.sh

HOSTPORT="${1:-10.0.2.2:17771}"
USER_NAME="${2:-admin}"
PASS="${3:-}"
TAG="${4:-/tmp/zv-emu}"
APK="app/build/outputs/apk/debug/app-debug.apk"
AVD="${ZV_AVD:-zv35}"

cleanup() { adb emu kill >/dev/null 2>&1 || true; sleep 2; pkill -f "emulator -avd $AVD" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

[ -f "$APK" ] || { echo "先构建：bash tools/build.sh" >&2; exit 1; }

if ! adb devices | grep -q "emulator-.*device"; then
  echo "==> 启动模拟器 $AVD（无窗口）"
  nohup "$ANDROID_HOME/emulator/emulator" -avd "$AVD" -no-window -no-audio -no-boot-anim \
    -gpu swiftshader_indirect -no-snapshot -netdelay none -netspeed full >/tmp/zv-emu-boot.log 2>&1 &
  adb wait-for-device
  for _ in $(seq 1 60); do
    [ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ] && break
    sleep 3
  done
fi
echo "==> 设备：$(adb shell getprop ro.build.version.release | tr -d '\r') / $(adb shell getprop ro.product.cpu.abi | tr -d '\r')"

echo "==> 装 APK 并清数据（每次从首屏开始）"
adb install -r "$APK" >/dev/null
adb shell pm clear com.zizdog.zizvideo >/dev/null
adb logcat -c
adb shell am start -n com.zizdog.zizvideo/.LoginActivity >/dev/null
sleep 3

tap_field() { adb shell input tap 540 "$1"; sleep 1; adb shell input text "$2"; sleep 1; }
tap_field 1008 "$HOSTPORT"
tap_field 1195 "$USER_NAME"
[ -n "$PASS" ] && tap_field 1382 "$PASS"
adb shell input keyevent 111 >/dev/null 2>&1   # ESC 收键盘（别用返回键，那会关掉 Activity）
sleep 2
adb shell uiautomator dump /sdcard/zv.xml >/dev/null 2>&1
COORD=$(adb shell cat /sdcard/zv.xml | python3 -c "
import sys,re
m=re.search(r'resource-id=\"com\.zizdog\.zizvideo:id/login\"[^>]*bounds=\"\[(\d+),(\d+)\]\[(\d+),(\d+)\]\"', sys.stdin.read())
print('' if not m else '%d %d' % ((int(m.group(1))+int(m.group(3)))//2, (int(m.group(2))+int(m.group(4)))//2))")
[ -n "$COORD" ] || { echo "!! 找不到登录按钮（首屏没起来？）"; exit 1; }
adb shell input tap $COORD
sleep 10

focus=$(adb shell dumpsys window 2>/dev/null | sed -n 's/.*mCurrentFocus=Window{[^ ]* [^ ]* \([^}]*\)}.*/\1/p' | head -1)
echo "==> 登录后焦点窗口：$focus"
adb exec-out screencap -p > "${TAG}-after-login.png" 2>/dev/null
echo "==> 截图：${TAG}-after-login.png"
case "$focus" in
  *WebActivity*) echo "✓ 已进网页界面（登录 + cookie 传递成功）";;
  *LoginActivity*) echo "!! 还停在登录页 —— 看 adb logcat（口令错？地址不通？）"; adb logcat -d | grep -iE "zizvideo|Exception" | tail -5; exit 1;;
  *) echo "!! 意外窗口：$focus"; exit 1;;
esac
