#!/usr/bin/env bash
# ============================================================================
#  make-fnos-pkg.sh —— 把 zizvideo 打成飞牛 fnOS 的 .fpk
#
#  飞牛的应用包是 `.fpk`，官方打包器是 **fnpack**（`fnpack build --directory <包目录>`）。
#  我们不重造打包格式：这个脚本只做两件事 ——
#    ① 把发行版里对应架构的 **Linux 静态二进制**放进包目录 `app/bin/zizvideo`；
#    ② 调官方 `fnpack build` 出 .fpk。
#  没装 fnpack 时**如实报错并给出装法**，不伪造一个"看起来像 .fpk"的压缩包
#  （假包会让使用者装不上还以为是我们的问题）。
#
#  用法：
#    bash tools/make-fnos-pkg.sh [--arch amd64|arm64] [--version <ver>] [--stage-only]
#  产物：
#    dist/fnos/zizvideo-<ver>-<arch>.fpk         （需要 fnpack）
#    dist/fnos/zizvideo-<ver>-<arch>/            （总是产出：可直接 fnpack build 的目录）
# ============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ARCH="amd64"
VERSION="$(sed -n 's/^VERSION[[:space:]]*?*=[[:space:]]*//p' "$ROOT/Makefile" | head -1)"
STAGE_ONLY=0

while [ $# -gt 0 ]; do
  case "$1" in
    --arch) ARCH="$2"; shift 2 ;;
    --version) VERSION="$2"; shift 2 ;;
    --stage-only) STAGE_ONLY=1; shift ;;
    --help|-h) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "!! 未知参数：$1" >&2; exit 2 ;;
  esac
done

case "$ARCH" in
  amd64|x86_64) ARCH="amd64"; FNOS_PLATFORM="x86" ;;
  arm64|aarch64) ARCH="arm64"; FNOS_PLATFORM="arm" ;;
  *) echo "!! 不支持的架构：${ARCH}（只做 amd64/arm64）" >&2; exit 2 ;;
esac

# fpk 的版本号用**去掉 -mvp 后缀**的服务端版本（飞牛要求 1.0.0 / 1.2.3-beta 这种形状）
PKGVER="${VERSION%-mvp}"
SRC="$ROOT/fnos/zizvideo"
DIST="$ROOT/dist/fnos"
STAGE="$DIST/zizvideo-${PKGVER}-${FNOS_PLATFORM}"

[ -d "$SRC" ] || { echo "!! 缺包源目录：$SRC" >&2; exit 1; }
BIN="$ROOT/dist/apps/zizvideo/${VERSION}/zizvideo_${VERSION}_linux_${ARCH}"
if [ ! -x "$BIN" ]; then
  echo "!! 找不到 Linux 二进制：$BIN" >&2
  echo "   先构建发行版：make release（会同时出 darwin 与 linux 产物）" >&2
  exit 1
fi

rm -rf "$STAGE"; mkdir -p "$STAGE"
cp -R "$SRC/." "$STAGE/"
mkdir -p "$STAGE/app/bin"
cp "$BIN" "$STAGE/app/bin/zizvideo"
chmod 0755 "$STAGE/app/bin/zizvideo" "$STAGE/cmd/main"
# manifest 里的 version / platform 必须与实际打包内容一致（否则用户看到的版本是假的）
python3 - "$STAGE/manifest" "$PKGVER" "$FNOS_PLATFORM" <<'PYEOF'
import sys
path, ver, platform = sys.argv[1], sys.argv[2], sys.argv[3]
lines = []
for line in open(path, encoding="utf-8").read().splitlines():
    if line.startswith("version="):
        line = "version=" + ver
    elif line.startswith("platform="):
        line = "platform=" + platform
    lines.append(line)
open(path, "w", encoding="utf-8").write("\n".join(lines) + "\n")
PYEOF
echo "==> 待打包目录已就绪：${STAGE}（含 Linux/$ARCH 二进制，$(wc -c <"$STAGE/app/bin/zizvideo" | tr -d ' ') 字节）"

if [ "$STAGE_ONLY" = "1" ]; then
  echo "（--stage-only：跳过 fnpack）"
  exit 0
fi

if ! command -v fnpack >/dev/null 2>&1; then
  cat >&2 <<'MSG'
!! 没有 fnpack（飞牛官方打包器）—— 不能诚实地产出 .fpk，所以这里直接失败。
   装法见飞牛开发者文档 https://developer.fnnas.com/docs/guide/（fnpack 与 appcenter-cli 都在那里）。
   目录已经准备好，装上之后可以直接跑：
     fnpack build --directory <上面的待打包目录>
   或者用本脚本的 --stage-only 只准备目录。
MSG
  exit 1
fi

cd "$DIST"
fnpack build --directory "$STAGE"
FPK="$(ls -1 "$DIST"/*.fpk 2>/dev/null | head -1 || true)"
if [ -z "$FPK" ]; then
  echo "!! fnpack 跑完却没看到 .fpk（不谎报成功）" >&2
  exit 1
fi
echo "==> 已产出：${FPK}（$(wc -c <"$FPK" | tr -d ' ') 字节）"
echo "    装到飞牛设备：appcenter-cli install-fpk $FPK"
