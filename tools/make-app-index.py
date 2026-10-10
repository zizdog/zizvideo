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

SHA256_RE = re.compile(r"^[0-9a-f]{64}$")


def validate(rows, ver: str):
    """写出前的自校验：**面板与独立安装器读的就是这几个字段**（改字段=破坏兼容）。

    宁可让 `make release` 当场红，也不许把"装不上/校验不过"的索引发出去
    （面板侧文档 §4.2/§4.3：`latest` 空 ⇒ 拒绝安装；`sha256` 不是 64 位小写 hex ⇒
    拒绝装"无法校验的二进制"；独立安装器还要 `size` 做磁盘前置检查）。
    返回问题列表（空 = 通过）。
    """
    problems = []
    if not ver.strip():
        problems.append("版本号是空的（面板发现 latest 为空会拒绝安装）")
    for row in rows:
        name = row.get("name", "?")
        if row.get("version") != ver:
            problems.append("%s 的 version=%r ≠ latest=%r（面板要求两者相等）"
                            % (name, row.get("version"), ver))
        if row.get("arch") not in ("arm64", "amd64"):
            problems.append("%s 的 arch=%r 不认识（面板只认 arm64/amd64 或 name 里的 darwin_<arch>）"
                            % (name, row.get("arch")))
        if not SHA256_RE.match(str(row.get("sha256", ""))):
            problems.append("%s 的 sha256 不是 64 位小写 hex（面板会拒绝装这个包）" % name)
        if int(row.get("size", 0)) <= 0:
            problems.append("%s 的 size=%r（独立安装器拿它做磁盘前置检查，必须 >0）"
                            % (name, row.get("size")))
    return problems


def main() -> int:
    if len(sys.argv) != 3:
        print(__doc__, file=sys.stderr)
        return 2
    vdir, ver = os.path.abspath(sys.argv[1]), sys.argv[2]
    if not os.path.isdir(vdir):
        print("!! 版本目录不存在：%s" % vdir, file=sys.stderr)
        return 1
    pattern = re.compile(r"^zizvideo_" + re.escape(ver) + r"_(darwin|linux)_(arm64|amd64)$")
    rows = []
    linux_rows = []
    for name in sorted(os.listdir(vdir)):
        path = os.path.join(vdir, name)
        found = pattern.match(name)
        if not found or not os.path.isfile(path):
            continue
        with open(path, "rb") as handle:
            digest = hashlib.sha256(handle.read()).hexdigest()
        row = {
            "name": name, "version": ver, "arch": found.group(2),
            "sha256": digest, "size": os.path.getsize(path),
        }
        # ⚠️ manifest.json 是**面板的契约**，只装 darwin（面板按 arch 选包，同 arch 塞两个平台
        # 会让 macOS 装到 Linux 二进制）。Linux 走独立的 linux.json（见下）。
        if found.group(1) == "linux":
            linux_rows.append({**row, "os": "linux"})
        else:
            rows.append(row)
    if not rows:
        print("!! %s 下没有 zizvideo_%s_darwin_<arch> 产物" % (vdir, ver), file=sys.stderr)
        return 1
    # 自校验放在**写盘之前**：坏索引一旦发出去，面板/安装器那边报的错跟这里毫无关系（难查）
    problems = validate(rows, ver)
    if problems:
        print("!! 索引自校验不通过，未写任何文件：", file=sys.stderr)
        for p in problems:
            print("   - " + p, file=sys.stderr)
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

    # Linux 独立部署清单（有 linux 产物才写；与 android.json 同一思路：平台专属、稳定路径、
    # **不塞进面板的 manifest.json**）。独立安装器 install-zizvideo-linux.sh 只读它。
    if linux_rows:
        lproblems = []
        for row in linux_rows:
            if not SHA256_RE.match(str(row["sha256"])) or int(row["size"]) <= 0:
                lproblems.append("%s 的 sha256/size 不合法" % row["name"])
            if row["arch"] not in ("arm64", "amd64"):
                lproblems.append("%s 的 arch=%r 不认识" % (row["name"], row["arch"]))
        if lproblems:
            print("!! linux.json 自校验不通过，未写：", file=sys.stderr)
            for p in lproblems:
                print("   - " + p, file=sys.stderr)
            return 1
        lpath = os.path.join(os.path.dirname(vdir), "linux.json")
        with open(lpath, "w", encoding="utf-8") as handle:
            json.dump({"app": "zizvideo", "platform": "linux", "latest": ver,
                       "generated_at": stamp, "assets": linux_rows}, handle,
                      ensure_ascii=False, indent=2)
            handle.write("\n")
        print("   Linux 清单已写：%s（%d 个架构：%s）" % (
            lpath, len(linux_rows), ", ".join(r["arch"] for r in linux_rows)))

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
        # APK 那条也自校验（App 自己读它自动更新）：版本空/sha 形状不对/0 字节都不许写出去
        size = os.path.getsize(src)
        apk_problems = []
        if not appver.strip():
            apk_problems.append("APK 版本号解析为空：" + name)
        if not SHA256_RE.match(digest):
            apk_problems.append("%s 的 sha256 形状不对" % name)
        if size <= 0:
            apk_problems.append("%s 是 0 字节" % name)
        if apk_problems:
            print("!! 安卓更新清单自校验不通过：", file=sys.stderr)
            for p in apk_problems:
                print("   - " + p, file=sys.stderr)
            return 1
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
                       "sha256": digest, "size": size, "published_at": stamp},
                      handle, ensure_ascii=False, indent=2)
            handle.write("\n")
        print("   安卓更新清单：%s（app %s，%s，%d B）" % (
            android_index, appver, digest[:16] + "…", size))
    return 0

if __name__ == "__main__":
    sys.exit(main())
