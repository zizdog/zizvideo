#!/usr/bin/env python3
"""check-script-hygiene.py —— 脚本卫生（这些错"语法合法、跑起来才炸"）

逐项（原来散在门禁的四个小节里，现在合并成一个可独立运行的报告）：

  ① **bash 4 专有语法**：`mapfile`/`readarray`/`declare -A`/`declare -n`/大小写转换 —— macOS 自带
     `/bin/bash` 是 **3.2**，用了就 `command not found`（安装器必须能在 3.2 上跑）。注释行跳过
     （注释里提 `mapfile` 是在说明"别用它"）。
  ② **`$var` 紧挨非 ASCII**：`$BIN（` 会被 macOS bash 吃成变量名的一部分 ⇒ `set -u` 下报 unbound。
     必须写成 `${BIN}（`。用 LC_ALL=C + POSIX 字符类（BSD grep 没有 -P）。
  ③ **头部注释块不许混进可执行行**：从 shebang 到第一行 `set ` 之间只能是注释/空行 ——
     否则可能变成自动执行（我踩过：用法注释漏了 `#`，脚本自我递归、3 秒内 2000 行输出直到 fork 耗尽）。
  ④ **`bash -n` / `sh -n` 语法**。
  ⑤ **Makefile 目标名与同名目录**：`make fnos` 会因存在 `platform/fnos/` 目录而认为"已是最新"、**静默跳过配方**。

用法：python3 tools/check-script-hygiene.py [--root <另一棵树>]   退出码 0=干净，1=有问题
"""
import glob
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if len(sys.argv) > 2 and sys.argv[1] == "--root":
    ROOT = os.path.abspath(sys.argv[2])      # 便于对**副本**做反例自测
SELF = os.path.basename(__file__)
# ⚠️ 必须**相对 ROOT** 展开（第一版用相对当前目录的 glob ⇒ `--root` 指向副本时根本没扫它，
# 前四项检查全是摆设 —— 反例自测当场发现）
SCRIPTS = (
    ["platform/macos/install-zizvideo.sh", "platform/linux/install-zizvideo-linux.sh"]
    + sorted(os.path.relpath(p, ROOT) for p in glob.glob(os.path.join(ROOT, "tools/*.sh")))
    + sorted(os.path.relpath(p, ROOT) for p in glob.glob(os.path.join(ROOT, "platform/fnos/*/cmd/*")))
)
BASH4_RE = re.compile(r"mapfile|readarray|declare -A|declare -n|\$\{[A-Za-z_]+,,\}|\$\{[A-Za-z_]+\^\^\}")
CJK_RE = re.compile(rb"\$[A-Za-z_][A-Za-z0-9_]*[^\x20-\x7e\s]")


def main() -> int:
    problems = []
    counts = {"bash4": 0, "cjk": 0, "header": 0, "syntax": 0, "make": 0}

    for rel in SCRIPTS:
        path = os.path.join(ROOT, rel)
        if not os.path.isfile(path) or os.path.basename(rel) == "test-installer.sh":
            continue                      # 门禁自己必须把 mapfile 等**模式**当数据写着，跳过
        raw = open(path, "rb").read()
        text = raw.decode("utf-8", "replace")

        # ① bash 4 专有语法（跳过注释行）
        for no, line in enumerate(text.splitlines(), 1):
            if line.lstrip().startswith("#"):
                continue
            if BASH4_RE.search(line):
                problems.append("%s:%d 用了 bash 4 专有语法（3.2 下 command not found）：%s"
                                % (rel, no, line.strip()[:70]))
                counts["bash4"] += 1
                break

        # ② $var 紧挨非 ASCII
        for no, line in enumerate(raw.split(b"\n"), 1):
            if CJK_RE.search(line):
                problems.append("%s:%d `$var` 紧挨非 ASCII（macOS bash 会当变量名一部分）：%s"
                                % (rel, no, line.decode("utf-8", "replace").strip()[:70]))
                counts["cjk"] += 1
                break

        # ③ 头部注释块纯净 + ④ 语法
        lines = text.splitlines()
        set_idx = next((i for i, l in enumerate(lines) if l.startswith("set ")), None)
        if set_idx is not None:
            for i in range(1, set_idx):          # 跳过 shebang
                if lines[i].strip() and not lines[i].lstrip().startswith("#"):
                    problems.append("%s:%d 头部注释块里混进可执行行（可能自我递归）：%s"
                                    % (rel, i + 1, lines[i].strip()[:70]))
                    counts["header"] += 1
                    break
        shell = "sh" if rel.startswith("docker/") else "bash"
        rc = subprocess.run([shell, "-n", path], capture_output=True, text=True).returncode
        if rc != 0:
            problems.append("%s 语法错（%s -n）" % (rel, shell))
            counts["syntax"] += 1

    # ⑤ Makefile 目标名 vs 同名目录
    mk = os.path.join(ROOT, "Makefile")
    if os.path.isfile(mk):
        for m in re.finditer(r"^([A-Za-z][A-Za-z0-9_-]*):", open(mk).read(), re.M):
            t = m.group(1)
            if os.path.isdir(os.path.join(ROOT, t)):
                problems.append("Makefile 目标 %s 与同名目录冲突（make 会静默跳过配方）" % t)
                counts["make"] += 1

    if problems:
        print("脚本卫生有问题（%d 处）：" % len(problems))
        for p in problems:
            print("  ✗ " + p)
        return 1
    print("✓ 脚本卫生通过：%d 个脚本（bash4 语法 0 / $var 紧邻非 ASCII 0 / 头部纯净 / 语法 / Makefile 目标无冲突）"
          % len([r for r in SCRIPTS if os.path.isfile(os.path.join(ROOT, r))]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
