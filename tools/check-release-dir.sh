#!/usr/bin/env bash
# ============================================================================
#  check-release-dir.sh —— 发版**前**把 dist/apps/zizvideo/<版本>/ 自检一遍
#
#  为什么要有它：`make publish` 会把索引（manifest.json / linux.json / android.json）与产物一起传上镜像，
#  而面板/App/独立安装器**只信索引里的 sha256 与 size**。索引和产物一旦不一致（手工改过产物、
#  构建中断留下的半截文件、版本号改过没重算索引），用户那边只会看到"装不上/校验不过"，
#  报错跟我们的源码毫无关系、极难查。所以发之前先在本地把"索引 ↔ 文件"对平。
#
#  用法：bash tools/check-release-dir.sh [--version <ver>] [版本目录]
#        缺省版本 = Makefile 里的 VERSION；缺省目录 = dist/apps/zizvideo/<版本>
#  退出码：0 全过；1 有不一致；2 环境/参数问题
# ============================================================================
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VER="$(sed -n 's/^VERSION[[:space:]]*?*=[[:space:]]*//p' "$ROOT/Makefile" | head -1)"
# --version 可覆盖：既能查历史版本的发布目录，也让门禁能用假目录（9.9.9）验它真的会红。
SKIP_SIG=0
while [ $# -gt 0 ]; do
  case "$1" in
    --version) VER="$2"; shift 2 ;;
    # 只查"索引 ↔ 产物"一致性、跳过签名检查：给门禁用**假发布目录**验它真会红时用
    # （假目录里的 darwin 文件不是签名的真产物）。真发版请勿加这个开关。
    --no-signature) SKIP_SIG=1; shift ;;
    *) break ;;
  esac
done
DIR="${1:-$ROOT/dist/apps/zizvideo/$VER}"
PARENT="$(dirname "$DIR")"

PASS=0; FAIL=0
ok()  { PASS=$((PASS + 1)); printf '  ✓ %s\n' "$*"; }
bad() { FAIL=$((FAIL + 1)); printf '  ✗ %s\n' "$*"; }
hdr() { printf '\n== %s\n' "$*"; }

[ -d "$DIR" ] || { echo "!! 版本目录不存在：${DIR}（先 make release）" >&2; exit 2; }
echo "版本目录：$DIR"

# 索引里每条资产都要：文件在、size 对、sha256 对
check_asset() { # $1=索引文件 $2=json 里的字段名（assets） $3=标签
  local idx="$1" key="$2" label="$3"
  python3 - "$idx" "$key" "$DIR" "$label" <<'PYEOF'
import hashlib, json, os, sys
idx, key, vdir, label = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
try:
    data = json.load(open(idx))
except Exception as exc:
    print("!! %s 不是合法 JSON：%s" % (idx, exc)); raise SystemExit(1)
rows = data.get("assets") or []
if not rows:
    print("!! %s 里没有 assets" % label); raise SystemExit(1)
bad = 0
for row in rows:
    name = row.get("name") or ""
    path = os.path.join(vdir, name)
    if not os.path.isfile(path):
        print("!! %s：索引里有 %s，磁盘上没有" % (label, name)); bad += 1; continue
    size = os.path.getsize(path)
    if int(row.get("size") or 0) != size:
        print("!! %s：%s 大小不符（索引 %s / 实际 %d）" % (label, name, row.get("size"), size)); bad += 1
    with open(path, "rb") as handle:
        digest = hashlib.sha256(handle.read()).hexdigest()
    if str(row.get("sha256") or "").lower() != digest:
        print("!! %s：%s sha256 不符（索引 %s… / 实际 %s…）" % (label, name, str(row.get("sha256"))[:12], digest[:12])); bad += 1
    if bad == 0:
        print("  ✓ %s：%s（%d B，sha256 %s…）" % (label, name, size, digest[:12]))
raise SystemExit(1 if bad else 0)
PYEOF
}

hdr "darwin 索引（面板契约）"
if [ -f "$DIR/manifest.json" ]; then
  check_asset "$DIR/manifest.json" assets "manifest.json" && ok "manifest.json 与产物一致" || bad "manifest.json 与产物不一致"
  # ⚠️ 两个 manifest 不是一回事：版本目录里的那份用 `version`，**顶层索引**才用 `latest`
  # （面板读的是顶层那份）。第一版就在这里取了错的字段，自己先被自己绊了一下。
  vfield="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("version") or "")' "$DIR/manifest.json")"
  [ "$vfield" = "$VER" ] && ok "版本目录 manifest.version = $VER" || bad "版本目录 manifest.version = '${vfield}'，期望 ${VER}"
  if [ -f "$PARENT/manifest.json" ]; then
    latest="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("latest") or "")' "$PARENT/manifest.json")"
    [ "$latest" = "$VER" ] && ok "顶层索引 latest = ${VER}（面板按它决定更新）" || bad "顶层索引 latest = '${latest}'，期望 ${VER}"
  else
    bad "缺顶层索引 $PARENT/manifest.json"
  fi
