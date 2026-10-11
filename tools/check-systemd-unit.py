#!/usr/bin/env python3
"""check-systemd-unit.py —— 校验 systemd 单元文件（写给 Linux/NAS 安装器用）

为什么值得单独查：单元文件**只断言"有 User/Restart/ProtectSystem"是不够的** ——
指令拼错（`ProtectSystem=fll`）、段名拼错（`[Services]`）、键值形状不对，systemd 在**目标 NAS 上**
加载时会拒（`systemctl status` 里报 unknown lvalue / invalid setting），而本机没有 systemd、
跑不起来 ⇒ 只能静态校验。这里做四件事：

  ① 段名必须是 systemd 认识的（Unit/Service/Install/Socket/Timer…）；
  ② 每个键必须在**已知指令白名单**里，有枚举取值的指令（Type/Restart/ProtectSystem…）**值也要对**
     （`ProtectSystem=fll` 这种就算指令名对，systemd 也会拒绝加载）；
  ③ 必填项：`ExecStart` 必须是绝对路径；服务类单元要有 `WantedBy=`；
  ④ 不许有重复键（systemd 只认最后一个，重复通常是复制粘贴出错）。

用法：python3 tools/check-systemd-unit.py <file.service>     退出码 0=通过，1=有问题
"""
import re
import sys

SECTION_OK = {"Unit", "Service", "Install", "Socket", "Timer", "Path", "Mount", "Automount"}

# 只列"我们可能用到 + 常见"的指令；写进来的都是 systemd 真认识的
UNIT_KEYS = {
    "Description", "Documentation", "Requires", "Wants", "After", "Before", "Conflicts",
    "BindsTo", "PartOf", "Requisite", "ConditionPathExists", "ConditionPathIsReadWrite",
    "StartLimitIntervalSec", "StartLimitBurst", "OnFailure", "RequiresMountsFor",
}
SERVICE_KEYS = {
    "Type", "ExecStart", "ExecStartPre", "ExecStartPost", "ExecStop", "ExecStopPost",
    "ExecReload", "Restart", "RestartSec", "User", "Group", "WorkingDirectory",
    "StandardOutput", "StandardError", "SyslogIdentifier", "Environment", "EnvironmentFile",
    "NoNewPrivileges", "PrivateTmp", "ProtectSystem", "ProtectHome", "ReadWritePaths",
    "ReadOnlyPaths", "InaccessiblePaths", "PrivateDevices", "ProtectKernelTunables",
    "ProtectKernelModules", "ProtectControlGroups", "RestrictAddressFamilies",
    "RestrictNamespaces", "LockPersonality", "MemoryDenyWriteExecute", "SystemCallFilter",
    "CapabilityBoundingSet", "AmbientCapabilities", "LimitNOFILE", "LimitNPROC",
    "TimeoutStartSec", "TimeoutStopSec", "KillSignal", "KillMode", "RuntimeDirectory",
    "StateDirectory", "LogsDirectory", "CacheDirectory", "UMask", "Nice", "IOSchedulingClass",
    "OOMScoreAdjust", "Slice", "SupplementaryGroups", "SuccessExitStatus", "WatchdogSec",
}
INSTALL_KEYS = {"WantedBy", "RequiredBy", "Alias", "Also", "DefaultInstance"}

KNOWN = {"Unit": UNIT_KEYS, "Service": SERVICE_KEYS, "Install": INSTALL_KEYS}

