#!/usr/bin/env python3
"""check-release-flow.py —— 用**本地假镜像**自测发布链路的判据（七种场景）

为什么值得单独跑：发布链路的判据（索引↔产物一致、线上字节复算、漏传、latest、两份索引一致）
全都是"平时不会触发、出事时才发现"的路径。用假镜像把它们**逐个跑一遍**，比在门禁里塞一堆
零散断言更好读、也更好维护：

  ① 一致的发布目录 → `check-release-dir.sh` 通过
  ② 索引里的 sha256 被改坏 → 必须**指名道姓**报 §sha256 不符
  ③ 顶层索引 latest 与版本目录不一致 → 必须报
  ④ 假镜像上产物与索引逐字节一致 → `preflight --only post-artifacts` 报"线上字节与索引 sha256 一致"
  ⑤ 产物被追加一个字节 → 必须报"大小不符"/"sha256 不符"
  ⑥ 镜像 latest == 本地版本、但本地有的 `linux.json` 在镜像上缺失 → 必须报"漏传"
  ⑦ 顶层索引与版本目录索引资产不一致 → 必须报"两份索引不一致"

用法：python3 tools/check-release-flow.py      退出码 0=全过，1=有场景不符
"""
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VER = "9.9.9"
MVER = VER  # 顶层 latest 用同一个假版本


def sh(args, env=None, timeout=120):
    e = dict(os.environ)
    e.update(env or {})
    out = subprocess.run(args, capture_output=True, text=True, timeout=timeout, env=e, cwd=ROOT)
    return out.returncode, out.stdout + out.stderr


def minimal_elf(machine: int) -> bytes:
    """造一个**最小的合法静态 ELF**（64 位、指定 machine、只有一个 PT_LOAD、没有 PT_INTERP）。

    发布目录自检对 linux 产物有真判据：必须是 **静态 ELF** 且架构对（`不是 ELF`/`动态链接`
    都会报 ✗）。夹具要么拷真产物（几十 MB、太慢），要么**合成**一个满足判据的最小 ELF —— 后者精确得多。
    """
    import struct
    e_ident = b"\x7fELF" + bytes([2, 1, 1, 0]) + b"\x00" * 8          # 64 位、小端、当前版本
    ehdr = e_ident + struct.pack("<HHIQQQIHHHHHH", 2, machine, 1, 0, 64, 0, 0, 64, 56, 1, 0, 0, 0)
    phdr = struct.pack("<IIQQQQQQ", 1, 5, 0, 0, 0, 0, 0, 0x1000)          # PT_LOAD（没有 PT_INTERP）
    return ehdr + phdr


def make_fake_release(base):
    """造一个最小发布目录 + 索引（结构上等价于 dist/apps/zizvideo/<ver>）"""
    vdir = os.path.join(base, "rel", VER)
    os.makedirs(vdir, exist_ok=True)
    # darwin：写成会打印版本号的脚本（自检要跑 `--version`；`--no-signature` 跳过签名检查）
    darwin = os.path.join(vdir, "zizvideo_%s_darwin_arm64" % VER)
    with open(darwin, "w") as f:
        f.write("#!/bin/sh\necho \"zizvideo %s\"\n" % VER)
    os.chmod(darwin, 0o755)
    # linux：最小静态 ELF，架构要对（amd64=62 / arm64=183）
    for name, machine in (("zizvideo_%s_linux_amd64" % VER, 62), ("zizvideo_%s_linux_arm64" % VER, 183)):
        with open(os.path.join(vdir, name), "wb") as f:
            f.write(minimal_elf(machine))
    rows = []
    for name in sorted(os.listdir(vdir)):
        p = os.path.join(vdir, name)
        with open(p, "rb") as f:
            data = f.read()
        rows.append({"name": name, "version": VER, "arch": "arm64" if "arm64" in name else "amd64",
                     "sha256": hashlib.sha256(data).hexdigest(), "size": len(data)})
    darwin = [r for r in rows if "darwin" in r["name"]]
    linux = [r for r in rows if "linux" in r["name"]]
    with open(os.path.join(vdir, "manifest.json"), "w") as f:
        json.dump({"app": "zizvideo", "version": VER, "assets": darwin}, f)
    with open(os.path.join(base, "rel", "manifest.json"), "w") as f:
        json.dump({"app": "zizvideo", "latest": MVER, "assets": darwin}, f)
    with open(os.path.join(base, "rel", "linux.json"), "w") as f:
        json.dump({"app": "zizvideo", "platform": "linux", "latest": MVER, "assets": linux}, f)
    # 发布目录自检还要求"APK 与 android.json 同时存在"（缺一个就报 ✗）——夹具也要满足
    apk = os.path.join(vdir, "zizvideo-android-9.9.9.apk")
    with open(apk, "wb") as f:
        f.write(b"stub apk\n")
    apk_body = open(apk, "rb").read()
    with open(os.path.join(base, "rel", "android.json"), "w") as f:
        json.dump({"app": "zizvideo", "platform": "android", "version": "9.9.9",
                   "server_version": VER, "file": "android/zizvideo-android-9.9.9.apk",
                   "sha256": hashlib.sha256(apk_body).hexdigest(), "size": len(apk_body)}, f)
    return vdir, rows


