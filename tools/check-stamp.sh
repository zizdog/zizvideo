#!/usr/bin/env bash
# ============================================================================
#  check-stamp.sh —— 「这棵树已经跑过 make check」的凭据
#
#  为什么需要它：`make check` 是硬门禁（版本一致 + acorn 真解析 + go vet + 全部单测），
#  但**同一棵树**上重复跑它没有任何新信息 —— 每次改完文档、或连着发版时都会白等一遍。
#  「手写的跳过」（SKIP_CHECK=1）无法自证跑没跑过，这里把跳过变成**可核对的事实**：
#    · fingerprint 算的是工作树里每个文件的内容哈希（已跟踪 + 未跟踪）；
#    · `make check` 成功时把指纹写进 .zv-check-stamp；
#    · 再次 `make check` 先比对指纹：一致就跳过并打印"哪版、什么时候跑的"。
#  任何改动（改文件/加文件/删文件/切版本号）都会改变指纹 ⇒ 强制重跑。
#
#  指纹刻意**不掺 HEAD / git diff**（照 zizpanel 的同名脚本，理由一致）：
#    · 只哈希 `git status`/`git diff` 会得到"空输入的哈希"，不同的干净提交会撞成同一个指纹；
#    · 掺 HEAD 又会造成"check 完一提交，标记立刻失效"（内容没变却判成变了）。
#  按内容取指纹同时解决这两点：提交前后不变 → 指纹不变；改一个字节 → 指纹必变。
#
#  自指问题：标记文件自己必须被 .gitignore 忽略。用 --exclude-standard 列未跟踪文件时，
#  被忽略的标记不会进来；万一没忽略，它会把自己写进指纹 → 每次 write 后校验必然失败。
# ============================================================================
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAMP="$REPO_ROOT/.zv-check-stamp"
FORCE="${ZV_FORCE_CHECK:-0}"

fingerprint() {
  cd "$REPO_ROOT"
  {
    # 已跟踪文件（含被删除的：跳过不存在的路径，删除本身会改变文件列表）
    while IFS= read -r -d '' f; do
      [ -f "$f" ] && shasum -a 256 "$f"
    done < <(git ls-files -z)
    # 未跟踪文件（排除 .gitignore 里的东西：标记文件自己必须被排除，否则自指）
    while IFS= read -r -d '' f; do
      [ -f "$f" ] && shasum -a 256 "$f"
    done < <(git ls-files --others --exclude-standard -z | LC_ALL=C sort -z)
  } | shasum -a 256 | awk '{print $1}'
}

version_of() {
  sed -n 's/^VERSION *?= *\(.*\)$/\1/p' "$REPO_ROOT/Makefile" | head -1
}

cmd="${1:-verify}"
case "$cmd" in
  fingerprint)
    fingerprint
    ;;
  write)
    fp="$(fingerprint)"
    ver="$(version_of)"
    printf '%s %s %s\n' "$fp" "$ver" "$(date '+%Y-%m-%d %H:%M:%S')" > "$STAMP"
    echo "已记录 check 标记：${ver} @ $(date '+%H:%M:%S')（指纹 ${fp:0:12}…）"
    ;;
  verify)
    # 退出码：0 = 这棵树确实跑过 check（可安全跳过）；1 = 没跑过/树已变（必须重跑）
    [ "$FORCE" = "1" ] && { echo "ZV_FORCE_CHECK=1：强制重跑门禁"; exit 1; }
    [ -f "$STAMP" ] || { echo "没有 check 标记（.zv-check-stamp 不存在）"; exit 1; }
    read -r fp ver ts < "$STAMP" || true
    now="$(fingerprint)"
    if [ "$fp" != "$now" ]; then
      echo "工作树自上次 check 后已变化（标记 ${fp:0:12}… → 现在 ${now:0:12}…），必须重跑"
      exit 1
    fi
    echo "这棵树已通过 make check：版本 ${ver}，时间 ${ts}（指纹 ${fp:0:12}…）"
    ;;
  *)
    echo "用法：$0 fingerprint|write|verify" >&2
    exit 2
    ;;
esac
