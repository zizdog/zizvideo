#!/usr/bin/env bash
# ============================================================================
#  make-docker-image.sh —— 打 zizvideo 的容器镜像（用发行版里的静态 Linux 二进制）
#
#  为什么要它：NAS（飞牛/群晖/Unraid）与很多自托管用户习惯 `docker run`，
#  这条路不需要任何安装器、也不需要苹果的签名/TCC。
#
#  用法：
#    bash tools/make-docker-image.sh [--arch amd64|arm64] [--tag zizvideo:local] [--stage-only]
#  行为：
#    ① 把 dist/apps/zizvideo/<版本>/zizvideo_<版本>_linux_<arch> 拷进 docker/zizvideo（构建上下文）；
#    ② 有可用的 **docker daemon** 才 `docker build`；没有就**如实报错**（只装 CLI 没 daemon、
#       或 Docker Desktop 没启动，都会走到这里）。
# ============================================================================
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ARCH="amd64"; TAG="zizvideo:local"; STAGE_ONLY=0
VERSION="$(sed -n 's/^VERSION[[:space:]]*?*=[[:space:]]*//p' "$ROOT/Makefile" | head -1)"

while [ $# -gt 0 ]; do
  case "$1" in
    --arch) ARCH="$2"; shift 2 ;;
    --tag) TAG="$2"; shift 2 ;;
    --stage-only) STAGE_ONLY=1; shift ;;
    --help|-h) sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "!! 未知参数：$1" >&2; exit 2 ;;
  esac
done
case "$ARCH" in
  amd64|arm64) : ;;
  *) echo "!! 架构只支持 amd64/arm64" >&2; exit 2 ;;
esac

BIN="$ROOT/dist/apps/zizvideo/${VERSION}/zizvideo_${VERSION}_linux_${ARCH}"
[ -x "$BIN" ] || { echo "!! 找不到 $BIN —— 先 make release" >&2; exit 1; }
CTX="$ROOT/docker"
cp -f "$BIN" "$CTX/zizvideo"
chmod 0755 "$CTX/zizvideo"
echo "==> 构建上下文就绪：${CTX}（zizvideo = linux/${ARCH}，$(wc -c <"$CTX/zizvideo" | tr -d ' ') 字节）"

if [ "$STAGE_ONLY" = "1" ]; then echo "（--stage-only：跳过 docker build）"; exit 0; fi

if ! command -v docker >/dev/null 2>&1; then
  echo "!! 没有 docker 命令 —— 装 Docker（或 podman）后重跑；文件已就绪" >&2
  exit 1
fi
if ! docker info >/dev/null 2>&1; then
  cat >&2 <<'MSG'
!! docker CLI 在，但 **daemon 连不上**（Docker Desktop 未安装/未启动，或 socket 路径不对）。
   这里面常见两种情况：
     · 只装了 CLI（brew install docker）—— 需要再装一个运行时（Docker Desktop / colima / podman）；
     · Docker Desktop 装了但没启动。
   本脚本不会去启动/安装任何东西（那是使用者机器上的事）。文件已经准备好，daemon 可用时直接重跑。
MSG
  exit 1
fi

cd "$CTX"
docker build -t "$TAG" .
echo "==> 镜像已构建：$TAG"
echo "    起服务（示例）：docker run -d --name zizvideo -p 7766:7766 \\"
echo "      -v \$PWD/data:/data -v /你的/视频目录:/media:ro -e ZV_MEDIA_ROOTS=/media $TAG"