def main() -> int:
    results = []
    tmp = tempfile.mkdtemp(prefix="zv-relflow-")
    try:
        # ---------------- ① 一致的发布目录 ----------------
        base1 = os.path.join(tmp, "ok")
        vdir1, rows1 = make_fake_release(base1)
        rc, out = sh(["bash", "tools/check-release-dir.sh", "--no-signature", "--version", VER, vdir1])
        results.append(("一致的发布目录 → check-release-dir 通过", rc == 0,
                        "" if rc == 0 else out.strip()[-200:]))

        # ---------------- ② sha256 被改坏 ----------------
        base2 = os.path.join(tmp, "badsha")
        vdir2, _ = make_fake_release(base2)
        p = os.path.join(base2, "rel", "linux.json")
        d = json.load(open(p))
        d["assets"][0]["sha256"] = "0" * 64
        json.dump(d, open(p, "w"))
        rc, out = sh(["bash", "tools/check-release-dir.sh", "--no-signature", "--version", VER, vdir2])
        results.append(("索引 sha256 被改坏 → 指名道姓报「sha256 不符」", rc != 0 and "sha256" in out,
                        out.strip()[-200:] if not (rc != 0 and "sha256" in out) else ""))

        # ---------------- ③ 顶层 latest 与版本目录不一致 ----------------
        base3 = os.path.join(tmp, "badlatest")
        vdir3, _ = make_fake_release(base3)
        p = os.path.join(base3, "rel", "manifest.json")
        d = json.load(open(p))
        d["latest"] = "0.0.1"
        json.dump(d, open(p, "w"))
        rc, out = sh(["bash", "tools/check-release-dir.sh", "--no-signature", "--version", VER, vdir3])
        results.append(("顶层 latest 不符 → 报出来", rc != 0 and "latest" in out, out.strip()[-200:] if "latest" not in out else ""))

        # --------- ④~⑦ 假镜像（file:// 给 preflight 用） ---------
        mir = os.path.join(tmp, "mirror")
        os.makedirs(os.path.join(mir, "apps", "zizvideo", VER), exist_ok=True)
        os.makedirs(os.path.join(mir, "apps", "zizvideo", "9.9.9-local"), exist_ok=True)
        asset = "zizvideo_%s_darwin_arm64" % VER
        body = b"mirror-bytes\n"
        with open(os.path.join(mir, "apps", "zizvideo", VER, asset), "wb") as f:
            f.write(body)
        row = {"name": asset, "version": VER, "arch": "arm64",
               "sha256": hashlib.sha256(body).hexdigest(), "size": len(body)}
        json.dump({"app": "zizvideo", "latest": VER, "assets": [row]},
                  open(os.path.join(mir, "apps", "zizvideo", "manifest.json"), "w"))
        json.dump({"app": "zizvideo", "version": VER, "assets": [row]},
                  open(os.path.join(mir, "apps", "zizvideo", VER, "manifest.json"), "w"))

        def preflight_post(extra_env=None):
            # preflight 用仓库 Makefile 的版本判断"是不是本次发布"；这里造一个临时 Makefile 版本没意义，
            # 所以只在"漏传"场景里用 —— 那个场景要求镜像 latest == 本地版本，我们在场景⑥里临时改本地判断。
            return sh(["bash", "tools/preflight.sh", "--only", "post-artifacts"],
                      env={"ZV_PREFLIGHT_MIRROR": "file://" + mir, **(extra_env or {})})

        # 场景④/⑥/⑦需要 preflight 认为"镜像 latest == 本地版本"。做法：把假镜像的 latest 设成
        # **本仓库 Makefile 的 VERSION**（并在镜像里放同名版本目录），这样"漏传"判据才会生效。
        local_ver = ""
        m = re.search(r"^VERSION\s*\??=\s*(\S+)", open(os.path.join(ROOT, "Makefile")).read(), re.M)
        if m:
            local_ver = m.group(1)
        mir2 = os.path.join(tmp, "mirror2")
        os.makedirs(os.path.join(mir2, "apps", "zizvideo", local_ver), exist_ok=True)
        asset_m2 = "zizvideo_%s_darwin_arm64" % local_ver
        with open(os.path.join(mir2, "apps", "zizvideo", local_ver, asset_m2), "wb") as f:
            f.write(body)
        row_m2 = {"name": asset_m2, "version": local_ver, "arch": "arm64",
                  "sha256": hashlib.sha256(body).hexdigest(), "size": len(body)}
        json.dump({"app": "zizvideo", "latest": local_ver, "assets": [row_m2]},
                  open(os.path.join(mir2, "apps", "zizvideo", "manifest.json"), "w"))
        json.dump({"app": "zizvideo", "version": local_ver, "assets": [row_m2]},
                  open(os.path.join(mir2, "apps", "zizvideo", local_ver, "manifest.json"), "w"))
        rc, out = sh(["bash", "tools/preflight.sh", "--only", "post-artifacts"],
                     env={"ZV_PREFLIGHT_MIRROR": "file://" + mir2})
        results.append(("假镜像上产物与索引一致 → 报「线上字节与索引 sha256 一致」",
                        "线上字节与索引 sha256 一致" in out, out.strip()[-200:]))

        # ---------------- ⑤ 产物被追加一个字节 ----------------
        with open(os.path.join(mir2, "apps", "zizvideo", local_ver, asset_m2), "ab") as f:
            f.write(b"x")
        rc, out = sh(["bash", "tools/preflight.sh", "--only", "post-artifacts"],
                     env={"ZV_PREFLIGHT_MIRROR": "file://" + mir2})
        results.append(("线上产物被换过 → 报「大小不符」或「sha256 不符」",
                        ("大小不符" in out) or ("sha256 不符" in out), out.strip()[-200:]))

        # ---------------- ⑥ 本地有、镜像没有的索引 = 漏传 ----------------
        # 本地 dist 里确实有 linux.json（make release 产出），所以镜像缺它就是"漏传"
        rich = os.path.join(tmp, "mirror3")
        shutil.copytree(mir2, rich)
        try:
            os.remove(os.path.join(rich, "apps", "zizvideo", local_ver, asset_m2))
        except OSError:
            pass
        to_delete = "linux.json"
        have_local = os.path.isfile(os.path.join(ROOT, "dist", "apps", "zizvideo", to_delete))
        if have_local:
            rc, out = sh(["bash", "tools/preflight.sh", "--only", "post-artifacts"],
                         env={"ZV_PREFLIGHT_MIRROR": "file://" + rich})
            results.append(("本地有 linux.json、镜像没有 → 报「漏传」",
                            "漏传" in out, out.strip()[-200:]))
        else:
            results.append(("本地有 linux.json、镜像没有 → 报「漏传」（跳过：本地没有 linux.json）", True, ""))

        # ---------------- ⑦ 两份索引资产不一致 ----------------
        bad2 = os.path.join(tmp, "mirror4")
        shutil.copytree(rich, bad2)
        p = os.path.join(bad2, "apps", "zizvideo", local_ver, "manifest.json")
        d = json.load(open(p))
        d["assets"][0]["sha256"] = "1" * 64
        json.dump(d, open(p, "w"))
        rc, out = sh(["bash", "tools/preflight.sh", "--only", "post-artifacts"],
                     env={"ZV_PREFLIGHT_MIRROR": "file://" + bad2})
        results.append(("顶层索引与版本目录索引不一致 → 报出来",
                        "不一致" in out, out.strip()[-200:]))

        bad = [r for r in results if not r[1]]
        for name, ok, detail in results:
            print(("  ✓ " if ok else "  ✗ ") + name + ("" if ok else "\n      " + detail.replace("\n", " ")[:300]))
        print("发布链路判据自测：%d/%d 场景通过" % (len(results) - len(bad), len(results)))
        return 1 if bad else 0
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
