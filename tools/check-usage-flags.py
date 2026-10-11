#!/usr/bin/env python3
"""check-usage-flags.py —— 校验"脚本自己声明支持的参数"与"它实际解析的参数"一致

为什么：安装器/工具的 `--help` 是使用者唯一的说明书。**它解析了某个参数但帮助里没写**，
用户就永远不知道（例如 `--verify`、`--mirror` 一开始就没写进帮助）；
反过来"帮助里写了但解析器不认"更糟（照着敲 → 报错）。

规则（保守，避免误报）：
  · 只从脚本的 `case` 分支里取"它真的解析的参数"（行首缩进后的 `--flag)` / `--a|--b)`）；
  · 只对**处理了 `--help`** 的脚本要求"帮助里必须写到每个参数"（没处理 --help 的脚本由别的检查盯着）；
  · 跳过门禁脚本（`test-*.sh`：它的 `--help` 会真的跑整套门禁）。

用法：python3 tools/check-usage-flags.py     退出码 0=一致，1=有漏
"""
import glob
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CANDIDATES = (
    ["platform/macos/install-zizvideo.sh", "platform/linux/install-zizvideo-linux.sh"]
    + sorted(glob.glob("tools/*.sh"))
    + sorted(glob.glob("platform/fnos/*/cmd/*"))
)
SKIP = {"tools/test-installer.sh", "tools/test-fast.sh", "tools/ui-test.sh"}   # 门禁/测试脚本
FLAG_RE = re.compile(r"^\s*(--[a-z][a-z0-9-]*(?:\|--[a-z][a-z0-9-]*)*)\)", re.M)


def main() -> int:
    problems = []
    checked = 0
    nohelp = []
    for rel in CANDIDATES:
        if rel in SKIP:
            continue
        path = os.path.join(ROOT, rel)
        if not os.path.isfile(path):
            continue
        src = open(path, encoding="utf-8").read()
        handled = set()
        for m in FLAG_RE.finditer(src):
            for f in m.group(1).split("|"):
                if f not in ("--help", "-h"):
                    handled.add(f)
        if not handled:
            continue
        has_help = bool(re.search(r"--help\|-h\)|--help\)", src))
        if not has_help:
            nohelp.append(rel)
            continue
        try:
            out = subprocess.run(["bash", path, "--help"], capture_output=True, text=True, timeout=15)
        except subprocess.TimeoutExpired:
            problems.append("%s: --help 超过 15 秒没返回（帮助不该干正事）" % rel)
            continue
        help_text = out.stdout + out.stderr
        missing = sorted(f for f in handled if f not in help_text)
        checked += 1
        if missing:
            problems.append("%s: 解析了但帮助里没写 —— %s" % (rel, " ".join(missing)))
    for rel in nohelp:
        print("  · %s 不处理 --help（维护者脚本，暂不强制）" % rel)
    if problems:
        print("帮助与参数解析不一致（%d 个脚本）：" % len(problems))
        for p in problems:
            print("  ✗ " + p)
        return 1
    print("✓ %d 个脚本的帮助都写全了它解析的参数" % checked)
    return 0


if __name__ == "__main__":
    sys.exit(main())
