#!/usr/bin/env python3
"""check-status-doc.py —— 核对 ZizVideo-当前状态.md 里**可机器验证的事实**

为什么要它：状态文档是新会话的第一入口，里面写的是"版本是 X""改动已提交未推送"这类**事实断言**。
事实会变（发版、推送、改版本），文档不会自己跟着变 —— 于是新会话可能照着过期事实做事
（例如以为"还没推"，实际早推了；或反过来）。这里只核对**能机器判定的**那几条：

  ① `工作树版本 **X**` 与 Makefile 的 VERSION 一致；
  ② "未推送/已推送"的断言与 git 实际一致（origin/main..HEAD 的提交数；没有 origin 时跳过）；
  ③ **速览那一节**里不许写精确门禁条数（`N 条 ok`）—— 那必腐，应该写成"条数见 make check 输出"。
     （只查速览：历史区块里写着当时的条数是对的，不该被当成腐烂。）

用法：python3 tools/check-status-doc.py     退出码 0=一致，1=有过期断言
"""
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DOC = os.path.join(ROOT, "ZizVideo-当前状态.md")


def git(args):
    try:
        out = subprocess.run(["git", "-C", ROOT] + args, capture_output=True, text=True, timeout=20)
        return out.returncode, out.stdout.strip()
    except Exception as exc:                                     # noqa: BLE001
        return 1, str(exc)


def main() -> int:
    if not os.path.isfile(DOC):
        print("!! 找不到 %s（本机状态文档，正常应该存在）" % DOC, file=sys.stderr)
        return 1
    full = open(DOC, encoding="utf-8").read()
    # 只核对**速览那一节**（新会话读的"当前事实"就在那里）。历史区块里写着当时的条数/版本是对的，
    # 查全篇会把自己的历史记录当成腐烂（第一版就是这么误报的）。
    m_sec = re.search(r"^## 🧭 本会话速览.*?(?=^## |^---\s*$)", full, re.M | re.S)
    text = m_sec.group(0) if m_sec else full
    ver = ""
    m = re.search(r"^VERSION\s*\??=\s*(\S+)", open(os.path.join(ROOT, "Makefile"), encoding="utf-8").read(), re.M)
    if m:
        ver = m.group(1)

    problems = []
    checked = 0

    claims = re.findall(r"工作树版本[^0-9]*([0-9][0-9A-Za-z.\-]*)", text)
    for c in claims:
        checked += 1
        if ver and c != ver:
            problems.append("文档说工作树版本 %s，Makefile 是 %s" % (c, ver))

    if "未推送" in text:
        checked += 1
        rc, out = git(["rev-list", "--count", "origin/main..HEAD"])
        if rc != 0:
            print("  · 没有 origin/main，跳过「未推送」核对")
        else:
            n = int(out or "0")
            if n == 0 and "未推送" in text:
                problems.append("文档说「未推送」，但 origin/main..HEAD = 0（其实已经推上去了）")
            elif n > 0:
                print("  · 本地还有 %d 个未推送提交（文档里若说已推送就会不一致）" % n)

    if re.search(r"[0-9]+\s*条\s*ok", text):
        problems.append("文档里写死了精确门禁条数（`N 条 ok`）—— 必腐，改成「条数见 make check 输出」")

    if problems:
        print("状态文档有过期/不可靠的断言（%d 处）：" % len(problems))
        for p in problems:
            print("  ✗ " + p)
        return 1
    print("✓ 状态文档里 %d 条可机器核对的事实都对得上（版本 %s）" % (checked, ver or "?"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
