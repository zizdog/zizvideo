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
#    bash tools/verify-deploy.sh --no-service           # 容器/无 init 系统：跳过服务状态那一条
#  退出码：0 = 关键项全过；1 = 有 ✗；2 = 参数/环境问题
# ============================================================================
set -uo pipefail

CONFIG=""
BIN=""
PORT=""
NO_SERVICE=0
AS_DAEMON=0
OS="$(uname -s)"
# 容器里没有 launchd/systemd：不显式给 --no-service 时也自动跳过（否则会误报一条 ✗）
if [ -f /.dockerenv ] || grep -qa 'docker\|containerd\|kubepods' /proc/1/cgroup 2>/dev/null; then
  NO_SERVICE=1
fi

usage() { sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
  case "$1" in
    --config) CONFIG="$2"; shift 2 ;;
    --bin) BIN="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --no-service) NO_SERVICE=1; shift ;;   # 容器/无 init 系统的环境（或不想管服务状态时）
    --as-daemon) AS_DAEMON=1; shift ;;     # 在**守护进程自己的上下文**里探媒体根（macOS 需 sudo）
    --help|-h) usage; exit 0 ;;
    *) echo "!! 未知参数：$1（--help 看用法）" >&2; exit 2 ;;
  esac
done

READYZ_BODY="$(mktemp -t zv-readyz.XXXXXX)"
trap 'rm -f "$READYZ_BODY"' EXIT

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
if [ "$NO_SERVICE" = "1" ]; then
  note "跳过服务状态检查（容器/--no-service：这里没有 launchd/systemd，进程由容器负责）"
elif [ "$OS" = "Darwin" ]; then
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
  # ⚠️ 必须取**状态码**：`curl -f` 会把 503（服务在跑、自检没过）和"根本没响应"混成一回事
  rcode="$(curl -s -o "$READYZ_BODY" -w '%{http_code}' --max-time 5 "$url" 2>/dev/null || echo 000)"
  body="$(cat "$READYZ_BODY" 2>/dev/null || true)"
  if [ "$rcode" = "000" ] || [ -z "$body" ]; then
    bad "$url 没有响应（服务没起来 / 端口不对 / 只绑了别的地址）"
  elif [ "$rcode" = "200" ]; then
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
    # 503 不是"服务坏了" —— 是"服务在跑，但自检没过"。逐条把没过的原因翻成人话，
    # 否则用户会去重启服务（方向错），实际要做的往往是"挂盘 / 建目录 / 装 ffmpeg"。
    bad "$url 回 $rcode —— **服务在跑，但自检没过**（不是服务没起来）"
    printf '%s' "$body" | python3 -c 'import json,sys
try:
    d = json.load(sys.stdin)
except Exception:
    print("  · （响应不是 JSON，原始内容前 200 字）"); raise SystemExit
data = d.get("data") or {}
checks = data.get("checks") or {}
hints = {
    "media_roots": "媒体根读不到：**目录不存在（挂盘了吗？）或权限不够** —— 用 `zizvideo check-access <目录>` 复核",
    "ffmpeg": "找不到 ffmpeg/ffprobe：装上（macOS: brew install ffmpeg；Debian/飞牛: apt install ffmpeg）",
    "db": "数据库打不开：数据目录不可写、或库文件损坏（看数据目录里的 pre-upgrade 备份）",
    "disk": "磁盘空间不足：清理数据目录或扩容",
}
shown = 0
for k, v in checks.items():
    bad_it = False
    if isinstance(v, dict) and "ok" in v:
        bad_it = not (v.get("ok") or v.get("ready"))
    elif isinstance(v, dict):
        bad_it = any(str(st) != "ok" for st in v.values())
    if not bad_it:
        continue
    shown += 1
    print("  · 没过的一项：%s → %s" % (k, hints.get(k, "看 /readyz 的原始输出")))
    if isinstance(v, dict) and "ok" not in v:
        for sub, st in v.items():
            if str(st) != "ok":
                print("       %s：%s" % (sub, st))
if not shown:
    print("  · 响应里没标出具体哪项没过（老版本？）原始内容前 200 字：%s" % str(data)[:200])' 2>/dev/null || true
  fi
else
  note "配置里没有 listen，跳过健康检查（可用 --port 指定）"
fi

