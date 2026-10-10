#!/usr/bin/env bash
# ============================================================================
#  preflight.sh —— 发布前把所有"证据"跑一遍，给一个结论（`make preflight`）
#
#  为什么要有它：发布前的证据散在六条命令里（沙箱门禁 / 冒烟 / 飞牛真打包 / 真 Linux / 发布目录对账 /
#  镜像漂移），人一忙就会漏跑一条，而漏掉的那条恰好可能是"用户会踩到的那个坑"。
#
#  用法：
#    bash tools/preflight.sh                  # 全跑
#    bash tools/preflight.sh --only smoke     # 只跑某一步（可重复；名字见下）
#    bash tools/preflight.sh --post           # **发布后复核**（= 只跑 post-* 两步 + mirror）
#    bash tools/preflight.sh --list           # 列出步骤名
#  环境：
#    ZV_PREFLIGHT_MIRROR  覆盖镜像地址（默认 https://mirror.zizdog.com:8888）；门禁令用它指向本地目录
#  退出码：0 = 关键步骤全过（SKIP 不算失败，但会在结论里单列）；1 = 有步骤失败
# ============================================================================
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MIRROR="${ZV_PREFLIGHT_MIRROR:-https://mirror.zizdog.com:8888}"
ONLY=()

STEPS=(
  "check:沙箱门禁与单测（make check）"
  "smoke:端到端冒烟（make smoke，真服务+真 ffmpeg）"
  "fpk:飞牛真打包 + 解开核对 23 项（make fpk-check）"
  "linux:发布的 Linux 二进制在真 Linux（容器）跑全链路（make linux-verify API=1）"
  "release:发布目录索引 ↔ 产物 + Linux 验证 stamp 对账（make release-check）"
  "mirror:镜像上的安装器/清单与我们验过的是否同一份字节"
  "post-artifacts:发布后复核：线上产物与索引里的 sha256/size 是否一致（下载复算）"
  "post-latest:发布后复核：镜像 latest 是否就是本版本"
)

while [ $# -gt 0 ]; do
  case "$1" in
    --only) ONLY+=("$2"); shift 2 ;;
    --list) for s in "${STEPS[@]}"; do printf '%s\n' "${s%%:*}"; done; exit 0 ;;
    --post) ONLY=("mirror" "post-artifacts" "post-latest"); shift ;;
    --help|-h) sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "!! 未知参数：$1（--help 看用法）" >&2; exit 2 ;;
  esac
done
wanted() { [ "${#ONLY[@]}" -eq 0 ] && return 0; for o in "${ONLY[@]}"; do [ "$o" = "$1" ] && return 0; done; return 1; }

PASS=0; FAIL=0; SKIP=0
declare -a SUMMARY=()
step_ok()   { PASS=$((PASS + 1)); SUMMARY+=("✓ $1"); }
step_bad()  { FAIL=$((FAIL + 1)); SUMMARY+=("✗ $1"); }
step_skip() { SKIP=$((SKIP + 1)); SUMMARY+=("· $1（跳过：$2）"); }   # SKIP 不算失败，但必须写清原因

run_make() { # run_make <名字> <失败说明> <make 参数...>
  local name="$1" hint="$2"; shift 2
  printf '\n──── %s ────\n' "$name"
  if ( cd "$ROOT" && make "$@" ); then
    step_ok "$name"
  else
    step_bad "$name —— $hint"
  fi
}

# ---- check / smoke / fpk / linux / release ------------------------------------
if wanted check; then
  run_make "沙箱门禁与单测" "看上面第一条报错（门禁红了不许发）" check
fi
if wanted smoke; then
  run_make "端到端冒烟" "冒烟失败通常是服务端行为变了（看上面 HTTP/断言）" smoke
fi
if wanted fpk; then
  printf '\n──── 飞牛真打包 + 自检 ────\n'
  if ! command -v fnpack >/dev/null 2>&1 && [ ! -x "$ROOT/.tools/fnpack" ]; then
    step_skip "飞牛包" "没有 fnpack（官方打包器）"
  elif ( cd "$ROOT" && make fpk >/dev/null 2>&1 ) && ( cd "$ROOT" && make fpk-check ); then
    step_ok "飞牛包（真打包 + 23 项自检）"
  else
    step_bad "飞牛包 —— 自检没过（含"包内二进制与发行件同源"那条）"
  fi
