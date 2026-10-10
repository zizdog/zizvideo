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
exit 0
EOF
chmod 0755 "$FAKE_LC"
export ZV_FAKE_LAUNCHCTL="$FAKE_LC"

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
