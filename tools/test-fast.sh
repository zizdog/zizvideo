#!/usr/bin/env bash
# ============================================================================
#  test-fast.sh —— 跑全部单测，但**不把同一件事算两遍**
#
#  三条规矩（用户 2026-09-22 定）：
#   ① 最重的包（internal/api、internal/media）按**测试名单**分片，多进程并行；
#      分片名单来自 `go test -list`，所以不重不漏（不是手写正则猜）。
#   ② 其余包一次 `go test` 跑完 —— 包之间本来就是并行的，不必再拆。
#   ③ **不加 -count=1**：那会关掉 go 的测试缓存，等于每次重算同一棵树。
#      没改动的包第二次直接命中缓存（几毫秒），这正是"别算两遍"。
#
#  用法：bash tools/test-fast.sh [分片数]（默认 4，可用 ZV_TEST_SHARDS 覆盖）
#  想要旧行为（串行 + 禁缓存）：go test ./... -count=1
# ============================================================================
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

SHARDS="${1:-${ZV_TEST_SHARDS:-4}}"
case "$SHARDS" in ''|*[!0-9]*) SHARDS=4 ;; esac
[ "$SHARDS" -lt 1 ] && SHARDS=1

# 分片对象：只挑真的耗时的两个包（其余包一次跑完更快，拆了反而多付启动开销）。
HEAVY_PKGS="github.com/zizdog/zizvideo/internal/api github.com/zizdog/zizvideo/internal/media"

all_pkgs="$(go list ./...)"
light_pkgs="$(printf '%s\n' $all_pkgs | grep -v -x -e 'github.com/zizdog/zizvideo/internal/api' -e 'github.com/zizdog/zizvideo/internal/media' || true)"

pids=()
logs=()
names=()
start=$(date +%s)

run_bg() { # run_bg <名字> <命令...>
  local name="$1"; shift
  local log; log="$(mktemp)"
  ( "$@" ) >"$log" 2>&1 &
  pids+=("$!"); logs+=("$log"); names+=("$name")
}

for pkg in $HEAVY_PKGS; do
  tests_raw="$(go test "$pkg" -list '^Test' 2>/dev/null | grep '^Test' | LC_ALL=C sort || true)"
  [ -n "$tests_raw" ] || { echo "!! $pkg 没列出任何测试（-list 失败？）"; exit 1; }
  # bash 3.2 没有 mapfile：用 while+数组
  tests=()
  while IFS= read -r line; do [ -n "$line" ] && tests+=("$line"); done <<< "$tests_raw"
  n="${#tests[@]}"
  per=$(( (n + SHARDS - 1) / SHARDS ))
  i=0
  while [ $((i * per)) -lt "$n" ]; do
    chunk=("${tests[@]:$((i * per)):$per}")
    if [ "${#chunk[@]}" -gt 0 ]; then
      pat="^($(printf '%s|' "${chunk[@]}" | sed 's/|$//'))$"
      run_bg "$(basename "$pkg") 分片$((i + 1))/${SHARDS}（${#chunk[@]} 个）" go test "$pkg" -run "$pat"
    fi
    i=$((i + 1))
  done
done

if [ -n "$light_pkgs" ]; then
  # shellcheck disable=SC2086
  run_bg "其余包（$(printf '%s\n' $light_pkgs | wc -l | tr -d ' ') 个）" go test $light_pkgs
fi

rc=0
idx=0
while [ "$idx" -lt "${#pids[@]}" ]; do
  if wait "${pids[$idx]}"; then
    echo "  ✓ ${names[$idx]}"
  else
    echo "  ✗ ${names[$idx]}"
    cat "${logs[$idx]}"
    rc=1
  fi
  rm -f "${logs[$idx]}"
  idx=$((idx + 1))
done

echo "单测用时 $(( $(date +%s) - start ))s（分片 ${SHARDS}，缓存开启）"
exit "$rc"