# **值**也要校验：指令名对、值拼错（`ProtectSystem=fll`）同样会让 systemd 拒绝加载这个单元，
# 而"断言某几个键存在"根本发现不了。只列有明确枚举的（自由取值的如 Description 不管）。
BOOLS = {"yes", "no", "true", "false", "1", "0", "on", "off"}
VALUE_RULES = {
    "Type": {"simple", "exec", "forking", "oneshot", "dbus", "notify", "idle"},
    "Restart": {"no", "on-success", "on-failure", "on-abnormal", "on-watchdog", "on-abort", "always"},
    "KillMode": {"control-group", "mixed", "process", "none"},
    "ProtectSystem": {"no", "yes", "true", "false", "full", "strict"},
    "ProtectHome": {"no", "yes", "true", "false", "read-only", "tmpfs"},
    "ProtectKernelTunables": BOOLS, "ProtectKernelModules": BOOLS,
    "ProtectControlGroups": BOOLS, "ProtectClock": BOOLS, "RestrictNamespaces": BOOLS | {"yes"},
    "NoNewPrivileges": BOOLS, "PrivateTmp": BOOLS, "PrivateDevices": BOOLS,
    "LockPersonality": BOOLS, "MemoryDenyWriteExecute": BOOLS, "DynamicUser": BOOLS,
}
# 取值带前缀的（file:/append:/truncate: 等）单独处理
PREFIXED = {"StandardOutput", "StandardError", "StandardInput"}


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__, file=sys.stderr)
        return 2
    path = sys.argv[1]
    try:
        lines = open(path, encoding="utf-8").read().splitlines()
    except OSError as exc:
        print("!! 读不了单元文件：%s" % exc, file=sys.stderr)
        return 1

    problems = []
    section = None
    seen = {}
    have = {}
    for no, raw in enumerate(lines, 1):
        line = raw.strip()
        if not line or line.startswith("#") or line.startswith(";"):
            continue
        if line.startswith("[") and line.endswith("]"):
            section = line[1:-1]
            if section not in SECTION_OK:
                problems.append("第 %d 行：段名 [%s] 不是 systemd 认识的段" % (no, section))
            continue
        if "=" not in line:
            problems.append("第 %d 行不是 Key=Value：%r" % (no, line))
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        if section is None:
            problems.append("第 %d 行：还没进任何 [段] 就写了 %s" % (no, key))
            continue
        allowed = KNOWN.get(section)
        if allowed is not None and key not in allowed:
            problems.append("第 %d 行：[%s] 里没有 %s 这个指令（拼错？systemd 会拒绝加载）" % (no, section, key))
        if (section, key) in seen:
            problems.append("第 %d 行：%s 重复出现（第 %d 行已写过；systemd 只认最后一个）"
                            % (no, key, seen[(section, key)]))
        # 值校验：枚举 / 带前缀 / 数值
        rule = VALUE_RULES.get(key)
        if rule is not None and value.strip() not in rule:
            problems.append("第 %d 行：%s=%s 的值不对（systemd 认识的是：%s）"
                            % (no, key, value.strip(), "/".join(sorted(rule))))
        if key in PREFIXED and not re.match(r"^(inherit|null|tty|journal|kmsg|journal\+console|"
                                            r"(file|append|truncate|socket):)", value.strip()):
            problems.append("第 %d 行：%s=%s 不是 systemd 认识的取值" % (no, key, value.strip()))
        if key == "UMask" and not re.match(r"^[0-7]{3,4}$", value.strip()):
            problems.append("第 %d 行：UMask=%s 应是八进制（如 0022）" % (no, value.strip()))
        if key in ("LimitNOFILE", "LimitNPROC") and not re.match(r"^(\d+|infinity|unlimited)$", value.strip()):
            problems.append("第 %d 行：%s=%s 应是数字或 infinity" % (no, key, value.strip()))
        seen[(section, key)] = no
        have.setdefault(section, set()).add(key)

    if "ExecStart" not in have.get("Service", set()):
        problems.append("[Service] 里没有 ExecStart")
    else:
        for no, raw in enumerate(lines, 1):
            if raw.strip().startswith("ExecStart="):
                val = raw.split("=", 1)[1].strip().split()[0]
                if not val.startswith("/"):
                    problems.append("第 %d 行：ExecStart 必须是绝对路径，实际 %r" % (no, val))
    if not have.get("Install"):
        problems.append("没有 [Install] 段（`systemctl enable` 会失败）")
    elif "WantedBy" not in have["Install"]:
        problems.append("[Install] 里没有 WantedBy=（enable 时不知道挂到哪个 target）")
    for need in ("User", "Group"):
        if need not in have.get("Service", set()):
            problems.append("[Service] 里没有 %s=（不利于最小权限/权属可读）" % need)

    if problems:
        print("单元文件有问题（%d 处）：" % len(problems))
        for p in problems:
            print("  ✗ " + p)
        return 1
    print("✓ 单元文件通过：段名/指令/必填项/无重复键都对（%s）" % path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