# ---------------------------------------------------------------------------
hdr "媒体目录可读性（扫描能不能看到你的视频）"
# 在守护进程上下文里探一个路径（macOS）：写一个**一次性** launchd 作业让 launchd 直接执行
# `zizvideo check-access <路径>`，读它写出的那行 JSON，然后 bootout + 删 plist。
# 为什么必须绕这一下：TCC 把访问权归给**发起进程** —— 我们在用户的终端里跑，终端可能已授权（或根本没有），
# 用它读测出来的**不是守护进程的权限**。
# 需要 sudo（要写 /Library/LaunchDaemons 并 bootstrap 系统域）；拿不到就**如实拒绝**，不猜。
probe_in_daemon_context() { # $1 = 路径；回显一行 JSON（失败回显空）
  root="$1"
  command -v launchctl >/dev/null 2>&1 || return 1
  if [ "${ZV_FAKE_SUDO:-}" != "1" ] && ! sudo -n true 2>/dev/null; then
    return 2   # 需要密码/没有 sudo：交由调用方如实告知
  fi
  SUDO="sudo"
  [ "${ZV_FAKE_SUDO:-}" = "1" ] && SUDO="${ZV_FAKE_SUDO_BIN:-sudo}"
  LC_BIN="${ZV_FAKE_LAUNCHCTL:-launchctl}"
  label="com.zizvideo.accessprobe.$$"
  daemon_dir="$(dirname "${ZV_SYSTEM_DAEMON_DIR:-/Library/LaunchDaemons}/x")"
  tmp="$(mktemp)"
  plist="$daemon_dir/${label}.plist"
  cat >"$tmp.plist" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array>
    <string>${BIN}</string><string>check-access</string><string>${root}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${tmp}</string>
  <key>StandardErrorPath</key><string>${tmp}</string>
</dict></plist>
PLISTEOF
  if [ "$SUDO" = "sudo" ]; then
    # 复制失败 = 拿不到权限（sudo 需要密码 / 被策略拒），与"作业跑了但没产出"是两回事
    sudo cp "$tmp.plist" "$plist" 2>/dev/null || { rm -f "$tmp" "$tmp.plist"; return 2; }
    sudo "$LC_BIN" bootstrap system "$plist" >/dev/null 2>&1 || true
    sleep "${ZV_ACCESS_PROBE_WAIT:-2}"
    sudo "$LC_BIN" bootout "system/${label}" >/dev/null 2>&1 || true
    out="$(sudo cat "$tmp" 2>/dev/null | grep '^{' | head -1 || true)"
    sudo rm -f "$plist" >/dev/null 2>&1 || true
  else
    cp "$tmp.plist" "$plist" 2>/dev/null || { rm -f "$tmp" "$tmp.plist"; return 1; }
    "$LC_BIN" bootstrap system "$plist" >/dev/null 2>&1 || true
    sleep "${ZV_ACCESS_PROBE_WAIT:-2}"
    "$LC_BIN" bootout "system/${label}" >/dev/null 2>&1 || true
    out="$(cat "$tmp" 2>/dev/null | grep '^{' | head -1 || true)"
    rm -f "$plist" >/dev/null 2>&1 || true
  fi
  rm -f "$tmp" "$tmp.plist"
  printf '%s' "$out"
  [ -n "$out" ]
}

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
    if [ ! -e "$r" ]; then
      bad "目录不存在：${r} —— 挂盘了吗？**路径写错/盘没挂**都会是这样（这也算"读不到"）"
      continue
    fi
    line="$(probe_one "$r")"
    case "$line" in
      *'"readable":true'*) ok "读得到：$r" ;;
      '') bad "探测没有输出：${r}（二进制有问题？）" ;;
      *) bad "读不到：$r —— $line" ;;
    esac
  done
  if [ "$OS" = "Darwin" ] && [ "$AS_DAEMON" = "1" ]; then
    printf '\n  以**守护进程上下文**复探（一次性 launchd 作业）：\n'
    for r in "${root_arr[@]}"; do
      dline="$(probe_in_daemon_context "$r")"
      drc=$?
      case "$drc" in
        2) note "拿不到 sudo，无法在守护进程上下文里探（**这不是"读不到"**）。请自己跑一次：
           sudo bash $0 --config \"$CONFIG\" --bin \"$BIN\" --as-daemon" ;;
      esac
      case "$dline" in
        *'"readable":true'*) ok "守护进程读得到：$r" ;;
        '') [ "$drc" = "2" ] || bad "守护进程上下文没有产出结果：${r}（看 /var/log 或重跑）" ;;
        *) bad "守护进程读不到：${r} —— ${dline}（去「系统设置 → 隐私与安全性 → 完全磁盘访问」把 ${BIN} 加进去）" ;;
      esac
    done
  elif [ "$OS" = "Darwin" ]; then
    note "以上是**当前身份**的探测结果；守护进程的身份未必相同 —— 要**可信**答案就加 --as-daemon（macOS 需 sudo，会写一次性 launchd 作业）"
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
