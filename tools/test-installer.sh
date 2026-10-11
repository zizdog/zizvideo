#!/usr/bin/env bash
# ============================================================================
#  tools/test-installer.sh —— platform/macos/install-zizvideo.sh 的回归门禁（make check-run 里跑）。
#
#  为什么要有它：独立部署安装器原来被 make check **零覆盖** —— 四个 P0/P1 问题
#  （--purge 裸 rm -rf、无条件导入系统信任根、BSD sed 静默不生效、回滚不原子）都是
#  "改一行就复活、跑一万次单测也抓不到"的那类。这里只跑**沙箱**能跑的部分：
#    ① bash -n 语法
#    ② --purge 删除前守门：危险 data_dir 必须被拒、合法 data_dir 才打印计划、真删后回读
#    ③ 配置写入：缺 "listen" 键要真插进去、已有键要真改掉（老实现用 GNU 独有 sed 地址撒谎）
#    ④ 回滚：绝不失败 + 末尾重新 bootstrap 恢复的 plist（否则失败的 --upgrade 把老用户丢在"服务停着"）
#    ⑤ 证书指纹硬编码：来路不明的 crt 必须被拒；内置指纹要与真实发布证书一致
#
#  🚨 全程不碰真机系统状态（铁律 1）：HOME / ZV_INSTALL_ROOT / ZV_SYSTEM_DAEMON_DIR /
#     ZV_TEST_KEYCHAIN 全在 mktemp -d 下，launchctl 用假可执行文件，ZV_FAKE_SUDO=1，
#     绝不调真 launchctl / sudo / security，也不真安装任何东西。
# ============================================================================
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT="$ROOT/platform/macos/install-zizvideo.sh"
SB="$(mktemp -d -t zv-installer-test.XXXXXX)"
trap 'rm -rf "$SB"' EXIT

FAIL=0
note_skip() { printf '   · %s\n' "$*"; }

# ⚠️ 这个脚本会把 HOME 指到沙箱里（见下方 export HOME），而 Go 的模块缓存默认跟着 HOME 走
# ⇒ 交叉编译会去空缓存里找依赖、然后去联网。这里在伪造之前把**真实**缓存位置记下来，
# 交叉编译时显式传下去（判据：本机 proxy.golang.org 不可达，只有缓存能保证离线可复现）。
REAL_GOMODCACHE="$(go env GOMODCACHE 2>/dev/null || true)"
ok()  { printf '   ok：%s\n' "$*"; }
bad() { printf '   !! %s\n' "$*" >&2; FAIL=1; }

[ -f "$SCRIPT" ] || { echo "!! 找不到 $SCRIPT" >&2; exit 1; }

# ---- 沙箱环境 -------------------------------------------------------------
export HOME="$SB/home"
mkdir -p "$HOME"
export ZV_INSTALL_ROOT="$SB/local"
export ZV_SYSTEM_DAEMON_DIR="$SB/LaunchDaemons"
mkdir -p "$ZV_SYSTEM_DAEMON_DIR"
export ZV_TEST_LABEL="com.zizvideo.test"
export ZV_FAKE_SUDO=1
export ZV_TEST_KEYCHAIN="$SB/never-created.keychain"
export ZV_ASSUME_YES=1
unset ZV_LIB_ONLY ZV_ALLOW_PURGE_ROOT 2>/dev/null || true

# 假 launchctl：print 一律失败（= 没有作业在跑 / 没装），其它子命令成功并记一行日志。
LC_LOG="$SB/launchctl.log"
FAKE_LC="$SB/launchctl"
: >"$LC_LOG"
cat >"$FAKE_LC" <<EOF
#!/bin/sh
echo "\$*" >>"$LC_LOG"
[ "\$1" = "print" ] && exit 1
# 模拟"一次性探测作业"：bootstrap 时按 plist 里的 StandardOutPath 写一份 check-access 的 JSON。
# 这样安装器的权限阶段走的是**真实代码路径**（写 plist → bootstrap → 读结果 → bootout → 删 plist），
# 只是 launchd 是假的、不会真去跑二进制。
if [ "\$1" = "bootstrap" ]; then
  plist=""
  for a in "\$@"; do case "\$a" in *.plist) plist="\$a" ;; esac; done
  if [ -n "\$plist" ] && [ -f "\$plist" ]; then
    outp=\$(sed -n 's:.*<key>StandardOutPath</key>.*:\1:p' "\$plist" | head -n1)
    if [ -z "\$outp" ]; then
      outp=\$(awk '/StandardOutPath/{getline; gsub(/.*<string>|<\/string>.*/,""); print; exit}' "\$plist")
    fi
    if [ -n "\$outp" ]; then
      printf '%s\n' "\${ZV_FAKE_PROBE_JSON:-{\"path\":\"/probe\",\"readable\":true}}" >"\$outp"
    fi
  fi
fi
exit 0
EOF
chmod 0755 "$FAKE_LC"
export ZV_FAKE_LAUNCHCTL="$FAKE_LC"

# 假 open：安装器的权限阶段会调 `open -R` 与 `open x-apple.systempreferences:...`，
# 沙箱里绝不许真去开系统设置/Finder。记一行日志，末尾断言"确实被调用过"。
OPEN_LOG="$SB/open.log"
FAKE_OPEN="$SB/open"
: >"$OPEN_LOG"
cat >"$FAKE_OPEN" <<EOF
#!/bin/sh
echo "\$*" >>"$OPEN_LOG"
exit 0
EOF
chmod 0755 "$FAKE_OPEN"
export ZV_FAKE_OPEN="$FAKE_OPEN"

# sudo 垫片（铁律 1）：PATH 最前面放一个只会失败的假 sudo。真走了 sudo 这条路，
# 它立刻失败并记一行日志，末尾断言日志为空 —— 测试绝不许碰真 sudo。
SUDO_LOG="$SB/sudo.log"
SHIM="$SB/shim"
mkdir -p "$SHIM"
cat >"$SHIM/sudo" <<EOF
#!/bin/sh
echo "sudo \$*" >>"$SUDO_LOG"
exit 1
EOF
chmod 0755 "$SHIM/sudo"
PATH="$SHIM:$PATH"
export PATH

CFG_DIR="$HOME/zizvideo"
mkdir -p "$CFG_DIR"
write_cfg() { printf '{\n  "data_dir": "%s"\n}\n' "$1" >"$CFG_DIR/config.json"; }
OUT="$SB/out.txt"

# ---- ① 语法 ---------------------------------------------------------------
printf '==> 安装器语法（bash -n）\n'
if bash -n "$SCRIPT"; then ok "bash -n 通过"; else bad "bash -n 失败"; fi

# ---- ② --purge 删除前守门 -------------------------------------------------
printf '==> --purge 删除前守门（危险 data_dir 必须被拒，且拒绝发生在打印"将删除什么"之前）\n'
for t in "/tmp" "$HOME" "/" "relative/dir" "/Users" "/Volumes/ExternalDisk"; do
  write_cfg "$t"
  if bash "$SCRIPT" --purge --dry-run >"$OUT" 2>&1; then
    bad "危险 data_dir=\"$t\" 竟然没被拒：$(head -c 200 "$OUT")"
  elif grep -q "拒绝清除" "$OUT" && ! grep -q "将删除" "$OUT"; then
    ok "危险 data_dir 被拒且没打印删除计划：$t"
  else
    bad "危险 data_dir=\"$t\" 被拒但行为不对：$(head -c 200 "$OUT")"
  fi
done

printf '==> --purge 合法 data_dir（$HOME/zizvideo 之下）要放行并打印计划\n'
write_cfg "$CFG_DIR"
if bash "$SCRIPT" --purge --dry-run >"$OUT" 2>&1 && grep -q "将删除" "$OUT" && grep -qF "${CFG_DIR}（含数据库" "$OUT"; then
  ok "合法 data_dir 打印了删除计划：${CFG_DIR}"
else
  bad "合法 data_dir 没通过守门：$(head -c 300 "$OUT")"
fi

printf '==> --purge 真删 + 删后回读\n'
mkdir -p "$CFG_DIR"; : >"$CFG_DIR/zizvideo.db"
if bash "$SCRIPT" --purge >"$OUT" 2>&1 && grep -q "回读确认：不存在" "$OUT" && [ ! -e "$CFG_DIR" ]; then
  ok "已删除并在回读确认后才打印成功"
else
  bad "真删/回读不对：$(head -c 300 "$OUT")；目录还在？$( [ -e "$CFG_DIR" ] && echo 是 || echo 否 )"
fi

# ---- ③ 配置写入（listen） -------------------------------------------------
printf '==> 配置里的 listen（缺键要真插入、有键要真改掉；老实现用 GNU 独有 sed 地址，BSD sed 静默不生效）\n'
listen_case() { # $1 = 初始 config 内容；$2 = 期望的 listen
  (
    export HOME="$SB/home-listen"
    mkdir -p "$HOME/zizvideo"
    export ZV_LIB_ONLY=1
    # shellcheck disable=SC1090
    . "$SCRIPT"
    derive_paths
    printf '%b' "$1" >"$CONFIG_PATH"
    LISTEN="$2"; LISTEN_GIVEN=1
    ensure_config >/dev/null
  )
}
LCFG="$SB/home-listen/zizvideo/config.json"
if listen_case '{\n  "data_dir": "/tmp/x"\n}\n' "127.0.0.1:7799" && \
   [ "$(node -e 'const o=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(String(o.listen))' "$LCFG" 2>/dev/null)" = "127.0.0.1:7799" ]; then
  ok "配置里没有 listen 键 → 真写进去了，且仍是合法 JSON"
else
  bad "缺 listen 键时没写进去/JSON 坏了：$(cat "$LCFG" 2>/dev/null)"
fi
if listen_case '{\n  "listen": "127.0.0.1:7766",\n  "data_dir": "/tmp/x"\n}\n' "127.0.0.1:7798" && \
   [ "$(node -e 'const o=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(String(o.listen))' "$LCFG" 2>/dev/null)" = "127.0.0.1:7798" ]; then
  ok "配置里已有 listen 键 → 真被改掉了"
else
  bad "已有 listen 键没被改对：$(cat "$LCFG" 2>/dev/null)"
fi

# ---- ④ 回滚：绝不失败 + 重新 bootstrap -----------------------------------
printf '==> 回滚（失败的 --upgrade 不许把老用户丢在"服务停着"）\n'
: >"$LC_LOG"
(
  export HOME="$SB/home-rollback"
  mkdir -p "$HOME" "$ZV_SYSTEM_DAEMON_DIR"
  export ZV_LIB_ONLY=1
  # shellcheck disable=SC1090
  . "$SCRIPT"
  derive_paths                       # 默认 system 模式
  mkdir -p "$INSTALL_ROOT/bin" "$(dirname "$PLIST")"
  printf 'new\n' >"$BIN"; BIN_NEW=1
  BIN_BACKUP="$BIN.zv-backup.1"; printf 'old\n' >"$BIN_BACKUP"
  printf '<plist/>\n' >"$PLIST"; PLIST_BACKUP="$PLIST.zv-backup.1"; printf '<old/>\n' >"$PLIST_BACKUP"
  BOOTED=1
  rollback
) >"$OUT" 2>&1
if grep -q "已重新 bootstrap 系统域" "$OUT" && grep -qF "bootstrap system $ZV_SYSTEM_DAEMON_DIR/com.zizvideo.test.plist" "$LC_LOG"; then
  ok "回滚末尾重新 bootstrap 了恢复出来的 plist（launchctl 日志为证）"
else
  bad "回滚没有重新 bootstrap：$(tail -c 400 "$OUT")"
fi
if grep -q "回滚结束：文件已按上表复原；服务状态见上" "$OUT"; then
  ok "回滚收尾措辞如实（不再说「没有留下半截安装」）"
else
  bad "回滚收尾措辞不对：$(tail -c 200 "$OUT")"
fi

# ---- ⑤ 证书指纹硬编码 -----------------------------------------------------
printf '==> 证书指纹硬编码（来路不明的 crt 绝不许进系统信任根）\n'
pin_case() { # $1 = crt 路径；返回 verify_cert_pin 的退出码
  (
    export ZV_LIB_ONLY=1
    # shellcheck disable=SC1090
    . "$SCRIPT"
    verify_cert_pin "$1"
  )
}
BOGUS="$SB/bogus.crt"
if command -v openssl >/dev/null 2>&1; then
  if openssl req -x509 -newkey rsa:2048 -nodes -keyout "$SB/bogus.key" -out "$BOGUS" \
       -days 1 -subj "/CN=Not ZizPanel Release" >/dev/null 2>&1; then
    if pin_case "$BOGUS" >"$OUT" 2>&1; then
      bad "自签的假证书竟然过了指纹核对（等于没硬编码）"
    elif grep -q "证书指纹不匹配" "$OUT"; then
      ok "假证书被指纹核对拒绝"
    else
      bad "假证书被拒但原因不对：$(head -c 200 "$OUT")"
    fi
  else
    bad "openssl 造不出测试证书"
  fi
  REAL_CRT="$ROOT/.release-key/codesign/zp-codesign.crt"
  if [ -f "$REAL_CRT" ]; then
    if pin_case "$REAL_CRT" >"$OUT" 2>&1; then
      ok "内置指纹与真实发布证书（.release-key/codesign/zp-codesign.crt）一致"
    else
      bad "内置 EXPECTED_CRT_SHA256 与真实发布证书不一致：$(head -c 200 "$OUT")"
    fi
  else
    printf '   （跳过：本机没有 %s，无法核对内置指纹与发布证书是否一致）\n' "$REAL_CRT"
  fi
else
  bad "找不到 openssl（脚本里读证书指纹就靠它）"
fi

# 静态顺序断言：核指纹 + 导入信任根必须发生在写二进制之前（见 prepare_signature 的注释）。
printf '==> 静态顺序：prepare_signature（核指纹+导入信任根）在写二进制之前\n'
BODY="$(awk '/^do_install_or_upgrade\(\)/,/^}/' "$SCRIPT")"
N_PREP="$(printf '%s\n' "$BODY" | grep -n '^  prepare_signature$' | head -1 | cut -d: -f1)"
N_MV="$(printf '%s\n' "$BODY" | grep -n 'mv "\$bin_tmp" "\$BIN"' | head -1 | cut -d: -f1)"
if [ -n "$N_PREP" ] && [ -n "$N_MV" ] && [ "$N_PREP" -lt "$N_MV" ]; then
  ok "prepare_signature（第 $N_PREP 行）早于 mv 二进制（第 $N_MV 行）"
else
  bad "顺序不对或读不到：prepare_signature=${N_PREP}，mv bin=$N_MV"
fi

