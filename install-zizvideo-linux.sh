#!/usr/bin/env bash
# ============================================================================
#  install-zizvideo-linux.sh —— Linux 独立部署（systemd），不依赖 ZizPanel
#
#  为什么单独一份：macOS 那份是 LaunchDaemon + 钥匙串 + TCC，整套都不通用。
#  Linux 侧要做的是另一件事：静态二进制 + systemd 单元 + 一个专用系统用户。
#  zizvideo 是纯 Go + 内嵌前端 + SQLite，CGO_ENABLED=0 的静态二进制直接可跑
#  （`make check` 里有 linux/amd64 + linux/arm64 的交叉编译门禁）。
#
#  产物来源：镜像 `apps/zizvideo/linux.json`（**平台专属清单**，不塞进面板契约的 manifest.json ——
#  那份只认 darwin，同 arch 塞两个平台会让面板装错平台）。
#
#  用法：
#    sudo bash install-zizvideo-linux.sh [--listen host:port] [--dry-run]
#    sudo bash install-zizvideo-linux.sh --upgrade
#    sudo bash install-zizvideo-linux.sh --uninstall | --purge --yes
#    bash install-zizvideo-linux.sh --help | --script-version
#
#  布局：
#    /opt/zizvideo/zizvideo              二进制（root:root 0755）
#    /etc/zizvideo/config.json           配置（不存在才创建，绝不覆盖现有配置）
#    /var/lib/zizvideo                   数据（数据库/封面/收件箱；属主 zizvideo）
#    /etc/systemd/system/zizvideo.service
#
#  测试口（仅沙箱用，生产一律不要设）：ZV_INSTALL_PREFIX / ZV_SYSTEMD_DIR / ZV_DATA_ROOT /
#    ZV_CONF_DIR / ZV_FAKE_SYSTEMCTL / ZV_FAKE_USERADD / ZV_FAKE_ID / ZV_LIB_ONLY /
#    ZV_ALLOW_ANY_OS（沙箱里在非 Linux 上跑逻辑用）/ ZV_ALLOW_NONROOT
# ============================================================================
set -euo pipefail

SCRIPT_VERSION="1.0.0"
DEFAULT_MIRROR="https://mirror.zizdog.com:8888"
SERVICE_NAME="zizvideo"
SERVICE_USER="zizvideo"

MIRROR="${ZV_MIRROR:-$DEFAULT_MIRROR}"
INSTALL_PREFIX="${ZV_INSTALL_PREFIX:-/opt/zizvideo}"
SYSTEMD_DIR="${ZV_SYSTEMD_DIR:-/etc/systemd/system}"
DATA_ROOT="${ZV_DATA_ROOT:-/var/lib/zizvideo}"
CONF_DIR="${ZV_CONF_DIR:-/etc/zizvideo}"
LISTEN="127.0.0.1:7766"
ACTION="install"
DRY_RUN=0
ASSUME_YES=0
PIN_VERSION=""

say()  { printf '%s\n' "$*"; }
warn() { printf '!! %s\n' "$*" >&2; }
die()  { printf '!! %s\n' "$*" >&2; exit 1; }
info() { printf '==> %s\n' "$*"; }

usage() {
  sed -n '2,26p' "$0" | sed 's/^# \{0,1\}//'
}

# ---------------------------------------------------------------------------
#  参数
# ---------------------------------------------------------------------------
while [ $# -gt 0 ]; do
  case "$1" in
    --listen) LISTEN="$2"; shift 2 ;;
    --mirror) MIRROR="${2%/}"; shift 2 ;;
    --version) PIN_VERSION="$2"; shift 2 ;;
    --upgrade) ACTION="upgrade"; shift ;;
    --uninstall) ACTION="uninstall"; shift ;;
    --purge) ACTION="purge"; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    --script-version) printf '%s\n' "$SCRIPT_VERSION"; exit 0 ;;
    --help|-h) usage; exit 0 ;;
    *) die "未知参数：$1（--help 看用法）" ;;
  esac
done

BIN="$INSTALL_PREFIX/zizvideo"
CONFIG="$CONF_DIR/config.json"
UNIT="$SYSTEMD_DIR/${SERVICE_NAME}.service"
DB="$DATA_ROOT/zizvideo.db"
case "$(uname -m)" in
  x86_64|amd64) ARCH="amd64" ;;
  aarch64|arm64) ARCH="arm64" ;;
  *) die "不认识的 CPU 架构：$(uname -m)（只提供 amd64/arm64）" ;;
