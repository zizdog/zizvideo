#!/usr/bin/env bash
# ============================================================================
#  tools/test-installer.sh —— install-zizvideo.sh 的回归门禁（make check-run 里跑）。
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
SCRIPT="$ROOT/install-zizvideo.sh"
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

CFG_DIR="$HOME/Library/Application Support/zizvideo"
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

printf '==> --purge 合法 data_dir（$HOME/Library/Application Support/ 之下）要放行并打印计划\n'
write_cfg "$CFG_DIR"
if bash "$SCRIPT" --purge --dry-run >"$OUT" 2>&1 && grep -q "将删除" "$OUT" && grep -qF "${CFG_DIR}（含数据库" "$OUT"; then
  ok "合法 data_dir 打印了删除计划：$CFG_DIR"
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
    mkdir -p "$HOME/Library/Application Support/zizvideo"
    export ZV_LIB_ONLY=1
    # shellcheck disable=SC1090
    . "$SCRIPT"
    derive_paths
    printf '%b' "$1" >"$CONFIG_PATH"
    LISTEN="$2"; LISTEN_GIVEN=1
    ensure_config >/dev/null
  )
}
LCFG="$SB/home-listen/Library/Application Support/zizvideo/config.json"
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
# Linux / systemd 安装器（install-zizvideo-linux.sh）：沙箱里真跑一遍
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
LINUX_INSTALLER="$ROOT/install-zizvideo-linux.sh"
linux_run() { # 回显安装器输出；参数原样传给安装器
  ZV_ALLOW_ANY_OS=1 ZV_ALLOW_NONROOT=1 ZV_INSTALL_PREFIX="$LROOT/bin" ZV_SYSTEMD_DIR="$LROOT/systemd" \
    ZV_DATA_ROOT="$LROOT/data" ZV_CONF_DIR="$LROOT/conf" ZV_FAKE_SYSTEMCTL="$LROOT/systemctl" \
    ZV_FAKE_USERADD="$LROOT/useradd" ZV_FAKE_ID="$LROOT/id" \
    bash "$LINUX_INSTALLER" --mirror "file://$LROOT/mirror" "$@" 2>&1
}

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
FNOS="$ROOT/fnos/zizvideo"
for f in manifest ICON.PNG ICON_256.PNG cmd/main config/privilege config/resource app/ui/config; do
  [ -e "$FNOS/${f}" ] && ok "存在 ${f}" || bad "缺 ${f}（fnOS 判定包不完整）"
done
# manifest：键值格式（不是 JSON）+ 必需键 + 第三方来源 + 架构不是 all（我们带原生二进制）
if awk -F= 'NF<2 || $1=="" {exit 1}' "$FNOS/manifest"; then
  ok "manifest 是 key=value 格式（不是 JSON）"
else
  bad "manifest 有坏行（fnOS 的 manifest 不是 JSON，每行必须 key=value）"
fi
for k in appname version display_name desc source platform service_port desktop_applaunchname; do
  grep -q "^${k}=" "$FNOS/manifest" && ok "manifest 有 ${k}" || bad "manifest 缺 ${k}"
done
grep -q '^source=thirdparty$' "$FNOS/manifest" && ok "source=thirdparty" || bad "source 必须是 thirdparty"
grep -q '^platform=all$' "$FNOS/manifest" && bad "platform=all 但包里带原生二进制（应该 x86/arm）" || ok "platform 不是 all（带原生二进制时必须分架构）"
# 权限：不许 root、必须 run-as=package
if grep -q '"run-as"[[:space:]]*:[[:space:]]*"package"' "$FNOS/config/privilege"; then
  ok "config/privilege 用 run-as=package（最小权限）"
else
  bad "config/privilege 没有 run-as=package"
fi
grep -qE '"run-as"[[:space:]]*:[[:space:]]*"root"' "$FNOS/config/privilege" && bad "不该用 root 常驻" || ok "没有用 root 常驻"
python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$FNOS/config/privilege" && ok "privilege 是合法 JSON" || bad "privilege 不是合法 JSON"
python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$FNOS/config/resource" && ok "resource 是合法 JSON" || bad "resource 不是合法 JSON"
python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$FNOS/app/ui/config" && ok "app/ui/config 是合法 JSON" || bad "app/ui/config 不是合法 JSON"
for w in install config; do
  if [ -f "$FNOS/wizard/$w" ]; then
    python3 - "$FNOS/wizard/$w" <<'PYW' && ok "wizard/${w} 是合法 JSON 且形状正确" || bad "wizard/${w} 不是合法 JSON / 形状不对"