# ---------------------------------------------------------------------------
# Linux / systemd 安装器（platform/linux/install-zizvideo-linux.sh）：沙箱里真跑一遍
#
# 用 file:// 当"镜像"（curl 支持 file://），systemctl/useradd/id 全用假的，
# 安装前缀/单元目录/数据目录/配置目录全指到 mktemp 下 —— 绝不碰真 systemd。
printf '==> Linux 安装器（systemd）：sha256 校验 + 落盘 + 单元文件 + 不符必须拒\n'
LROOT="$SB/linux"; LMIR="$LROOT/mirror/apps/zizvideo"; LVER="9.9.9-mvp"
mkdir -p "$LMIR/$LVER" "$LROOT/bin" "$LROOT/systemd" "$LROOT/data" "$LROOT/conf"
# 两个架构都造一份：门禁要在 arm64（开发机）与 amd64（CI/x86）上都能跑
for A in amd64 arm64; do
  printf '#!/bin/sh\necho "zizvideo %s %s"\n' "$LVER" "$A" >"$LMIR/$LVER/zizvideo_${LVER}_linux_$A"
  chmod 0755 "$LMIR/$LVER/zizvideo_${LVER}_linux_$A"
done
LSHA_A=$(shasum -a 256 "$LMIR/$LVER/zizvideo_${LVER}_linux_amd64" | awk '{print $1}')
LSIZE_A=$(wc -c <"$LMIR/$LVER/zizvideo_${LVER}_linux_amd64" | tr -d ' ')
LSHA_R=$(shasum -a 256 "$LMIR/$LVER/zizvideo_${LVER}_linux_arm64" | awk '{print $1}')
LSIZE_R=$(wc -c <"$LMIR/$LVER/zizvideo_${LVER}_linux_arm64" | tr -d ' ')
cat >"$LMIR/linux.json" <<JSONEOF
{"app":"zizvideo","platform":"linux","latest":"$LVER","generated_at":"2026-01-01T00:00:00Z",
 "assets":[{"name":"zizvideo_${LVER}_linux_amd64","version":"$LVER","arch":"amd64",
            "sha256":"$LSHA_A","size":$LSIZE_A,"os":"linux"},
           {"name":"zizvideo_${LVER}_linux_arm64","version":"$LVER","arch":"arm64",
            "sha256":"$LSHA_R","size":$LSIZE_R,"os":"linux"}]}
JSONEOF
LC_SYS="$LROOT/systemctl.log"; : >"$LC_SYS"
cat >"$LROOT/systemctl" <<EOF
#!/bin/sh
echo "\$*" >>"$LC_SYS"
exit 0
EOF
chmod 0755 "$LROOT/systemctl"
printf '#!/bin/sh\nexit 0\n' >"$LROOT/useradd"; chmod 0755 "$LROOT/useradd"
printf '#!/bin/sh\n[ "\$1" = "-u" ] && exit 1\nexec /usr/bin/id "\$@"\n' >"$LROOT/id"; chmod 0755 "$LROOT/id"
LINUX_INSTALLER="$ROOT/platform/linux/install-zizvideo-linux.sh"
linux_run() { # 回显安装器输出；参数原样传给安装器
  ZV_ALLOW_ANY_OS=1 ZV_ALLOW_NONROOT=1 ZV_INSTALL_PREFIX="$LROOT/bin" ZV_SYSTEMD_DIR="$LROOT/systemd" \
    ZV_DATA_ROOT="$LROOT/data" ZV_CONF_DIR="$LROOT/conf" ZV_FAKE_SYSTEMCTL="$LROOT/systemctl" \
    ZV_FAKE_USERADD="$LROOT/useradd" ZV_FAKE_ID="$LROOT/id" \
    bash "$LINUX_INSTALLER" --mirror "file://$LROOT/mirror" "$@" 2>&1
}

# 真 Linux 验证脚本：没有 docker daemon 时必须**如实跳过**（exit 2），不许假装验过
printf '==> verify-linux-container.sh：环境不具备时如实跳过\n'
LVC="$ROOT/tools/verify-linux-container.sh"
bash -n "$LVC" && ok "verify-linux-container.sh 通过语法检查" || bad "verify-linux-container.sh 语法错"
SHIM2="$(mktemp -d)"; printf '#!/bin/sh\nexit 1\n' >"$SHIM2/docker"; chmod 0755 "$SHIM2/docker"
if out=$(PATH="$SHIM2:$PATH" bash "$LVC" 2>&1); then
  bad "没有 docker daemon 时竟然返回成功（假装验过了）"
else
  rc=$?
  case "$out" in
    *"如实跳过"*) ok "没有 docker daemon 时如实跳过（退出码 ${rc}，不假装验过）" ;;
    *) bad "没有 docker daemon 时的说明不清：$(printf '%s' "$out" | tail -2 | tr '\n' ' ')" ;;
  esac
fi
rm -rf "$SHIM2"

# ① sha256 对不上：必须拒，且不许把半截产物留在目标位置
cp "$LMIR/linux.json" "$LROOT/linux.json.good"
python3 - "$LMIR/linux.json" <<'PYEOF'
import json, sys
p = sys.argv[1]
d = json.load(open(p))
# 所有架构都改坏：门禁可能在 arm64 或 amd64 上跑，只改 index 0 会打不中实际会选的那条
for row in d["assets"]:
    row["sha256"] = "0" * 64
json.dump(d, open(p, "w"))
PYEOF
if out=$(linux_run --dry-run); then
  bad "sha256 不符时竟然成功了：$out"
else
  case "$out" in
    *"sha256 不符"*) ok "sha256 不符被拒（不装无法校验的包）" ;;
    *) bad "sha256 不符的报错不对：$out" ;;
  esac
fi
[ -e "$LROOT/bin/zizvideo" ] && bad "sha256 不符却留下了产物" || ok "sha256 不符时目标位置没有半截产物"
cp "$LROOT/linux.json.good" "$LMIR/linux.json"

# ② dry-run 全流程：下载 + 校验 + 建用户 + 写配置/单元 + daemon-reload
if out=$(linux_run --listen 0.0.0.0:7799 --dry-run); then
  ok "dry-run 安装流程跑通"
else
  bad "dry-run 安装失败：$out"
fi
case "$out" in *"sha256 校验通过"*) ok "做了 sha256 校验" ;; *) bad "没做 sha256 校验：$out" ;; esac
case "$out" in *"版本 $LVER"*) ok "版本取自 linux.json 的 latest" ;; *) bad "没报版本：$out" ;; esac
case "$out" in *"journalctl"*) ok "给出了 systemd 运维命令提示" ;; *) bad "没给运维提示：$out" ;; esac

# ③ 真装（不 dry-run，假二进制起不了服务 ⇒ 必须回滚且如实报错，不许谎报成功）
if out=$(linux_run --listen 127.0.0.1:7799); then
  warn_note="（假二进制居然验收通过了？）"
  bad "假二进制不可能通过 /readyz 验收，却返回了成功：$out"
else
  case "$out" in
    *"回滚"*|*"验收未通过"*) ok "起不来的服务如实报错并回滚（不谎报成功）" ;;
    *) bad "失败路径的说明不清：$out" ;;
  esac
fi
grep -q "daemon-reload" "$LC_SYS" && ok "真装时调用了（假的）systemctl daemon-reload" || bad "没有 daemon-reload：$(cat "$LC_SYS")"
if [ -f "$LROOT/systemd/zizvideo.service" ]; then
  ok "写了 systemd 单元"
  # 静态校验单元文件：段名/指令白名单/**枚举值**/必填项/重复键（本机没有 systemd，跑不起来只能静查；
  # 拼错一个值（ProtectSystem=fll）在真 NAS 上就是"服务起不来"，而"断言某几个键存在"发现不了）
  if uout="$(python3 "$ROOT/tools/check-systemd-unit.py" "$LROOT/systemd/zizvideo.service" 2>&1)"; then
    ok "systemd 单元通过静态校验：$(printf '%s' "$uout" | tail -1)"
  else
    bad "systemd 单元没通过静态校验：$(printf '%s' "$uout" | grep '✗' | head -3 | tr '\n' ' ')"
  fi
  # **文档宣称的安全属性**必须真的写在单元里（别让"只放开数据目录"变成一句空话）：
  # ReadWritePaths 只能有一条且等于数据目录；ProtectSystem/ProtectHome/NoNewPrivileges/PrivateTmp 都要在
  unit="$LROOT/systemd/zizvideo.service"
  rw_n="$(grep -c '^ReadWritePaths=' "$unit" || true)"
  if [ "$rw_n" = "1" ] && grep -q "^ReadWritePaths=$LROOT/data$" "$unit"; then
    ok "单元只放开数据目录（ReadWritePaths 恰好一条 = 数据目录）"
  else
    bad "单元的 ReadWritePaths 不对（应恰好一条 = 数据目录，实际 ${rw_n} 条：$(grep '^ReadWritePaths=' "$unit" | tr '\n' ' '))"
  fi
  for kv in "ProtectSystem=full" "ProtectHome=read-only" "NoNewPrivileges=yes" "PrivateTmp=yes" "User=zizvideo" "Group=zizvideo"; do
    grep -q "^${kv}$" "$unit" && ok "单元里有 ${kv}（文档宣称的安全属性）" || bad "单元缺 ${kv}（文档宣称了这条）"
  done
  # 反例：把枚举值改坏必须被报出来（否则这个校验就是摆设）
  sed 's/^ProtectSystem=.*/ProtectSystem=fll/' "$LROOT/systemd/zizvideo.service" >"$LROOT/systemd/bad.service"
  if python3 "$ROOT/tools/check-systemd-unit.py" "$LROOT/systemd/bad.service" >/dev/null 2>&1; then
    bad "单元里 ProtectSystem=fll 这种拼错没被校验出来"
  else
    ok "枚举值拼错（ProtectSystem=fll）被校验出来"
  fi
  grep -q "User=zizvideo" "$LROOT/systemd/zizvideo.service" && ok "单元指定了专用用户" || bad "单元没有 User="
  grep -q "Restart=always" "$LROOT/systemd/zizvideo.service" && ok "单元 Restart=always" || bad "单元没有 Restart=always"
  grep -q "ProtectSystem=full" "$LROOT/systemd/zizvideo.service" && ok "单元带 systemd 沙箱项" || bad "单元没有沙箱项"
else
  bad "没写出 systemd 单元"
fi
if [ -f "$LROOT/conf/config.json" ]; then
  python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$LROOT/conf/config.json" && ok "配置是合法 JSON" || bad "配置不是合法 JSON"
  grep -q "$LROOT/data" "$LROOT/conf/config.json" && ok "配置里的 data_dir 指向指定数据目录" || bad "配置里 data_dir 不对"
else
  bad "没写配置"
fi

# ---------------------------------------------------------------------------
# 飞牛 fnOS 应用包（`.fpk` 源目录）：结构 + 生命周期脚本的退出码 + 最小权限
#
# 为什么结构也要门禁：fnOS 的包格式（manifest / config/privilege / config/resource /
# cmd/main / app/ui/config / 图标尺寸）是**外部契约**，装错键名或漏文件，用户那边只会
# 看到"安装失败"，跟我们的源码毫无关系、极难查。这里只做**能用文件判定的部分**；
# 真正的 `fnpack build` 与真机安装要在有 fnpack / 飞牛设备的地方做（脚本会如实说）。
printf '==> 飞牛 fnOS 包（.fpk 源目录）：结构 + 生命周期 + 最小权限\n'
FNOS="$ROOT/platform/fnos/zizvideo"
# **静态契约**合并成一个强检查（tools/check-fnos-project.py）：必需文件/目录、manifest 取值与
# **拼错的键**（fnOS 静默忽略）、**重复键**（后写的静默覆盖）、入口交叉引用、权限最小形态、
# resource 合法、向导形状与字段类型（只认 fnpack 实测接受的三种）、图标尺寸。
# 一串弱断言（"存在 manifest"“privilege 是合法 JSON”…）换成它，覆盖面反而更大。
if fout="$(python3 "$ROOT/tools/check-fnos-project.py" "$FNOS" 2>&1)"; then
  ok "飞牛包静态校验通过：$(printf '%s' "$fout" | tail -1)"
else
  bad "飞牛包静态校验不过：$(printf '%s' "$fout" | grep '✗' | head -3 | tr '\n' ' ')"
fi
# 反例：拼错的键（fnOS 会静默忽略）必须被报出来 —— 否则这个校验是摆设
MBAD="$(mktemp -d)"; cp -R "$FNOS" "$MBAD/pkg"
printf '\ndescripton=拼错的键\n' >>"$MBAD/pkg/manifest"
if python3 "$ROOT/tools/check-fnos-project.py" "$MBAD/pkg" >/dev/null 2>&1; then
  bad "manifest 里拼错的键（descripton）没被校验出来"
else
  ok "manifest 里拼错的键会被报出来（fnOS 自己会静默忽略）"
fi
rm -rf "$MBAD"
# 配置变更钩子：幂等地合并端口/媒体根并重启
#  ① 没有可执行文件时：配置**照样要写对**，但必须**如实非零退出**（不许假装服务起来了）
#  ② 放一个只会 sleep 的假二进制：应当成功退出、并落下 pid 文件
CVD="$(mktemp -d)"; mkdir -p "$CVD/etc" "$CVD/var" "$CVD/app/bin"
printf '{"listen":"0.0.0.0:7799","data_dir":"%s","database_path":"%s/zizvideo.db","media_allow_roots":["%s/media"]}\n' "$CVD/var" "$CVD/var" "$CVD/var" >"$CVD/etc/config.json"
cvd_run() {
  TRIM_APPDEST="$CVD/app" TRIM_PKGETC="$CVD/etc" TRIM_PKGVAR="$CVD/var" TRIM_SERVICE_PORT=7799 \
    wizard_port=8899 wizard_extra_root=/vol1/media \
    sh "$FNOS/cmd/main" "$@" 2>&1
}
if cvd_run config_callback >/dev/null 2>&1; then
  bad "没有可执行文件时 config_callback 竟然返回成功（在假装服务起来了）"
else
  ok "没有可执行文件时 config_callback 如实非零退出"
fi
pyerr="$(python3 -c 'import json,sys
cfg = json.load(open(sys.argv[1]))
assert cfg.get("listen") == "0.0.0.0:8899", cfg.get("listen")
roots = cfg.get("media_allow_roots") or []
assert any(r.startswith("/vol1") for r in roots), roots' "$CVD/etc/config.json" 2>&1)" \
  && ok "config_callback 写出的配置是合法 JSON 且端口/媒体根已更新" || bad "config_callback 写坏了配置：$pyerr"
