#!/usr/bin/env bash
# ============================================================================
#  电视端「只用遥控器登录」验收（用户 2026-09-25 报障："TV 客户端登录界面确认按钮无法获得焦点，
#  输入完信息，无法操作登录！"）
#
#  为什么必须有这个脚本：手机上永远测不出来 —— 电视的软键盘是**遥控器驱动**的，
#  键盘右下角那颗"确认"键走的是 IME editor action（口令框上是 ✓、地址/用户名框上是 →|），
#  不是点击。原来三个输入框没写 imeOptions，那颗确认键按下去什么都不发生（旧包实测：
#  焦点被输入框顺移到"使用 HTTPS"，登录请求根本没发出）。而登录页是**原生 Activity**，
#  网页侧那套 tv.js 遥控器导航管不到它 —— 所以既有的电视验收
#  （旧 harness 是"种 prefs 走自动登录"）永远碰不到这条路径。
#
#  用法：
#    bash android/tools/tv-accept-login.sh            # 键盘确认键那条路（默认）
#    ACTION=button bash android/tools/tv-accept-login.sh   # 返回收键盘 → ↓ 到「登录」→ 确定
#  前置：
#    · Android TV 模拟器（AVD zv34tv，系统镜像 system-images;android-34;android-tv;arm64-v8a）已启动：
#        emulator -avd zv34tv -no-window -no-audio -no-boot-anim -gpu swiftshader_indirect
#      没建过 AVD：
#        sdkmanager --install "system-images;android-34;android-tv;arm64-v8a"
#        avdmanager create avd -n zv34tv -k "system-images;android-34;android-tv;arm64-v8a" -d tv_1080p
#    · 一个 zizvideo 服务在 10.0.2.2:17799（就是从模拟器看宿主机的 17799），账号 zvtest/zv-dev-pass-123
#  结论怎么看：最后一行是 `遥控器登录通过 ✅`（窗口变成 WebActivity）才算过。
# ============================================================================
set -u
cd "$(dirname "$0")/.." || exit 1
source tools/env.sh >/dev/null 2>&1

APK="${APK:-app/build/outputs/apk/debug/app-debug.apk}"
HOSTPORT="${HOSTPORT:-10.0.2.2:17799}"
USER_NAME="${USER_NAME:-zvtest}"
PASS="${PASS:-zv-dev-pass-123}"
ACTION="${ACTION:-ime}"

[ -f "$APK" ] || { echo "!! 没有 $APK（先 bash android/tools/build.sh assembleDebug）"; exit 1; }

adb uninstall com.zizdog.zizvideo >/dev/null 2>&1
adb install "$APK" >/dev/null 2>&1 || { echo "!! 装不上 $APK"; exit 1; }
adb shell pm clear com.zizdog.zizvideo >/dev/null
adb shell logcat -c
adb shell am start -n com.zizdog.zizvideo/.LoginActivity >/dev/null
sleep 5

k() { adb shell input keyevent "$1"; sleep "${2:-0.5}"; }
focus() { # 打印当前获得焦点的控件（uiautomator 那套对 Material 输入框的 text 读不稳，只看 id）
  adb shell uiautomator dump /sdcard/zvac.xml >/dev/null 2>&1
  adb shell cat /sdcard/zvac.xml 2>/dev/null > /tmp/zvac.xml
  python3 - <<'PY'
import re
x = open('/tmp/zvac.xml').read()
got = ""
for m in re.finditer(r"<node[^>]*>", x):
    n = m.group(0)
    if re.search(r'focused="true"', n):
        rid = re.search(r'resource-id="([^"]*)"', n)
        got = rid.group(1).split("/")[-1] if rid else "?"
print(got or "（无）")
PY
}
# 把键盘高亮挪到右下角那颗确认键：↓ 到底部行（3 下），再 → 6 下（底行 7 个键，会绕圈）
ime_action() {
  for _ in 1 2 3; do k 20 0.4; done
  for _ in 1 2 3 4 5 6; do k 22 0.4; done
  k 23 2
}

echo "== 只用遥控器填表（不点屏幕） =="
k 20 1                       # ↓ → 服务器地址
k 23 2                       # 确定：打开软键盘
k 67 1                       # 键盘一开常顺手打出一个字符，删掉
adb shell input text "$HOSTPORT"; sleep 1
ime_action;        echo "   地址后焦点 = $(focus)"
adb shell input text "$USER_NAME"; sleep 1
ime_action;        echo "   用户名后焦点 = $(focus)"
adb shell input text "$PASS"; sleep 1
if [ "$ACTION" = "button" ]; then
  k 4 1.5                    # 返回：收起软键盘（电视键盘是浮层）
  k 20 1.2                   # ↓ → 登录按钮
  echo "   收键盘后焦点 = $(focus)"
  k 23 1
else
  ime_action                 # 口令框上的确认键 ⇒ 直接登录
fi
sleep 6

WIN=$(adb shell dumpsys window 2>/dev/null | sed -n 's/.*mCurrentFocus=\(.*\)/\1/p' | head -1)
echo "   最终窗口 = ${WIN}"
case "$WIN" in
  *WebActivity*) echo "==> 遥控器登录通过 ✅"; exit 0 ;;
esac
echo "!! 遥控器登录失败（没进 WebActivity）"
adb logcat -d -s zv-login | tail -8
exit 1