esac

# systemctl/useradd 包装（沙箱用 ZV_FAKE_* 顶掉，绝不碰真系统）
SYSTEMCTL_BIN="${ZV_FAKE_SYSTEMCTL:-systemctl}"
USERADD_BIN="${ZV_FAKE_USERADD:-useradd}"
ID_BIN="${ZV_FAKE_ID:-id}"
sysctl_run() { "$SYSTEMCTL_BIN" "$@"; }

# ---------------------------------------------------------------------------
#  前置检查
# ---------------------------------------------------------------------------
require_linux_root() {
  # ZV_ALLOW_ANY_OS=1 是**沙箱测试口**（让门禁能在 macOS 的开发机上跑通逻辑，见 tools/test-installer.sh）；
  # 生产环境绝不要设 —— 真在 macOS 上跑会把 Linux 二进制装进 /opt。
  if [ "${ZV_ALLOW_ANY_OS:-}" != "1" ] && [ "$(uname -s)" != "Linux" ]; then
    die "这是 Linux 安装器（当前系统：$(uname -s)）。macOS 请用 install-zizvideo.sh"
  fi
  if [ "$(uname -s)" = "Linux" ] && [ "${ZV_ALLOW_NONROOT:-}" != "1" ] && [ "$(id -u)" != "0" ]; then
    die "需要 root（要写 ${INSTALL_PREFIX}、$SYSTEMD_DIR 并启 systemd 服务）：请用 sudo 重跑"
  fi
  command -v curl >/dev/null 2>&1 || die "缺 curl"
  command -v python3 >/dev/null 2>&1 || die "缺 python3（解析清单/写配置要它）"
  if [ "$ACTION" != "uninstall" ] && [ "$ACTION" != "purge" ]; then
    [ -d "$SYSTEMD_DIR" ] || warn "$SYSTEMD_DIR 不存在？这台机器可能不是 systemd 系统"
  fi
}

# 取 linux.json 并挑出本架构的那条：回显 "name sha256 size"
fetch_asset() {
  local manifest mfile
  manifest="$(curl -fsS --max-time 30 "$MIRROR/apps/zizvideo/linux.json" 2>/dev/null)" \
    || die "拉不到 $MIRROR/apps/zizvideo/linux.json（镜像上还没有 Linux 产物？先 make release && make publish）"
  # ⚠️ 必须落成文件再交给 python：`printf | python3 - <<'PY'` 里**heredoc 会抢走 stdin**，
  # python 读到的就是空（实测报 "Expecting value: line 1 column 1"），清单永远解析不出来。
  mfile="$(mktemp -t zizvideo-linuxjson.XXXXXX)"
  printf '%s' "$manifest" >"$mfile"
  python3 - "$mfile" "$ARCH" "$PIN_VERSION" <<'PYEOF'
import json, sys
path, arch, pin = sys.argv[1], sys.argv[2], sys.argv[3]
try:
    with open(path) as handle:
        data = json.load(handle)
except Exception as exc:
    raise SystemExit("!! linux.json 不是合法 JSON：%s" % exc)
latest = data.get("latest") or ""
if not latest:
    raise SystemExit("!! linux.json 里 latest 是空的（拒绝装一个无法确认版本的包）")
if pin and pin != latest:
    raise SystemExit("!! 镜像上 latest=%s，而你要求 %s（版本已翻页，别装旧包）" % (latest, pin))
for row in data.get("assets") or []:
    if row.get("arch") != arch:
        continue
    name, sha, size = row.get("name"), str(row.get("sha256") or ""), int(row.get("size") or 0)
    if len(sha) != 64 or size <= 0:
        raise SystemExit("!! linux.json 里 %s 的 sha256/size 不合法（拒绝装无法校验的包）" % name)
    print("%s %s %d %s" % (name, sha, size, latest))
    break
else:
    raise SystemExit("!! linux.json 里没有 %s 架构的产物" % arch)
PYEOF
  rm -f "$mfile"
}

