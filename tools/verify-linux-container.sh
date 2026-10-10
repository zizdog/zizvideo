#!/usr/bin/env bash
# ============================================================================
#  verify-linux-container.sh —— 把**发布的 Linux 二进制**跑进真 Linux 内核里验一遍
#
#  为什么要它：这是"独立部署/飞牛"里最难自证的一格 —— 我们只能在 macOS 上交叉编译，
#  却要保证它在 NAS 的 Linux 上真能跑。做法：用 `FROM scratch` 起一个最小镜像
#  （静态二进制**不需要底座镜像**，所以没有外网、拉不到 Docker Hub 也能验），
#  把发布件 COPY 进去跑起来，再从宿主机打它的 HTTP 接口。
#
#  用法：
#    bash tools/verify-linux-container.sh [--arch arm64|amd64|both] [--api] [--keep]
#  退出码：0 全过 / 1 有 ✗ / 2 环境不具备（没有 docker daemon 或没有发行件 —— **如实跳过，不假装**）
#
#  ⚠️ 两点环境知识（踩过）：
#    · Docker Desktop(macOS) 默认**不共享 `/tmp`**：构建上下文/挂载点要放在已共享的路径下
#      （本脚本用仓库下的 .linetest/，并加进 .gitignore）。挂载点在共享列表外时容器看到空目录，
#      甚至 `docker run` 会卡住等一个没人能点的授权弹窗。
#    · Docker 经典构建器的 `COPY` 目标**不支持空格** ⇒ 镜像内部路径一律用无空格的
#      （宿主里带空格/中文的路径由服务层自己的测试覆盖 —— 见 make smoke）。
# ============================================================================
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VER="$(sed -n 's/^VERSION[[:space:]]*?*=[[:space:]]*//p' "$ROOT/Makefile" | head -1)"
ARCH="both"; WANT_API=0; KEEP=0
HOST_ARCH="$(uname -m)"; [ "$HOST_ARCH" = "aarch64" ] && HOST_ARCH="arm64"; [ "$HOST_ARCH" = "x86_64" ] && HOST_ARCH="amd64"

while [ $# -gt 0 ]; do
  case "$1" in
    --arch) ARCH="$2"; shift 2 ;;
    --api) WANT_API=1; shift ;;
    --keep) KEEP=1; shift ;;
    --help|-h) sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "!! 未知参数：$1（--help 看用法）" >&2; exit 2 ;;
  esac
done
case "$ARCH" in
  both) ARCHS=("$HOST_ARCH"); [ "$HOST_ARCH" = "arm64" ] && ARCHS+=("amd64") || ARCHS+=("arm64") ;;
  arm64|amd64) ARCHS=("$ARCH") ;;
  *) echo "!! --arch 只支持 arm64/amd64/both" >&2; exit 2 ;;
esac

# 与 tools/check-release-dir.sh 同一规则：版本目录的上一级
STAMP="$ROOT/dist/apps/zizvideo/.linux-verified.json"

# record_verified <arch> <二进制路径>：把 sha256 + 时间戳并进 stamp（同 arch 覆盖）
record_verified() {
  python3 - "$STAMP" "$1" "$2" <<'PYR' 2>/dev/null || return 0
import hashlib, json, os, sys, time
stamp, arch, path = sys.argv[1], sys.argv[2], sys.argv[3]
data = {}
if os.path.exists(stamp):
    try:
        with open(stamp) as f:
            data = json.load(f)
    except Exception:
        data = {}
with open(path, "rb") as f:
    digest = hashlib.sha256(f.read()).hexdigest()
data.setdefault("verified", {})[arch] = {"sha256": digest, "at": time.strftime("%Y-%m-%dT%H:%M:%S%z")}
data["version"] = os.path.basename(os.path.dirname(path)).replace("zizvideo-", "") or data.get("version", "")
os.makedirs(os.path.dirname(stamp), exist_ok=True)
with open(stamp, "w") as f:
    json.dump(data, f, ensure_ascii=False, indent=2)
    f.write("\n")
PYR
}

PASS=0; FAIL=0
ok()  { PASS=$((PASS + 1)); printf '  ✓ %s\n' "$*"; }
bad() { FAIL=$((FAIL + 1)); printf '  ✗ %s\n' "$*"; }
note(){ printf '  · %s\n' "$*"; }

if ! command -v docker >/dev/null 2>&1; then
  echo "!! 没有 docker 命令 —— 这一步需要它（**如实跳过**，不代表验证通过）" >&2
  exit 2