fi
if wanted linux; then
  printf '\n──── 真 Linux（容器）────\n'
  if ! docker info >/dev/null 2>&1; then
    step_skip "真 Linux 验证" "没有可用的 docker daemon（**这不算验过**）"
  elif ( cd "$ROOT" && make linux-verify API=1 ); then
    step_ok "真 Linux 验证（arm64 原生 + amd64 模拟，含 API 全链路）"
  else
    step_bad "真 Linux 验证 —— 发布件在 Linux 上出问题，用户那边就是"装完起不来""
  fi
fi
if wanted release; then
  run_make "发布目录对账" "索引与产物不一致（宁可重跑 make release）" release-check
fi

# ---- 镜像漂移：用户下到的东西，跟我们验过的是不是一份 ------------------------
if wanted mirror; then
  printf '\n──── 镜像漂移（安装器/清单同源）────\n'
  drifted=""
  for f in install-zizvideo.sh install-zizvideo-linux.sh; do
    [ -f "$ROOT/$f" ] || continue
    local_sum="$(python3 -c 'import hashlib,sys; print(hashlib.sha256(open(sys.argv[1],"rb").read()).hexdigest())' "$ROOT/$f")"
    remote_sum="$(curl -fsS --max-time 20 "$MIRROR/apps/zizvideo/$f" 2>/dev/null \
      | python3 -c 'import hashlib,sys; print(hashlib.sha256(sys.stdin.buffer.read()).hexdigest())' 2>/dev/null || true)"
    if [ -z "$remote_sum" ]; then
      printf '  · %s：镜像上取不到（还没发过 / 网络不通），无法比对\n' "$f"
      drifted="$drifted $f(取不到)"
    elif [ "$local_sum" = "$remote_sum" ]; then
      printf '  ✓ %s：与镜像上的逐字节一致（sha256 %s…）\n' "$f" "${local_sum:0:12}"
    else
      printf '  ✗ %s：**镜像上是旧版**（本地 %s… ≠ 镜像 %s…）—— 用户装到的是老安装器\n' \
        "$f" "${local_sum:0:12}" "${remote_sum:0:12}"
      drifted="$drifted $f(旧版)"
    fi
  done
  # 镜像索引的 latest 与我们工作树版本的关系：不一致是**正常的**（发布前就是这样），但要写清楚
  remote_latest="$(curl -fsS --max-time 20 "$MIRROR/apps/zizvideo/manifest.json" 2>/dev/null \
    | python3 -c 'import json,sys; print((json.load(sys.stdin).get("latest") or ""))' 2>/dev/null || true)"
  local_ver="$(sed -n 's/^VERSION[[:space:]]*?*=[[:space:]]*//p' "$ROOT/Makefile" | head -1)"
  printf '  · 镜像 latest = %s；工作树 = %s%s\n' "${remote_latest:-（取不到）}" "$local_ver" \
    "$([ -n "$remote_latest" ] && [ "$remote_latest" != "$local_ver" ] && echo "（发布前正常：镜像还是上一版）")"
  # 判据要分清两种情况（否则每次发布前都会误报"失败"）：
  #   · 镜像 latest ≠ 工作树版本 ⇒ 镜像还是**上一版**，安装器不一致是**正常的**（如实说明，不算失败）；
  #   · 镜像 latest == 工作树版本 ⇒ 同一版本却字节不同 = **真漂移**（违反"同版本不许换字节"）⇒ 失败。
  if [ -z "$drifted" ]; then
    step_ok "镜像漂移（安装器与镜像逐字节一致）"
  elif ! printf '%s' "$drifted" | grep -q "旧版"; then
    step_skip "镜像漂移" "镜像上取不到文件（网络或还没发过）"
  elif [ -n "$remote_latest" ] && [ "$remote_latest" != "$local_ver" ]; then
    step_skip "镜像漂移" "镜像还是 ${remote_latest} 那一版、本地已到 ${local_ver}（**发布前正常**；发布后应一致）"
  else
    step_bad "镜像漂移 —— 同版本（${local_ver}）却字节不同：${drifted}（违反"同版本不许换字节"）"
  fi
