#!/usr/bin/env bash
# ============================================================================
#  publish-mirror.sh —— 把 dist/apps/zizvideo/ 发到公网镜像站 apps/zizvideo/
#
#  为什么不能 rsync/scp：镜像站文档根在外接盘上，**只有 mini 上的面板进程**有那个卷的
#  完全磁盘访问授权；本机或 SSH 会话写它一律 "Operation not permitted"（坑 217，已复验）。
#  所以这里走 mini 面板的文件接口：POST /api/v1/login → POST /api/v1/files/upload。
#
#  用法：
#    make publish                      # 上传 + 复验（默认）
#    bash tools/publish-mirror.sh --verify-only   # 只复验线上与本地是否一致
#    bash tools/publish-mirror.sh --self-test      # 只探"能不能写镜像"（上传探针即删）
#    bash tools/publish-mirror.sh --app-only
#                                      # 只发安卓客户端（APK + android.json），不动服务端版本目录与 manifest：
#                                      # 改的只有安卓代码时用它 —— 服务端字节没变就不该再发一次服务端
#    bash tools/publish-mirror.sh --allow-existing-version
#                                      # 允许覆盖镜像上已存在的同版本（默认拒绝：同版本换字节
#                                      # 会让"已装 0.1.2 的用户"和"新装 0.1.2 的用户"不是同一份产物）
#
#  凭据：.panel-credential.local（gitignored，600）里的
#    ZP_MINI_URL / ZP_MINI_USER / ZP_MINI_PASS
#  地址由调用者提供，仓库里不留任何内网/公网默认值以外的秘密。
# ============================================================================
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

VERSION="${VERSION:-$(sed -n 's/^VERSION *?= *\(.*\)$/\1/p' Makefile | head -1)}"
APPDIR="dist/apps/zizvideo"
VERDIR="$APPDIR/$VERSION"
VERIFY_ONLY=0
# 镜像上保留几个版本（版本目录与对应 APK 都按这个数留）。用户 2026-09-27："服务器上以后保留近 3 个版本的文件"。
# 想改就改这里；--no-prune 仍然可以完全不清理。
KEEP_VERSIONS="${ZV_KEEP_VERSIONS:-3}"
ALLOW_EXISTING=0
SELF_TEST=0
APP_ONLY=0
DEEP="${VERIFY_DEEP:-0}"
PRUNE="${PRUNE:-1}"
for arg in "$@"; do
  case "$arg" in
    --verify-only) VERIFY_ONLY=1 ;;
    --allow-existing-version) ALLOW_EXISTING=1 ;;
    --app-only) APP_ONLY=1 ;;
    --self-test) SELF_TEST=1 ;;
    --deep) DEEP=1 ;;
    --no-prune) PRUNE=0 ;;
    *) echo "!! 未知参数：$arg"; exit 2 ;;
  esac
done

ok()   { printf '  ✓ %s\n' "$*"; }
# 分段计时：发布慢在哪一段，用数字说话（用户 2026-09-22 要求提速）
T0=$(date +%s)
phase() { local now; now=$(date +%s); printf '  ⏱ %s：%ss（累计 %ss）\n' "$1" "$((now-TLAST))" "$((now-T0))"; TLAST=$now; }
TLAST=$T0
info() { printf '==> %s\n' "$*"; }
die()  { printf '!! %s\n' "$*" >&2; exit 1; }