fi
if ! docker info >/dev/null 2>&1; then
  echo "!! docker CLI 在但 **daemon 连不上** —— 需要 Docker Desktop/colima/podman（**如实跳过**）" >&2
  exit 2
fi

WORK="$ROOT/.linetest"
grep -q '^\.linetest/' "$ROOT/.gitignore" 2>/dev/null || printf '\n.linetest/\n' >>"$ROOT/.gitignore"
mkdir -p "$WORK"

cleanup() {
  if [ "$KEEP" = "1" ]; then note "--keep：保留现场 $WORK 与容器"; return 0; fi
  for name in $(docker ps -a --format '{{.Names}}' 2>/dev/null | grep '^zv-linux-verify' || true); do
    (docker rm -f "$name" >/dev/null 2>&1 &)   # 后台执行：daemon 偶尔对变更类操作迟迟不返回
  done
  sleep 2
  rm -rf "$WORK"
}
trap cleanup EXIT

# 探测端口是否已经被自己的容器占用（避免打到别的实例上还以为是自己的）
free_port() {
  python3 - "$1" <<'PYP'
import socket, sys
port = int(sys.argv[1])
s = socket.socket()
try:
    s.bind(("127.0.0.1", port)); print("free")
except OSError:
    print("busy")
finally:
    s.close()
PYP
}

for arch in "${ARCHS[@]}"; do
  emulated=""
  [ "$arch" != "$HOST_ARCH" ] && emulated="（qemu 模拟）"
  printf '\n== linux/%s%s\n' "$arch" "$emulated"
  BIN="$ROOT/dist/apps/zizvideo/$VER/zizvideo_${VER}_linux_$arch"
  if [ ! -x "$BIN" ]; then
    bad "没有发行件 ${BIN}（先 make release）"
    continue
  fi
  ctx="$WORK/$arch"
  rm -rf "$ctx"; mkdir -p "$ctx"
  # 端口固定但每个架构不同，方便排查；被占就换一个
  base_port=17790; [ "$arch" = "amd64" ] && base_port=17795
  port="$base_port"
  for cand in "$base_port" $((base_port + 1)) $((base_port + 2)); do
    [ "$(free_port "$cand")" = "free" ] && { port="$cand"; break; }
  done
  cp "$BIN" "$ctx/zizvideo"
  # 造一个 1 秒测试视频**打进镜像**（scratch 里没有 ffmpeg，但扫描只看文件名也够验证链路）
  if command -v ffmpeg >/dev/null 2>&1; then
    ffmpeg -hide_banner -loglevel error -f lavfi -i testsrc=size=160x120:rate=10 -t 1 \
      -pix_fmt yuv420p "$ctx/demo.mp4" >/dev/null 2>&1 || true
  fi
  printf '{"listen":"0.0.0.0:7791","data_dir":"/data","database_path":"/data/zizvideo.db","media_allow_roots":["/media"],"allow_register":false}\n' >"$ctx/config.json"
  media_copy=""
  [ -f "$ctx/demo.mp4" ] && media_copy='COPY demo.mp4 /media/demo.mp4'
  {
    printf 'FROM scratch\n'
    printf 'COPY zizvideo /zizvideo\n'
    printf 'COPY config.json /config.json\n'
    [ -n "$media_copy" ] && printf '%s\n' "$media_copy"
    printf 'ENTRYPOINT ["/zizvideo"]\n'
  } >"$ctx/Dockerfile"
  img="zv-linux-verify-$arch:latest"
  if ! docker build -q --platform "linux/$arch" -t "$img" "$ctx" >/tmp/zv-lc-build.log 2>&1; then
    bad "镜像构建失败（$(tail -1 /tmp/zv-lc-build.log)）"
    continue
  fi
  ok "用发布件建出最小镜像（FROM scratch，不需要拉底座）"
  name="zv-linux-verify-$arch"
  docker rm -f "$name" >/dev/null 2>&1 || true
  if ! docker run -d --platform "linux/$arch" --name "$name" -p "127.0.0.1:$port:7791" "$img" --config /config.json >/dev/null 2>&1; then
    bad "容器起不来（docker run 失败）"
    continue
  fi
  # 等它有 HTTP 响应（**任何**状态码都算"在跑"；503 是"在跑但没就绪"，不是没起来）
  code="000"; i=0
  while [ "$i" -lt 40 ]; do
    code="$(curl -s -o "$WORK/readyz.json" -w '%{http_code}' --max-time 3 "http://127.0.0.1:$port/readyz" 2>/dev/null || true)"
    [ -n "$code" ] || code=000
    [ "$code" != "000" ] && break
    sleep 0.5; i=$((i + 1))
  done
  if [ "$code" = "000" ]; then
    bad "容器里服务没有响应（看 docker logs ${name}）"
    docker logs "$name" 2>&1 | tail -3 | sed 's/^/      /'
    continue
  fi
  ver_in_log="$(docker logs "$name" 2>&1 | grep -o '"version":"[^"]*"' | head -1)"
  ok "发布件在真 Linux 上跑起来了（/readyz HTTP ${code}；${ver_in_log}）"
  # 记证据：**这一份字节**（sha256）在真 Linux 上起过服务。发布前自检会拿它对账，
  # 免得"发布件换了但没人再验过"这种最危险的漂移（stamp 与产物不同源就该提示）。
  record_verified "$arch" "$BIN" >/dev/null 2>&1 || note "（证据文件没写成：${STAMP}）"
  case "$(cat "$WORK/readyz.json" 2>/dev/null)" in
    *'"db":{"ok":true'*|*'"db": {"ok": true'*) ok "容器里数据库正常（SQLite 迁移在 Linux 上跑通）" ;;
    *) note "readyz 里没读到 db ok（老版本字段？）" ;;
  esac
  if [ "$WANT_API" = "1" ] && [ -f "$ctx/demo.mp4" ]; then
    api_out="$(python3 - "$port" <<'PYAPI' 2>&1
