#!/usr/bin/env bash
# ============================================================================
#  verify-deploy.sh —— 在**目标机器上**给一次部署做体检（macOS 独立部署 / Linux systemd 都支持）
#
#  为什么要有它：独立部署的最后一步只能在真机上做（TCC 授权、外挂盘权限、服务身份能否读到媒体），
#  而"看起来装上了"和"真能用"差得远。这个脚本把该验的东西一条条真跑一遍，并**如实**说哪条没过，
#  以及哪条它测不了（比如在调用者身份下测媒体可读性 ≠ 守护进程身份）。
#
#  用法：
#    bash tools/verify-deploy.sh                       # 自动找默认路径
#    bash tools/verify-deploy.sh --config /etc/zizvideo/config.json --bin /opt/zizvideo/zizvideo
#    bash tools/verify-deploy.sh --port 7766           # 只检查健康端点用哪个端口
#  退出码：0 = 关键项全过；1 = 有 ✗；2 = 参数/环境问题
# ============================================================================
set -uo pipefail

CONFIG=""
BIN=""
PORT=""
OS="$(uname -s)"

usage() { sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
  case "$1" in
    --config) CONFIG="$2"; shift 2 ;;
    --bin) BIN="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) echo "!! 未知参数：$1（--help 看用法）" >&2; exit 2 ;;
  esac
done

PASS=0; FAIL=0; NOTE=0
ok()   { PASS=$((PASS + 1)); printf '  ✓ %s\n' "$*"; }
bad()  { FAIL=$((FAIL + 1)); printf '  ✗ %s\n' "$*"; }
note() { NOTE=$((NOTE + 1)); printf '  · %s\n' "$*"; }
hdr()  { printf '\n== %s\n' "$*"; }

# 默认路径（与两份安装器一致）
if [ "$OS" = "Darwin" ]; then
  [ -n "$BIN" ] || BIN="$HOME/.local/bin/zizvideo"
  [ -n "$CONFIG" ] || CONFIG="$HOME/Library/Application Support/zizvideo/config.json"
  SERVICE_LABEL="com.zizvideo.server"
else
  [ -n "$BIN" ] || BIN="/opt/zizvideo/zizvideo"
  [ -n "$CONFIG" ] || CONFIG="/etc/zizvideo/config.json"
  SERVICE_NAME="zizvideo"
fi

hdr "环境"
printf '  系统：%s %s（%s）\n' "$OS" "$(uname -r)" "$(uname -m)"

# ---------------------------------------------------------------------------
hdr "二进制"
if [ ! -x "$BIN" ]; then
  bad "找不到可执行文件：${BIN}（用 --bin 指定）"
else
  ok "可执行：${BIN}（$(wc -c <"$BIN" | tr -d ' ') 字节）"
  ver="$("$BIN" --version 2>&1 | head -1)"
  case "$ver" in
    *"zizvideo "*) ok "--version：$ver" ;;
    *) bad "--version 输出异常：$ver" ;;
  esac
  if [ "$OS" = "Linux" ]; then
    # 静态编译：极简 NAS 上没有 ld.so/glibc 也能跑（动态的话会报 "not found" 而不是权限错）
    elf="$(python3 - "$BIN" <<'PYEOF' 2>/dev/null || echo "python3-missing"
import struct, sys
data = open(sys.argv[1], "rb").read()
if data[:4] != b"\x7fELF": print("不是 ELF"); raise SystemExit
e_phoff = struct.unpack("<Q", data[32:40])[0]
e_phentsize = struct.unpack("<H", data[54:56])[0]
e_phnum = struct.unpack("<H", data[56:58])[0]
ptypes = [struct.unpack("<I", data[e_phoff + i*e_phentsize:][:4])[0] for i in range(e_phnum)]
print("动态（需要 ld.so）" if 3 in ptypes else "静态")
PYEOF
)"
    case "$elf" in
      静态) ok "静态编译（不依赖目标机的 ld.so/glibc）" ;;
      动态*) note "二进制是动态链接的：极简 NAS 上可能缺 ld.so（${elf}）" ;;
      *) note "没法判定是否静态：$elf" ;;
    esac
  else
    if command -v codesign >/dev/null 2>&1; then
      sig="$(codesign -dv --verbose=2 "$BIN" 2>&1 | awk -F= '/^Authority=/{print $2; exit}')"
      if [ -n "$sig" ]; then ok "签名身份：${sig}（有稳定签名，TCC 授权才能跨升级保留）"; else note "未签名部署：每次升级都要重新授权完全磁盘访问"; fi
    fi
  fi
fi

# ---------------------------------------------------------------------------
hdr "配置"
if [ ! -f "$CONFIG" ]; then
  bad "找不到配置：$CONFIG"
else
  read -r listen data_dir db_path roots <<EOF