TMPDIRS=()
JAR=""
cleanup() {
  [ -n "$JAR" ] && rm -f "$JAR"
  if [ ${#TMPDIRS[@]} -gt 0 ]; then
    for d in "${TMPDIRS[@]}"; do rm -rf "$d"; done
  fi
  return 0
}
trap cleanup EXIT

mktmp() { local d; d="$(mktemp -d)"; TMPDIRS+=("$d"); printf '%s' "$d"; }

[ -n "$VERSION" ] || die "从 Makefile 读不到 VERSION"

# ---------------------------------------------------------------- 凭据 --
if [ -f .panel-credential.local ]; then
  # shellcheck disable=SC1091
  . ./.panel-credential.local
fi
MIRROR_BASE="${ZP_MIRROR_BASE:-https://mirror.zizdog.com:8888}"
MINI_URL="${ZP_MINI_URL:-https://panel.zizdog.com:8888}"
MINI_USER="${ZP_MINI_USER:-}"
MINI_PASS="${ZP_MINI_PASS:-}"
APP_DIR="${ZP_MIRROR_APP_DIR:-/Volumes/ZPMirror/mirror/apps/zizvideo}"

# ---------------------------------------------------------------- 复验 --
# 复验只读公网镜像，不需要凭据。默认**不把产物下载回来**（用户 2026-09-22：时间都花在
# 反复搬同一份字节上）：索引 latest、索引里的 sha256/size 与**本地已签名产物**逐字段一致、
# 线上产物 HTTP 可达且 Content-Length 与索引一致 —— 全部零大流量。
# VERIFY_DEEP=1（或 --deep）才整包下载复算 sha256 并跑 --version，做字节级复验。
verify_remote() {
  info "复验公网镜像 $MIRROR_BASE/apps/zizvideo/（$( [ "$DEEP" = "1" ] && echo 深验：下载整包 || echo 快验：不下整包 )）"
  local tmp; tmp="$(mktmp)"
  curl -fsS --max-time 30 "$MIRROR_BASE/apps/zizvideo/manifest.json" -o "$tmp/index.json" \
    || die "拉不到镜像索引 manifest.json"
  local latest; latest="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["latest"])' "$tmp/index.json")"
  [ "$latest" = "$VERSION" ] || die "镜像 latest=${latest}，本地=${VERSION}（上传没成功？）"
  ok "索引 latest = $VERSION"

  # ① 索引 vs 本地产物：sha256/大小逐字段比对（本地算，零下载）
  VERSION="$VERSION" VERDIR="$VERDIR" INDEX="$tmp/index.json" python3 - <<'PY' || die "索引与本地发布件不一致"
import json, os, hashlib, sys
ver, verdir, index = os.environ["VERSION"], os.environ["VERDIR"], os.environ["INDEX"]
rows = json.load(open(index))["assets"]
if not rows:
    raise SystemExit("!! 索引里没有任何产物")
for row in rows:
    p = os.path.join(verdir, row["name"])
    if not os.path.isfile(p):
        raise SystemExit("!! 本地产物缺失：%s" % p)
    size = os.path.getsize(p)
    digest = hashlib.sha256(open(p, "rb").read()).hexdigest()
    if digest != row["sha256"] or size != row["size"]:
        raise SystemExit("!! %s 与本地不一致：索引 %s/%d，本地 %s/%d"
                         % (row["name"], row["sha256"][:12], row["size"], digest[:12], size))
    print("  ✓ %s 与本地发布件一致（sha256 %s…，%d B）" % (row["name"], digest[:12], size))
PY

  # ② 线上可达 + Content-Length 与索引一致（HEAD，不拉 body）
  MIRROR_BASE="$MIRROR_BASE" INDEX="$tmp/index.json" python3 - <<'PY' || die "线上产物不可达或大小不符"
import json, os, urllib.request
base, index = os.environ["MIRROR_BASE"], os.environ["INDEX"]
for row in json.load(open(index))["assets"]:
    url = "%s/apps/zizvideo/%s/%s" % (base, row["version"], row["name"])
    req = urllib.request.Request(url, method="HEAD")
    with urllib.request.urlopen(req, timeout=30) as resp:
        cl = int(resp.headers.get("Content-Length") or 0)
    if cl != row["size"]:
        raise SystemExit("!! %s 线上大小 %d ≠ 索引 %d" % (row["name"], cl, row["size"]))
    print("  ✓ %s 线上可达，大小 %d B" % (row["name"], cl))
PY

  # ③ 深验（可选）：整包下载复算 + 跑 --version
  if [ "$DEEP" = "1" ]; then
    python3 - "$tmp/index.json" "$tmp" <<'PY'
import json, sys, urllib.request, hashlib, os
index, tmp = sys.argv[1], sys.argv[2]
base = os.environ["MIRROR_BASE"]
for row in json.load(open(index))["assets"]:
    url = "%s/apps/zizvideo/%s/%s" % (base, row["version"], row["name"])
    dst = os.path.join(tmp, row["name"])
    urllib.request.urlretrieve(url, dst)
    digest = hashlib.sha256(open(dst, "rb").read()).hexdigest()
    if digest != row["sha256"]:
        raise SystemExit("!! %s 下载后 sha256 不符：索引 %s，实际 %s" % (row["name"], row["sha256"], digest))
    print("  ✓ %s 下载复算 sha256 一致" % row["name"])
PY
    if [ "$(uname -m)" = "arm64" ]; then
      local bin="$tmp/zizvideo_${VERSION}_darwin_arm64"
      if [ -f "$bin" ]; then
        chmod +x "$bin"
        local got; got="$("$bin" --version 2>/dev/null | head -1)"
        case "$got" in
          *"$VERSION"*) ok "--version 含 ${VERSION}（${got}）" ;;
          *) die "--version 输出 \"$got\" 不含 ${VERSION}" ;;
        esac
      fi
    fi
  else
    # 零传输也要证明版本号对：直接跑**本地那份**发布件（与线上是同一份字节，已比过 sha256）
    local localbin="$VERDIR/zizvideo_${VERSION}_darwin_arm64"
    if [ -x "$localbin" ] && [ "$(uname -m)" = "arm64" ]; then
      local got; got="$("$localbin" --version 2>/dev/null | head -1)"
      case "$got" in
        *"${VERSION}"*) ok "本地发布件 --version 含 ${VERSION}（${got}）" ;;
        *) die "本地发布件 --version 输出 \"$got\" 不含 ${VERSION}" ;;
      esac
    fi
    info "（未做字节级复验；要整包下载复算：make verify DEEP=1）"
  fi
  # 安卓更新源（App 自动更新依赖它）：索引可达 + 它指向的 APK 就在线上且大小一致
  if [ -f "$APPDIR/android.json" ]; then
    local ajson="$tmp/android.json"
    if ! curl -fsS --max-time 30 "$MIRROR_BASE/apps/zizvideo/android.json" -o "$ajson"; then
      die "拉不到镜像上的 apps/zizvideo/android.json（App 自动更新会失效）"
    fi
    local apk_url; apk_url="$(python3 - "$ajson" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
