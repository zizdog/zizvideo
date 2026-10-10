#!/usr/bin/env bash
# ============================================================================
#  check-fnos-fpk.sh —— 对一个**已经打好的** .fpk 做安装前自检（解开包逐项核对）
#
#  为什么要它：`fnpack build` 成功只说明"结构与 JSON 合法"，不说明**包里的东西对得上**：
#  二进制是不是本架构、是不是静态、manifest 版本与产物是否同源、9 个生命周期钩子是否都在、
#  桌面入口的端口与 manifest 的 service_port 是否一致（两份真源漂移就点不开）。这些只能在
#  解开包之后查 —— 而用户装不上的时候我们拿不到他的机器，所以要在发之前查。
#
#  用法：bash tools/check-fnos-fpk.sh [<file.fpk>]      # 缺省取 dist/fnos/zizvideo-<版本>-x86.fpk
#  退出码：0 全过；1 有问题；2 环境/参数问题
# ============================================================================
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VER="$(sed -n 's/^VERSION[[:space:]]*?*=[[:space:]]*//p' "$ROOT/Makefile" | head -1)"
PKGVER="${VER%-mvp}"
FPK="${1:-$ROOT/dist/fnos/zizvideo-${PKGVER}-x86.fpk}"

PASS=0; FAIL=0
ok()  { PASS=$((PASS + 1)); printf '  ✓ %s\n' "$*"; }
bad() { FAIL=$((FAIL + 1)); printf '  ✗ %s\n' "$*"; }
hdr() { printf '\n== %s\n' "$*"; }

[ -f "$FPK" ] || { echo "!! 找不到 .fpk：${FPK}（先 make fpk）" >&2; exit 2; }
echo "包：${FPK}（$(wc -c <"$FPK" | tr -d ' ') 字节）"

WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
tar xzf "$FPK" -C "$WORK" 2>/dev/null || { echo "!! 解不开 .fpk（不是 gzip tar？）" >&2; exit 1; }
# .fpk 里 app/ 是**单独打成 app.tgz** 的（官方打包器行为）⇒ 先解开，让 ui/ 与 bin/ 落在 $WORK 下，
# 后面统一用 appdir() 找"应用文件目录"（两种布局都认）。
APPROOT=""
tar xzf "$WORK/app.tgz" -C "$WORK" 2>/dev/null || true
if [ -d "$WORK/ui" ] || [ -d "$WORK/bin" ]; then APPROOT="$WORK"
elif [ -d "$WORK/app" ]; then APPROOT="$WORK/app"; fi
[ -n "$APPROOT" ] || { echo "!! 包里的应用文件目录找不到（app/ 或 app.tgz）" >&2; exit 1; }

hdr "官方要求的最小结构"
for f in manifest ICON.PNG ICON_256.PNG config/privilege config/resource cmd/main; do
  [ -e "$WORK/$f" ] && ok "包内有 $f" || bad "包内缺 $f"
done
if [ -f "$WORK/app.tgz" ] || [ -d "$WORK/app" ]; then
  ok "包内有 app（.fpk 里是 app.tgz）"
else
  bad "包内既没有 app/ 也没有 app.tgz"
fi
hooks="install_init install_callback upgrade_init upgrade_callback uninstall_init uninstall_callback config_init config_callback"
missing_hooks=""
for h in $hooks; do [ -e "$WORK/cmd/$h" ] || missing_hooks="$missing_hooks $h"; done
[ -z "$missing_hooks" ] && ok "8 个生命周期钩子都在（fnOS 按**文件**调用）" || bad "缺钩子：$missing_hooks"

hdr "manifest 与桌面入口（两份真源不能漂移）"
MF="$WORK/manifest"
mval() { sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*//p" "$MF" | head -1; }
appname="$(mval appname)"; mver="$(mval version)"; platform="$(mval platform)"; uidir="$(mval desktop_uidir)"
launch="$(mval desktop_applaunchname)"; sport="$(mval service_port)"
[ "$mver" = "$PKGVER" ] && ok "manifest.version = ${mver}（与本次版本一致）" || bad "manifest.version=${mver}，期望 $PKGVER"
[ "$appname" = "zizvideo" ] && ok "appname = zizvideo（升级期间必须稳定）" || bad "appname=$appname"
case "$platform" in
  x86|arm) ok "platform = ${platform}（带原生二进制不能是 all）" ;;
  all) bad "platform=all 但包里有原生二进制" ;;
  *) bad "platform=$platform 不认识" ;;
