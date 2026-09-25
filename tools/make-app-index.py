#!/usr/bin/env python3
"""make-app-index.py —— 生成 zizvideo 的镜像索引（面板唯一认的版本真源）。

用法：
    tools/make-app-index.py <版本目录> <版本>

产出（覆盖写）：
    <版本目录>/manifest.json            每个架构的 sha256/大小（+ upstream）
    <版本目录>/../manifest.json          顶层索引：{"app","latest","generated_at","assets":[{name,version,arch,sha256,size}]}
    <版本目录>/../android.json           安卓客户端自动更新清单（有 APK 时才写，见下）
    <版本目录>/../android/<apk>          当前这一份 APK（稳定路径，只留最新）

前两份的字段是**面板代码读的契约**（internal/services/zizvideo.go 的 resolveZizvideoRelease），
改字段=破坏兼容，必须先改 CONTRACT.md 并让面板侧同步。

android.json 是**给 App 自己读的**（用户 2026-09-25："给 app 加自动检查更新"），与面板无关：
    {"app","platform":"android","version","server_version","file","sha256","size","published_at"}
  · 为什么不塞进 manifest.json：那个 schema 是面板的契约，多塞东西有被面板误当成产物的风险；
  · 为什么 APK 放 ../android/ 而不是版本目录里：版本目录会被 `make publish` 按规矩 prune 掉，
    APK 跟着走就 404 了 —— 更新源必须是稳定路径。
"""
import hashlib
import json
import os
import re
import shutil
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

    # 安卓客户端的自动更新清单（有 APK 才写；没带客户端时**不动**旧的那份，
    # 否则会把手上的更新源清掉）
    apk = None
    for name in sorted(os.listdir(vdir)):
        found = re.match(r"^zizvideo-android-(.+)\.apk$", name)
        if found and os.path.isfile(os.path.join(vdir, name)):
            apk = (name, found.group(1))
    if apk:
        name, appver = apk
        src = os.path.join(vdir, name)
        with open(src, "rb") as handle:
            digest = hashlib.sha256(handle.read()).hexdigest()
        parent = os.path.dirname(vdir)
        android_dir = os.path.join(parent, "android")
        os.makedirs(android_dir, exist_ok=True)
        # 只留最新这一份（App 只会要最新版；旧包留着既占地方又容易被误链）
        for old in os.listdir(android_dir):
            if old != name and re.match(r"^zizvideo-android-.+\.apk$", old):
                os.remove(os.path.join(android_dir, old))
        shutil.copy2(src, os.path.join(android_dir, name))
        android_index = os.path.join(parent, "android.json")
        with open(android_index, "w", encoding="utf-8") as handle:
            json.dump({"app": "zizvideo", "platform": "android", "version": appver,
                       "server_version": ver, "file": "android/" + name,
                       "sha256": digest, "size": os.path.getsize(src), "published_at": stamp},
                      handle, ensure_ascii=False, indent=2)
            handle.write("\n")
        print("   安卓更新清单：%s（app %s，%s，%d B）" % (
            android_index, appver, digest[:16] + "…", os.path.getsize(src)))
    return 0

if __name__ == "__main__":
    sys.exit(main())