fi

# ---- 发布后复核：线上产物是不是"索引里写的那份字节" ------------------------------
# 为什么值得下载复算：`publish-mirror.sh` 上传时会核对大小，但那是在**发布那一刻**；
# 事后文件被换、被截断、CDN 缓存了旧版本，都只有"下载回来算 sha256"才能发现。
if wanted post-artifacts; then
  printf '\n──── 发布后复核：线上产物 ↔ 索引 ────\n'
  mver="$(curl -fsS --max-time 20 "$MIRROR/apps/zizvideo/manifest.json" 2>/dev/null \
    | python3 -c 'import json,sys; print((json.load(sys.stdin).get("latest") or ""))' 2>/dev/null || true)"
  if [ -z "$mver" ]; then
    step_skip "线上产物复核" "拉不到镜像索引（网络不通 / 还没发布过）"
  else
    printf '  镜像 latest = %s\n' "$mver"
    local_ver="$(sed -n 's/^VERSION[[:space:]]*?*=[[:space:]]*//p' "$ROOT/Makefile" | head -1)"
    [ "$mver" = "$local_ver" ] && printf '  （镜像 latest 就是本次版本：缺任何本地有的索引都算漏传）\n'
    tmpd="$(mktemp -d)"
    bad_items=0; checked=0
    for idx in "manifest.json" "linux.json" "android.json"; do
      url="$MIRROR/apps/zizvideo/$idx"
      case "$idx" in
        manifest.json) assets_base="$MIRROR/apps/zizvideo/$mver" ;;
        linux.json)    assets_base="$MIRROR/apps/zizvideo/$mver" ;;
        android.json)  assets_base="$MIRROR/apps/zizvideo" ;;
      esac
      if ! curl -fsS --max-time 20 "$url" -o "$tmpd/$idx" 2>/dev/null; then
        # 缺索引要分清两种情况（否则发布后"漏传了 linux.json"会被当成"老版本没有这类产物"糊过去）：
        #   · 镜像 latest == 本地版本（= 这就是本次发布）且**本地**有这份索引 ⇒ **漏传了** ⇒ 失败；
        #   · 镜像还是上一版 ⇒ 老版本没有这类产物很正常 ⇒ 只记一条说明。
        if [ "$mver" = "$local_ver" ] && [ -f "$ROOT/dist/apps/zizvideo/$idx" ]; then
          printf '  ✗ %s：**本地有、镜像上没有** —— 本次发布漏传了它（独立部署/飞牛装不上）\n' "$idx"
          bad_items=$((bad_items + 1))
        else
          printf '  · %s：镜像上没有（老版本没这类产物，正常）\n' "$idx"
        fi
        continue
      fi
      # 每条资产：先比 size，再**下载**算 sha256（这是唯一能发现"被换过/被截断"的办法）
      # ⚠️ macOS 自带 bash 3.2 **没有 mapfile**（安装器就要在 3.2 上跑）⇒ 用 while+数组
      rows="$(python3 - "$tmpd/$idx" <<'PYI'
import json, sys
d = json.load(open(sys.argv[1]))
if "assets" in d:
    for a in d.get("assets") or []:
        print("%s\t%s\t%s" % (a.get("name") or "", a.get("sha256") or "", a.get("size") or 0))
elif d.get("file"):
    print("%s\t%s\t%s" % (d["file"], d.get("sha256") or "", d.get("size") or 0))