print(d.get("file") or "")
PY
)"
    local apk_ver; apk_ver="$(python3 - "$ajson" <<'PY'
import json, sys
print(json.load(open(sys.argv[1]))["version"])
PY
)"
    local link="${apk_url##*/}"
    [ -n "$link" ] || die "android.json 里没有 file 字段"
    local want_size; want_size="$(python3 - "$ajson" <<'PY'
import json, sys
print(json.load(open(sys.argv[1]))["size"])
PY
)"
    local got_size
    got_size="$(curl -fsSI --max-time 30 "$MIRROR_BASE/apps/zizvideo/$apk_url" 2>/dev/null \
      | tr -d '\r' | awk 'tolower($1)=="content-length:"{print $2}' | tail -1)"
    [ -n "$got_size" ] || die "线上取不到 APP 更新包：$apk_url"
    [ "$got_size" = "$want_size" ] || die "线上 APK 大小 ${got_size} ≠ 清单 ${want_size}（$apk_url）"
    ok "安卓更新源可用：android.json → app ${apk_ver}，${link}（${got_size} B，线上可达）"
  fi
  ok "镜像复验通过：latest=${VERSION}，索引与本地发布件一致，线上可达"
  phase "复验"
}

# prune_old_versions：发布成功后清理镜像上的旧版本目录，**保留最近 KEEP_VERSIONS 个**（用户 2026-09-27 要求）。
# 为什么不是"只留最新"：用户偶尔要回滚/对比上一两版，镜像上留 3 份只占几十 MB。
# ⚠️ 版本号**必须按数字段比较**：末段是 0~10 的计数器，字符串比较会把 0.3.10 排在 0.3.9 前面（错的）。
# 安全约束（这里是递归删除，必须保守）：
#   · 只在**新版本已经复验通过之后**才调用（绝不先删后传）；
#   · 只删名字严格匹配 <数字.数字.数字>-mvp 的**目录**，且路径必须在 $APP_DIR 下；
#   · 顶层文件（manifest.json / 安装器 / 证书）一律不碰；
#   · 删完**回读目录**核对，残留就如实报错，不假装成功。
# 安卓更新源目录同样保留最近 KEEP_VERSIONS 份 APK（与版本目录对齐；App 只会拉最新那份）。
# 只在"新 APK 已经传完 + android.json 已指向它"之后调用 —— 顺序反了会把手上的更新源删掉。
prune_old_apks() {
  [ -n "${ANDROID_APK:-}" ] || return 0
  local listing
  listing="$(api GET "/api/v1/files" -G --data-urlencode "path=$APP_DIR/android" 2>/dev/null || true)"
  [ -n "$listing" ] || { info "（列不出 $APP_DIR/android，跳过旧 APK 清理）"; return 0; }
  local olds
  olds="$(printf '%s' "$listing" | KEEP="$ANDROID_APK" KEEP_N="$KEEP_VERSIONS" APP_DIR="$APP_DIR" python3 -c '
import json, os, re, sys
cur, app = os.environ["KEEP"], os.environ["APP_DIR"].rstrip("/")
keep_n = max(1, int(os.environ.get("KEEP_N") or "3"))
pat = re.compile(r"^zizvideo-android-([0-9]+)\.([0-9]+)\.([0-9]+)\.apk$")
try:
    data = json.load(sys.stdin)
except Exception:
    raise SystemExit(0)
apks = []
for e in (data.get("data") or {}).get("entries") or []:
    name = str(e.get("name") or "")
    path = str(e.get("path") or (app + "/android/" + name))
    m = pat.match(name)
    if e.get("is_dir") or not m:
        continue
    if not path.startswith(app + "/android/") or ".." in path:
        continue
    apks.append(((int(m.group(1)), int(m.group(2)), int(m.group(3))), name, path))
# 当前这份一定留；其余按版本号从新到旧补到 keep_n 份（版本目录与 APK 一一对应，方便回滚）
kept = {cur}
for _, name, _ in sorted(apks, key=lambda a: a[0], reverse=True):
    if len(kept) >= keep_n:
        break
    kept.add(name)
for _, name, path in apks:
    if name not in kept:
        print(path)
')"
  [ -z "$olds" ] && { ok "更新源目录不超过 ${KEEP_VERSIONS} 份 APK"; return 0; }
  echo "  将删除旧 APK：$(printf '%s' "$olds" | tr '\n' ' ')"
  local body
  body="$(printf '%s' "$olds" | python3 -c 'import json,sys; print(json.dumps({"paths":[l for l in sys.stdin.read().split("\n") if l]}))')"
  if api POST /api/v1/files/delete -H 'Content-Type: application/json' -d "$body" >/dev/null; then
    ok "旧 APK 已清理（保留最近 ${KEEP_VERSIONS} 份，含 ${ANDROID_APK}）"
  else
    info "（旧 APK 没删掉；不影响更新，只是占地方）"
  fi
}

