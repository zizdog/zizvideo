#!/usr/bin/env python3
"""check-fnos-project.py —— 校验飞牛 fnOS 应用包目录（**静态契约检查**，本机没有飞牛设备时的第一道闸）

覆盖（都是"fnpack 不查、真机上才暴露"的东西）：
  ① 必需文件/目录齐全（manifest、两张图标、config/{privilege,resource}、app/<uidir>/config、wizard/*）；
  ② manifest：键名（拼错的键会被 fnOS **静默忽略**）、重复键（后写的静默覆盖）、取值集合、必需字段；
  ③ 与入口配置交叉引用：`desktop_applaunchname` 必须真的存在、入口 `port` == `service_port`；
  ④ `config/privilege` 是官方模板的**最小形态**（只有 `defaults.run-as=package`，不用 root）；
  ⑤ `config/resource` 是合法 JSON；
  ⑥ `wizard/*` 形状正确，字段类型只在 fnpack **实测接受**的三种里（text/password/switch）；
  ⑦ 图标尺寸（ICON.PNG 64×64、ICON_256.PNG 256×256）。

`fnpack build` 只检查"必需文件在不在、JSON 能不能解析"，它**不会**告诉你：
  · 键名拼错了（`descripton=` —— fnOS 直接忽略，你的描述就永远不会出现，而且**不报错**）；
  · 取值不合法（`platform=arm64` 应为 `arm`；`ctl_stop=yes` 应为 `true`；端口写成 `0`）；
  · 入口配置与 manifest 对不上（`desktop_applaunchname` 指向的入口不存在 ⇒ 桌面卡片点不开；
    入口 `port` 与 `service_port` 不一致 ⇒ fnOS 改了端口后入口指错地方）。

这些错在真机上表现为"装上了但某功能不工作"，而本机没有飞牛设备 ⇒ 只能静态查。

用法：python3 tools/check-fnos-project.py fnos/zizvideo     退出码 0=通过，1=有问题，2=参数错
"""
import json
import os
import re
import sys

# 官方文档（developer.fnnas.com 的 manifest 一节）列出的字段
KNOWN_KEYS = {
    "appname", "version", "display_name", "desc", "source", "platform",
    "maintainer", "maintainer_url", "distributor", "distributor_url",
    "os_min_version", "os_max_version", "ctl_stop", "install_type",
    "install_dep_apps", "desktop_uidir", "desktop_applaunchname",
    "service_port", "checkport", "disable_authorization_path", "changelog", "micro_app",
}
BOOLS = {"true", "false"}