else
  bad "缺 $DIR/manifest.json"
fi

hdr "签名与可执行"
for f in "$DIR"/zizvideo_*_darwin_*; do
  [ -f "$f" ] || continue
  name="$(basename "$f")"
  v="$("$f" --version 2>&1 | head -1)"
  case "$v" in *"$VER"*) ok "$name --version = $v" ;; *) bad "$name --version 输出异常：$v" ;; esac
  if [ "$SKIP_SIG" = "1" ]; then
    note_sig="（--no-signature：跳过签名检查）"
    printf '  · %s %s\n' "$name" "$note_sig"
  elif command -v codesign >/dev/null 2>&1; then
    auth="$(codesign -dv --verbose=2 "$f" 2>&1 | awk -F= '/^Authority=/{print $2; exit}')"
    [ -n "$auth" ] && ok "$name 已签名（${auth}）" || bad "$name 没有签名（用户每次升级都要重新授权）"
  fi
done

hdr "Linux 产物（独立部署 / 飞牛用）"
if [ -f "$PARENT/linux.json" ]; then
  check_asset "$PARENT/linux.json" assets "linux.json" && ok "linux.json 与产物一致" || bad "linux.json 与产物不一致"
  for pair in "amd64 62" "arm64 183"; do
    set -- $pair
    f="$DIR/zizvideo_${VER}_linux_$1"
    [ -f "$f" ] || { bad "缺 $f"; continue; }
    res="$(python3 - "$f" "$2" <<'PYE'
import struct, sys
data = open(sys.argv[1], "rb").read()
if data[:4] != b"\x7fELF": print("不是 ELF"); raise SystemExit
if struct.unpack("<H", data[18:20])[0] != int(sys.argv[2]): print("架构不对"); raise SystemExit
off = struct.unpack("<Q", data[32:40])[0]; sz = struct.unpack("<H", data[54:56])[0]; num = struct.unpack("<H", data[56:58])[0]
if 3 in [struct.unpack("<I", data[off+i*sz:][:4])[0] for i in range(num)]:
    print("动态链接（极简 NAS 可能起不来）"); raise SystemExit
print("ok")
PYE
)"
    [ "$res" = "ok" ] && ok "linux/$1 是静态 ELF 且架构正确" || bad "linux/$1：$res"
  done
else
  bad "缺 $PARENT/linux.json（Linux/飞牛安装器靠它挑包）"
fi

hdr "安卓产物"
APK="$(ls -1 "$DIR"/zizvideo-android-*.apk 2>/dev/null | head -1 || true)"
if [ -n "$APK" ] && [ -f "$PARENT/android.json" ]; then
  python3 - "$PARENT/android.json" "$APK" <<'PYA' && ok "android.json 与 APK 一致" || bad "android.json 与 APK 不一致"
import hashlib, json, os, sys
meta = json.load(open(sys.argv[1]))
apk = sys.argv[2]
name = os.path.basename(apk)
ver = name[len("zizvideo-android-"):-len(".apk")] if name.startswith("zizvideo-android-") else ""
if meta.get("version") != ver:
    print("!! android.json version=%s，而 APK 文件名是 %s" % (meta.get("version"), ver)); raise SystemExit(1)
want = str(meta.get("sha256") or "").lower()
with open(apk, "rb") as handle:
    got = hashlib.sha256(handle.read()).hexdigest()
if want != got:
    print("!! APK sha256 不符（android.json %s… / 实际 %s…）" % (want[:12], got[:12])); raise SystemExit(1)
if int(meta.get("size") or 0) != os.path.getsize(apk):
    print("!! APK 大小不符"); raise SystemExit(1)
print("  ✓ android.json：app %s（%s…，%d B）" % (ver, got[:12], os.path.getsize(apk)))
PYA
else
  bad "缺 APK 或 $PARENT/android.json（二者要同时有才发得出去）"
fi

printf '\n== 结论：%d 项通过，%d 项失败\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] || { printf '上面每条 ✗ 都要先修（宁可重跑 make release，也别把不一致的索引发出去）\n' >&2; exit 1; }
printf '发布目录自检通过，可以 make publish。\n'
