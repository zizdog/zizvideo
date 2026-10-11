#!/usr/bin/env python3
"""check-docs.py —— 文档 ↔ 实现一致性检查（文档腐烂是长期风险）

检查三件事（都是"写死了必腐"或"改名后没人改文档"的典型）：
  ① 文档里提到的仓库内路径（platform/… 、tools/… 、docker/… 、fnos/… 、dist/… 、install-*.sh…）必须存在；
  ② 文档里写的 `make <目标>` 必须在 Makefile 里真的有；
  ③ 文档里提到的 `ZV_*` 环境开关必须在代码里真的存在（文档写了、代码没有 = 用户照着设了没用）；
  ④ 文档**不许写死门禁条数**（例如"覆盖（92 条 ok）"）—— 条数会涨，写死了必腐，
     应该写"条数见 make check 输出"。

用法：python3 tools/check-docs.py       退出码 0=一致，1=有不一致
"""
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# 只检查"**描述当前用法**"的活文档。以下刻意**不查**（写了原因，免得以后有人顺手加回来）：
#   · docs/坑清单.md        —— 它记录的是"过去的错"，里面**故意**写着 `make docker`、`android/xxx.apk`
#                              这类已被修掉的旧名字；查它等于把历史当成腐烂。
#   · docs/ITERATION-*.md   —— 历史设计基线，写的是当时的路径（现在可能已不存在）。
#   · docs/给面板的*.md      —— 面向面板仓库的接口说明，引用的路径在**面板仓库**里。
#   · AGENTS.md             —— 工作区规则，里面是示意（`docs/ITERATION-` 前缀等）。
# CONTRACT.md 是**跨仓库契约**（面板侧照它实现）⇒ 也纳入活文档检查：它写错的代价最大
LIVING = ["docs/独立部署.md", "docs/验收清单.md", "docs/配置.md", "README.md", "CONTRACT.md",
          "platform/README.md", "platform/panel/README.md"]
SKIP = ("坑清单.md", "给面板的")
DOCS = [os.path.join(ROOT, p) for p in LIVING if os.path.isfile(os.path.join(ROOT, p))]

# 只认"仓库根下的实际路径"（tree 图里的相对路径如 `cmd/main` 不算 —— 它是 fnos 包内的相对路径）
PATH_RE = re.compile(
    # ⚠️ `platform` 必须在这里：搬到 platform/ 之后，`platform/macos/install-zizvideo.sh` 前面有 `/`，
    # 既匹配不上旧前缀、也不匹配"裸文件名"那条 ⇒ 会被**静默跳过**（引用数从 116 掉到 92 就是这个信号）
    r"(?<![\w./])((?:platform|tools|docker|fnos|docs|dist)/[A-Za-z0-9_./\u4e00-\u9fff\-]+"
    r"|install-zizvideo[a-z\-]*\.sh)"
)
MAKE_RE = re.compile(r"\bmake ([a-z][a-z0-9\-]*)")
COUNT_RE = re.compile(r"[0-9]+\s*条\s*ok")
IGNORE_MAKE = {"install", "release"}   # 文档里偶尔写"make install"是通用说法，不要求是本仓库目标


def main() -> int:
    known_targets = set(re.findall(r"^([a-zA-Z][a-zA-Z0-9_\-]*):",
                                   open(os.path.join(ROOT, "Makefile"), encoding="utf-8").read(), re.M))
    problems = []
    checked = 0
    for doc in DOCS:
        text = open(doc, encoding="utf-8").read()
        # 在**原文**里找路径，但跳过"模板"：紧跟着 `<`（占位符）或 `*`（glob）的匹配（如 `…/zizvideo-<版本>-x86.fpk`、
        # `…/zizvideo-*.fpk`）不是路径声明。
        # （第一版先剥掉 `<…>` 再匹配，于是模板被拼成了 `zizvideo--x86.fpk` 这种不存在的路径，报了 4 处误报）
        for m in PATH_RE.finditer(text):
            # 紧跟 `<`（占位符）或 `*`（glob）的都不是"路径声明"，是模板
            if text[m.end():m.end() + 1] in ("<", "*"):
                continue
            # **URL 里的文件名不是仓库路径**（镜像按文件名存：.../apps/zizvideo/install-zizvideo.sh）——
            # 不排除会把它们当"仓库根下的 install-zizvideo.sh"而误报（我的路径扫描曾真把 URL 改坏过）
            line_start = text.rfind("\n", 0, m.start()) + 1
            prefix = text[line_start:m.start()]
            toks = prefix.rsplit(None, 1)
            if toks and "://" in toks[-1]:
                continue
            p = m.group(1).rstrip(".,;)`'\"")
            if "//" in p:
                continue
            checked += 1
            full = os.path.join(ROOT, p)
            if p.endswith("/"):
                if not os.path.isdir(full):
                    problems.append("%s: 目录不存在 %s" % (os.path.relpath(doc, ROOT), p))
            elif not os.path.exists(full):
                problems.append("%s: 路径不存在 %s" % (os.path.relpath(doc, ROOT), p))
        for t in sorted(set(MAKE_RE.findall(text))):
            checked += 1
            if t not in known_targets and t not in IGNORE_MAKE:
                problems.append("%s: `make %s` 在 Makefile 里没有" % (os.path.basename(doc), t))
        # 环境开关：文档里写了 `ZV_XXX=...`，代码里必须有这个变量（否则用户照着设，什么都不会发生）
        for var in sorted(set(re.findall(r"\bZV_[A-Z0-9_]+", text))):
            checked += 1
            hit = False
            for root, dirs, files in os.walk(ROOT):
                dirs[:] = [d for d in dirs if d not in (".git", "dist", "node_modules", ".tools", ".linetest")]
                for f in files:
                    if not f.endswith((".sh", ".py", ".go", ".mk")) and f != "Makefile":
                        continue
                    try:
                        if var in open(os.path.join(root, f), encoding="utf-8", errors="ignore").read():
                            hit = True
                            break
                    except OSError:
                        continue
                if hit:
                    break
            if not hit:
                problems.append("%s: 文档写了环境开关 %s，但代码里没有它（用户设了也不会生效）"
                                % (os.path.basename(doc), var))
        if COUNT_RE.search(text):
            problems.append("%s: 写死了门禁条数（应改成「条数见 make check 输出」）" % os.path.basename(doc))
    if problems:
        print("文档与实现不一致（%d 处）：" % len(problems))
        for p in problems:
            print("  ✗ " + p)
        return 1
    print("✓ 检查了 %d 份文档、%d 条路径/目标引用，全部对得上；且没有写死门禁条数" % (len(DOCS), checked))
    return 0


if __name__ == "__main__":
    sys.exit(main())