# 下载 + **逐字节校验 sha256**（校验不过一律不装）
download_binary() { # $1=name $2=sha256 $3=目标
  local name="$1" want="$2" dst="$3" tmp
  tmp="$(mktemp -t zizvideo-dl.XXXXXX)"
  info "下载 $name"
  curl -fsS --max-time 300 "$MIRROR/apps/zizvideo/${LATEST_VERSION:-$PIN_VERSION}/$name" -o "$tmp" \
    || { rm -f "$tmp"; die "下载失败：$MIRROR/apps/zizvideo/…/$name"; }
  local got
  got="$(sha256sum "$tmp" | awk '{print $1}')"
  if [ "$got" != "$want" ]; then
    rm -f "$tmp"
    die "sha256 不符：拿到 ${got:0:16}…，清单是 ${want:0:16}…（拒绝安装无法校验的包）"
  fi
  info "sha256 校验通过：${got:0:16}…"
  if [ "$DRY_RUN" = "1" ]; then rm -f "$tmp"; return 0; fi
  install -m 0755 "$tmp" "$dst"
  rm -f "$tmp"
}

ensure_service_user() {
  if "$ID_BIN" -u "$SERVICE_USER" >/dev/null 2>&1; then return 0; fi
  info "创建系统用户 ${SERVICE_USER}（无家目录、不可登录）"
  if [ "$DRY_RUN" = "1" ]; then return 0; fi
  "$USERADD_BIN" --system --no-create-home --home-dir "$DATA_ROOT" \
    --shell /usr/sbin/nologin "$SERVICE_USER" >/dev/null 2>&1 \
    || warn "建用户失败（已存在或系统策略不同）；服务将按 User=$SERVICE_USER 启动，请自行确认该用户存在"
}

write_config_if_missing() {
  [ -f "$CONFIG" ] && { say "  配置已存在，保持不动：$CONFIG"; return 0; }
  info "写配置：${CONFIG}（listen=${LISTEN}，数据目录 ${DATA_ROOT}）"
  [ "$DRY_RUN" = "1" ] && return 0
  mkdir -p "$CONF_DIR"
  python3 - "$CONFIG" "$LISTEN" "$DATA_ROOT" <<'PYEOF'
import json, os, sys
path, listen, data = sys.argv[1], sys.argv[2], sys.argv[3]
cfg = {
    "listen": listen,
    "data_dir": data,
    "database_path": os.path.join(data, "zizvideo.db"),
    "media_allow_roots": [os.path.expanduser("~/Movies")],
    "allow_register": False,
    "scan_workers": 2,
}
tmp = path + ".tmp"
with open(tmp, "w") as handle:
    json.dump(cfg, handle, ensure_ascii=False, indent=2)
    handle.write("\n")
os.replace(tmp, path)
PYEOF
  chmod 0644 "$CONFIG"
}

write_unit() {
  info "写 systemd 单元：$UNIT"
  [ "$DRY_RUN" = "1" ] && return 0
  mkdir -p "$SYSTEMD_DIR" "$DATA_ROOT"
  cat >"$UNIT.zv-tmp.$$" <<UNITEOF
[Unit]
Description=zizvideo（自托管短视频/短剧）
Documentation=https://github.com/zizdog/zizvideo
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${SERVICE_USER}
Group=${SERVICE_USER}
WorkingDirectory=${DATA_ROOT}
ExecStart=${BIN} --config ${CONFIG}
Restart=always
RestartSec=3
# 日志走 journald：journalctl -u ${SERVICE_NAME} -f
StandardOutput=journal
StandardError=journal
# 收紧权限：只允许写自己的数据目录（Linux 没有 macOS TCC 那套，靠 systemd 沙箱）
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=full
ProtectHome=read-only
ReadWritePaths=${DATA_ROOT}
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
UNITEOF
  mv -f "$UNIT.zv-tmp.$$" "$UNIT"
  chmod 0644 "$UNIT"
}

start_and_accept() {
  info "启动服务并验收（/readyz 必须回 200）"
  [ "$DRY_RUN" = "1" ] && { say "  （dry-run：跳过）"; return 0; }
  sysctl_run daemon-reload >/dev/null 2>&1 || true
  sysctl_run enable --now "$SERVICE_NAME" >/dev/null 2>&1 || warn "enable --now 失败，请手动：systemctl enable --now $SERVICE_NAME"
  local port host url i=0
  host="${LISTEN%:*}"; port="${LISTEN##*:}"
  case "$host" in ""|"0.0.0.0"|"::"|"[::]") host="127.0.0.1" ;; esac
  url="http://$host:$port/readyz"
  while [ "$i" -lt 60 ]; do
    if curl -fsS --max-time 3 "$url" >/dev/null 2>&1; then
      say "  ✓ 验收通过：$url 回 200"
      return 0
    fi
    sleep 0.5; i=$((i + 1))
  done
  warn "验收未通过：$url 60 次都没回 200 —— 看 journalctl -u $SERVICE_NAME -n 50"
  "$SYSTEMCTL_BIN" status "$SERVICE_NAME" --no-pager 2>&1 | tail -5 || true
  return 1
}