# 飞牛给的共享/授权目录（TRIM_DATA_SHARE_PATHS / TRIM_DATA_ACCESSIBLE_PATHS）必须并进媒体根：
#   · 原有条目一个不丢（用户可能在网页后台手加过）
#   · 自己的共享目录（$TRIM_PKGVAR/media）永远在
#   · 重复项去重、非绝对路径忽略、空段忽略
T2="$(mktemp -d)"; mkdir -p "$T2/etc" "$T2/var" "$T2/app/bin"
printf '#!/bin/sh\nwhile true; do sleep 1; done\n' >"$T2/app/bin/zizvideo"; chmod 0755 "$T2/app/bin/zizvideo"
printf '{"listen":"0.0.0.0:7799","data_dir":"%s/var","database_path":"%s/var/zizvideo.db","media_allow_roots":["/vol1/1000/视频"]}\n' "$T2" "$T2" >"$T2/etc/config.json"
t2_run() {
  TRIM_APPDEST="$T2/app" TRIM_PKGETC="$T2/etc" TRIM_PKGVAR="$T2/var" TRIM_SERVICE_PORT=7799 \
    TRIM_DATA_SHARE_PATHS="/vol2/@appdata/zizvideo/media" \
    TRIM_DATA_ACCESSIBLE_PATHS="/vol1/1000/电影:/vol1/1000/剧集::relative/path:/vol1/1000/电影" \
    sh "$FNOS/cmd/main" "$@" 2>&1
}
t2_run start >/dev/null 2>&1 || true
merr="$(python3 -c 'import json,sys
cfg = json.load(open(sys.argv[1]))
roots = cfg.get("media_allow_roots") or []
own = sys.argv[2]
assert "/vol1/1000/视频" in roots, ("原有条目丢了", roots)
assert own in roots, ("自己的共享目录不在", roots)
assert "/vol2/@appdata/zizvideo/media" in roots, ("TRIM_DATA_SHARE_PATHS 没并进来", roots)
assert "/vol1/1000/电影" in roots and "/vol1/1000/剧集" in roots, ("授权目录没并进来", roots)
assert "relative/path" not in roots, ("相对路径应该被忽略", roots)
assert roots.count("/vol1/1000/电影") == 1, ("重复项没去重", roots)' "$T2/etc/config.json" "$T2/var/media" 2>&1)" \
  && ok "飞牛给的共享/授权目录并进了 media_allow_roots（原有条目保留、去重、忽略非法项）" || bad "媒体根合并结果不对：$merr"
n1="$(python3 -c 'import json,sys; print(len(json.load(open(sys.argv[1])).get("media_allow_roots") or []))' "$T2/etc/config.json")"
t2_run stop >/dev/null 2>&1 || true
t2_run start >/dev/null 2>&1 || true
n2="$(python3 -c 'import json,sys; print(len(json.load(open(sys.argv[1])).get("media_allow_roots") or []))' "$T2/etc/config.json")"
[ "$n1" = "$n2" ] && ok "重复 start 幂等（媒体根数量 $n1 不变）" || bad "重复 start 把媒体根越加越多：$n1 → $n2"
t2_run stop >/dev/null 2>&1 || true
rm -rf "$T2"
# 卸载时"保留还是删除数据"：官方要求尊重向导选择；**默认保留**、删除要显式 + 删前守门 + 删后回读
T3="$(mktemp -d)"; mkdir -p "$T3/var/zizvideo" "$T3/app"; : >"$T3/var/zizvideo/zizvideo.db"
t3_run() {
  TRIM_APPDEST="$T3/app" TRIM_PKGETC="$T3/etc" TRIM_PKGVAR="$T3/var/zizvideo" \
    sh "$FNOS/cmd/main" uninstall_callback 2>&1
}
out3="$(t3_run)" || true
if [ -e "$T3/var/zizvideo/zizvideo.db" ]; then
  case "$out3" in *"已保留"*) ok "卸载默认**保留**数据（没勾选就不删）" ;; *) bad "默认既没保留也没说明：$out3" ;; esac
else
  bad "没勾选「删除数据」却把数据删了"
fi
out3="$(wizard_delete_data=1 t3_run)" || true
if [ ! -e "$T3/var/zizvideo" ]; then
  case "$out3" in *"回读确认"*) ok "显式勾选后真删并回读确认" ;; *) bad "删了但没说清：$out3" ;; esac
else
  bad "勾选了删除却没删干净：$out3"
fi
# 守门：把数据目录指到系统目录必须被拒（铁律 5：删文件前先证明这是我们的数据）
mkdir -p "$T3/var/zizvideo" 2>/dev/null || true
if out3="$(TRIM_APPDEST="$T3/app" TRIM_PKGETC="$T3/etc" TRIM_PKGVAR=/tmp wizard_delete_data=1 \
     sh "$FNOS/cmd/main" uninstall_callback 2>&1)"; then
  bad "TRIM_PKGVAR 指向 /tmp 时竟然照删了"
else
  [ -d /tmp ] && ok "数据目录可疑时拒绝删除（/tmp 原样保留）" || bad "/tmp 不见了！"
fi
# 不像本应用数据目录的也必须拒
if out3="$(TRIM_APPDEST="$T3/app" TRIM_PKGETC="$T3/etc" TRIM_PKGVAR="$T3/var/notours" wizard_delete_data=1 \
     sh "$FNOS/cmd/main" uninstall_callback 2>&1)"; then
  bad "不像本应用数据的目录也被删了"
else
  ok "不像本应用数据的目录被拒（不删未明确拥有的数据）"
fi
rm -rf "$T3"
# PID 文件过期/被系统复用：不能误报"在运行"（官方排错清单点名这条）
T4="$(mktemp -d)"; mkdir -p "$T4/var" "$T4/app/bin"
printf '#!/bin/sh\nwhile true; do sleep 1; done\n' >"$T4/app/bin/zizvideo"; chmod 0755 "$T4/app/bin/zizvideo"
sleep 60 & other_pid=$!
printf '%s' "$other_pid" >"$T4/var/zizvideo.pid"
if TRIM_APPDEST="$T4/app" TRIM_PKGETC="$T4/etc" TRIM_PKGVAR="$T4/var" \
   sh "$FNOS/cmd/main" status >/dev/null 2>&1; then
  bad "pidfile 里是别人的进程（sleep）时 status 竟然报「在运行」"
else
  rc=$?
  [ "$rc" = "3" ] && ok "pidfile 指向无关进程时 status 返回 3（不误报）" || bad "status 返回 ${rc}，应为 3"
fi
kill "$other_pid" 2>/dev/null || true
# 真启动后 status 必须是 0（上面刚验了身份核对不会把真进程也否掉）
TRIM_APPDEST="$T4/app" TRIM_PKGETC="$T4/etc" TRIM_PKGVAR="$T4/var" TRIM_SERVICE_PORT=7799 \
  sh "$FNOS/cmd/main" start >/dev/null 2>&1 || true
if TRIM_APPDEST="$T4/app" TRIM_PKGETC="$T4/etc" TRIM_PKGVAR="$T4/var" sh "$FNOS/cmd/main" status >/dev/null 2>&1; then
  ok "真在跑时 status 返回 0（身份核对没把自家进程否掉）"
else
  bad "真在跑时 status 却不是 0"
fi
TRIM_APPDEST="$T4/app" TRIM_PKGETC="$T4/etc" TRIM_PKGVAR="$T4/var" sh "$FNOS/cmd/main" stop >/dev/null 2>&1 || true
rm -rf "$T4"
# install_callback：装完就把目录与配置准备好（幂等）；upgrade_callback：配置坏了先备份再重建
T5="$(mktemp -d)"
t5_run() { TRIM_APPDEST="$T5/app" TRIM_PKGETC="$T5/etc" TRIM_PKGVAR="$T5/var" TRIM_SERVICE_PORT=7799 \
  TRIM_DATA_ACCESSIBLE_PATHS="/vol1/1000/电影" sh "$FNOS/cmd/main" "$@" 2>&1; }
t5_run install_callback >/dev/null 2>&1
if [ -f "$T5/etc/config.json" ] && [ -d "$T5/var" ]; then
  python3 -c 'import json,sys
cfg = json.load(open(sys.argv[1]))
assert cfg["listen"] == "0.0.0.0:7799", cfg["listen"]
assert "/vol1/1000/电影" in cfg["media_allow_roots"], cfg["media_allow_roots"]' "$T5/etc/config.json" \
    && ok "install_callback 建好目录与配置（并含飞牛授权目录）" || bad "install_callback 写的配置不对"
else
  bad "install_callback 没有建目录/写配置"
fi
# 幂等：再跑一次不能把配置改坏
before="$(cat "$T5/etc/config.json")"
t5_run install_callback >/dev/null 2>&1
[ "$before" = "$(cat "$T5/etc/config.json")" ] && ok "install_callback 幂等（重复执行不改配置）" || bad "install_callback 不幂等"
# 配置损坏：必须备份 + 重建（可回滚），且重建后可解析
printf '{坏\n' >"$T5/etc/config.json"
t5_run upgrade_callback >/dev/null 2>&1
broken="$(ls -1 "$T5/etc"/config.json.broken.* 2>/dev/null | head -1 || true)"
if [ -n "$broken" ]; then
  ok "upgrade_callback 把损坏配置备份成 $(basename "$broken")"
  python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$T5/etc/config.json" \
    && ok "损坏配置被重建为合法 JSON（旧文件留着可回滚）" || bad "重建后的配置仍不合法"
else
  bad "配置损坏时 upgrade_callback 没有备份（用户改过的配置不能悄悄丢）"
fi
# 配置正常时：不许改动它
good="$(cat "$T5/etc/config.json")"
t5_run upgrade_callback >/dev/null 2>&1
[ "$good" = "$(cat "$T5/etc/config.json")" ] && ok "upgrade_callback 不覆盖正常配置" || bad "upgrade_callback 改动了正常配置"
rm -rf "$T5"
# 升级的安全网：upgrade_init 停服务；upgrade_callback 备份数据库（同版本不重复、只留最近 2 份、
# 非 SQLite 不备）。官方要求"升级前备份或验证可回滚数据"——没有这条，坏升级就没法回退。
T6="$(mktemp -d)"; mkdir -p "$T6/var" "$T6/app/bin"
printf '#!/bin/sh\nwhile true; do sleep 1; done\n' >"$T6/app/bin/zizvideo"; chmod 0755 "$T6/app/bin/zizvideo"
python3 - "$T6/var/zizvideo.db" <<'PYD'
import sqlite3, sys
c = sqlite3.connect(sys.argv[1]); c.execute("create table t(x)"); c.commit(); c.close()
PYD
orig_sha="$(shasum -a 256 "$T6/var/zizvideo.db" | awk '{print $1}')"
t6_run() { TRIM_APPDEST="$T6/app" TRIM_PKGETC="$T6/etc" TRIM_PKGVAR="$T6/var" TRIM_SERVICE_PORT=7799 \
  TRIM_APPVER="$1" sh "$FNOS/cmd/main" "$2" 2>&1; }
# ① upgrade_init 要把正在跑的服务停掉
t6_run "" start >/dev/null 2>&1 || true
t6_run "" upgrade_init >/dev/null 2>&1 || true
if [ -f "$T6/var/zizvideo.pid" ] && kill -0 "$(cat "$T6/var/zizvideo.pid" 2>/dev/null)" 2>/dev/null; then
  bad "upgrade_init 之后服务还在跑（换二进制时旧进程还在）"
else
  ok "upgrade_init 停掉了服务（数据库静止，备份才可信）"
fi
# ② upgrade_callback 备份数据库，内容与原库逐字节一致
t6_run 1.0.0 upgrade_callback >/dev/null 2>&1
bk="$T6/var/zizvideo.db.pre-upgrade.1.0.0"
if [ -f "$bk" ] && [ "$(shasum -a 256 "$bk" | awk '{print $1}')" = "$orig_sha" ]; then
  ok "upgrade_callback 备份的数据库与原库逐字节一致"
else
  bad "升级备份缺失或内容不符：$bk"
fi
# ③ 同版本重复升级不重复备（幂等），且不动原库
t6_run 1.0.0 upgrade_callback >/dev/null 2>&1
cnt1="$(ls -1 "$T6/var"/zizvideo.db.pre-upgrade.1.0.0 2>/dev/null | wc -l | tr -d ' ')"
[ "$cnt1" = "1" ] && ok "同版本重复升级不重复备份（幂等）" || bad "同版本产生了 $cnt1 份备份"
# ④ 只保留最近 2 份（老 NAS 卷小，别把数据目录撑爆）
for v in 1.0.1 1.0.2 1.0.3; do t6_run "$v" upgrade_callback >/dev/null 2>&1; done
left="$(ls -1 "$T6/var"/zizvideo.db.pre-upgrade.* 2>/dev/null | wc -l | tr -d ' ')"
[ "$left" = "2" ] && ok "升级备份只保留最近 2 份（旧份自动清理）" || bad "备份剩了 $left 份（应为 2）"
# ⑤ 不是 SQLite 的东西不许当备份（也不许因此让升级失败）
printf 'not a db\n' >"$T6/var/zizvideo.db"
if t6_run 2.0.0 upgrade_callback >/dev/null 2>&1; then
  if [ -f "$T6/var/zizvideo.db.pre-upgrade.2.0.0" ]; then
    bad "非 SQLite 文件被当成数据库备份了"
  else
    ok "非 SQLite 文件不备份且升级不失败（不把不确定的东西当库）"
  fi
else
  bad "遇到非 SQLite 的库时 upgrade_callback 失败了（应当跳过备份但继续）"
fi
rm -rf "$T6"
# 带**空格**的媒体根必须被当成一个目标（`for target in $targets` 会按空格切分 ——
# macOS 上 `/Volumes/My Drive/…` 太常见；被切开后用户看到的是"探了几个不存在的位置"）
printf '==> 带空格的媒体根：--verify 与权限阶段都不许被切碎\n'
SP="$(mktemp -d)"; mkdir -p "$SP/My Drive/视频" "$SP/home/zizvideo" "$SP/bin" "$SP/daemons"
printf '{"listen":"127.0.0.1:7817","data_dir":"%s/home/zizvideo","database_path":"%s/var/zizvideo.db","media_allow_roots":["%s/My Drive/视频"],"allow_register":false}\n' "$SP" "$SP" "$SP" \
  >"$SP/home/zizvideo/config.json"
cat >"$SP/lc" <<'FAKELC4'
#!/bin/sh
if [ "$1" = "print" ]; then echo "	state = running"; exit 0; fi
if [ "$1" = "bootstrap" ]; then
  plist=""
  for a in "$@"; do case "$a" in *.plist) plist="$a" ;; esac; done
  if [ -n "$plist" ]; then
    outp=$(awk '/StandardOutPath/{getline; gsub(/.*<string>|<\/string>.*/,""); print; exit}' "$plist")
    if [ -n "$outp" ]; then printf '%s\n' "${ZV_FAKE_PROBE_JSON:-{\"path\":\"x\",\"readable\":true}}" >"$outp"; fi
  fi
fi
exit 0
FAKELC4
chmod 0755 "$SP/lc"
printf '#!/bin/sh\n[ "$1" = "--version" ] && { echo "zizvideo 9.9.9"; exit 0; }; [ "$1" = "check-access" ] && { printf %s "{\"path\":\"x\",\"readable\":true}"; exit 0; }; exit 0\n' >"$SP/bin/zizvideo"
chmod 0755 "$SP/bin/zizvideo"
spout="$(HOME="$SP/home" ZV_FAKE_SUDO=1 ZV_FAKE_SUDO_BIN=/usr/bin/env ZV_FAKE_LAUNCHCTL="$SP/lc" \
  ZV_SYSTEM_DAEMON_DIR="$SP/daemons" ZV_INSTALL_ROOT="$SP" ZV_ACCESS_PROBE_WAIT=0 \
  bash "$ROOT/platform/macos/install-zizvideo.sh" --verify 2>&1 || true)"