PYI
)"
      while IFS= read -r row; do
        [ -n "$row" ] || continue
        name="$(printf '%s' "$row" | cut -f1)"; want="$(printf '%s' "$row" | cut -f2)"; dsize="$(printf '%s' "$row" | cut -f3)"
        file_url="$assets_base/$name"
        got_size="$(curl -fsSI --max-time 20 "$file_url" 2>/dev/null | tr -d '\r' \
          | awk 'tolower($1)=="content-length:"{print $2}' | tail -1)"
        if [ -z "$got_size" ]; then
          printf '  ✗ %s：线上取不到（%s）\n' "$name" "$file_url"; bad_items=$((bad_items + 1)); continue
        fi
        if [ "$got_size" != "$dsize" ]; then
          printf '  ✗ %s：大小不符（索引 %s / 线上 %s）\n' "$name" "$dsize" "$got_size"
          bad_items=$((bad_items + 1)); continue
        fi
        # ⚠️ 输出文件名要 sanitize：APK 那条的 name 是**带斜杠的路径**（android/xxx.apk），
        # 直接当文件名会因"目录不存在"写不进去，报出来却是"下载失败"（又是名字带斜杠这一类坑）
        safe_name="$(printf '%s' "$name" | tr '/' '_')"
        curl -fsS --max-time 300 "$file_url" -o "$tmpd/$safe_name" 2>/dev/null || {
          printf '  ✗ %s：下载失败\n' "$name"; bad_items=$((bad_items + 1)); continue; }
        got="$(python3 -c 'import hashlib,sys; print(hashlib.sha256(open(sys.argv[1],"rb").read()).hexdigest())' "$tmpd/$safe_name")"
        if [ "$got" = "$want" ]; then
          printf '  ✓ %s：线上字节与索引 sha256 一致（%s…，%s B）\n' "$name" "${got:0:12}" "$got_size"
          checked=$((checked + 1))
        else
          printf '  ✗ %s：sha256 不符（索引 %s… / 线上 %s…）\n' "$name" "${want:0:12}" "${got:0:12}"
          bad_items=$((bad_items + 1))
        fi
      done <<EOF
$rows
EOF
    done
    rm -rf "$tmpd"
    # 顺序很重要：**只要有 ✗ 就是失败**（第一版把"没读到可比对资产"排在前面，
    # 于是"漏传了 linux.json/android.json"被当成 skip 放过去了 —— 判据顺序错了等于没有判据）
    if [ "$bad_items" -gt 0 ]; then
      step_bad "线上产物复核 —— ${bad_items} 项有问题（漏传 / 与索引不符 / 取不到）"
    elif [ "$checked" -gt 0 ]; then
      step_ok "线上产物复核（${checked} 份逐字节与索引一致）"
    else
      step_skip "线上产物复核" "索引里没读到可比对的资产"
    fi
  fi
fi

if wanted post-latest; then
  printf '\n──── 发布后复核：latest 就是本版本吗 ────\n'
  mver2="$(curl -fsS --max-time 20 "$MIRROR/apps/zizvideo/manifest.json" 2>/dev/null \
    | python3 -c 'import json,sys; print((json.load(sys.stdin).get("latest") or ""))' 2>/dev/null || true)"
  local_ver2="$(sed -n 's/^VERSION[[:space:]]*?*=[[:space:]]*//p' "$ROOT/Makefile" | head -1)"
  printf '  镜像 latest = %s；工作树 = %s\n' "${mver2:-（取不到）}" "$local_ver2"
  if [ -z "$mver2" ]; then
    step_skip "latest 复核" "拉不到镜像索引"
  elif [ "$mver2" = "$local_ver2" ]; then
    step_ok "latest 复核（镜像就是这个版本，面板会看到更新）"
  else
    step_bad "latest 复核 —— 镜像 latest=${mver2} ≠ 本地 ${local_ver2}（**还没发布**，或发的是别的版本）"
  fi
fi

# ---- 结论 -------------------------------------------------------------------
printf '\n════ 发布前检查结论 ════\n'
for line in "${SUMMARY[@]}"; do printf '  %s\n' "$line"; done
printf '\n通过 %d，失败 %d，跳过 %d\n' "$PASS" "$FAIL" "$SKIP"
if [ "$FAIL" -gt 0 ]; then
  printf '有失败项：先修上面每条 ✗（跳过的项也要看清原因 —— 跳过 ≠ 验过）\n' >&2
  exit 1
fi
if [ "$SKIP" -gt 0 ]; then
  printf '关键项都过了，但有 %d 项**跳过**（例如没有 docker/没有 fnpack）—— 那部分等于没验过。\n' "$SKIP"
fi
printf '可以发布（发版/推送仍需你点名）。\n'