def parse_manifest(path):
    """解析 manifest，并**报出重复键**：后写的会静默覆盖前一行（
    `ctl_stop=yes` 后面又有一行 `ctl_stop=true` ⇒ 前面那个错值就永远看不见了 —— 这类覆盖最难查）。"""
    rows = {}
    seen = {}
    problems = []
    for no, raw in enumerate(open(path, encoding="utf-8").read().splitlines(), 1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            return None, ["第 %d 行不是 key=value：%r" % (no, raw)]
        k, _, v = line.partition("=")
        k = k.strip()
        if k in seen:
            problems.append("第 %d 行：%s 重复出现（第 %d 行已写过，后写的会静默覆盖）" % (no, k, seen[k]))
        seen[k] = no
        rows[k] = v.strip()
    return rows, problems


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__, file=sys.stderr)
        return 2
    pkg = sys.argv[1]
    mpath = os.path.join(pkg, "manifest")
    if not os.path.isfile(mpath):
        print("!! 没有 %s" % mpath, file=sys.stderr)
        return 1

    problems = []
    rows, errs = parse_manifest(mpath)
    problems += errs
    if rows is None:
        for p in problems:
            print("  ✗ " + p)
        return 1

    # ① 未知键 = 拼错（fnOS 静默忽略）
    for k in sorted(rows):
        if k not in KNOWN_KEYS:
            problems.append("未知字段 %s=（fnOS 会静默忽略；是不是拼错了？）" % k)
    # ② 必需字段
    for k in ("appname", "version", "display_name", "desc", "source", "platform",
              "desktop_uidir", "desktop_applaunchname"):
        if not rows.get(k):
            problems.append("缺必需字段 %s=" % k)
    # ③ 取值约束
    if rows.get("source") != "thirdparty":
        problems.append("source=%r（第三方应用必须是 thirdparty）" % rows.get("source"))
    plat = rows.get("platform")
    if plat not in ("x86", "arm", "all"):
        problems.append("platform=%r 不认识（只能是 x86 / arm / all）" % plat)
    if plat == "all":
        problems.append("platform=all，但包里带原生二进制（必须分 x86/arm）")
    if not re.match(r"^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.\-]+)?$", rows.get("version", "")):
        problems.append("version=%r 形状不对（飞牛要 1.0.0 / 1.2.3-beta 这种）" % rows.get("version"))
    if not re.match(r"^[a-z][a-z0-9_\-]*$", rows.get("appname", "")):
        problems.append("appname=%r 建议小写字母/数字/_/-（且升级期间不许改）" % rows.get("appname"))
    for k in ("ctl_stop", "checkport", "disable_authorization_path", "micro_app"):
        if k in rows and rows[k] not in BOOLS:
            problems.append("%s=%r 必须是 true/false" % (k, rows[k]))
    if "service_port" in rows:
        try:
            port = int(rows["service_port"])
            if not 1 <= port <= 65535:
                problems.append("service_port=%s 不在 1..65535" % rows["service_port"])
        except ValueError:
            problems.append("service_port=%r 不是数字" % rows["service_port"])
    if "os_min_version" in rows and not re.match(r"^\d+(\.\d+){1,3}$", rows["os_min_version"]):
        problems.append("os_min_version=%r 形状不对（如 1.0.0）" % rows["os_min_version"])
    if "install_type" in rows and rows["install_type"] not in ("", "root"):
        problems.append("install_type=%r（空=用户选卷，root=装到系统分区）" % rows["install_type"])
    if "/" in rows.get("desktop_uidir", ""):
        problems.append("desktop_uidir=%r 不该带斜杠（它是 app/ 下的目录名）" % rows["desktop_uidir"])

    # ④ 与入口配置交叉核对
    uidir = rows.get("desktop_uidir", "ui")
    cfg_path = os.path.join(pkg, "app", uidir, "config")
    if not os.path.isfile(cfg_path):
        problems.append("入口配置不在：app/%s/config" % uidir)
    else:
        try:
            cfg = json.load(open(cfg_path, encoding="utf-8"))
        except Exception as exc:                                     # noqa: BLE001
            problems.append("入口配置不是合法 JSON：%s" % exc)
            cfg = None
        if cfg is not None:
            entries = cfg.get(".url") or {}
            if not entries:
                problems.append("入口配置里没有 .url（桌面卡片没有入口）")
            launch = rows.get("desktop_applaunchname")
            if launch and launch not in entries:
                problems.append("desktop_applaunchname=%s 在入口配置里找不到（卡片点不开）" % launch)
            sport = rows.get("service_port")
            for eid, e in entries.items():
                got = str(e.get("port") or "")
                if sport and got != sport:
                    problems.append("入口 %s 的 port=%r ≠ service_port=%s（fnOS 改端口后这个入口就指错地方）"
                                    % (eid, got, sport))
                if got == "{port}":
                    problems.append("入口 %s 用了 {port} 占位符 —— fnpack **不会替换**它（实测），必须写实际端口" % eid)
                if not e.get("icon"):
                    problems.append("入口 %s 没有 icon" % eid)

    # ⑤ 必需文件/目录
    for rel in ("manifest", "ICON.PNG", "ICON_256.PNG", "config/privilege", "config/resource",
                "app/%s/config" % rows.get("desktop_uidir", "ui")):
        if not os.path.exists(os.path.join(pkg, rel)):
            problems.append("缺必需文件/目录：%s" % rel)
    for w in ("install", "config", "uninstall"):
        wpath = os.path.join(pkg, "wizard", w)
        if not os.path.isfile(wpath):
            problems.append("缺向导文件：wizard/%s" % w)
            continue
        wtxt = open(wpath, encoding="utf-8").read()
        if not wtxt.strip():
            continue
        try:
            steps = json.loads(wtxt)
        except Exception as exc:                                     # noqa: BLE001
            problems.append("wizard/%s 不是合法 JSON：%s" % (w, exc))
            continue
        if not isinstance(steps, list) or not steps:
            problems.append("wizard/%s 应是**步骤数组**（官方形状）" % w)
            continue
        for st in steps:
            if not isinstance(st, dict) or not st.get("stepTitle") or not isinstance(st.get("items"), list):
                problems.append("wizard/%s 的每一步都要有 stepTitle 与 items" % w)
                continue
            for it in st["items"]:
                t = it.get("type")
                # ⚠️ 只认 fnpack **实测接受**的三种：官方那套开发 Skill 文档里还列了
                # radio/checkbox/select/tips，但用它们打包会被 `File install is not valid` 拒掉
                if t not in ("text", "password", "switch"):
                    problems.append("wizard/%s 里字段类型 %r 不被 fnpack 接受（只能 text/password/switch）" % (w, t))
                if t != "tips" and not it.get("field"):
                    problems.append("wizard/%s 里非提示项必须带 field" % w)

    # ⑥ 权限：官方模板的最小形态（多了没用，还可能指到不存在的组）
    pv = os.path.join(pkg, "config", "privilege")
    if os.path.isfile(pv):
        try:
            pvj = json.load(open(pv, encoding="utf-8"))
            if set(pvj.keys()) != {"defaults"} or set(pvj["defaults"].keys()) != {"run-as"}:
                problems.append("config/privilege 应只有 defaults.run-as（官方模板的最小形态），实际 %s" % sorted(pvj))
            if pvj.get("defaults", {}).get("run-as") != "package":
                problems.append("config/privilege 的 run-as 必须是 package（最小权限）")
        except Exception as exc:                                     # noqa: BLE001
            problems.append("config/privilege 不是合法 JSON：%s" % exc)

    # ⑦ config/resource 合法
    res = os.path.join(pkg, "config", "resource")
    if os.path.isfile(res):
        try:
            json.load(open(res, encoding="utf-8"))
        except Exception as exc:                                     # noqa: BLE001
            problems.append("config/resource 不是合法 JSON：%s" % exc)

    # ⑧ 图标尺寸（飞牛硬要求 64/256）
    import struct
    for name, want in (("ICON.PNG", 64), ("ICON_256.PNG", 256)):
        ip = os.path.join(pkg, name)
        if not os.path.isfile(ip):
            continue
        data = open(ip, "rb").read()
        if data[:8] != b"\x89PNG\r\n\x1a\n":
            problems.append("%s 不是 PNG" % name)
            continue
        got = struct.unpack(">II", data[16:24])[0]
        if got != want:
            problems.append("%s 是 %d×%d，应为 %d×%d（飞牛硬要求）" % (name, got, got, want, want))

    if problems:
        print("飞牛包目录有问题（%d 处）：" % len(problems))
        for p in problems:
            print("  ✗ " + p)
        return 1
    print("✓ 飞牛包目录通过静态校验：文件/字段/取值/交叉引用/向导/图标都对（%s）" % pkg)
    return 0


if __name__ == "__main__":
    sys.exit(main())