n_read="$(printf '%s' "$spout" | grep -c "守护进程读得到：$SP/My Drive/视频" || true)"
[ "$n_read" = "1" ] && ok "--verify 把带空格的媒体根当成**一个**目标（不是切成几段）" \
  || bad "--verify 对带空格路径的处理不对（匹配行数 ${n_read}）：$(printf '%s' "$spout" | grep '守护进程' | head -3 | tr '\n' ' ')"
rm -rf "$SP"

# ② 假二进制（只 sleep）→ 应当成功
printf '#!/bin/sh\nwhile true; do sleep 1; done\n' >"$CVD/app/bin/zizvideo"; chmod 0755 "$CVD/app/bin/zizvideo"
if cvd_run config_callback >/dev/null 2>&1; then
  ok "有可执行文件时 config_callback 成功（改了配置并重启）"
  [ -f "$CVD/var/zizvideo.pid" ] && ok "重启后落了 pid 文件" || bad "重启后没有 pid 文件"
  cvd_run stop >/dev/null 2>&1 || true
else
  bad "有可执行文件时 config_callback 失败：$(cvd_run config_callback | tail -2)"
fi
rm -rf "$CVD"

# 生命周期脚本：status 在没跑时必须是 3、未知参数必须 1（官方硬要求），且不许硬编码安装路径
syntaxless="$FNOS/cmd/main"
sh -n "$syntaxless" && ok "cmd/main 通过 sh -n" || bad "cmd/main 语法错"
# 官方布局（fnpack create 生成的工程为准）：cmd/ 下每个生命周期钩子都是**独立文件**，
# 塞进 main 的子命令 fnOS 根本不会调（我第一版就是那样）。
for h in install_init install_callback upgrade_init upgrade_callback uninstall_init uninstall_callback config_init config_callback; do
  if [ -x "$FNOS/cmd/${h}" ]; then
    sh -n "$FNOS/cmd/${h}" 2>/dev/null && ok "cmd/${h} 存在且可执行" || bad "cmd/${h} 语法错"
  else
    bad "缺 cmd/${h}（fnOS 的钩子按**文件**调用，不是 main 的子命令）"
  fi
done
tmpd="$(mktemp -d)"
if TRIM_APPDEST="$tmpd/app" TRIM_PKGETC="$tmpd/etc" TRIM_PKGVAR="$tmpd/var" \
   TRIM_SERVICE_PORT=7799 sh "$syntaxless" status >/dev/null 2>&1; then
  bad "没在跑时 status 竟然返回 0（官方要求 3）"
else
  rc=$?
  [ "$rc" = "3" ] && ok "没在跑时 status 返回 3（官方要求）" || bad "status 返回 ${rc}，应为 3"
fi
if TRIM_APPDEST="$tmpd/app" TRIM_PKGETC="$tmpd/etc" TRIM_PKGVAR="$tmpd/var" sh "$syntaxless" bogus >/dev/null 2>&1; then
  bad "未知参数竟然返回 0（官方要求非零）"
else
  ok "未知参数返回非零"
fi
rm -rf "$tmpd"
if grep -v '^[[:space:]]*#' "$FNOS/cmd/main" | grep -q '/var/apps/'; then
  bad "cmd/main 硬编码了 /var/apps/…（官方要求走 TRIM_* 变量）"
else
  ok "cmd/main 没有硬编码安装路径（用 TRIM_*）"
fi
# 图标尺寸（fnOS 要求 64x64 与 256x256）
for spec in "ICON.PNG 64" "ICON_256.PNG 256"; do
  set -- $spec
  dim=$(python3 - "$FNOS/$1" <<'PYI'
import struct, sys
with open(sys.argv[1], "rb") as f:
    head = f.read(24)
if head[:8] != b"\x89PNG\r\n\x1a\n":
    print("notpng"); raise SystemExit
print(struct.unpack(">II", head[16:24])[0])
PYI
)
  [ "$dim" = "$2" ] && ok "$1 是 ${2}x${2}" || bad "$1 是 ${dim}，应为 $2（fnOS 要求）"
done
# 打包脚本：没有 fnpack 时必须**如实失败**，不许伪造 .fpk
# ⚠️ 真打包需要**本版本已构建的** Linux 发行件（`make release` 产出）。发行后 bump 版本、还没重新
# 构建时，这里要**如实跳过**而不是报 ✗ —— 否则"刚发完版、下一轮刚开始"每次都会红（假失败会让人
# 开始无视门禁）。结构类判据（check-fnos-project.py）不依赖发行件，照常跑。
FNOS_VER="$(sed -n 's/^VERSION[[:space:]]*?*=[[:space:]]*//p' "$ROOT/Makefile" | head -1)"
FNOS_REL_BIN="$ROOT/dist/apps/zizvideo/$FNOS_VER/zizvideo_${FNOS_VER}_linux_amd64"
if [ ! -f "$FNOS_REL_BIN" ]; then
  note_skip "飞牛真打包：本版本（${FNOS_VER}）的 Linux 发行件还没构建（先 make release）"
elif bash "$ROOT/tools/make-fnos-pkg.sh" --stage-only >/dev/null 2>&1; then
  ok "make-fnos-pkg.sh --stage-only 能准备出待打包目录"
else
  bad "make-fnos-pkg.sh --stage-only 失败（待打包目录都出不来）"
fi
FN=""
if [ ! -f "$FNOS_REL_BIN" ]; then
  FN=""      # 没有本版本发行件 ⇒ 后面"真打包"整段跳过（上面已 note_skip 说明原因）
elif [ -x "$ROOT/.tools/fnpack" ]; then FN="$ROOT/.tools/fnpack"
elif command -v fnpack >/dev/null 2>&1; then FN="$(command -v fnpack)"; fi
if [ -n "$FN" ]; then
  ok "本机有 fnpack（${FN}）：跑一次**真打包**验包结构与向导格式"
  if out=$(bash "$ROOT/tools/make-fnos-pkg.sh" --arch amd64 2>&1); then
    # ⚠️ 必须按**本版本**选包：`ls … | head -1` 会在 dist 里同时有旧版本残留时选中旧包
    # （0.6.5 排在 0.6.6 前面 ⇒ 自检拿 0.6.5 的 manifest 对 0.6.6 的期望，报"包自检没过"）
    fpkver="${FNOS_VER%-mvp}"
    fpk="$(ls -1 "$ROOT/dist/apps/zizvideo/fnos/zizvideo-${fpkver}-x86.fpk" 2>/dev/null | head -1 || true)"
    if [ -n "$fpk" ] && [ "$(wc -c <"$fpk" | tr -d ' ')" -gt 1000000 ]; then
      ok "fnpack 真打包成功：$(basename "$fpk")（$(wc -c <"$fpk" | tr -d ' ') 字节）"
      # 包里必须真有我们的二进制与 9 个 cmd 脚本（别只看"打包成功"）
      if tar tzf "$fpk" 2>/dev/null | grep -q '^cmd/main$' && tar xzOf "$fpk" app.tgz 2>/dev/null | tar tzf - 2>/dev/null | grep -q '^bin/zizvideo$'; then
        ok "包内含 cmd/main 与 app/bin/zizvideo"
      else
        bad ".fpk 里没找到 cmd/main 或 app/bin/zizvideo"
      fi
      # 再用**独立的自检脚本**把这一个包解开逐项核对（manifest↔架构↔钩子↔入口端口）
      if fpkout="$(bash "$ROOT/tools/check-fnos-fpk.sh" "$fpk" 2>&1)"; then
        ok "包自检通过（$(printf '%s' "$fpkout" | grep '结论' | head -1)）"
      else
        bad "包自检没过：$(printf '%s' "$fpkout" | grep '✗' | head -3)"
      fi
      # 同源核对的反例：把"发行件"指到别的文件（模拟"打完包之后又重建了二进制"）
      if fpkbad="$(ZV_FNOS_RELEASE_BIN=/bin/echo bash "$ROOT/tools/check-fnos-fpk.sh" "$fpk" 2>&1)"; then
        bad "包内二进制与发行件不同源时自检竟然通过（这种漂移会让"验过的包"其实装着另一份二进制）"
      else
        case "$fpkbad" in
          *"不同源"*) ok "包内二进制与发行件不同源时如实报错（防止打包后又重建二进制）" ;;
          *) bad "不同源时的报错不对：$(printf '%s' "$fpkbad" | grep '✗' | head -2 | tr '\n' ' ')" ;;
        esac
      fi
    else
      bad "fnpack 说成功但没有像样的 .fpk：${fpk}（看 dist/apps/zizvideo/fnos/）"
    fi
  else
    bad "fnpack 真打包失败：$(printf '%s' "$out" | tail -3)"
  fi
else
  ok "本机没有 fnpack：脚本会如实报错而**不**伪造 .fpk（有 fnpack 的机器上会自动跑真打包）"
fi

# ---------------------------------------------------------------------------
# Makefile 目标名不许与仓库里的**目录**同名（否则 make 判定"目标已存在"直接跳过配方 ——
# 这坑我踩了两次：`fnos` 与 `docker`。与其记着，不如让门禁盯住。）
printf '==> 脚本卫生（bash 3.2 兼容 / $var 紧邻非 ASCII / 头部纯净 / 语法 / Makefile 目标名）\n'
# 原来这是四个小节、六七条断言，合并成 tools/check-script-hygiene.py（可独立运行、带 --root 便于反例自测）
if hyout="$(python3 "$ROOT/tools/check-script-hygiene.py" 2>&1)"; then
  ok "脚本卫生通过：$(printf '%s' "$hyout" | tail -1)"
else
  bad "脚本卫生有问题：$(printf '%s' "$hyout" | grep '✗' | head -3 | tr '\n' ' ')"
fi

# ---------------------------------------------------------------------------
# 容器部署路径（docker/）：结构 + 入口脚本 + 没有 daemon 时必须如实失败
printf '==> 容器部署（Dockerfile / compose / 入口脚本：静态结构 + 入口脚本行为）\n'
# 静态结构 + **入口脚本行为**（首次生成配置/不覆盖已有配置/过滤不存在的媒体根/忽略相对路径）
# 合并到 tools/check-container-assets.py（自带反例：删掉 USER、或让它覆盖已有配置，都必须被报出来）
if cout="$(python3 "$ROOT/tools/check-container-assets.py" 2>&1)"; then
  ok "容器部署静态+行为校验通过：$(printf '%s' "$cout" | tail -1)"
else
  bad "容器部署有问题：$(printf '%s' "$cout" | grep '✗' | head -3 | tr '\n' ' ')"
fi
# 生成镜像的脚本：没有可用 daemon 时必须**如实失败**，不许假装构建好了
if bash "$ROOT/tools/make-docker-image.sh" >/dev/null 2>&1; then
  if docker info >/dev/null 2>&1; then
    ok "本机有 docker daemon，镜像构建成功"
  else
    bad "没有 docker daemon 时 make-docker-image.sh 竟然返回成功"
  fi
else
  ok "没有可用 docker daemon 时如实失败（不假装构建成功）"
fi
# 文档 ↔ 实现一致性（文档腐烂是长期风险：命令改名/文件搬家/门禁条数写死后，文档开始骗人）
# 具体检查放在 tools/check-docs.py 里 —— 用 python 写比在 bash 里塞 heredoc 靠谱
# （我第一版就是在门禁里套 heredoc 做命令替换，直接把门禁语法搞坏了）
printf '==> 文档与实现是否还对得上（路径 / make 目标 / 别写死门禁条数）\n'
if dout="$(python3 "$ROOT/tools/check-docs.py" 2>&1)"; then
  ok "文档与实现一致：$(printf '%s' "$dout" | tail -1)"
else
  bad "文档与实现不一致：$(printf '%s' "$dout" | grep -v '^✓' | head -4 | tr '\n' ' ')"
fi
# 脚本自己的 --help 必须写全它解析的参数（"解析了但没写"= 用户永远不知道有这功能）
if uout="$(python3 "$ROOT/tools/check-usage-flags.py" 2>&1)"; then
  ok "各脚本 --help 与参数解析一致：$(printf '%s' "$uout" | tail -1)"
else
  bad "有帮助漏写参数：$(printf '%s' "$uout" | grep '✗' | head -3 | tr '\n' ' ')"
fi
# publish 的上传名必须是**对外名字**（不带目录）：这类错只在下一次真发版时才暴露，代价是使用者 404
upout="$(python3 - "$ROOT/tools/publish-mirror.sh" <<'PYUP'
import re, sys
bad = []
for i, line in enumerate(open(sys.argv[1], encoding="utf-8"), 1):
    m = re.search(r'queue_upload\s+\S+\s+\S+\s+"([^"]*)"', line)
    if m and "/" in m.group(1):
        bad.append("第%d行=%s" % (i, m.group(1)))
print("；".join(bad))
PYUP
)"
if [ -z "$upout" ]; then
  ok "publish 的上传名都是对外名字（不带目录）"
else
  bad "publish 的上传名带了目录（会传到镜像子目录，使用者的一键 URL 会 404）：${upout}"
fi
# 状态文档（新会话第一入口）里**可机器核对的事实**：工作树版本、未推送、速览里不许写死条数
if sout="$(python3 "$ROOT/tools/check-status-doc.py" 2>&1)"; then
  ok "状态文档的事实对得上：$(printf '%s' "$sout" | tail -1)"
else
  bad "状态文档有过期断言：$(printf '%s' "$sout" | grep '✗' | head -3 | tr '\n' ' ')"
fi

# ---------------------------------------------------------------------------
# 发布前总检（tools/preflight.sh）：步骤清单 + 镜像漂移的两条判据（正常待发布 vs 真漂移）
printf '==> 发布前总检 preflight.sh\n'
PF="$ROOT/tools/preflight.sh"
bash -n "$PF" && ok "preflight.sh 通过语法检查" || bad "preflight.sh 语法错"
steps="$(bash "$PF" --list 2>&1 || true)"
n_steps="$(printf '%s\n' "$steps" | grep -c . || true)"
[ "$n_steps" -ge 6 ] && ok "preflight 列出 ${n_steps} 个步骤（含 mirror 漂移）" || bad "preflight --list 只列出 ${n_steps} 个步骤"
# 假镜像：本地安装器与镜像一致 → ✓
FM="$(mktemp -d)"; mkdir -p "$FM/apps/zizvideo"
cp "$ROOT/platform/macos/install-zizvideo.sh" "$ROOT/platform/linux/install-zizvideo-linux.sh" "$FM/apps/zizvideo/" 2>/dev/null || true
# ⚠️ latest 必须等于**本地版本**：否则会走"镜像还是上一版（发布前正常）"那条分支，测不到我们要拦的情况
PFVER="$(sed -n 's/^VERSION[[:space:]]*?*=[[:space:]]*//p' "$ROOT/Makefile" | head -1)"
printf '{"app":"zizvideo","latest":"%s","assets":[]}\n' "$PFVER" >"$FM/apps/zizvideo/manifest.json"
pfout="$(ZV_PREFLIGHT_MIRROR="file://$FM" bash "$PF" --only mirror 2>&1 || true)"
case "$pfout" in
  *"逐字节一致"*) ok "镜像与本地一致时报「逐字节一致」" ;;
  *) bad "镜像一致时没报一致：$(printf '%s' "$pfout" | grep -E '安装器|✗' | head -2 | tr '\n' ' ')" ;;
