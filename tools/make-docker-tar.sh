#!/usr/bin/env bash
# ============================================================================
#  make-docker-tar.sh —— 把**发布件**打成可离线导入的容器镜像 tar（给没有外网/registry 的 NAS 用）
#
#  为什么是 `FROM scratch`：
#    · 我们的发布件是**静态二进制**，不需要底座镜像 ⇒ 没有 registry、拉不到 Docker Hub 也能构建/分发；
#    · 这也正是 `tools/verify-linux-container.sh` 在**真 Linux** 上验过的那一种镜像（不是"另一个口味"）。
#    代价：镜像里没有 shell/python3 ⇒ 配置在**构建时**烘焙进去（默认 0.0.0.0:7766 / 数据 /data / 媒体 /media）；
#    要改就自己挂一份 config.json 进去：`docker run -v my.json:/config.json <image> --config /config.json`。
#
#  用法：
#    bash tools/make-docker-tar.sh [--arch amd64|arm64] [--keep-image]
#  产物：
#    dist/apps/zizvideo/docker/zizvideo-<版本>-<arch>.tar.gz   （app 级稳定路径，用户 docker load 导入）
#    dist/apps/zizvideo/docker.json                            （索引：file/sha256/size/arch）
#  退出码：0 成功 / 1 失败 / 2 环境不具备（没有 docker daemon —— **如实跳过**）
# ============================================================================
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="$(sed -n 's/^VERSION[[:space:]]*?*=[[:space:]]*//p' "$ROOT/Makefile" | head -1)"
ARCH="amd64"; KEEP_IMAGE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --arch) ARCH="$2"; shift 2 ;;
    --keep-image) KEEP_IMAGE=1; shift ;;
    --help|-h) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "!! 未知参数：$1（--help 看用法）" >&2; exit 2 ;;
  esac
done
case "$ARCH" in amd64|arm64) : ;; *) echo "!! --arch 只支持 amd64/arm64" >&2; exit 2 ;; esac

BIN="$ROOT/dist/apps/zizvideo/$VERSION/zizvideo_${VERSION}_linux_$ARCH"
[ -x "$BIN" ] || { echo "!! 找不到 $BIN —— 先 make release" >&2; exit 1; }
command -v docker >/dev/null 2>&1 || { echo "!! 没有 docker 命令（**如实跳过**，不代表做过了）" >&2; exit 2; }
docker info >/dev/null 2>&1 || { echo "!! docker CLI 在但 daemon 连不上（**如实跳过**）" >&2; exit 2; }

OUTDIR="$ROOT/dist/apps/zizvideo/docker"
CTX="$ROOT/.dockertar"
mkdir -p "$OUTDIR" "$CTX"
cp "$BIN" "$CTX/zizvideo"
# 烘焙默认配置：与容器入口脚本的默认一致（用户可挂自己的 config 覆盖）
printf '{"listen":"0.0.0.0:7766","data_dir":"/data","database_path":"/data/zizvideo.db","media_allow_roots":["/media"],"allow_register":false}\n' >"$CTX/config.json"
{
  printf 'FROM scratch\n'
  printf 'COPY zizvideo /zizvideo\n'
  printf 'COPY config.json /config.json\n'
  printf 'VOLUME ["/data"]\n'
  printf 'EXPOSE 7766\n'
  printf 'ENTRYPOINT ["/zizvideo", "--config", "/config.json"]\n'
} >"$CTX/Dockerfile"

TAG="zizvideo:${VERSION}-${ARCH}"
echo "==> 构建 ${TAG}（FROM scratch，含 linux/$ARCH 发布件 $(wc -c <"$BIN" | tr -d ' ') 字节）"
if ! docker build -q --platform "linux/$ARCH" -t "$TAG" "$CTX" >/tmp/zv-dockertar-build.log 2>&1; then
  echo "!! 镜像构建失败：$(tail -2 /tmp/zv-dockertar-build.log)" >&2
  rm -rf "$CTX"; exit 1
fi
TAR="$OUTDIR/zizvideo-${VERSION}-${ARCH}.tar.gz"
echo "==> 导出镜像（docker save | gzip）→ $TAR"
if ! docker save "$TAG" | gzip -9 >"$TAR"; then
  echo "!! docker save 失败" >&2; rm -f "$TAR"; rm -rf "$CTX"; exit 1
fi
SIZE="$(wc -c <"$TAR" | tr -d ' ')"
if [ "$SIZE" -lt 1000000 ]; then
  echo "!! 导出的 tar 只有 ${SIZE} 字节 —— 太小了，八成没把二进制打进去（不谎报成功）" >&2
  rm -f "$TAR"; rm -rf "$CTX"; exit 1
fi
if [ "$KEEP_IMAGE" != "1" ]; then docker rmi -f "$TAG" >/dev/null 2>&1 || true; fi
rm -rf "$CTX"

# 立刻刷新索引（docker.json 里要写 tar 的 sha256/size —— 与 fnos.json 同样的道理：
# 索引不刷新，用户按索引下载就会拿到对不上的一份）
VERDIR="$ROOT/dist/apps/zizvideo/$VERSION"
if [ -d "$VERDIR" ]; then
  if python3 "$ROOT/tools/make-app-index.py" "$VERDIR" "$VERSION" >/dev/null 2>&1; then
    echo "==> 已刷新索引（docker.json / fnos.json / manifest.json / linux.json）"
  else
    echo "!! 索引刷新失败 —— 先看 make release 的输出（docker.json 可能是旧的）" >&2
  fi
fi
echo "==> 已产出：${TAR}（${SIZE} 字节）"
echo "    用户侧导入：docker load -i $(basename "$TAR") && docker run -d -p 7766:7766 -v <数据目录>:/data -v <媒体目录>:/media:ro $TAG"
