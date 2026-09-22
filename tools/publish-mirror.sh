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
for arg in "$@"; do
  case "$arg" in
    --verify-only) VERIFY_ONLY=1 ;;
    --allow-existing-version) ALLOW_EXISTING=1 ;;
    --self-test) SELF_TEST=1 ;;
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
# 复验只读公网镜像，不需要凭据：索引 latest 对不对、sha256 与本地是否一致、
# 下下来的二进制 --version 打印的版本是否等于索引版本。
verify_remote() {
  info "复验公网镜像 $MIRROR_BASE/apps/zizvideo/"
  local tmp; tmp="$(mktmp)"
  curl -fsS --max-time 30 "$MIRROR_BASE/apps/zizvideo/manifest.json" -o "$tmp/index.json" \
    || die "拉不到镜像索引 manifest.json"
  local latest; latest="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["latest"])' "$tmp/index.json")"
  [ "$latest" = "$VERSION" ] || die "镜像 latest=${latest}，本地=${VERSION}（上传没成功？）"
  ok "索引 latest = $VERSION"
  python3 - "$tmp/index.json" "$tmp" <<'PY'
import json, sys, urllib.request, hashlib, os
index, tmp = sys.argv[1], sys.argv[2]
rows = json.load(open(index))["assets"]
base = os.environ["MIRROR_BASE"]
for row in rows:
    url = "%s/apps/zizvideo/%s/%s" % (base, row["version"], row["name"])
    dst = os.path.join(tmp, row["name"])
    urllib.request.urlretrieve(url, dst)
    digest = hashlib.sha256(open(dst, "rb").read()).hexdigest()
    if digest != row["sha256"]:
        raise SystemExit("!! %s sha256 不符：索引 %s，实际 %s" % (row["name"], row["sha256"], digest))
    if os.path.getsize(dst) != row["size"]:
        raise SystemExit("!! %s 大小不符" % row["name"])
    print("  ✓ %s sha256/大小一致（%d B）" % (row["name"], row["size"]))
PY
  # 产物内嵌版本必须与索引一致（本机是 arm64，能直接跑）
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
  ok "镜像复验通过"
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

info "上传产物到 $APP_DIR/$VERSION/"
for f in "$VERDIR"/*; do
  name="$(basename "$f")"
  api POST /api/v1/files/upload \
    -F "dir=$APP_DIR/$VERSION" -F "on_conflict=overwrite" -F "files=@$f" >/dev/null \
    || die "上传 $name 失败"
  ok "$name"
done

info "上传索引与安装器到 $APP_DIR/"
api POST /api/v1/files/upload -F "dir=$APP_DIR" -F "on_conflict=overwrite" \
  -F "files=@$APPDIR/manifest.json" >/dev/null || die "上传顶层索引失败"
ok "manifest.json（版本真源）"
if [ -f install-zizvideo.sh ]; then
  api POST /api/v1/files/upload -F "dir=$APP_DIR" -F "on_conflict=overwrite" \
    -F "files=@install-zizvideo.sh" >/dev/null || die "上传安装器失败"
  ok "install-zizvideo.sh"
fi
if [ -f .release-key/codesign/zp-codesign.crt ]; then
  cp .release-key/codesign/zp-codesign.crt /tmp/zizvideo-codesign.crt.$$
  api POST /api/v1/files/upload -F "dir=$APP_DIR" -F "on_conflict=overwrite" \
    -F "files=@/tmp/zizvideo-codesign.crt.$$" >/dev/null || { rm -f /tmp/zizvideo-codesign.crt.$$; die "上传证书失败"; }
  rm -f /tmp/zizvideo-codesign.crt.$$
  ok "zizvideo-codesign.crt（安装器用；文件名必须是这个）"
fi

MIRROR_BASE="$MIRROR_BASE" verify_remote
info "完成：面板后台现在应显示「可更新 v${VERSION}」，你手动点更新即可。"