esac
# 同一版本却字节不同 → **必须失败**（违反"同版本不许换字节"）
# ⚠️ 改的是**镜像侧**文件：镜像上只按**文件名**存放（没有 platform/ 那层）——我的路径扫描曾把它改成
# `$FM/apps/zizvideo/install-zizvideo.sh`，append 因目录不存在而静默失败 ⇒ 造不出
# "同版本字节不同"，那条判据就白测了。
printf '\n# 与本地不同\n' >>"$FM/apps/zizvideo/install-zizvideo.sh"
if ZV_PREFLIGHT_MIRROR="file://$FM" bash "$PF" --only mirror >"$FM/out" 2>&1; then
  bad "同一版本字节不同时 preflight 竟然通过（同版本换字节是最该拦的）"
else
  case "$(cat "$FM/out")" in
    *"同版本"*"字节不同"*) ok "同版本字节不同时 preflight 如实失败" ;;
    *) bad "同版本字节不同的报错不对：$(grep -E '✗' "$FM/out" | head -2 | tr '\n' ' ')" ;;
  esac
fi
# 镜像 latest 与本地不同（发布前正常）→ 跳过且说明"发布前正常"，**不算失败**
printf '{"app":"zizvideo","latest":"0.0.1","assets":[]}\n' >"$FM/apps/zizvideo/manifest.json"
if ZV_PREFLIGHT_MIRROR="file://$FM" bash "$PF" --only mirror >"$FM/out2" 2>&1; then
  case "$(cat "$FM/out2")" in
    *"发布前正常"*) ok "镜像还是上一版时如实说明「发布前正常」且不算失败" ;;
    *) bad "镜像旧版时的说明不清：$(grep -E '·|✗' "$FM/out2" | head -2 | tr '\n' ' ')" ;;
  esac
else
  bad "镜像还是上一版时 preflight 竟然判失败（发布前必然如此，会天天误报）"
fi
rm -rf "$FM"
# 发布后复核的**场景**（线上字节 / 漏传 / 两份索引一致 / 产物被换过）已合并到
# tools/check-release-flow.py（假镜像七种场景，可独立运行）—— 这里只留脚本级检查。

# ---------------------------------------------------------------------------
# 安装器 --verify 与自查脚本 --as-daemon：两个**独立实现**在同一场景下必须给出同样判定
#
# 这两处都会回答"守护进程到底读不读得到媒体根"（安装器复用安装时那套一次性 launchd 作业，
# 自查脚本是另一份实现）。两份实现给出不同答案 = 用户会拿到互相矛盾的结论，比只有一份更糟。
printf '==> 安装器 --verify（单文件体检）+ 与自查脚本结论一致\n'
VA="$(mktemp -d)"; mkdir -p "$VA/home/zizvideo" "$VA/bin" "$VA/daemons" "$VA/media"
printf '{"listen":"127.0.0.1:7796","data_dir":"%s/home/zizvideo","database_path":"%s/home/zizvideo/zizvideo.db","media_allow_roots":["%s/media"]}\n' "$VA" "$VA" "$VA" \
  >"$VA/home/zizvideo/config.json"
printf '#!/bin/sh\n[ "$1" = "--version" ] && { echo "zizvideo 9.9.9"; exit 0; }; exit 0\n' >"$VA/bin/zizvideo"
chmod 0755 "$VA/bin/zizvideo"
cat >"$VA/lc" <<'FAKELC2'
#!/bin/sh
if [ "$1" = "print" ]; then echo "	state = running"; exit 0; fi
if [ "$1" = "bootstrap" ]; then
  plist=""
  for a in "$@"; do case "$a" in *.plist) plist="$a" ;; esac; done
  if [ -n "$plist" ]; then
    outp=$(awk '/StandardOutPath/{getline; gsub(/.*<string>|<\/string>.*/,""); print; exit}' "$plist")
    if [ -n "$outp" ]; then printf '%s\n' "$ZV_FAKE_PROBE_JSON" >"$outp"; fi
  fi
fi
exit 0
FAKELC2
chmod 0755 "$VA/lc"
inst_verify() {
  HOME="$VA/home" ZV_FAKE_SUDO=1 ZV_FAKE_SUDO_BIN=/usr/bin/env ZV_FAKE_LAUNCHCTL="$VA/lc" \
    ZV_SYSTEM_DAEMON_DIR="$VA/daemons" ZV_INSTALL_ROOT="$VA" ZV_ACCESS_PROBE_WAIT=0 \
    ZV_FAKE_PROBE_JSON="$1" bash "$ROOT/platform/macos/install-zizvideo.sh" --verify 2>&1
}
vd_verify() {
  ZV_FAKE_SUDO=1 ZV_FAKE_SUDO_BIN=/usr/bin/env ZV_FAKE_LAUNCHCTL="$VA/lc" \
    ZV_SYSTEM_DAEMON_DIR="$VA/daemons" ZV_ACCESS_PROBE_WAIT=0 ZV_FAKE_PROBE_JSON="$1" \
    bash "$ROOT/tools/verify-deploy.sh" --config "$VA/home/zizvideo/config.json" \
      --bin "$VA/bin/zizvideo" --as-daemon --no-service 2>&1
}
cfg_before="$(cat "$VA/home/zizvideo/config.json")"
out_i="$(inst_verify '{"path":"x","readable":true}')"
out_v="$(vd_verify '{"path":"x","readable":true}')"
case "$out_i" in
  *"守护进程读得到"*) ok "安装器 --verify 报「守护进程读得到」（可读场景）" ;;
  *) bad "安装器 --verify 没报读得到：$(printf '%s' "$out_i" | grep -E '读|✗' | head -2)" ;;
esac
case "$out_i" in
  *"守护进程读不到"*) bad "安装器 --verify 在可读场景也报了读不到（自相矛盾）" ;;
  *) ok "安装器 --verify 可读场景没有误报读不到" ;;
esac
case "$out_v" in
  *"✓ 守护进程读得到"*) ok "自查脚本 --as-daemon 在**同一场景**报读得到（两份实现一致）" ;;
  *) bad "自查脚本在同一场景给出不同结论：$(printf '%s' "$out_v" | grep -E '守护进程' | head -2)" ;;
esac
out_i="$(inst_verify '{"path":"x","readable":false}')"
inst_rc=$?
out_v="$(vd_verify '{"path":"x","readable":false}')"
case "$out_i" in
  *"守护进程读不到"*) ok "安装器 --verify 报「守护进程读不到」（不可读场景）" ;;
  *) bad "安装器 --verify 没报读不到：$(printf '%s' "$out_i" | grep -E '读|✗' | head -2)" ;;
esac
case "$out_v" in
  *"✗ 守护进程读不到"*) ok "自查脚本在同一场景也报读不到（两份实现一致）" ;;
  *) bad "自查脚本给出不同结论：$(printf '%s' "$out_v" | grep -E '守护进程' | head -2)" ;;
esac
# --verify 必须"只读"：不改配置、不在 LaunchDaemons 里留东西
[ "$cfg_before" = "$(cat "$VA/home/zizvideo/config.json")" ] \
  && ok "--verify 不改动配置（只体检）" || bad "--verify 动了配置文件"
[ "$(ls -1 "$VA/daemons" 2>/dev/null | wc -l | tr -d ' ')" = "0" ] \
  && ok "--verify 没在 LaunchDaemons 里留东西" || bad "--verify 留了 plist 残渣"
# 两份体检实现的**覆盖面必须对齐**（否则会出现"安装器说全过、自查脚本却报某项没过"，让人困惑）：
# 拿一个"故意有问题"的配置跑安装器 --verify，要求它把自查脚本会报的几项也报出来
VH2="$(mktemp -d)"; mkdir -p "$VH2/home/zizvideo" "$VH2/bin" "$VH2/daemons" "$VH2/media"
printf '{"listen":"127.0.0.1:7822","data_dir":"%s/home/zizvideo","database_path":"/tmp/elsewhere.db","media_allow_roots":["%s/media","%s/不存在"]}\n' "$VH2" "$VH2" "$VH2" \
  >"$VH2/home/zizvideo/config.json"
printf '#!/bin/sh\n[ "$1" = "--version" ] && { echo "zizvideo 9.9.9"; exit 0; }; [ "$1" = "check-access" ] && { printf %s "{\"readable\":true}"; exit 0; }; exit 0\n' >"$VH2/bin/zizvideo"
chmod 0755 "$VH2/bin/zizvideo"
printf '#!/bin/sh\n[ "$1" = "print" ] && { echo "	state = running"; exit 0; }; exit 0\n' >"$VH2/lc"; chmod 0755 "$VH2/lc"
vout2="$(HOME="$VH2/home" ZV_FAKE_SUDO=1 ZV_FAKE_SUDO_BIN=/usr/bin/env ZV_FAKE_LAUNCHCTL="$VH2/lc" \
  ZV_SYSTEM_DAEMON_DIR="$VH2/daemons" ZV_INSTALL_ROOT="$VH2" \
  bash "$ROOT/platform/macos/install-zizvideo.sh" --verify 2>&1 || true)"
case "$vout2" in
  *"数据库不在数据目录内"*) ok "安装器 --verify 也会报「数据库不在数据目录内」（与自查脚本覆盖面一致）" ;;
  *) bad "安装器 --verify 漏了"数据库不在数据目录内"（两份实现覆盖面不一致）" ;;
esac
case "$vout2" in
  *"数据所在卷剩余"*) ok "安装器 --verify 给出磁盘余量" ;;
  *) bad "安装器 --verify 没给磁盘余量" ;;
esac
case "$vout2" in
  *"目录不存在"*"挂盘了吗"*) ok "安装器 --verify 对不存在的媒体根说「挂盘了吗」" ;;
  *) bad "安装器 --verify 没说清"目录不存在"" ;;
esac
# ⚠️ set -e + pipefail 下 codesign 对**未签名**二进制返回非零会**直接中断报告**
# （表现出来是"报告只出了二进制那两行"）—— 断言报告确实跑到了结论段
case "$vout2" in
  *"标准结论"*|*"== 结论"*) ok "安装器 --verify 的报告没被中途截断（跑到结论段）" ;;
  *) bad "安装器 --verify 报告被截断了（很可能 set -e 下某个命令返回非零）：$(printf '%s' "$vout2" | tail -2 | tr '\n' ' ')" ;;
esac
# 二进制**坏掉**时（架构不对/被拦截/损坏），体检必须**跑到底**并把原因说清 ——
# 这正是最需要报告的时候，绝不能让 `set -e` 把报告截断（我在这两处各栽过一次）
printf '#!/bin/sh\necho "broken: cannot execute" >&2\nexit 126\n' >"$VH2/bin/zizvideo"; chmod 0755 "$VH2/bin/zizvideo"
vbout="$(HOME="$VH2/home" ZV_FAKE_SUDO=1 ZV_FAKE_SUDO_BIN=/usr/bin/env ZV_FAKE_LAUNCHCTL="$VH2/lc" \
  ZV_SYSTEM_DAEMON_DIR="$VH2/daemons" ZV_INSTALL_ROOT="$VH2" \
  bash "$ROOT/platform/macos/install-zizvideo.sh" --verify 2>&1 || true)"
case "$vbout" in
  *"跑不起来"*"== 结论："*) ok "二进制坏掉时体检跑到底并说清「跑不起来」（不被 set -e 截断）" ;;
  *) bad "二进制坏掉时体检被截断或没说清：$(printf '%s' "$vbout" | tail -2 | tr '\n' ' ')" ;;
esac
rm -rf "$VH2"
# 同一个对账也要覆盖 **Linux 安装器的 --verify**（设备上没有仓库、只能用装它的那个脚本自检）：
# 用假 harness 造一个"结构项有问题"的部署，要求它报出同样的四项 + 报告不被截断 + 用**配置里的端口**
VH3="$(mktemp -d)"; mkdir -p "$VH3/bin" "$VH3/conf" "$VH3/data" "$VH3/media"
printf '#!/bin/sh\n[ "$1" = "is-active" ] && { echo active; exit 0; }; exit 0\n' >"$VH3/systemctl"; chmod 0755 "$VH3/systemctl"
printf '#!/bin/sh\n[ "$1" = "--version" ] && { echo "zizvideo 9.9.9"; exit 0; }\nexit 0\n' >"$VH3/bin/zizvideo"; chmod 0755 "$VH3/bin/zizvideo"
printf '{"listen":"127.0.0.1:7793","data_dir":"%s/data","database_path":"/tmp/elsewhere.db","media_allow_roots":["%s/missing"]}\n' "$VH3" "$VH3" >"$VH3/conf/config.json"
lvout="$(ZV_ALLOW_ANY_OS=1 ZV_ALLOW_NONROOT=1 ZV_INSTALL_PREFIX="$VH3/bin" ZV_CONF_DIR="$VH3/conf" \
  ZV_FAKE_SYSTEMCTL="$VH3/systemctl" bash "$ROOT/platform/linux/install-zizvideo-linux.sh" --verify 2>&1 || true)"
case "$lvout" in
  *"数据库不在数据目录内"*) ok "Linux 安装器 --verify 也报「数据库不在数据目录内」（与另两份实现覆盖面一致）" ;;
  *) bad "Linux 安装器 --verify 漏了"数据库不在数据目录内"" ;;
esac
case "$lvout" in
  *"数据所在卷剩余"*) ok "Linux 安装器 --verify 给出磁盘余量" ;;
  *) bad "Linux 安装器 --verify 没给磁盘余量" ;;
esac
case "$lvout" in
  *"目录不存在"*"挂盘了吗"*) ok "Linux 安装器 --verify 对不存在的媒体根说「挂盘了吗」" ;;
  *) bad "Linux 安装器 --verify 没说清"目录不存在"" ;;
esac
case "$lvout" in
  *"7793"*) ok "Linux 安装器 --verify 用**配置里的**端口（不是脚本默认值）" ;;
  *) bad "Linux 安装器 --verify 没按配置里的端口探测" ;;
esac
case "$lvout" in
  *"== 结论："*) ok "Linux 安装器 --verify 的报告没被中途截断" ;;
  *) bad "Linux 安装器 --verify 报告被截断了：$(printf '%s' "$lvout" | tail -2 | tr '\n' ' ')" ;;
esac
rm -rf "$VH3"

rm -rf "$VA"

# ---------------------------------------------------------------------------
# 部署自查脚本（tools/verify-deploy.sh）+ 发布件的 Linux 二进制必须真是静态 ELF
# ---------------------------------------------------------------------------
# 脚本开头的注释块里混进一行"代码"会**自我递归**（我这一轮真踩了：用法块里漏写一个 `#`，
# 于是 `bash tools/verify-deploy.sh --no-service` 被当命令执行，脚本无限重启自己直到 fork 耗尽）。
# 判据：从文件头到第一个 `set ` 之前，每一行都必须是注释或空行。

