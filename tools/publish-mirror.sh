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
ALLOW_EXISTING=0
SELF_TEST=0
DEEP="${VERIFY_DEEP:-0}"
for arg in "$@"; do
  case "$arg" in
    --verify-only) VERIFY_ONLY=1 ;;
    --allow-existing-version) ALLOW_EXISTING=1 ;;
    --self-test) SELF_TEST=1 ;;
    --deep) DEEP=1 ;;
    *) echo "!! 未知参数：$arg"; exit 2 ;;
  esac
done

ok()   { printf '  ✓ %s\n' "$*"; }
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
    info "（未做字节级复验；要整包下载复算：make verify DEEP=1）"
  fi
  ok "镜像复验通过：latest=${VERSION}，索引与本地发布件一致，线上可达"
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

api() { # api <method> <path> [curl args...]
  local method="$1" path="$2"; shift 2
  curl -fsSk -b "$JAR" -c "$JAR" -X "$method" -H "X-CSRF-Token: $(csrf)" "$@" "$MINI_URL$path"
}

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
  # 必须显式给 filename：curl 默认用源文件基名，临时文件带 PID（xxx.crt.22824），
  # 线上就会多出个垃圾名，而安装器只认 zizvideo-codesign.crt（0.1.2 发版时踩到）。
  cp .release-key/codesign/zp-codesign.crt /tmp/zizvideo-codesign.crt.$$
  queue_upload "$APP_DIR" "/tmp/zizvideo-codesign.crt.$$" "zizvideo-codesign.crt"
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
rm -f /tmp/zizvideo-codesign.crt.$$ 2>/dev/null || true
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

# 顶层索引是"latest 指针"，**最后传**：绝不让它指向还没上传完的产物。
info "上传顶层索引到 $APP_DIR/"
api POST /api/v1/files/upload -F "dir=$APP_DIR" -F "on_conflict=overwrite" \
  -F "files=@$APPDIR/manifest.json" >/dev/null || die "上传顶层索引失败"
ok "manifest.json（版本真源：latest=${VERSION}）"

MIRROR_BASE="$MIRROR_BASE" verify_remote
echo
info "→ 可测：面板「应用市场 → zizvideo」现在应显示「可更新 v${VERSION}」，你手动点更新即可。"