do_install_or_upgrade() {
  require_linux_root
  info "安装 zizvideo（Linux/${ARCH}，${MIRROR}）"
  read -r NAME SHA SIZE LATEST_VERSION <<EOF
$(fetch_asset)
EOF
  [ -n "${NAME:-}" ] || die "清单里没有可用产物"
  say "  版本 ${LATEST_VERSION}，产物 ${NAME}（$SIZE 字节）"
  if [ "$ACTION" = "upgrade" ] && [ ! -x "$BIN" ]; then
    die "--upgrade 但 $BIN 不存在；先跑一次安装"
  fi
  mkdir -p "$INSTALL_PREFIX"
  local backup=""
  if [ -x "$BIN" ] && [ "$DRY_RUN" != "1" ]; then
    backup="$BIN.zv-backup.$$"; cp -p "$BIN" "$backup"
  fi
  download_binary "$NAME" "$SHA" "$BIN" || { [ -n "$backup" ] && mv -f "$backup" "$BIN"; die "安装失败，已还原旧二进制"; }
  ensure_service_user
  write_config_if_missing
  write_unit
  # ⚠️ 验收失败**必须**算失败（老写法 `if ! start_and_accept && [ -n "$backup" ]` 在
  # 首次安装（没有旧二进制可回滚）时把失败吞掉，然后照样打印"安装完成" —— 谎报成功）。
  if ! start_and_accept; then
    if [ -n "$backup" ]; then
      warn "启动/验收失败，回滚到旧二进制并重启"
      mv -f "$backup" "$BIN"
      sysctl_run restart "$SERVICE_NAME" >/dev/null 2>&1 || true
      die "本次升级未成功（已回滚到旧二进制）"
    fi
    die "服务没能通过 /readyz 验收：安装不算成功（二进制留在 ${BIN}，日志见 journalctl -u ${SERVICE_NAME}）"
  fi
  [ -n "$backup" ] && rm -f "$backup"
  say ""
  say "安装完成：${BIN}（版本 ${LATEST_VERSION}）"
  say "  配置：${CONFIG}（改完 systemctl restart ${SERVICE_NAME}）"
  say "  数据：$DATA_ROOT        日志：journalctl -u $SERVICE_NAME -f"
  say "  访问：http://$( [ "${LISTEN%%:*}" = "0.0.0.0" ] && hostname -I 2>/dev/null | awk '{print $1}' || printf '%s' "${LISTEN%%:*}" ):${LISTEN##*:}/"
}

do_uninstall() {
  require_linux_root
  info "停用并卸载服务（数据保留）"
  [ "$DRY_RUN" = "1" ] || {
    sysctl_run disable --now "$SERVICE_NAME" >/dev/null 2>&1 || true
    rm -f "$UNIT"
    sysctl_run daemon-reload >/dev/null 2>&1 || true
    rm -f "$BIN"
  }
  say "已卸载。数据仍在 ${DATA_ROOT}（要连数据一起删：--purge --yes）"
}

do_purge() {
  require_linux_root
  if [ "$ASSUME_YES" != "1" ]; then
    die "--purge 会**不可恢复地**删掉 ${DATA_ROOT}（数据库/封面/收件箱）。确认请加 --yes"
  fi
  do_uninstall
  info "删除数据目录：$DATA_ROOT"
  [ "$DRY_RUN" = "1" ] || rm -rf "${DATA_ROOT:?}"
  if [ "$DRY_RUN" != "1" ] && [ -e "$DATA_ROOT" ]; then
    die "删不干净：$DATA_ROOT 仍存在（不谎报成功）"
  fi
  say "已删除数据目录（回读确认：不存在）"
}

# 测试接缝：source 本脚本 + ZV_LIB_ONLY=1 时只定义函数、不跑 main
if [ "${ZV_LIB_ONLY:-0}" = "1" ]; then
  return 0 2>/dev/null || exit 0
fi

case "$ACTION" in
  install|upgrade) do_install_or_upgrade ;;
  uninstall) do_uninstall ;;
  purge) do_purge ;;
  *) die "未知动作：$ACTION" ;;
esac
