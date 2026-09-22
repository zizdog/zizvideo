#!/usr/bin/env bash
# ============================================================================
#  ui-test.sh —— 跑一个 Playwright 脚本，**无论怎么结束都清干净浏览器**
#
#  为什么必须有：2026-09-22 我的排查脚本被 harness 超时杀掉，harness 只杀 `node`，
#  它拉起的 Chromium 子进程活了下来；那两个 renderer 卡在我代码的死循环里，
#  分别烧 145% / 65% CPU 持续 11 分钟，把开发机搞到卡死发热（负载 12）。
#  单靠"记得收尾"不可靠，所以把收尾做成**不会忘的出口**：
#    · trap 在 EXIT/INT/TERM/HUP 上都执行 pkill，正常跑完、报错、Ctrl-C、被 kill 都会清；
#    · 清完再复核一次，残留就大声报出来（不静默）。
#  注意：SIGKILL（kill -9）无法被捕获 —— 所以收尾后仍要 `pgrep -fl ms-playwright` 看一眼。
#
#  用法：bash tools/ui-test.sh <脚本.mjs> [参数...]
#        （脚本要能解析到 playwright：在 zizpanel 仓库跑，或 /tmp 下用 node_modules 软链）
# ============================================================================
set -uo pipefail

SCRIPT="${1:?用法: tools/ui-test.sh <脚本.mjs> [参数...]}"
shift || true

cleanup() {
  pkill -f 'ms-playwright' 2>/dev/null || true
  pkill -f 'chrome-headless-shell' 2>/dev/null || true
}
trap cleanup EXIT INT TERM HUP

rc=0
node "$SCRIPT" "$@" || rc=$?

cleanup
left="$(pgrep -f 'ms-playwright|chrome-headless-shell' 2>/dev/null | wc -l | tr -d ' ')"
if [ "$left" != "0" ]; then
  echo "!! 仍有 ${left} 个无头浏览器进程残留（可能被 kill -9），请手动 pkill -f ms-playwright" >&2
  rc=1
fi
exit "$rc"