# preflight 的"发布件完整性"必须**真会抓缺失**（不是只列清单）：临时把 linux 产物挪走试一次
RELVER_PF="$(sed -n 's/^VERSION[[:space:]]*?*=[[:space:]]*//p' "$ROOT/Makefile" | head -1)"
PFBIN="$ROOT/dist/apps/zizvideo/$RELVER_PF/zizvideo_${RELVER_PF}_linux_amd64"
if [ -f "$PFBIN" ]; then
  mv "$PFBIN" "$PFBIN.hidden"
  if bash "$ROOT/tools/preflight.sh" --only release >/dev/null 2>&1; then
    bad "缺了 linux 产物时 preflight 的发布件完整性竟然通过"
  else
    ok "缺了 linux 产物时发布件完整性如实失败（不会静默少发 Linux）"
  fi
  mv "$PFBIN.hidden" "$PFBIN"
else
  note_skip "没有 ${PFBIN}，跳过发布件完整性用例"
fi
if /bin/bash "$ROOT/tools/preflight.sh" --list >/dev/null 2>&1; then
  ok "preflight.sh 在 /bin/bash（$(/bin/bash --version | head -1 | grep -o '3\.[0-9]*\.[0-9]*' | head -1)）下能跑"
else
  bad "preflight.sh 在 /bin/bash 3.2 下跑不起来"
fi
# bash 3.2 + set -u 下**展开空数组**会报 unbound（4.4+ 才修）—— 语法检查抓不到，只能真跑边缘输入
# （我就是在 `--only` 不存在时踩的：`for o in "${ONLY[@]}"` 直接炸）
if /bin/bash "$ROOT/tools/preflight.sh" --only 不存在的步骤 >/dev/null 2>&1; then
  ok "preflight.sh 传未知 --only 时不崩（空数组展开已按 3.2 写法处理）"
else
  bad "preflight.sh 传未知 --only 时崩了（很可能是 bash 3.2 下空数组展开的 unbound）"
fi


printf '==> 部署自查脚本 + Linux 发行件静态性\n'
VD="$ROOT/tools/verify-deploy.sh"
sh -n "$VD" 2>/dev/null || bash -n "$VD"
if bash -n "$VD" 2>/dev/null; then ok "verify-deploy.sh 通过语法检查" ; else bad "verify-deploy.sh 语法错" ; fi
# 配置不存在时必须**如实报 ✗ 且非零退出**（不许把"文件都没有"说成通过）
if out=$(bash "$VD" --config "$SB/nope/config.json" --bin /bin/echo 2>&1); then
  bad "配置文件不存在时竟然返回成功：$out"
else
  case "$out" in
    *"找不到配置"*) ok "配置缺失时如实报 ✗ 并非零退出" ;;
    *) bad "配置缺失时报错不清：$out" ;;
  esac
fi
# 拿一个**真**实例自查：健康端点/媒体根可读性/数据目录都要能过（服务状态那条允许 ✗ —— 这是临时进程）
VDTMP="$SB/vd"; mkdir -p "$VDTMP/data" "$VDTMP/media"
cat >"$VDTMP/config.json" <<JSONEOF
{"listen":"127.0.0.1:7794","data_dir":"$VDTMP/data","database_path":"$VDTMP/data/zizvideo.db","media_allow_roots":["$VDTMP/media"],"allow_register":false}
JSONEOF
if [ -x "$ROOT/dist/zizvideo" ]; then
  "$ROOT/dist/zizvideo" --config "$VDTMP/config.json" >"$VDTMP/server.log" 2>&1 &
  vdpid=$!
  i=0; until curl -fsS --max-time 2 http://127.0.0.1:7794/readyz >/dev/null 2>&1 || [ "$i" -ge 20 ]; do sleep 0.3; i=$((i+1)); done
  out=$(bash "$VD" --config "$VDTMP/config.json" --bin "$ROOT/dist/zizvideo" 2>&1)
  kill "$vdpid" 2>/dev/null || true; wait "$vdpid" 2>/dev/null || true
  case "$out" in
    *"回 200"*) ok "自查脚本打通了健康端点（真实例）" ;;
    *) bad "自查脚本没打通健康端点：$(printf '%s' "$out" | tail -3)" ;;
  esac
  case "$out" in
    *"读得到：$VDTMP/media"*) ok "自查脚本验到媒体根可读（真实例）" ;;
    *) bad "自查脚本没验到媒体根：$(printf '%s' "$out" | tail -3)" ;;
  esac
  case "$out" in
    *"readyz.status = ready"*) ok "自查脚本解析 /readyz 的 status" ;;
    *) bad "自查脚本没解析出 readyz.status" ;;
  esac
else
  note_skip "没有 dist/zizvideo，跳过真实例自查"
fi

# --as-daemon：在**守护进程上下文**里探媒体根（macOS 一次性 launchd 作业；全用假 sudo/launchctl）
printf '==> 部署自查脚本的 --as-daemon（守护进程上下文探测）\n'
DA="$(mktemp -d)"; mkdir -p "$DA/daemons" "$DA/data" "$DA/media"
printf '#!/bin/sh\nexec "$@"\n' >"$DA/fake-sudo"; chmod 0755 "$DA/fake-sudo"
cat >"$DA/fake-launchctl" <<'FAKELC'
#!/bin/sh
if [ "$1" = "bootstrap" ]; then
  plist=""
  for a in "$@"; do case "$a" in *.plist) plist="$a" ;; esac; done
  if [ -n "$plist" ]; then
    outp=$(awk '/StandardOutPath/{getline; gsub(/.*<string>|<\/string>.*/,""); print; exit}' "$plist")
    if [ -n "$outp" ]; then printf '%s\n' "$ZV_FAKE_PROBE_JSON" >"$outp"; fi
  fi
fi
exit 0
FAKELC
chmod 0755 "$DA/fake-launchctl"
printf '{"listen":"127.0.0.1:7797","data_dir":"%s/data","database_path":"%s/data/zizvideo.db","media_allow_roots":["%s/media"]}\n' "$DA" "$DA" "$DA" >"$DA/config.json"
da_run() { ZV_FAKE_SUDO=1 ZV_FAKE_SUDO_BIN="$DA/fake-sudo" ZV_FAKE_LAUNCHCTL="$DA/fake-launchctl" \
  ZV_SYSTEM_DAEMON_DIR="$DA/daemons" ZV_ACCESS_PROBE_WAIT=0 ZV_FAKE_PROBE_JSON="$1" \
  bash "$ROOT/tools/verify-deploy.sh" --config "$DA/config.json" --bin /bin/echo --no-service --as-daemon 2>&1; }
out="$(da_run '{"path":"x","readable":true}')"
case "$out" in
  *"✓ 守护进程读得到"*) ok "守护进程上下文读得到时如实报 ✓" ;;
  *) bad "--as-daemon 没报成功：$(printf '%s' "$out" | tail -2)" ;;
esac
out="$(da_run '{"path":"x","readable":false,"reason":"未授予"}')"
case "$out" in
  *"✗ 守护进程读不到"*) ok "守护进程上下文读不到时如实报 ✗" ;;
  *) bad "--as-daemon 没报读不到：$(printf '%s' "$out" | tail -2)" ;;
esac
case "$out" in
  *"完全磁盘访问"*) ok "读不到时给出「完全磁盘访问」的处置指引" ;;
  *) bad "读不到时没有处置指引" ;;
esac
left="$(ls -1 "$DA/daemons" 2>/dev/null | wc -l | tr -d ' ')"
[ "$left" = "0" ] && ok "一次性探测作业的 plist 没残留" || bad "残留了 $left 个探测 plist"
# 拿不到 sudo 时必须**如实拒绝**（不能猜一个"读不到/读得到"给用户）。
# ⚠️ 用一个**只会失败**的 sudo 垫片来模拟"没有 sudo"——决不能让门禁去调真 sudo（铁律 1）。
mkdir -p "$DA/shim"
printf '#!/bin/sh\nexit 1\n' >"$DA/shim/sudo"; chmod 0755 "$DA/shim/sudo"
# ⚠️ 门禁在别处 `export ZV_FAKE_SUDO=1` 了 ⇒ 这里必须显式 -u 摘掉，才真的走到"没有 sudo"分支
out="$(env -u ZV_FAKE_SUDO -u ZV_FAKE_SUDO_BIN PATH="$DA/shim:$PATH" ZV_SYSTEM_DAEMON_DIR="$DA/daemons" \
  ZV_FAKE_LAUNCHCTL="$DA/fake-launchctl" \
  bash "$ROOT/tools/verify-deploy.sh" --config "$DA/config.json" --bin /bin/echo --no-service --as-daemon 2>&1 || true)"
case "$out" in
  *"拿不到 sudo"*) ok "没有 sudo 时明确说"无法在守护进程上下文里探"（不猜结论）" ;;
  *"✓ 守护进程读得到"*|*"✗ 守护进程读不到"*) bad "没有 sudo 却给出了守护进程上下文的结论（凭空猜）" ;;
  *) bad "没有 sudo 时应当如实说「拿不到 sudo」；实际输出：$(printf '%s' "$out" | sed -n '/媒体目录/,$p' | head -6 | tr '\n' ' ')" ;;
esac
# 不带 --as-daemon 时要明确提示"这只是当前身份"
out="$(ZV_FAKE_SUDO=1 ZV_FAKE_SUDO_BIN="$DA/fake-sudo" ZV_FAKE_LAUNCHCTL="$DA/fake-launchctl" \
  ZV_SYSTEM_DAEMON_DIR="$DA/daemons" bash "$ROOT/tools/verify-deploy.sh" --config "$DA/config.json" --bin /bin/echo --no-service 2>&1)"
case "$out" in
  *"当前身份"*"--as-daemon"*) ok "默认明确标注"当前身份 ≠ 守护进程"并指向 --as-daemon" ;;
  *) bad "默认没有把"身份不同"讲清楚" ;;
esac
# 同一份输出里必须**明说"跳过了服务检查"**（容器/--no-service 场景）—— 否则用户会以为服务也验过了
case "$out" in
  *"跳过服务状态检查"*) ok "--no-service 时明说"跳过服务检查"（不让人误以为服务验过了）" ;;
  *) bad "--no-service 时没说清跳过了什么（用户会以为服务验过了）" ;;
esac
rm -rf "$DA"

# 发行目录里的 linux 产物：必须是**静态** ELF 且架构对（极简 NAS 上没有 ld.so/glibc）
RELVER="$(sed -n 's/^VERSION[[:space:]]*?*=[[:space:]]*//p' "$ROOT/Makefile" | head -1)"
for pair in "amd64 62" "arm64 183"; do
  set -- $pair
  f="$ROOT/dist/apps/zizvideo/$RELVER/zizvideo_${RELVER}_linux_$1"
  if [ ! -f "$f" ]; then note_skip "没有 ${f}（先 make release）"; continue; fi
  res=$(python3 - "$f" "$2" <<'PYE'
import struct, sys
path, want = sys.argv[1], int(sys.argv[2])
data = open(path, "rb").read()
if data[:4] != b"\x7fELF": print("不是 ELF"); raise SystemExit
if struct.unpack("<H", data[18:20])[0] != want: print("架构不对"); raise SystemExit
off = struct.unpack("<Q", data[32:40])[0]
sz = struct.unpack("<H", data[54:56])[0]
num = struct.unpack("<H", data[56:58])[0]
if 3 in [struct.unpack("<I", data[off+i*sz:][:4])[0] for i in range(num)]:
    print("动态链接（需要 ld.so）"); raise SystemExit
print("ok")
PYE
)
  [ "$res" = "ok" ] && ok "linux/$1 发行件是静态 ELF 且架构正确" || bad "linux/$1 发行件有问题：$res"
done

# ---------------------------------------------------------------------------
# 三个"生成 config.json 的地方"（飞牛 cmd/main、容器 entrypoint、Linux 安装器）产出必须被**真服务**接受
#
# 为什么值得单独测：这三处是同一件事的三份实现（key 名、listen 形状、database_path 位置各写各的）。
# 只验"JSON 合法"不够 —— 真风险是"真服务不认这份配置"（字段名写错/路径不合法/端口形状不对），
# 而那种错在用户那边表现为"装完起不来"，跟这几行 python 毫无关系、极难查。
printf '==> 三个配置生成器：产出必须能被真服务接受（真起一遍）\n'
CW="$(mktemp -d)"; CW_PORT=7798; mkdir -p "$CW/media"
cfgnote() { printf '  · %s\n' "$*"; }

# ① 飞牛：install_callback 会写配置（并并入系统给的目录）
mkdir -p "$CW/fnos"
TRIM_APPDEST="$CW/platform/fnos/app" TRIM_PKGETC="$CW/platform/fnos/etc" TRIM_PKGVAR="$CW/platform/fnos/var" \
  TRIM_SERVICE_PORT="$CW_PORT" TRIM_DATA_ACCESSIBLE_PATHS="$CW/media" \
  sh "$ROOT/platform/fnos/zizvideo/cmd/main" install_callback >/dev/null 2>&1 || true
# ② 容器：entrypoint.sh 首次启动写配置
mkdir -p "$CW/docker"
ZV_LISTEN="127.0.0.1:$CW_PORT" ZV_DATA_DIR="$CW/docker/data" ZV_MEDIA_ROOTS="$CW/media" ZV_BIN=/bin/true \
  sh "$ROOT/platform/docker/entrypoint.sh" >/dev/null 2>&1 || true
# ③ Linux 安装器：真装一遍（假 systemctl，file:// 当镜像）；配置在它 start 之前就写好，
#    服务起不来不影响我们取配置（但要求配置必须存在，不许"什么都没写"）
mkdir -p "$CW/lin/apps/zizvideo/9.9.9" "$CW/lin/media"
printf '#!/bin/sh\nexit 0\n' >"$CW/lin/apps/zizvideo/9.9.9/zizvideo_9.9.9_linux_arm64"
printf '#!/bin/sh\nexit 0\n' >"$CW/lin/apps/zizvideo/9.9.9/zizvideo_9.9.9_linux_amd64"
printf 'stub darwin\n' >"$CW/lin/apps/zizvideo/9.9.9/zizvideo_9.9.9_darwin_arm64"
chmod 0755 "$CW/lin/apps/zizvideo/9.9.9"/zizvideo_9.9.9_linux_*
if python3 "$ROOT/tools/make-app-index.py" "$CW/lin/apps/zizvideo/9.9.9" 9.9.9 >/dev/null 2>&1; then
  ZV_ALLOW_ANY_OS=1 ZV_ALLOW_NONROOT=1 ZV_INSTALL_PREFIX="$CW/lin/bin" ZV_SYSTEMD_DIR="$CW/lin/systemd" \
    ZV_DATA_ROOT="$CW/lin/data" ZV_CONF_DIR="$CW/lin/conf" ZV_FAKE_SYSTEMCTL=/bin/true \
    ZV_FAKE_USERADD=/bin/true ZV_FAKE_ID=/usr/bin/id ZV_ACCESS_PROBE_WAIT=0 \
    bash "$ROOT/platform/linux/install-zizvideo-linux.sh" --mirror "file://$CW/lin" --listen "127.0.0.1:$CW_PORT" \
    >/dev/null 2>&1 || true
fi