prune_old_versions() {
  info "清理镜像旧版本（保留最近 ${KEEP_VERSIONS} 个，当前 ${VERSION}）"
  local listing
  listing="$(api GET "/api/v1/files" -G --data-urlencode "path=$APP_DIR" 2>/dev/null || true)"
  [ -n "$listing" ] || die "清理失败：列不出 $APP_DIR（面板接口异常）"
  local olds
  olds="$(printf '%s' "$listing" | VERSION="$VERSION" KEEP="$KEEP_VERSIONS" APP_DIR="$APP_DIR" python3 -c '
import json, os, re, sys
ver, app = os.environ["VERSION"], os.environ["APP_DIR"].rstrip("/")
keep = max(1, int(os.environ.get("KEEP") or "3"))
pat = re.compile(r"^([0-9]+)\.([0-9]+)\.([0-9]+)-mvp$")
try:
    data = json.load(sys.stdin)
except Exception:
    raise SystemExit(0)
dirs = []
for e in (data.get("data") or {}).get("entries") or []:
    name = str(e.get("name") or "")
    path = str(e.get("path") or (app + "/" + name))
    m = pat.match(name)
    if not e.get("is_dir") or not m:
        continue
    if not path.startswith(app + "/") or ".." in path:
        continue
    dirs.append((tuple(int(x) for x in m.groups()), name, path))
# 当前版本一定留；其余按版本号从新到旧补到 keep 个
kept = {ver}
ordered = sorted(dirs, key=lambda d: d[0], reverse=True)
for _, name, _ in ordered:
    if len(kept) >= keep:
        break
    kept.add(name)
for _, name, path in ordered:
    if name not in kept:
        print(path)
')"
  if [ -z "$olds" ]; then
    ok "没有需要清理的旧版本（镜像上不超过 ${KEEP_VERSIONS} 个）"
    return 0
  fi
  echo "  将删除：$(printf '%s' "$olds" | tr '\n' ' ')"
  local body
  body="$(printf '%s' "$olds" | python3 -c 'import json,sys; print(json.dumps({"paths":[l for l in sys.stdin.read().split("\n") if l], "recursive": True}))')"
  api POST /api/v1/files/delete -H 'Content-Type: application/json' -d "$body" >/dev/null \
    || die "删除旧版本失败（面板接口拒绝；旧版本仍在，不影响新版本使用）"
  local after
  after="$(api GET "/api/v1/files" -G --data-urlencode "path=$APP_DIR" 2>/dev/null || true)"
  printf '%s' "$after" | VERSION="$VERSION" KEEP="$KEEP_VERSIONS" python3 -c '
import json, os, re, sys
ver = os.environ["VERSION"]
keep = max(1, int(os.environ.get("KEEP") or "3"))
pat = re.compile(r"^([0-9]+)\.([0-9]+)\.([0-9]+)-mvp$")
data = json.load(sys.stdin)
left = [str(e.get("name")) for e in (data.get("data") or {}).get("entries") or []
        if e.get("is_dir") and pat.match(str(e.get("name") or ""))]
if ver not in left:
    raise SystemExit("!! 回读发现当前版本 %s 不见了" % ver)
if len(left) > keep:
    raise SystemExit("!! 回读发现版本目录还有 %d 个（应不超过 %d）：%s" % (len(left), keep, ", ".join(sorted(left))))
print("  ✓ 回读确认：版本目录 %d 个（保留最近 %d）：%s" % (len(left), keep, ", ".join(sorted(left))))
' || die "清理后回读不符（见上）"
  phase "清理旧版本"
}

