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
# 默认验 debug 包；验正式签名包：ZV_APK=app/build/outputs/apk/release/app-release.apk
APK="${ZV_APK:-app/build/outputs/apk/debug/app-debug.apk}"
AVD="${ZV_AVD:-zv35}"
# 想验别的页面就传 ZV_PATH（如 ZV_PATH="/#/series/<id>"）；默认进稍后再看列表走原生播放那条路

# ZV_KEEP=1：跑完不关模拟器（手动接着验别的；不用了记得自己 adb emu kill）
cleanup() { [ "${ZV_KEEP:-0}" = "1" ] && return 0; adb emu kill >/dev/null 2>&1 || true; sleep 2; pkill -f "emulator -avd ${AVD}" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

[ -f "$APK" ] || { echo "先构建：bash tools/build.sh" >&2; exit 1; }

if ! adb devices | grep -q "emulator-.*device"; then
  echo "==> 启动模拟器 ${AVD}（无窗口）"
  nohup "$ANDROID_HOME/emulator/emulator" -avd "$AVD" -no-window -no-audio -no-boot-anim \
    -gpu swiftshader_indirect -no-snapshot -netdelay none -netspeed full >/tmp/zv-emu-boot.log 2>&1 &
  adb wait-for-device
  for _ in $(seq 1 60); do
    [ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ] && break
    sleep 3
  done
fi
echo "==> 设备：$(adb shell getprop ro.build.version.release | tr -d '\r') / $(adb shell getprop ro.product.cpu.abi | tr -d '\r')"

# 刚开机时模拟器的虚拟网卡可能还没就绪（实测过一次 ConnectException）——先等能连通宿主再装。
echo "==> 等模拟器网络就绪"
net=0
for _ in $(seq 1 30); do
  if adb shell ping -c 1 -W 1 10.0.2.2 >/dev/null 2>&1; then net=1; break; fi
  sleep 2
done
[ "$net" = "1" ] && echo "✓ 网络就绪" || echo "!! 30 次探测仍不通，继续跑（失败会有截图）"

echo "==> 装 APK 并清数据（每次从首屏开始）"
# debug 与 release 签名不同，直接 -r 会被拒 —— 这时先卸载再装（换包不许静默失败）。
if ! adb install -r "$APK" >/dev/null 2>&1; then
  echo "==> 签名与已装的不同（debug↔release）：先卸载再装"
  adb uninstall com.zizdog.zizvideo >/dev/null 2>&1 || true
  adb install "$APK" >/dev/null
fi
adb shell pm clear com.zizdog.zizvideo >/dev/null
# 通知权限先授予：不然第一次进播放页会弹系统对话框，挡住焦点判定（真机上点一次就行）
adb shell pm grant com.zizdog.zizvideo android.permission.POST_NOTIFICATIONS >/dev/null 2>&1 || true
adb logcat -c
# 启动就打开列表页：比"点底栏再点页签"稳得多（底栏样式一改，写死的坐标就废了）
adb shell am start -n com.zizdog.zizvideo/.LoginActivity --es path "${ZV_PATH:-/#/favorites/later}" >/dev/null
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
# 偶发连不上（模拟器网络抖动）时再点一次登录：字段还在，重试无副作用。
focus0=$(adb shell dumpsys window 2>/dev/null | sed -n 's/.*mCurrentFocus=Window{[^ ]* [^ ]* \([^}]*\)}.*/\1/p' | head -1)
if [ "${focus0##*.}" = "LoginActivity" ]; then
  echo "==> 第一次没进网页，重试一次登录"
  adb shell input tap $COORD
  sleep 10
fi

focus=$(adb shell dumpsys window 2>/dev/null | sed -n 's/.*mCurrentFocus=Window{[^ ]* [^ ]* \([^}]*\)}.*/\1/p' | head -1)
echo "==> 登录后焦点窗口：$focus"
adb exec-out screencap -p > "${TAG}-after-login.png" 2>/dev/null
echo "==> 截图：${TAG}-after-login.png"
case "$focus" in
  *WebActivity*) echo "✓ 已进网页界面（登录 + cookie 传递成功）";;
  *LoginActivity*) echo "!! 还停在登录页 —— 看 adb logcat（口令错？地址不通？）"; adb logcat -d | grep -iE "zizvideo|Exception" | tail -5; exit 1;;
  *) echo "!! 意外窗口：$focus"; exit 1;;
esac

# ---------------------------------------------------------------- 原生播放 + 后台
# 说明：靠坐标点「收藏」→「收藏」Tab → 第一张卡（只对 `-d pixel_6` 这个 AVD 成立）。
#       这段是这套客户端最要紧的能力（后台听视频），所以固化成可复跑的一步。
if [ "${ZV_SKIP_PLAY:-0}" = "1" ]; then echo "（跳过原生播放验证）"; exit 0; fi
echo "==> 走原生播放：点列表第一张卡"
adb logcat -c
adb shell input tap 236 544 >/dev/null; sleep 10  # 第一张卡 → 应被原生播放页接管

focus=$(adb shell dumpsys window 2>/dev/null | sed -n 's/.*mCurrentFocus=Window{[^ ]* [^ ]* \([^}]*\)}.*/\1/p' | head -1)
[ "${focus##*.}" = "PlayerActivity" ] || { echo "!! 没进原生播放页，实际：$focus"; exit 1; }
echo "✓ 深链已交原生播放页（PlayerActivity）"

# 从 PlaybackState 里同时取状态、播放位置与"当前是队列里第几条"：
# 素材有长有短，短片会**播完自动跳下一条**，所以"位置前进"或"换条了"都算后台在继续放。
state() { adb shell dumpsys media_session 2>/dev/null | grep -A12 "com.zizdog.zizvideo/androidx" \
  | grep -oE "state=PlaybackState \{state=[A-Z]+\([0-9]\), position=[0-9]+.*active item id=[0-9-]+" | tail -1; }
pos_of() { echo "$1" | sed -n 's/.*position=\([0-9]*\).*/\1/p'; }
item_of() { echo "$1" | sed -n 's/.*active item id=\([0-9-]*\).*/\1/p'; }

line=$(state); echo "前台：$line"
case "$line" in *PLAYING*) ;; *) echo "!! 不是 PLAYING：$line"; exit 1;; esac

echo "==> 按 HOME 回桌面，验后台是否继续解码"
adb shell input keyevent 3 >/dev/null
p1=$(pos_of "$line"); i1=$(item_of "$line")
sleep 3
line2=$(state); p2=$(pos_of "$line2"); i2=$(item_of "$line2")
delta=$((p2 - p1))
echo "后台 3 秒：position $p1 → ${p2}（Δ${delta}ms），item $i1 → $i2"
case "$line2" in *PLAYING*) ;; *) echo "!! 后台状态不是 PLAYING：$line2"; exit 1;; esac
if [ "$delta" -lt 1000 ] && [ "$i1" = "$i2" ]; then
  echo "!! 后台没在继续放：位置没走、也没换条（Δ=${delta}ms, item=${i1}）"; exit 1
fi
echo "✓ 后台播放成立（位置前进或已连播下一条；前台服务 types=mediaPlayback + 通知栏可见）"

# 解码器是谁：模拟器上必然是软解（c2.android.*），真机上这里应当出现厂商硬件解码器
# （c2.qti.* / c2.mtk.* / OMX.* 等）—— 这是"有没有用上手机硬件解码"的唯一硬判据。
echo "==> 当前用的解码器（真机上应为厂商硬件解码器）"
adb shell dumpsys media.codec 2>/dev/null | grep -iE "avc|hevc|decoder" | grep -iE "c2\.|OMX\." | head -5