for spec in "飞牛cmd/main:$CW/platform/fnos/etc/config.json" "容器entrypoint:$CW/docker/data/config.json" "Linux安装器:$CW/lin/conf/config.json"; do
  name="${spec%%:*}"; cfg="${spec#*:}"
  if [ ! -f "$cfg" ]; then
    bad "$name 没有生成配置：$cfg"
    continue
  fi
  cfg_err="$(python3 -c 'import json,sys
cfg = json.load(open(sys.argv[1]))
missing = [k for k in ("listen","data_dir","database_path","media_allow_roots","allow_register") if k not in cfg]
assert not missing, "缺字段 %s" % missing
db, data = cfg["database_path"], cfg["data_dir"].rstrip("/")
assert db.startswith(data + "/"), "database_path=%s 不在 data_dir=%s 内（备份/卸载会漏掉它）" % (db, data)
assert ":" in cfg["listen"], "listen 形状不对：%r" % cfg["listen"]
' "$cfg" 2>&1)" && ok "$name 生成的配置结构正确（5 个共享字段都在、库在数据目录内、listen 形状对）" \
    || bad "$name 生成的配置结构不对：$cfg_err"
  # 真起一遍：HTTP 200 且 db 检查通过（有真服务认可才算数）
  port="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["listen"].split(":")[-1])' "$cfg")"
  # 日志名不能用带 `/` 的 name（"飞牛cmd/main" 会让重定向直接失败、服务根本没起 —— 踩过）
  safe="$(printf '%s' "$name" | tr '/ ' '__')"
  "$ROOT/dist/zizvideo" --config "$cfg" >"$CW/${safe}.log" 2>&1 &
  srv=$!
  i=0; body=""; code="000"
  while [ "$i" -lt 40 ]; do
    # ⚠️ 必须看**状态码**：curl -f 会把 503（服务在跑但自检没过）当成失败，与"根本没响应"无法区分
    code="$(curl -s -o "$CW/readyz.json" -w '%{http_code}' --max-time 2 "http://127.0.0.1:$port/readyz" 2>/dev/null || echo 000)"
    body="$(cat "$CW/readyz.json" 2>/dev/null || true)"
    [ "$code" = "200" ] && break
    case "$code" in 5*) break ;; esac   # 5xx = 服务在跑但没就绪，别等到超时
    sleep 0.3; i=$((i + 1))
  done
  kill "$srv" 2>/dev/null || true; wait "$srv" 2>/dev/null || true
  if [ "$code" = "000" ] || [ -z "$body" ]; then
    bad "$name 的配置服务起不来（/readyz 无响应）；日志尾部：$(tail -2 "$CW/${safe}.log" | tr '\n' ' ')"
  else
    dbok="$(printf '%s' "$body" | python3 -c 'import json,sys
try:
    d = json.load(sys.stdin)
except Exception:
    print("no"); raise SystemExit
checks = (d.get("data") or {}).get("checks") or {}
print("yes" if (checks.get("db") or {}).get("ok") else "no")' 2>/dev/null || echo no)"
    if [ "$code" = "200" ] && [ "$dbok" = "yes" ]; then
      ok "$name 的配置**真服务接受**（起得来、/readyz 200、db 检查 ok）"
    else
      bad "$name 的配置没被服务接受（HTTP ${code}，db=${dbok}）：$(printf '%s' "$body" | head -c 200)"
    fi
  fi
done
# ④b 三个生成器的**字段集必须一致**（同一应用不该按平台给不同默认：
#     `scan_workers` 原来只有 Linux 安装器写了 2，飞牛/容器漏了 ⇒ 小 NAS 上并发 4 个探测偏重）
python3 - "$CW/platform/fnos/etc/config.json" "$CW/docker/data/config.json" "$CW/lin/conf/config.json" <<'PYFS' \
  && ok "三个配置生成器的字段集一致（同一应用同一套默认）" \
  || bad "三个配置生成器的字段集不一致（平台间默认漂移）"
import json, sys
sets = []
for p in sys.argv[1:]:
    with open(p) as f:
        sets.append(set(json.load(f)))
if not all(s == sets[0] for s in sets):
    print("字段集不同：%s" % [sorted(s) for s in sets]); raise SystemExit(1)
if "scan_workers" not in sets[0]:
    print("scan_workers 没写（NAS 上并发探测数应显式给）"); raise SystemExit(1)
PYFS

# ④ 记下一条**语义**：媒体根不存在 ⇒ /readyz 503（"服务在跑但没就绪"）。容器编排器会把 503 当没就绪，
#    所以容器入口已经改成"只把存在的媒体根写进配置"（见 platform/docker/entrypoint.sh）。
printf '#!/bin/sh\nexit 0\n' >"$CW/media-probe.json"
mkdir -p "$CW/missing-test"
printf '{"listen":"127.0.0.1:7798","data_dir":"%s/missing-test","database_path":"%s/missing-test/zizvideo.db","media_allow_roots":["%s/不存在"],"allow_register":false}\n' "$CW" "$CW" "$CW" >"$CW/missing.json"
"$ROOT/dist/zizvideo" --config "$CW/missing.json" >"$CW/missing.log" 2>&1 &
msrv=$!
i=0; mcode="000"
while [ "$i" -lt 40 ]; do
  mcode="$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 http://127.0.0.1:7798/readyz 2>/dev/null || echo 000)"
  case "$mcode" in 200|5*) break ;; esac
  sleep 0.3; i=$((i + 1))
done
[ "$mcode" = "503" ] && ok "媒体根不存在时 /readyz 回 503（明确"没就绪"，不是假装健康也不是无响应）" \
  || bad "媒体根不存在时的 /readyz 状态码是 ${mcode}（期望 503）"
# 503 必须被**翻译成人话**：否则用户会去重启服务，而该做的是挂盘 / 建目录 / 装 ffmpeg
vout="$(bash "$ROOT/tools/verify-deploy.sh" --config "$CW/missing.json" --bin "$ROOT/dist/zizvideo" --no-service 2>&1 || true)"
case "$vout" in
  *"服务在跑，但自检没过"*) ok "自查脚本把 503 说成「服务在跑但自检没过」（不是服务没起来）" ;;
  *) bad "自查脚本对 503 的解释不清：$(printf '%s' "$vout" | grep -E 'readyz' | head -2 | tr '\n' ' ')" ;;
esac
case "$vout" in
  *"目录不存在（挂盘了吗？）或权限不够"*) ok "自查脚本把原因指到媒体根（挂盘/权限），而不是"服务坏了"" ;;
  *) bad "自查脚本没把原因指到媒体根：$(printf '%s' "$vout" | grep '没过' | head -2 | tr '\n' ' ')" ;;
esac
case "$vout" in
  *"挂盘了吗"*) ok "媒体根不存在时明确说「挂盘了吗」" ;;
  *) bad "媒体根不存在时没给"挂盘"提示" ;;
esac
# 飞牛 start 的日志也要把 503 翻译出来（用户看的就是那里）
FR="$(mktemp -d)"; mkdir -p "$FR/var" "$FR/etc" "$FR/app/bin"
printf '{"listen":"127.0.0.1:7799","data_dir":"%s/var","database_path":"%s/var/zizvideo.db","media_allow_roots":["%s/不存在"],"allow_register":false}\n' "$FR" "$FR" "$FR" >"$FR/etc/config.json"
printf '#!/bin/sh\nexec %s/dist/zizvideo --config "%s/etc/config.json"\n' "$ROOT" "$FR" >"$FR/app/bin/zizvideo"
chmod 0755 "$FR/app/bin/zizvideo"
fout="$(TRIM_APPDEST="$FR/app" TRIM_PKGETC="$FR/etc" TRIM_PKGVAR="$FR/var" TRIM_SERVICE_PORT=7799 \
  sh "$ROOT/platform/fnos/zizvideo/cmd/main" start 2>&1 || true)"
TRIM_APPDEST="$FR/app" TRIM_PKGETC="$FR/etc" TRIM_PKGVAR="$FR/var" sh "$ROOT/platform/fnos/zizvideo/cmd/main" stop >/dev/null 2>&1 || true
case "$fout" in
  *"自检没过（HTTP 503）"*) ok "飞牛 start 日志把 503 说清楚（不是「服务没起来」）" ;;
  *) bad "飞牛 start 没解释 503：$(printf '%s' "$fout" | tail -2 | tr '\n' ' ')" ;;
esac
case "$fout" in
  *"授权目录"*|*"zizvideo/media"*) ok "飞牛日志给出该怎么做（授权目录 / 放进共享目录）" ;;
  *) bad "飞牛日志没给处置办法" ;;
esac
kill "$msrv" 2>/dev/null || true; wait "$msrv" 2>/dev/null || true
rm -rf "$FR"
# 结论必须能区分"服务在跑但没就绪"（退出码 3）与"服务没起来"（1）：两件事该做的不一样。
# 两个实现（安装器 --verify 与自查脚本）在**同一场景**要给出同样的退出码。
VH="$(mktemp -d)"; mkdir -p "$VH/media" "$VH/home/zizvideo" "$VH/bin" "$VH/daemons"
printf '{"listen":"127.0.0.1:7808","data_dir":"%s/home/zizvideo","database_path":"%s/home/zizvideo/zizvideo.db","media_allow_roots":["%s/media"],"allow_register":false}\n' "$VH" "$VH" "$VH" \
  >"$VH/home/zizvideo/config.json"
# 假二进制要能回答 verifier 的两种调用：--version 与 check-access <路径>
cat >"$VH/bin/zizvideo" <<'FAKEBIN'
#!/bin/sh
case "$1" in
  --version) echo "zizvideo 9.9.9"; exit 0 ;;
  check-access) printf '{"path":"%s","readable":true,"reason":"假二进制"}\n' "$2"; exit 0 ;;
  *) exit 0 ;;
esac
FAKEBIN
chmod 0755 "$VH/bin/zizvideo"
cat >"$VH/lc" <<'FAKELC3'
#!/bin/sh
if [ "$1" = "print" ]; then echo "	state = running"; exit 0; fi
if [ "$1" = "bootstrap" ]; then
  plist=""
  for a in "$@"; do case "$a" in *.plist) plist="$a" ;; esac; done
  if [ -n "$plist" ]; then
    outp=$(awk '/StandardOutPath/{getline; gsub(/.*<string>|<\/string>.*/,""); print; exit}' "$plist")
    if [ -n "$outp" ]; then printf '%s\n' "${ZV_FAKE_PROBE_JSON:-{\"path\":\"x\",\"readable\":true}}" >"$outp"; fi
  fi
fi
exit 0
FAKELC3
chmod 0755 "$VH/lc"
# ① 健康场景（真服务在跑、媒体根存在）：两个实现都应给 0
"$ROOT/dist/zizvideo" --config "$VH/home/zizvideo/config.json" >"$VH/srv.log" 2>&1 &
vsrv=$!
i=0; until curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:7808/readyz 2>/dev/null | grep -q 200 || [ "$i" -ge 30 ]; do sleep 0.3; i=$((i+1)); done
HOME="$VH/home" ZV_FAKE_SUDO=1 ZV_FAKE_SUDO_BIN=/usr/bin/env ZV_FAKE_LAUNCHCTL="$VH/lc" \
  ZV_SYSTEM_DAEMON_DIR="$VH/daemons" ZV_INSTALL_ROOT="$VH" bash "$ROOT/platform/macos/install-zizvideo.sh" --verify >/dev/null 2>&1
rc_i=$?
vout_ok="$(bash "$ROOT/tools/verify-deploy.sh" --config "$VH/home/zizvideo/config.json" \
  --bin "$VH/bin/zizvideo" --no-service 2>&1)"
rc_v=$?
[ "$rc_i" = "0" ] && ok "健康场景：安装器 --verify 退出码 0" || bad "健康场景安装器 --verify 退出码 ${rc_i}（期望 0）"
[ "$rc_v" = "0" ] && ok "健康场景：自查脚本退出码 0（两实现一致）" \
  || bad "健康场景自查脚本退出码 ${rc_v}（期望 0）：$(printf '%s' "$vout_ok" | grep '✗' | head -3 | tr '\n' ' ')"
kill "$vsrv" 2>/dev/null || true; wait "$vsrv" 2>/dev/null || true
# ② 在跑但没就绪（媒体根不存在）：两个实现都应给 **3**（≠1，因为服务确实在跑）
printf '{"listen":"127.0.0.1:7808","data_dir":"%s/home/zizvideo","database_path":"%s/home/zizvideo/zizvideo.db","media_allow_roots":["%s/不存在"],"allow_register":false}\n' "$VH" "$VH" "$VH" \
  >"$VH/home/zizvideo/config.json"
"$ROOT/dist/zizvideo" --config "$VH/home/zizvideo/config.json" >"$VH/srv2.log" 2>&1 &
vsrv2=$!
i=0; until [ "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:7808/readyz 2>/dev/null || echo 000)" = "503" ] || [ "$i" -ge 30 ]; do sleep 0.3; i=$((i+1)); done
HOME="$VH/home" ZV_FAKE_SUDO=1 ZV_FAKE_SUDO_BIN=/usr/bin/env ZV_FAKE_LAUNCHCTL="$VH/lc" \
  ZV_SYSTEM_DAEMON_DIR="$VH/daemons" ZV_INSTALL_ROOT="$VH" bash "$ROOT/platform/macos/install-zizvideo.sh" --verify >/dev/null 2>&1
rc_i2=$?
bash "$ROOT/tools/verify-deploy.sh" --config "$VH/home/zizvideo/config.json" \
  --bin "$VH/bin/zizvideo" --no-service >/dev/null 2>&1
rc_v2=$?
[ "$rc_i2" = "3" ] && ok "没就绪场景：安装器 --verify 退出码 3（在跑但没就绪，≠1）" || bad "安装器 --verify 退出码 ${rc_i2}（期望 3）"
[ "$rc_v2" = "3" ] && ok "没就绪场景：自查脚本退出码 3（两实现一致）" || bad "自查脚本退出码 ${rc_v2}（期望 3）"
kill "$vsrv2" 2>/dev/null || true; wait "$vsrv2" 2>/dev/null || true
# ③ 服务没起来（把服务停掉再验）：应给 1（"服务不可用"，与"没就绪"区分开）
HOME="$VH/home" ZV_FAKE_SUDO=1 ZV_FAKE_SUDO_BIN=/usr/bin/env ZV_FAKE_LAUNCHCTL="$VH/lc" \
  ZV_SYSTEM_DAEMON_DIR="$VH/daemons" ZV_INSTALL_ROOT="$VH" bash "$ROOT/platform/macos/install-zizvideo.sh" --verify >/dev/null 2>&1
rc_i3=$?
[ "$rc_i3" = "1" ] && ok "服务不可用场景：安装器 --verify 退出码 1（与"没就绪"区分）" || bad "安装器 --verify 退出码 ${rc_i3}（期望 1）"
rm -rf "$VH"
rm -rf "$CW"