import json, sys
steps = json.load(open(sys.argv[1]))
assert isinstance(steps, list) and steps, "向导必须是**步骤数组**"
for st in steps:
    assert isinstance(st, dict) and st.get("stepTitle") and isinstance(st.get("items"), list), "每步要有 stepTitle 与 items"
    for it in st["items"]:
        assert it.get("type") in ("text", "password", "radio", "checkbox", "select", "switch", "tips"), "字段类型不认识：%r" % it.get("type")
        if it["type"] != "tips":
            assert it.get("field"), "非 tips 的项必须有 field"
PYW
  else
    bad "缺 wizard/$w"
  fi
done
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
python3 - "$CVD/etc/config.json" <<'PYC' && ok "config_callback 写出的配置是合法 JSON 且端口/媒体根已更新" || bad "config_callback 写坏了配置"
import json, sys
cfg = json.load(open(sys.argv[1]))
assert cfg.get("listen") == "0.0.0.0:8899", cfg.get("listen")
roots = cfg.get("media_allow_roots") or []
assert any(r.startswith("/vol1") for r in roots), roots
PYC
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
if bash "$ROOT/tools/make-fnos-pkg.sh" --stage-only >/dev/null 2>&1; then
  ok "make-fnos-pkg.sh --stage-only 能准备出待打包目录"
else
  bad "make-fnos-pkg.sh --stage-only 失败（待打包目录都出不来）"
fi
if command -v fnpack >/dev/null 2>&1; then
  ok "本机有 fnpack，可以出真 .fpk（make-fnos-pkg.sh）"
else
  ok "本机没有 fnpack：脚本会如实报错而**不**伪造 .fpk（真机打包待有 fnpack 的机器）"
fi

# ---------------------------------------------------------------------------
# 部署自查脚本（tools/verify-deploy.sh）+ 发布件的 Linux 二进制必须真是静态 ELF
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
fda_case() { # $1 = config JSON；$2 = 探测结果 JSON；$3 = 等待秒数；回显 check_full_disk_access 的输出
  (
    export HOME="$SB/home-fda"
    mkdir -p "$HOME/Library/Application Support/zizvideo"
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
out=$(fda_case "$(printf "$CFG_ROOT" "$SB/home-fda/Library/Application Support/zizvideo" "$SB/media")" \
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
if out=$(fda_case "$(printf "$CFG_ROOT" "$SB/home-fda/Library/Application Support/zizvideo" "$SB/media")" \
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
printf '==> shell 语法（含 tools/*.sh）+ `$var` 紧挨中文的坑\n'
for sh in "$ROOT/install-zizvideo.sh" "$ROOT/install-zizvideo-linux.sh" "$ROOT"/tools/*.sh "$ROOT"/fnos/*/cmd/*; do
  [ -f "$sh" ] || continue
  if bash -n "$sh" 2>"$SB/sh-err.log"; then
    :
  else
    bad "bash -n 失败：${sh} —— $(tr '\n' ' ' < "$SB/sh-err.log")"
  fi
done
# ⚠️ 用 LC_ALL=C + POSIX 字符类，**不能用 `grep -P`**：BSD grep 不支持 -P，只会报错、
# 输出为空 ⇒ 门禁变成永远绿的摆设（我第一版就是这么写的，灵敏度一测就露了）。
BAD_VAR="$(LC_ALL=C grep -nE '\$[A-Za-z_][A-Za-z0-9_]*[^[:print:][:space:]]' \
  "$ROOT/install-zizvideo.sh" "$ROOT/install-zizvideo-linux.sh" "$ROOT"/tools/*.sh "$ROOT"/fnos/*/cmd/* 2>/dev/null | head -5)"
if [ -z "$BAD_VAR" ]; then
  ok "语法全过；没有 \`\$var\` 紧挨中文的写法（要写就写 \${var}）"
else
  bad "有变量紧挨非 ASCII 字符（macOS bash 会把它当变量名的一部分）：$BAD_VAR"
fi

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