import json, sys, time, urllib.request, urllib.error
BASE = "http://127.0.0.1:%s" % sys.argv[1]
ck = {}
def call(method, path, body=None, raw=False, hdrs=None):
    data = json.dumps(body).encode() if body is not None else None
    h = dict(hdrs or {})
    if data is not None: h["Content-Type"] = "application/json"
    if ck: h["Cookie"] = "; ".join("%s=%s" % kv for kv in ck.items())
    if ck.get("zv_csrf"): h["X-CSRF-Token"] = ck["zv_csrf"]
    req = urllib.request.Request(BASE + path, data=data, headers=h, method=method)
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            payload, code = r.read(), r.status
            for c in r.headers.get_all("Set-Cookie") or []:
                k, v = c.split(";", 1)[0].split("=", 1); ck[k.strip()] = v.strip()
    except urllib.error.HTTPError as e:
        payload, code = e.read(), e.code
    return (code, payload) if raw else (code, json.loads(payload.decode() or "{}"))
c1 = call("POST", "/api/v1/setup", {"username": "lin", "password": "linpass123", "display_name": "linux"})[0]
c2 = call("POST", "/api/v1/auth/login", {"username": "lin", "password": "linpass123"})[0]
code, body = call("POST", "/api/v1/libraries", {"name": "容器库", "root_path": "/media", "kind": "short"})
if code != 201:
    print("建库失败 %s %s" % (code, body)); raise SystemExit(1)
lib = body["data"]["id"]
code, body = call("POST", "/api/v1/libraries/%s/scan" % lib)
if code not in (200, 202):
    print("触发扫描失败 %s %s" % (code, body)); raise SystemExit(1)
tid = body["data"]["task_id"]; st = "?"
for _ in range(60):
    st = (call("GET", "/api/v1/scan-tasks/" + tid)[1].get("data") or {}).get("status")
    if st in ("success", "failed", "error"): break
    time.sleep(0.5)
code, body = call("GET", "/api/v1/media?per_page=50")
items = (body.get("data") or {}).get("list") or []
if st != "success" or not items:
    print("扫描 %s，媒体 %d 条" % (st, len(items))); raise SystemExit(1)
su = (call("GET", "/api/v1/media/" + items[0]["id"])[1].get("data") or {}).get("stream_url")
code, raw = call("GET", su, raw=True, hdrs={"Range": "bytes=0-1023"})
if code not in (200, 206) or not raw:
    print("流式读取失败 %s / %d 字节" % (code, len(raw))); raise SystemExit(1)
print("setup=%s login=%s 建库=201 扫描=%s 媒体=%d 流式=%s/%d字节" % (c1, c2, st, len(items), code, len(raw)))
PYAPI
)"
    if [ $? = 0 ]; then
      ok "Linux 上的 API 全链路：$api_out"
    else
      bad "Linux 上的 API 全链路失败：$api_out"
    fi
  elif [ "$WANT_API" = "1" ]; then
    note "没有 ffmpeg（宿主）就没造测试视频，跳过 --api 检查"
  fi
done

printf '\n== 结论：%d 项通过，%d 项失败\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] || { printf '上面每条 ✗ 都要先修（发布件在真 Linux 上出问题，用户那边就是"装完起不来"）\n' >&2; exit 1; }
printf '发布件在真 Linux（容器）上验证通过。\n'
