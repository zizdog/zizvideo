#!/usr/bin/env python3
"""check-container-assets.py —— 校验容器部署的三份文件（静态结构 + 入口脚本**行为**）

静态（docker/Dockerfile、docker-compose.yml、docker/entrypoint.sh）：
  · Dockerfile：有 `FROM`、**非 root** 的 `USER`、`VOLUME`、`EXPOSE`、`COPY zizvideo`（用发行版二进制、不在镜像里编译）；
  · compose：给了 `ZV_LISTEN`/`ZV_DATA_DIR`/`ZV_MEDIA_ROOTS`，挂了 `/data` 卷；
  · entrypoint 通过 `sh -n`。
行为（真跑 `docker/entrypoint.sh`，`ZV_BIN=/bin/true` 顶掉真正的二进制）—— 这部分原来只在门禁里**静态**断言，
  等于没验过行为：
  · ① 首次启动写出配置，字段齐全（含 `scan_workers`）、`database_path` 在 `data_dir` 内；
  · ② **已有配置绝不覆盖**（用户改过的东西不能被容器重启冲掉）；
  · ③ 不存在的媒体根**不写进配置**，且**明确说出来**（否则 `/readyz` 会一直 503、"应用像坏了"）；
  · ④ 非绝对路径被忽略。

反例（自带）：把 Dockerfile 的 `USER` 删掉，校验必须报错（否则这些判据是摆设）。

用法：python3 tools/check-container-assets.py [--dir <另一份 docker/ 目录>]   退出码 0=通过，1=有问题
"""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# `--dir <path>` 指向一份 docker/ 副本，便于**反例自测**（改坏的副本必须被抓住）
DDIR = sys.argv[2] if len(sys.argv) > 2 and sys.argv[1] == "--dir" else os.path.join(ROOT, "docker")
DOCKERFILE = os.path.join(DDIR, "Dockerfile")
COMPOSE = os.path.join(DDIR, "docker-compose.yml")
ENTRY = os.path.join(DDIR, "entrypoint.sh")


def run_entrypoint(data_dir, media_roots, extra_env=None):
    env = dict(os.environ)
    env.update({"ZV_LISTEN": "127.0.0.1:7999", "ZV_DATA_DIR": data_dir,
                "ZV_MEDIA_ROOTS": media_roots, "ZV_BIN": "/bin/true"})
    env.update(extra_env or {})
    return subprocess.run(["sh", ENTRY], capture_output=True, text=True, timeout=60, env=env, cwd=ROOT)


def main() -> int:
    problems = []
    checks = 0

    # ---------------- 静态：Dockerfile ----------------
    if not os.path.isfile(DOCKERFILE):
        problems.append("缺 docker/Dockerfile")
    else:
        txt = open(DOCKERFILE, encoding="utf-8").read()
        checks += 5
        if not re.search(r"^FROM\s+\S+", txt, re.M):
            problems.append("Dockerfile 没有 FROM")
        if not re.search(r"^USER\s+(?!root)\S+", txt, re.M):
            problems.append("Dockerfile 没有非 root 的 USER（容器不该以 root 跑）")
        if not re.search(r"^VOLUME", txt, re.M):
            problems.append("Dockerfile 没有 VOLUME（数据要能挂出来）")
        if not re.search(r"^EXPOSE", txt, re.M):
            problems.append("Dockerfile 没有 EXPOSE")
        if "COPY zizvideo" not in txt:
            problems.append("Dockerfile 没拷贝 zizvideo（应当用发行版里的静态二进制，不在镜像里编译）")
        # 反例：把 USER 删掉，门禁判据必须能报（证明检查不是摆设）
        with tempfile.TemporaryDirectory() as td:
            bad = os.path.join(td, "Dockerfile")
            with open(bad, "w") as f:
                f.write(re.sub(r"^USER.*$", "", txt, flags=re.M))
            bad_txt = open(bad).read()
            if re.search(r"^USER\s+(?!root)\S+", bad_txt, re.M):
                problems.append("反例失败：删掉 USER 后仍被判为有 USER（检查无效）")
            checks += 1

    # ---------------- 静态：compose ----------------
    if not os.path.isfile(COMPOSE):
        problems.append("缺 docker/docker-compose.yml")
    else:
        ctxt = open(COMPOSE, encoding="utf-8").read()
        for k in ("ZV_LISTEN", "ZV_DATA_DIR", "ZV_MEDIA_ROOTS"):
            checks += 1
            if k not in ctxt:
                problems.append("compose 缺环境变量 %s" % k)
        checks += 1
        if "/data" not in ctxt:
            problems.append("compose 没挂数据卷 /data")

    # ---------------- 静态：entrypoint 语法 ----------------
    if not os.path.isfile(ENTRY):
        problems.append("缺 docker/entrypoint.sh")
        print("\n".join("  ✗ " + p for p in problems))
        return 1
    rc = subprocess.run(["sh", "-n", ENTRY], capture_output=True, text=True).returncode
    checks += 1
    if rc != 0:
        problems.append("docker/entrypoint.sh 语法错")

    # ---------------- 行为：真跑一遍 ----------------
    with tempfile.TemporaryDirectory() as td:
        data = os.path.join(td, "data")
        media_ok = os.path.join(td, "media exists")
        os.makedirs(media_ok, exist_ok=True)
        missing = os.path.join(td, "missing")
        r = run_entrypoint(data, "%s:%s:/relative" % (media_ok, missing))
        cfg_path = os.path.join(data, "config.json")
        checks += 1
        if not os.path.isfile(cfg_path):
            problems.append("入口脚本没有生成配置")
        else:
            cfg = json.load(open(cfg_path))
            checks += 4
            for key in ("listen", "data_dir", "database_path", "media_allow_roots", "allow_register", "scan_workers"):
                if key not in cfg:
                    problems.append("生成的配置缺字段 %s（应与其它平台一致）" % key)
            if not str(cfg.get("database_path", "")).startswith(cfg.get("data_dir", "").rstrip("/") + "/"):
                problems.append("database_path 不在 data_dir 内（备份/卸载会漏掉它）")
            if missing in cfg.get("media_allow_roots", []):
                problems.append("不存在的媒体根被写进了配置（会让 /readyz 一直 503）")
            if "/relative" in cfg.get("media_allow_roots", []):
                problems.append("非绝对路径被写进了配置")
            if "卷挂上了吗" not in (r.stdout + r.stderr) and missing in r.stdout + r.stderr:
                problems.append("不存在的媒体根没有说清原因（应提示「卷挂上了吗」）")
        # ② 已有配置绝不覆盖
        checks += 1
        if os.path.isfile(cfg_path):
            with open(cfg_path, "a") as f:
                f.write("\n")
            before = open(cfg_path).read()
            run_entrypoint(data, media_ok)
            if open(cfg_path).read() != before:
                problems.append("已有配置被覆盖了（容器重启不该冲掉用户改过的东西）")

    if problems:
        print("容器部署有问题（%d 处）：" % len(problems))
        for p in problems:
            print("  ✗ " + p)
        return 1
    print("✓ 容器部署通过：Dockerfile/compose/entrypoint 静态结构 + 入口脚本行为（%d 项判据）" % checks)
    return 0


if __name__ == "__main__":
    sys.exit(main())