if [ "$VERIFY_ONLY" = "1" ]; then
  MIRROR_BASE="$MIRROR_BASE" verify_remote
  exit 0
fi

# ---------------------------------------------------------------- 上传 --
[ -n "$MINI_USER" ] && [ -n "$MINI_PASS" ] || die "缺 ZP_MINI_USER/ZP_MINI_PASS（放 .panel-credential.local 或环境变量）"

JAR="$(mktemp)"
csrf() { awk '$6=="zp_csrf"{print $7}' "$JAR" | tail -1; }

info "登录 mini 面板 $MINI_URL"
curl -fsSk -c "$JAR" -o /dev/null "$MINI_URL/" || die "打不开 mini 面板"
curl -fsSk -b "$JAR" -c "$JAR" -H 'Content-Type: application/json' \
  -H "X-CSRF-Token: $(csrf)" \
  -d "{\"username\":\"$MINI_USER\",\"password\":\"$MINI_PASS\"}" \
  "$MINI_URL/api/v1/login" >/dev/null || die "mini 面板登录失败"
[ -n "$(csrf)" ] || die "登录后没拿到 zp_csrf（面板版本太旧？）"
ok "已登录 mini 面板（会话 cookie + CSRF 就绪）"
phase "登录"

api() { # api <method> <path> [curl args...]
  local method="$1" path="$2"; shift 2
  curl -fsSk -b "$JAR" -c "$JAR" -X "$method" -H "X-CSRF-Token: $(csrf)" "$@" "$MINI_URL$path"
}