# ---------------------------------------------------------------------------
# 真索引端到端：用**真的** tools/make-app-index.py 生成索引，再让 Linux 安装器按它挑包
#
# 为什么必须这样测：安装器与索引生成器是两个独立组件，只在"字段名/形状一致"这一层耦合。
# 各自用假数据都能过，但真发出去就会"挑不到架构/校验不过"。这里让两个真组件对接一次。
printf '==> 真索引端到端（make-app-index.py → platform/linux/install-zizvideo-linux.sh）\n'
RELVER_NOW="$(sed -n 's/^VERSION[[:space:]]*?*=[[:space:]]*//p' "$ROOT/Makefile" | head -1)"
REAL_AMD64="$ROOT/dist/apps/zizvideo/$RELVER_NOW/zizvideo_${RELVER_NOW}_linux_amd64"
REAL_ARM64="$ROOT/dist/apps/zizvideo/$RELVER_NOW/zizvideo_${RELVER_NOW}_linux_arm64"
if [ -f "$REAL_AMD64" ] && [ -f "$REAL_ARM64" ]; then
  IDX="$(mktemp -d)"; VERFAKE="1.2.3"   # 用一个"新版本号"，把真产物按新名字放进去
  VF="$IDX/apps/zizvideo/zizvideo-${VERFAKE}"   # 仅占位，索引只看版本目录里的文件名
  mkdir -p "$IDX/apps/zizvideo/${VERFAKE}"
  cp "$REAL_AMD64" "$IDX/apps/zizvideo/${VERFAKE}/zizvideo_${VERFAKE}_linux_amd64"
  cp "$REAL_ARM64" "$IDX/apps/zizvideo/${VERFAKE}/zizvideo_${VERFAKE}_linux_arm64"
  # ⚠️ 索引生成器**要求至少一个 darwin 产物**（manifest.json 是面板契约，latest 不能为空）⇒
  # linux.json 只会在"跟 darwin 一起发"时生成。这里放一个占位 darwin 文件即可（本用例只走 linux 路径）。
  printf 'stub-darwin-binary\n' >"$IDX/apps/zizvideo/${VERFAKE}/zizvideo_${VERFAKE}_darwin_arm64"
  if python3 "$ROOT/tools/make-app-index.py" "$IDX/apps/zizvideo/${VERFAKE}" "$VERFAKE" >/dev/null 2>&1 \
     && [ -f "$IDX/apps/zizvideo/linux.json" ]; then
    ok "make-app-index.py 从真产物生成了 linux.json"
    # ① 安装器能按真索引挑到本机架构的包（dry-run，不落盘）
    ldrive() { ZV_ALLOW_ANY_OS=1 ZV_ALLOW_NONROOT=1 ZV_INSTALL_PREFIX="$IDX/bin" \
      ZV_SYSTEMD_DIR="$IDX/systemd" ZV_DATA_ROOT="$IDX/data" ZV_CONF_DIR="$IDX/conf" \
      ZV_FAKE_SYSTEMCTL=/bin/true ZV_FAKE_USERADD=/bin/true ZV_FAKE_ID=/usr/bin/id \
      bash "$ROOT/platform/linux/install-zizvideo-linux.sh" --mirror "file://$IDX" "$@"; }
    if lout="$(ldrive --dry-run 2>&1)"; then
      case "$lout" in
        *"版本 $VERFAKE"*) ok "安装器从**真索引**里读到版本 $VERFAKE" ;;
        *) bad "安装器没读出真索引的版本：$(printf '%s' "$lout" | tail -2)" ;;
      esac
      case "$lout" in
        *"sha256 校验通过"*) ok "安装器用真索引的 sha256 校验通过（两个组件字段对得上）" ;;
        *) bad "安装器没做/没过 sha256 校验：$(printf '%s' "$lout" | tail -2)" ;;
      esac
    else
      bad "安装器读真索引失败：$(printf '%s' "$lout" | tail -3)"
    fi
    # ② 明确钉一个过期版本时必须拒绝（别把旧包装上去）
    if lout="$(ldrive --version 0.0.1 --dry-run 2>&1)"; then
      bad "钉了不存在的版本竟然还成功：$(printf '%s' "$lout" | tail -2)"
    else
      case "$lout" in
        *"版本已翻页"*) ok "钉过期版本被拒（不装旧包）" ;;
        *) bad "钉过期版本的报错不对：$(printf '%s' "$lout" | tail -2)" ;;
      esac
    fi
    # ③ 索引里的 sha256 被改坏时，安装器必须拒绝（真索引 + 真安装器的失败路径）
    python3 - "$IDX/apps/zizvideo/linux.json" <<'PYB2'
import json, sys
p = sys.argv[1]
d = json.load(open(p))
for row in d["assets"]:
    row["sha256"] = "1" * 64
json.dump(d, open(p, "w"))
PYB2
    if lout="$(ldrive --dry-run 2>&1)"; then
      bad "真索引 sha256 被改坏后安装器竟然还成功"
    else
      case "$lout" in
        *"sha256 不符"*) ok "真索引 sha256 不符时安装器拒绝安装" ;;
        *) bad "sha256 不符的报错不对：$(printf '%s' "$lout" | tail -2)" ;;
      esac
    fi
  else
    bad "make-app-index.py 没能在真产物上生成 linux.json"
  fi
  rm -rf "$IDX"
else
  note_skip "没有 linux 发行件（先 make release），跳过真索引端到端"
fi

# ---------------------------------------------------------------------------
# 发版前自检与发布链路判据：**假镜像七种场景**合并到 tools/check-release-flow.py
# （一致的目录能过 / sha256 改坏必须指名报错 / latest 不符 / 线上字节一致 / 产物被换过 /
#  本地有镜像没有=漏传 / 两份索引不一致）—— 一堆零散断言换成一个可独立运行的校验器
printf '==> 发版前自检与发布链路判据（索引 ↔ 产物 / 线上字节 / 漏传 / latest）\n'
if rflow="$(python3 "$ROOT/tools/check-release-flow.py" 2>&1)"; then
  ok "发布链路判据自测：$(printf '%s' "$rflow" | tail -1)"
else
  bad "发布链路判据自测不过：$(printf '%s' "$rflow" | grep '✗' | head -3 | tr '\n' ' ')"
fi
CRD="$ROOT/tools/check-release-dir.sh"
bash -n "$CRD" && ok "check-release-dir.sh 通过语法检查" || bad "check-release-dir.sh 语法错"
# 真实 dist（存在就顺手验一遍；不存在不阻塞）
# 真实 dist（存在就顺手验一遍；不存在不阻塞）
if [ -d "$ROOT/dist/apps/zizvideo/$RELVER" ]; then
  bash "$CRD" >/dev/null 2>&1 && ok "当前 dist 的发布目录自检通过" || bad "当前 dist 的发布目录自检没过（跑 make release-check 看细节）"
fi

# ---------------------------------------------------------------------------
fda_case() { # $1 = config JSON；$2 = 探测结果 JSON；$3 = 等待秒数；回显 check_full_disk_access 的输出
  (
    export HOME="$SB/home-fda"
    mkdir -p "$HOME/zizvideo"
    export ZV_LIB_ONLY=1
    # shellcheck disable=SC1090
    . "$SCRIPT"
    derive_paths
    printf '%b' "$1" >"$CONFIG_PATH"
    BIN="$SB/bin/zizvideo"; mkdir -p "$SB/bin"; : >"$BIN"; chmod 0755 "$BIN"
    MODE=system; TARGET_USER="$(id -un)"
    ZV_FAKE_PROBE_JSON="$2" ZV_ACCESS_PROBE_WAIT="$3" check_full_disk_access
  )
}
printf '==> 完全磁盘访问阶段（在守护进程上下文里探媒体根；缺授权要引导且不阻断安装）\n'
CFG_ROOT='{\n  "data_dir": "%s",\n  "media_allow_roots": ["%s"]\n}\n'

# ① 读得到：如实报告、不打扰用户
: >"$OPEN_LOG"
out=$(fda_case "$(printf "$CFG_ROOT" "$SB/home-fda/zizvideo" "$SB/media")" \
  '{"path":"PROBE","readable":true}' 0 2>&1)
case "$out" in
  *"✓ 守护进程读得到"*) ok "探测到可读时如实报告" ;;
  *) bad "可读时没有报告成功：$out" ;;
esac
case "$out" in
  *"隐私与安全性"*) bad "可读时不该打印授权引导" ;;
  *) ok "可读时不打扰用户（没有引导块）" ;;
esac

# ② 读不到：必须引导（系统设置 + 二进制路径 + 影响），ZV_ACCESS_PROBE_WAIT=0 时不等待、不失败
: >"$OPEN_LOG"
if out=$(fda_case "$(printf "$CFG_ROOT" "$SB/home-fda/zizvideo" "$SB/media")" \
     '{"path":"PROBE","readable":false,"reason":"未授予"}' 0 2>&1); then
  ok "缺授权时**不阻断安装**（返回 0，如实报告）"
else
  bad "缺授权不该让安装失败"
fi
case "$out" in
  *"隐私与安全性"*) ok "缺授权时给出「系统设置 → 隐私与安全性 → 完全磁盘访问」的指引" ;;
  *) bad "缺授权时没有指引：$out" ;;
esac
case "$out" in
  *"$SB/bin/zizvideo"*) ok "指引里写清了要授权的二进制路径" ;;
  *) bad "指引里没写二进制路径：$out" ;;
esac
case "$out" in
  *"不会被扫描到"*) ok "讲清了影响（那些目录里的媒体扫不到）" ;;
  *) bad "没讲清影响：$out" ;;
esac
case "$out" in
  *"不等待"*) ok "ZV_ACCESS_PROBE_WAIT=0 时不等待" ;;
  *) bad "0 秒等待没有明说不等待：$out" ;;
esac
if grep -q "Privacy_AllFiles" "$OPEN_LOG" && grep -q -- "-R" "$OPEN_LOG"; then
  ok "用假 open 打开了完全磁盘访问面板并在 Finder 里选中二进制"
else
  bad "没有调用 open 打开设置面板/选中二进制：$(cat "$OPEN_LOG")"
fi

# ②b 带**空格**的媒体根：权限阶段必须把它当成一个目标（切碎了就会报"探了几个不存在的位置"）
SP2="$(mktemp -d)"; mkdir -p "$SP2/home-fda/zizvideo" "$SP2/My Drive/视频"
printf '{\n  "data_dir": "%s",\n  "media_allow_roots": ["%s/My Drive/视频"]\n}\n' "$SP2/data" "$SP2" \
  >"$SP2/home-fda/zizvideo/config.json"
out=$(fda_case "$(cat "$SP2/home-fda/zizvideo/config.json")" \
  '{"path":"x","readable":true}' 0 2>&1)
n_sp="$(printf '%s' "$out" | grep -c "守护进程读得到：$SP2/My Drive/视频" || true)"
[ "$n_sp" = "1" ] && ok "权限阶段把带空格的媒体根当成一个目标（没被空格切碎）" \
  || bad "权限阶段切碎了带空格的路径（匹配 ${n_sp} 行）：$(printf '%s' "$out" | grep '读' | head -3 | tr '\n' ' ')"
rm -rf "$SP2"

# ③ 没有配媒体根时退回 --fda 哨兵探测
: >"$OPEN_LOG"
out=$(fda_case '{\n  "data_dir": "%s"\n}\n' '{"path":"PROBE","readable":true,"mode":"fda"}' 0 2>&1)
case "$out" in
  *"--fda"*|*"哨兵"*|*"✓ 守护进程读得到"*) ok "没配媒体根时退回 --fda 探测" ;;
  *) bad "没有退回 --fda：$out" ;;
esac

# ④ 探测用的临时 plist 必须清干净（不许留在 LaunchDaemons 里）
leftover=$(find "$SB/LaunchDaemons" -name '*.accessprobe.*' 2>/dev/null | wc -l | tr -d ' ')
if [ "$leftover" = "0" ]; then
  ok "一次性探测作业的 plist 已清理（没有残留）"
else
  bad "残留了 $leftover 个探测 plist：$(find "$SB/LaunchDaemons" -name '*.accessprobe.*')"
fi

# ---------------------------------------------------------------------------
# 所有 shell 脚本的语法 + 一个 macOS bash 的坑：`$var` 紧挨中文字符会被当成变量名的一部分。
#
# 为什么值得拦（2026-10-11 亲自踩到）：我写的 `ok "…：${target}（模块缓存命中）"` 在 macOS 自带
# bash 3.2 下报 `targetï…: unbound variable` —— bash 把全角括号的字节也吃进变量名了。
# `set -u` 下直接炸，`set +u` 下会静默变成空串拼进消息。这类错一旦混进安装器就是"用户看到
# 一句缺字的提示"或者"安装到一半退出"。**判据：变量后面紧跟非 ASCII 时一律写 `${var}`。**


# ---------------------------------------------------------------------------
# 独立部署的目标平台必须能构建出来（这属于"安装器这条路走不走得通"的一部分）：
# 安装器支持 Linux（飞牛/NAS 等），而本机是 macOS —— 至少在这里静态证一遍交叉编译。
# 先只用模块缓存（GOPROXY=off，正常开发机上缓存必然是热的，不依赖任何镜像）；
# 缓存不全再退回环境里配的 GOPROXY（本机是 goproxy.cn，proxy.golang.org 不可达）。
# 不新增门禁条目：直接并进这条已有的"独立部署"门禁。
printf '==> 交叉编译（独立部署目标：linux/amd64 + linux/arm64，CGO_ENABLED=0）\n'
if command -v go >/dev/null 2>&1; then
  XTMP="$(mktemp -d)"
  for target in linux/amd64 linux/arm64; do
    XBIN="$XTMP/zv-$target"
    XENV="GOOS=${target%/*} GOARCH=${target#*/} CGO_ENABLED=0"
    [ -n "$REAL_GOMODCACHE" ] && XENV="$XENV GOMODCACHE=$REAL_GOMODCACHE"
    if (cd "$ROOT" && env $XENV GOPROXY=off go build -o "$XBIN" ./cmd/server) 2>"$XTMP/err.log"; then
      ok "交叉编译通过：${target}（模块缓存命中，$(wc -c < "$XBIN" | tr -d ' ') 字节）"
    elif (cd "$ROOT" && env $XENV go build -o "$XBIN" ./cmd/server) 2>"$XTMP/err2.log"; then
      ok "交叉编译通过：${target}（走了 GOPROXY=${GOPROXY:-默认}，$(wc -c < "$XBIN" | tr -d ' ') 字节）"
    else
      bad "交叉编译失败：$target —— $(tail -2 "$XTMP/err2.log" "$XTMP/err.log" 2>/dev/null | tr '\n' ' ')"
    fi
  done
  rm -rf "$XTMP"
else
  bad "PATH 里没有 go，无法验证交叉编译（独立部署门禁必须真跑）"
fi

# ---------------------------------------------------------------------------
printf '==> 全程没碰真 sudo（PATH 垫片日志为空）\n'
if [ ! -s "$SUDO_LOG" ]; then
  ok "sudo 垫片一次都没被调用"
else
  bad "有代码走了真 sudo 这条路：$(cat "$SUDO_LOG")"
fi

if [ "$FAIL" = "0" ]; then
  printf '安装器门禁通过 ✅\n'
  exit 0
fi
printf '安装器门禁未通过 ❌（上面每条 !! 都要修）\n' >&2
exit 1
