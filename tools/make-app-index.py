#!/usr/bin/env python3
"""make-app-index.py —— 生成 zizvideo 的镜像索引（面板唯一认的版本真源）。

用法：
    tools/make-app-index.py <版本目录> <版本>

产出两份（覆盖写）：
    <版本目录>/manifest.json            每个架构的 sha256/大小（+ upstream）
    <版本目录>/../manifest.json          顶层索引：{"app","latest","generated_at","assets":[{name,version,arch,sha256,size}]}

两份的字段是**面板代码读的契约**（internal/services/zizvideo.go 的 resolveZizvideoRelease），
改字段=破坏兼容，必须先改 CONTRACT.md 并让面板侧同步。
"""
import hashlib
import json
import os
import re
import sys
import time

def main() -> int:
    if len(sys.argv) != 3:
        print(__doc__, file=sys.stderr)
        return 2
    vdir, ver = os.path.abspath(sys.argv[1]), sys.argv[2]
    if not os.path.isdir(vdir):
        print("!! 版本目录不存在：%s" % vdir, file=sys.stderr)
        return 1
    pattern = re.compile(r"^zizvideo_" + re.escape(ver) + r"_darwin_(arm64|amd64)$")
    rows = []
    for name in sorted(os.listdir(vdir)):
        path = os.path.join(vdir, name)
        if not pattern.match(name) or not os.path.isfile(path):
            continue
        with open(path, "rb") as handle:
            digest = hashlib.sha256(handle.read()).hexdigest()
        rows.append({
            "name": name, "version": ver, "arch": pattern.match(name).group(1),
            "sha256": digest, "size": os.path.getsize(path),
        })
    if not rows:
        print("!! %s 下没有 zizvideo_%s_darwin_<arch> 产物" % (vdir, ver), file=sys.stderr)
        return 1
    stamp = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    per_version = dict(rows[0])
    per_version["upstream"] = "本地构建（zizvideo make release）"
    with open(os.path.join(vdir, "manifest.json"), "w", encoding="utf-8") as handle:
        json.dump({"app": "zizvideo", "version": ver, "generated_at": stamp,
                   "assets": [{**row, "upstream": per_version["upstream"]} for row in rows]},
                  handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    index = os.path.join(os.path.dirname(vdir), "manifest.json")
    with open(index, "w", encoding="utf-8") as handle:
        json.dump({"app": "zizvideo", "latest": ver, "generated_at": stamp, "assets": rows},
                  handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    print("   索引已写：%s（latest=%s，%d 个架构）" % (index, ver, len(rows)))
    for row in rows:
        print("     %s  %s  %d B" % (row["name"], row["sha256"][:16] + "…", row["size"]))
    return 0

if __name__ == "__main__":
    sys.exit(main())