esac
[ -n "$uidir" ] && [ -d "$APPROOT/$uidir" ] && ok "desktop_uidir=$uidir 且该目录存在" || bad "desktop_uidir=$uidir 对应的目录不在包里"
[ -n "$launch" ] || bad "manifest 没有 desktop_applaunchname"
# 桌面入口：launch 指向的入口必须真的存在，且端口与 service_port 一致
if [ -f "$APPROOT/$uidir/config" ]; then
  res="$(python3 - "$APPROOT/$uidir/config" "$launch" "$sport" <<'PYEOF'
import json, sys
cfg = json.load(open(sys.argv[1]))
launch, sport = sys.argv[2], sys.argv[3]
entries = cfg.get(".url") or {}
if not entries:
    print("入口配置里没有 .url"); raise SystemExit(1)
if launch not in entries:
    print("desktop_applaunchname=%s 在入口配置里找不到（桌面卡片会点不开）" % launch); raise SystemExit(1)
bad = []
for eid, e in entries.items():
    if sport and str(e.get("port") or "") not in ("", sport):
        bad.append("%s 的 port=%s ≠ service_port=%s" % (eid, e.get("port"), sport))
    if str(e.get("port") or "") == "{port}":
        bad.append("%s 用了 {port} 占位符，但 fnpack 不替换它（实测）" % eid)
if bad:
    print("; ".join(bad)); raise SystemExit(1)
print("ok %d 个入口" % len(entries))
PYEOF
)" && ok "桌面入口自洽：$res" || bad "桌面入口不自洽：$res"
else
  bad "包内没有 $uidir/config"
fi

hdr "内嵌的 Linux 二进制"
BIN="$APPROOT/bin/zizvideo"
if [ -f "$BIN" ]; then
  ok "app.tgz 里有 bin/zizvideo（$(wc -c <"$BIN" | tr -d ' ') 字节）"
  want_machine=62; [ "$platform" = "arm" ] && want_machine=183
  res="$(python3 - "$BIN" "$want_machine" <<'PYE'
import struct, sys
data = open(sys.argv[1], "rb").read()
if data[:4] != b"\x7fELF":
    print("不是 ELF"); raise SystemExit(1)
if struct.unpack("<H", data[18:20])[0] != int(sys.argv[2]):
    print("架构与 manifest.platform 不符"); raise SystemExit(1)
off = struct.unpack("<Q", data[32:40])[0]; sz = struct.unpack("<H", data[54:56])[0]; num = struct.unpack("<H", data[56:58])[0]
if 3 in [struct.unpack("<I", data[off+i*sz:][:4])[0] for i in range(num)]:
    print("动态链接（极简系统会缺 ld.so）"); raise SystemExit(1)
print("ok")
PYE
)" && ok "二进制是静态 ELF 且架构与 platform 一致（${res}）" || bad "二进制有问题：$res"
  # ⚠️ 不能直接跑它 —— 这是 **Linux** 二进制，在 macOS 上 exec 不了（会得到空输出）。
  # 改成在字节里找构建时注入的版本串（ldflags 会带进去）。
  if python3 -c 'import sys; data=open(sys.argv[1],"rb").read(); sys.exit(0 if sys.argv[2].encode() in data else 1)' "$BIN" "$VER"; then
    ok "二进制里含版本串 ${VER}（构建时注入；Linux 二进制在 macOS 上跑不了，只能按字节验）"
  else
    bad "二进制里找不到版本串 ${VER}（可能打进了旧产物）"
  fi
else
  bad "app.tgz 里没有 bin/zizvideo（装上也起不来）"
fi

hdr "图标与权限声明"
for spec in "ICON.PNG 64" "ICON_256.PNG 256"; do
  set -- $spec
  dim="$(python3 - "$WORK/$1" <<'PYI'
import struct, sys
data = open(sys.argv[1], "rb").read()
print(struct.unpack(">II", data[16:24])[0] if data[:8] == b"\x89PNG\r\n\x1a\n" else "notpng")
PYI
)"
  [ "$dim" = "$2" ] && ok "$1 是 ${2}x${2}" || bad "$1 是 ${dim}，应为 $2"
done
if grep -q '"run-as"[[:space:]]*:[[:space:]]*"package"' "$WORK/config/privilege"; then
  ok "config/privilege 是 run-as=package（最小权限）"
else
  bad "config/privilege 不是 run-as=package"
fi
grep -q '"run-as"[[:space:]]*:[[:space:]]*"root"' "$WORK/config/privilege" && bad "不该用 root" || ok "没有用 root"

printf '\n== 结论：%d 项通过，%d 项失败\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] || { printf '上面每条 ✗ 都要先修（这个包装到飞牛上会出问题）\n' >&2; exit 1; }
printf '这个 .fpk 可以装到飞牛设备上试：appcenter-cli install-fpk %s\n' "$FPK"