# --app-only：只发安卓客户端。改的只有安卓代码时用它 —— 服务端字节没变就不该再发一次服务端
# （同版本换字节是明令禁止的，重发服务端只会撞上"已存在"的保护）。
# 要求：先 `bash android/tools/build.sh assembleRelease` + `make release`（后者刷新 dist 里的 APK 与 android.json）。
if [ "$APP_ONLY" = "1" ]; then
  shopt -s nullglob
  apks=("$APPDIR"/android/*.apk)
  shopt -u nullglob
  [ "${#apks[@]}" -gt 0 ] || die "缺 $APPDIR/android/*.apk —— 先 bash android/tools/build.sh assembleRelease && make release"
  [ -f "$APPDIR/android.json" ] || die "缺 $APPDIR/android.json —— 先跑 make release（它按 APK 重算更新清单）"
  adir="$APP_DIR/android"
  abody="$(python3 -c 'import json,sys; print(json.dumps({"path": sys.argv[1]}))' "$adir")"
  if api POST /api/v1/files/mkdir -H 'Content-Type: application/json' -d "$abody" >/dev/null 2>&1; then
    ok "已创建 android/（App 更新源目录）"
  elif api GET /api/v1/files -G --data-urlencode "path=$adir" 2>/dev/null | grep -q '"entries"'; then
    ok "android/ 已存在"
  else
    die "创建更新源目录失败：$adir（面板接口不建目录）"
  fi
  info "只发安卓客户端（服务端 ${VERSION} 一个字节都不动）"
  for f in "${apks[@]}" "$APPDIR/android.json"; do
    name="$(basename "$f")"
    size="$(wc -c < "$f" | tr -d ' ')"
    resp="$(mktemp)"
    if ! api_ro POST /api/v1/files/upload -F "dir=$adir" -F "on_conflict=overwrite" \
        -F "files=@$f;filename=$name" >"$resp" 2>&1; then
      rm -f "$resp"; die "上传 $name 失败"
    fi
    got="$(RESP="$resp" NAME="$name" python3 -c 'import json,os
try:
    d = json.load(open(os.environ["RESP"]))
except Exception:
    print(""); raise SystemExit
print(",".join(str(f.get("size")) for f in (d.get("data") or {}).get("uploaded") or [] if f.get("name") == os.environ["NAME"]))')"
    rm -f "$resp"
    [ "$got" = "$size" ] || die "$name 落盘大小 $got ≠ 本地 $size"
    ok "$name（$size B）"
  done
  ANDROID_APK="$(basename "$(ls -1 "${apks[@]}" | tail -1)")"
  if [ "$PRUNE" = "1" ]; then prune_old_apks; else info "（--no-prune：不清理旧 APK）"; fi
  # 线上核对：manifest 不动，只核对 android.json 指向的 APK 是否与本地逐字节一致
  MIRROR_BASE="$MIRROR_BASE" APPDIR="$APPDIR" python3 -c '
import hashlib, json, os, ssl, urllib.request
base = os.environ["MIRROR_BASE"].rstrip("/") + "/apps/zizvideo"
appdir = os.environ["APPDIR"]
ctx = ssl._create_unverified_context()
def fetch(url):
    with urllib.request.urlopen(url, timeout=60, context=ctx) as r:
        return r.read()
meta = json.loads(fetch(base + "/android.json").decode())
apk = meta["file"]
local = os.path.join(appdir, "android", os.path.basename(apk))
want = hashlib.sha256(open(local, "rb").read()).hexdigest()
got = hashlib.sha256(fetch(base + "/" + apk)).hexdigest()
if want != got:
    raise SystemExit("!! 线上 APK sha256 %s… != 本地 %s…" % (got[:16], want[:16]))
print("  ✓ 线上 APK 与本地逐字节一致：%s（%s…）" % (os.path.basename(apk), got[:16]))
' || die "线上核对失败"
  ok "安卓客户端已发布（服务端未动）"
  exit 0
fi

# --self-test：只验证"能不能写镜像"（上传一个几字节的探针再删掉），不碰任何线上产物。
# 换机器/换凭据后先跑这个，别拿真版本试。
if [ "$SELF_TEST" = "1" ]; then
  probe="$(mktemp)"; printf 'zizvideo publish self-test %s\n' "$(date -u +%FT%TZ)" > "$probe"
  api POST /api/v1/files/upload -F "dir=$APP_DIR" -F "on_conflict=overwrite" \
    -F "files=@$probe;filename=.publish-selftest" >/dev/null || die "自检上传失败（写权限/凭据有问题）"
  ok "自检上传成功：$APP_DIR/.publish-selftest"
  api POST /api/v1/files/delete -H 'Content-Type: application/json' \
    -d "{\"paths\":[\"$APP_DIR/.publish-selftest\"]}" >/dev/null || die "自检删除失败（请手动删掉 .publish-selftest）"
  rm -f "$probe"
  ok "自检清理完成；写权限可用，可以 make publish"
  exit 0
fi

[ -d "$VERDIR" ] || die "缺 $VERDIR —— 先跑 make release"
[ -f "$APPDIR/manifest.json" ] || die "缺 $APPDIR/manifest.json —— 先跑 make release"

# 同版本换字节会让新老用户拿到不同产物 —— 默认拒绝，除非显式放行。
EXISTING="$(curl -fsSk -b "$JAR" -G --data-urlencode "path=$APP_DIR/$VERSION" "$MINI_URL/api/v1/files" 2>/dev/null \
  | python3 -c 'import json,sys
try:
    data = json.load(sys.stdin)
except Exception:
    print(""); raise SystemExit
names = [e.get("name","") for e in (data.get("data") or {}).get("entries") or []]
print(",".join(names))' 2>/dev/null || true)"
if [ -n "$EXISTING" ] && [ "$ALLOW_EXISTING" != "1" ]; then
  die "镜像上已存在 apps/zizvideo/${VERSION}（${EXISTING}）。同版本不许换字节：请 bump VERSION 重发，或明确加 --allow-existing-version"
fi

# 面板的上传接口**不会自动建目录**（实测：目标目录不存在 → 400「文件不存在」），
# 所以每个新版本必须先 mkdir；`--allow-existing-version` 重传时目录已存在，属正常不算错。
info "确保版本目录存在 $APP_DIR/$VERSION/"
mkdir_body="$(python3 -c 'import json,sys; print(json.dumps({"path": sys.argv[1]}))' "$APP_DIR/$VERSION")"
if api POST /api/v1/files/mkdir -H 'Content-Type: application/json' -d "$mkdir_body" >/dev/null 2>&1; then
  ok "已创建 $VERSION/"
elif [ "$ALLOW_EXISTING" = "1" ]; then
  ok "$VERSION/ 已存在（--allow-existing-version）"
else
  die "创建版本目录失败：$APP_DIR/${VERSION}（面板接口不建目录，先确认权限/路径）"
fi

# 上传：**并行**（大二进制和小文件同时走，省掉串行等待），每个文件只传一次。
# 只读 cookie（不并行写 jar）；上传响应里面板回了真实落盘大小，逐个核对，不靠"200 就算成功"。
api_ro() { # api_ro <method> <path> [curl args...]：不写 cookie jar，供并行调用
  local method="$1" path="$2"; shift 2
  curl -fsSk -b "$JAR" -X "$method" -H "X-CSRF-Token: $(csrf)" "$@" "$MINI_URL$path"
}

UPLOAD_DIR="$APP_DIR/$VERSION"
UP_JOBS=(); UP_NAMES=(); UP_FILES=(); UP_ALL_RESP=()

queue_upload() { # queue_upload <目录> <本地文件> <线上文件名>
  local dir="$1" file="$2" name="$3"
  local resp; resp="$(mktemp)"
  api_ro POST /api/v1/files/upload -F "dir=$dir" -F "on_conflict=overwrite" \
    -F "files=@$file;filename=$name" >"$resp" 2>&1 &
  UP_JOBS+=("$!")
  UP_NAMES+=("$name"); UP_FILES+=("$file"); UP_ALL_RESP+=("$resp")
}

info "上传产物到 $UPLOAD_DIR/（并行）"
for f in "$VERDIR"/*; do
  queue_upload "$UPLOAD_DIR" "$f" "$(basename "$f")"
done
if [ -f install-zizvideo.sh ]; then
  queue_upload "$APP_DIR" "$PWD/install-zizvideo.sh" "install-zizvideo.sh"
fi
if [ -f .release-key/codesign/zp-codesign.crt ]; then
  # 必须显式给 filename：curl 默认用源文件基名，带 PID 的临时名（xxx.crt.22824）会被传成垃圾名，
  # 而安装器只认 zizvideo-codesign.crt（0.1.2 发版时踩到）。
  # 放受管临时目录（cleanup trap 负责删），**不能在大小核对之前删** —— 核对要 stat 它。
  crtdir="$(mktmp)"; cp .release-key/codesign/zp-codesign.crt "$crtdir/zizvideo-codesign.crt"
  queue_upload "$APP_DIR" "$crtdir/zizvideo-codesign.crt" "zizvideo-codesign.crt"
fi
# 安卓客户端更新源（App 自己拉）：APK 放稳定路径 apps/zizvideo/android/，不跟着版本目录被 prune
if [ -d "$APPDIR/android" ]; then
  # 面板的上传接口不会自动建目录（目标目录不存在 → 400），子目录同样要先 mkdir 一次
  adir="$APP_DIR/android"
  abody="$(python3 -c 'import json,sys; print(json.dumps({"path": sys.argv[1]}))' "$adir")"
  if api POST /api/v1/files/mkdir -H 'Content-Type: application/json' -d "$abody" >/dev/null 2>&1; then
    ok "已创建 android/（App 更新源目录）"
  elif api GET /api/v1/files -G --data-urlencode "path=$adir" 2>/dev/null | grep -q '"entries"'; then
    ok "android/ 已存在"
  else
    die "创建更新源目录失败：$adir（面板接口不建目录）"
  fi
  for f in "$APPDIR"/android/*.apk; do
    [ -f "$f" ] || continue
    queue_upload "$adir" "$f" "$(basename "$f")"
  done
  ANDROID_APK="$(basename "$(ls -1 "$APPDIR"/android/*.apk | tail -1)")"
fi

up_fail=0
idx=0
while [ "$idx" -lt "${#UP_JOBS[@]}" ]; do
  if ! wait "${UP_JOBS[$idx]}"; then
    echo "!! 上传 ${UP_NAMES[$idx]} 失败：$(cat "${UP_ALL_RESP[$idx]}" 2>/dev/null | head -c 200)" >&2
    up_fail=1
  fi
  idx=$((idx + 1))
done
[ "$up_fail" = "1" ] && die "有文件上传失败（上面已列出；索引未更新，面板不会显示新版本）"

# 面板回的落盘大小必须与本地一致（上传截断/写错目录都会在这里现形）
python3 - "${#UP_FILES[@]}" "${UP_FILES[@]}" "${UP_NAMES[@]}" "${UP_ALL_RESP[@]}" <<'PY' || die "上传后大小核对失败"
import json, os, sys
n = int(sys.argv[1]); files = sys.argv[2:2+n]; names = sys.argv[2+n:2+2*n]; resps = sys.argv[2+2*n:]
for local, name, resp in zip(files, names, resps):
    want = os.path.getsize(local)
    try:
        data = json.load(open(resp))
    except Exception:
        raise SystemExit("!! %s 的响应不是 JSON：%s" % (name, open(resp).read()[:120]))
    if not data.get("ok"):
        raise SystemExit("!! %s 上传失败：%s" % (name, json.dumps(data, ensure_ascii=False)[:160]))
    got = [f.get("size") for f in (data.get("data") or {}).get("uploaded") or [] if f.get("name") == name]
    if not got or got[0] != want:
        raise SystemExit("!! %s 落盘大小 %s ≠ 本地 %d" % (name, got, want))
    print("  ✓ %s（%d B）" % (name, want))
PY
for r in "${UP_ALL_RESP[@]}"; do rm -f "$r"; done
phase "上传产物（并行）"

# 顶层索引是"latest 指针"，**最后传**：绝不让它指向还没上传完的产物。
# android.json 也是"指针"（给 App 读），同样放在产物都上传完之后、manifest 之前。
if [ -f "$APPDIR/android.json" ]; then
  info "上传安卓更新清单到 $APP_DIR/"
  api POST /api/v1/files/upload -F "dir=$APP_DIR" -F "on_conflict=overwrite" \
    -F "files=@$APPDIR/android.json" >/dev/null || die "上传 android.json 失败"
  ok "android.json（App 自动更新源：$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$APPDIR/android.json")）"
  prune_old_apks
fi
info "上传顶层索引到 $APP_DIR/"
api POST /api/v1/files/upload -F "dir=$APP_DIR" -F "on_conflict=overwrite" \
  -F "files=@$APPDIR/manifest.json" >/dev/null || die "上传顶层索引失败"
ok "manifest.json（版本真源：latest=${VERSION}）"
phase "上传顶层索引"

MIRROR_BASE="$MIRROR_BASE" verify_remote
if [ "$PRUNE" = "1" ]; then
  prune_old_versions
else
  info "（--no-prune：保留镜像上的旧版本，便于回滚）"
fi
echo
info "→ 可测：面板「应用市场 → zizvideo」现在应显示「可更新 v${VERSION}」，你手动点更新即可。"