$(python3 - "$CONFIG" <<'PYEOF' 2>/dev/null || echo "? ? ? ?"
import json, sys
cfg = json.load(open(sys.argv[1]))
roots = ",".join(cfg.get("media_allow_roots") or [])
print(cfg.get("listen") or "?", cfg.get("data_dir") or "?", cfg.get("database_path") or "?", roots or "?")
PYEOF
)
EOF
  ok "配置可解析：$CONFIG"
  [ -n "${listen:-}" ] && [ "$listen" != "?" ] && ok "listen=$listen" || bad "配置里读不到 listen"
  [ -n "$PORT" ] || PORT="${listen##*:}"
  if [ -d "${data_dir:-}" ] && [ -w "${data_dir:-}" ]; then
    ok "数据目录存在且可写：$data_dir"
  elif [ -d "${data_dir:-}" ]; then
    note "数据目录存在但当前用户不可写（守护进程身份可能可以）：$data_dir"
  else
    bad "数据目录不存在：$data_dir"
  fi
  case "${db_path:-}" in
    "${data_dir%/}"/*) ok "数据库在数据目录内（备份/卸载不会漏掉它）" ;;
    "?") : ;;
    *) note "数据库不在数据目录内：$db_path —— 备份/卸载只会处理 ${data_dir}（zizvideo 启动时也会警告这一条）" ;;
  esac
  if [ "${roots:-}" = "?" ] || [ -z "${roots:-}" ]; then
    bad "media_allow_roots 是空的：没有允许根就建不了媒体库"
  else
    ok "媒体允许根：$roots"
  fi
  df -h "${data_dir:-/}" 2>/dev/null | awk 'NR==2{printf "  · 数据所在卷剩余 %s（已用 %s）\n", $4, $5}'
fi

# ---------------------------------------------------------------------------
hdr "服务与健康"
if [ "$OS" = "Darwin" ]; then
  if launchctl print "system/$SERVICE_LABEL" >/dev/null 2>&1; then
    st="$(launchctl print "system/$SERVICE_LABEL" 2>/dev/null | awk -F' = ' '/state =/{print $2; exit}')"
    [ "$st" = "running" ] && ok "LaunchDaemon $SERVICE_LABEL 在 running" || bad "LaunchDaemon $SERVICE_LABEL 状态是 ${st}（不是 running）"
  else
    if launchctl print "gui/$(id -u)/$SERVICE_LABEL" >/dev/null 2>&1; then
      ok "LaunchAgent $SERVICE_LABEL 已加载（--user 模式）"
    else
      bad "launchd 里没有 ${SERVICE_LABEL}（既不是系统域也不是用户域）"
    fi
  fi
else
  if command -v systemctl >/dev/null 2>&1; then
    act="$(systemctl is-active "$SERVICE_NAME" 2>/dev/null)"
    [ "$act" = "active" ] && ok "systemd $SERVICE_NAME 是 active" || bad "systemd $SERVICE_NAME 状态：$act"
    note "日志：journalctl -u $SERVICE_NAME -n 50"
  else
    note "这台机器没有 systemctl（不是 systemd 系统？）"
  fi
fi
if [ -n "${PORT:-}" ]; then
  url="http://127.0.0.1:$PORT/readyz"
  body="$(curl -fsS --max-time 5 "$url" 2>/dev/null)"
  if [ -n "$body" ]; then
    ok "$url 回 200"
    printf '%s' "$body" | python3 -c 'import json,sys
try:
    d = json.load(sys.stdin)
except Exception:
    print("  · /readyz 不是 JSON（老版本？）"); raise SystemExit
data = d.get("data") or {}
checks = data.get("checks") or {}
print("  · readyz.status = %s" % data.get("status"))
for k, v in checks.items():
    if isinstance(v, list):
        print("    · %s（%d 项）" % (k, len(v)))
        continue
    if not isinstance(v, dict):
        print("    · %s = %s" % (k, v))
        continue
    if "ok" not in v:
        # 形如 {"<路径>": "ok"} 的映射（media_roots 就是这样），逐项如实标注
        for sub, st in v.items():
            mark = "✓" if str(st) == "ok" else "✗"
            print("    %s %s：%s" % (mark, sub, st))
        continue
    flag = "✓" if (v.get("ok") or v.get("ready")) else "✗"
    detail = str(v.get("note") or v.get("detail") or v.get("error") or v.get("reason") or "")
    print("    %s %s %s" % (flag, k, detail[:70]))' 2>/dev/null || true
  else
    bad "$url 没回 200（服务没起来 / 端口不对 / 只绑了别的地址）"
  fi
else
  note "配置里没有 listen，跳过健康检查（可用 --port 指定）"
fi

# ---------------------------------------------------------------------------
hdr "媒体目录可读性（扫描能不能看到你的视频）"
probe_one() { # $1 = 路径；回显 "readable reason"
  if [ "$OS" = "Linux" ] && [ "$(id -u)" = "0" ] && id -u zizvideo >/dev/null 2>&1; then
    # 以**服务身份**探（最接近真实运行时；不是在 root 身份下自欺欺人）
    sudo -n -u zizvideo "$BIN" check-access "$1" 2>/dev/null | head -1
  else
    "$BIN" check-access "$1" 2>/dev/null | head -1
  fi
}
if [ -x "$BIN" ] && [ -n "${roots:-}" ] && [ "${roots:-}" != "?" ]; then
  IFS=',' read -r -a root_arr <<<"$roots"
  for r in "${root_arr[@]}"; do
    line="$(probe_one "$r")"
    case "$line" in
      *'"readable":true'*) ok "读得到：$r" ;;
      '') bad "探测没有输出：${r}（二进制有问题？）" ;;
      *) bad "读不到：$r —— $line" ;;
    esac
  done
  if [ "$OS" = "Darwin" ]; then
    note "以上是**当前身份**的探测结果；守护进程的身份未必相同（安装器的权限阶段会在守护进程上下文里再探一次）"
    fda="$("$BIN" check-access --fda 2>/dev/null | head -1)"
    case "$fda" in
      *'"readable":true'*) note "完全磁盘访问探测：${fda}（启发式，别当判决）" ;;
      *) note "完全磁盘访问探测：$fda" ;;
    esac
  fi
else
  note "跳过：拿不到二进制或媒体允许根"
fi

# ---------------------------------------------------------------------------
printf '\n== 结论：%d 项通过，%d 项失败，%d 条提醒\n' "$PASS" "$FAIL" "$NOTE"
if [ "$FAIL" -gt 0 ]; then
  printf '有 ✗ 项：先按上面每条括号里的提示处理，再重跑本脚本。\n' >&2
  exit 1
fi
printf '关键项全过。\n'
exit 0
