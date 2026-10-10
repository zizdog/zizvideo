#!/usr/bin/env python3
"""端到端冒烟：拿**真二进制**跑一遍"短视频/短剧"的完整链路（不碰用户的实例与数据）。

为什么要有这个（2026-10-11）：单测都是"直接插 media 行"，绕过了 ffprobe、真实扫描、
真实配置加载、真实 HTTP 层。而本会话抓到的两个真 bug 恰恰在接缝上：
  · 短剧库扫描按目录给的季号，被扫描后自动跑一次的识别任务抹成 NULL；
  · 上传分片的读超时延长是死代码。
所以这里用临时数据目录 + 临时端口起一个独立实例，走真 HTTP：

    setup(建管理员) → login → 建短视频库 + 短剧库 → 写两个真视频（ffmpeg 生成）
    → 扫描（等任务结束）→ 断言：
      ① 短视频库的内容出现在首页 feed 里；
      ② 短剧库的内容**永不**出现在首页（结构性规则）；
      ③ 短剧库按目录自动建剧，季号/集号正确（Season 1/01.mp4 ⇒ 第 1 季第 1 集）；
      ④ 扫描后的自动识别**没有**把季号抹掉（就是上面那个真 bug）。

跑法：python3 tools/smoke-e2e.py         （需要 ffmpeg/ffprobe 在 PATH）
退出码 0 = 全绿；任何断言失败会给 HTTP body 与日志尾部。
"""
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BIN = os.path.join(ROOT, "dist", "zizvideo")
USER, PASS = "smokeadmin", "smoke-pass-123"


def fail(msg, extra=""):
    print("✗ " + msg)
    if extra:
        print(extra)
    sys.exit(1)


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


class Client:
    """极小的 HTTP 客户端：自带 cookie jar + X-CSRF-Token。"""

    def __init__(self, base):
        self.base = base
        self.cookies = {}
        self.opener = urllib.request.build_opener()

    def call(self, method, path, body=None, raw=False):
        data = None
        headers = {}
        if body is not None:
            data = json.dumps(body).encode()
            headers["Content-Type"] = "application/json"
        if self.cookies:
            headers["Cookie"] = "; ".join("%s=%s" % kv for kv in self.cookies.items())
        if self.cookies.get("zv_csrf"):
            headers["X-CSRF-Token"] = self.cookies["zv_csrf"]
        req = urllib.request.Request(self.base + path, data=data, headers=headers, method=method)
        try:
            with self.opener.open(req, timeout=30) as res:
                payload = res.read()
                self._store(res)
                code = res.status
        except urllib.error.HTTPError as e:
            payload = e.read()
            self._store(e)
            code = e.code
        if raw:
            return code, payload
        try:
            return code, json.loads(payload.decode() or "{}")
        except json.JSONDecodeError:
            return code, {"_raw": payload.decode(errors="replace")}

    def _store(self, res):
        for cookie in res.headers.get_all("Set-Cookie") or []:
            head = cookie.split(";", 1)[0]
            if "=" in head:
                k, v = head.split("=", 1)
                self.cookies[k.strip()] = v.strip()


def make_video(path, seconds=1):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    subprocess.run(
        ["ffmpeg", "-loglevel", "error", "-y", "-f", "lavfi", "-i",
         "testsrc=size=160x90:rate=10:duration=%d" % seconds, "-f", "lavfi", "-i",
         "sine=frequency=440:duration=%d" % seconds,
         "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
         "-c:a", "aac", "-shortest", path],
        check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)


def wait_ready(client, proc, log_path, timeout=40):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if proc.poll() is not None:
            fail("服务提前退出（exit=%s）" % proc.returncode, tail(log_path))
        try:
            code, _ = client.call("GET", "/readyz")
            if code == 200:
                return
        except Exception:
            pass
        time.sleep(0.25)
    fail("等服务就绪超时", tail(log_path))


def tail(path, n=25):
    try:
        with open(path, "r", errors="replace") as f:
            return "--- 日志尾部 ---\n" + "".join(f.readlines()[-n:])
    except OSError:
        return ""


def wait_task(client, task_id, timeout=120):
    deadline = time.time() + timeout
    while time.time() < deadline:
        code, body = client.call("GET", "/api/v1/scan-tasks/" + task_id)
        if code != 200:
            fail("查任务失败 %s: %s" % (code, body))
        task = body.get("data") or {}
        if task.get("status") in ("success", "failed", "interrupted"):
            return task
        time.sleep(0.3)
    fail("扫描任务超时未结束")


def main():
    if not os.path.exists(BIN):
        fail("找不到 %s —— 先 `make build`" % BIN)
    if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
        fail("需要 ffmpeg/ffprobe（探元数据与生成测试视频）")

    work = tempfile.mkdtemp(prefix="zv-smoke-")
    media = os.path.join(work, "media")
    data = os.path.join(work, "data")
    port = free_port()
    cfg = os.path.join(work, "config.json")
    log = os.path.join(work, "server.log")
    with open(cfg, "w") as f:
        json.dump({
            "listen": "127.0.0.1:%d" % port,
            "data_dir": data,
            "database_path": os.path.join(data, "zizvideo.db"),
            "media_allow_roots": [media],
            "allow_register": False,
            "scan_workers": 2,
            "probe_timeout_seconds": 30,
        }, f)

    # 真视频：短视频库 2 条；短剧库 1 部剧（Season 1 两集 + 剧目录下散一集）
    shorts = os.path.join(media, "shorts")
    drama = os.path.join(media, "drama")
    make_video(os.path.join(shorts, "散片一.mp4"))
    make_video(os.path.join(shorts, "散片二.mp4"))
    make_video(os.path.join(drama, "某剧", "Season 1", "01.mp4"))
    make_video(os.path.join(drama, "某剧", "Season 1", "02.mp4"))
    make_video(os.path.join(drama, "某剧", "剧集03.mp4"))

    proc = subprocess.Popen([BIN, "--config", cfg], stdout=open(log, "w"), stderr=subprocess.STDOUT)
    client = Client("http://127.0.0.1:%d" % port)
    try:
        wait_ready(client, proc, log)

        code, body = client.call("POST", "/api/v1/setup",
                                 {"username": USER, "password": PASS, "display_name": "冒烟"})
        if code not in (200, 201):
            fail("建管理员失败 %s: %s" % (code, body), tail(log))
        code, body = client.call("POST", "/api/v1/auth/login", {"username": USER, "password": PASS})
        if code != 200:
            fail("登录失败 %s: %s" % (code, body), tail(log))

        def make_library(name, root, kind):
            code, body = client.call("POST", "/api/v1/libraries",
                                     {"name": name, "root_path": root, "kind": kind})
            if code != 201:
                fail("建库 %s 失败 %s: %s" % (name, code, body), tail(log))
            return body["data"]

        short_lib = make_library("散片库", shorts, "short")
        drama_lib = make_library("短剧库", drama, "drama")
        if short_lib.get("kind") != "short" or drama_lib.get("kind") != "drama":
            fail("库类型没有如实返回：%s / %s" % (short_lib.get("kind"), drama_lib.get("kind")))

        for lib in (short_lib, drama_lib):
            code, body = client.call("POST", "/api/v1/libraries/%s/scan" % lib["id"])
            if code not in (200, 202):
                fail("触发扫描失败 %s: %s" % (code, body), tail(log))
            task = wait_task(client, body["data"]["task_id"])
            if task.get("status") != "success":
                fail("扫描 %s 未成功：%s" % (lib["name"], task), tail(log))

        # 等扫描后的自动识别（真实链路里就是它把我的季号抹掉的）落地
        time.sleep(2.5)

        # ① 首页只出短视频库
        code, body = client.call("GET", "/api/v1/feed/next?limit=50")
        if code != 200:
            fail("取首页失败 %s: %s" % (code, body), tail(log))
        items = (body.get("data") or {}).get("list") or []
        titles = {it.get("title") or "" for it in items}
        libs = {it.get("library_id") for it in items}
        if libs != {short_lib["id"]}:
            fail("首页出现了非短视频库的内容：%s（标题 %s）" % (libs, titles))
        if len(items) != 2:
            fail("首页应有短视频库的 2 条，实际 %d 条：%s" % (len(items), titles))

        # ② 短剧库的媒体都在，且不在首页
        code, body = client.call("GET", "/api/v1/media?per_page=50&kind=drama")
        if code != 200:
            fail("按 kind 列媒体失败 %s: %s" % (code, body), tail(log))
        drama_media = (body.get("data") or {}).get("list") or []
        if len(drama_media) != 3:
            fail("短剧库应有 3 条媒体，实际 %d" % len(drama_media))

        # ③ 短剧库按目录自动建剧 + 季/集号正确（含扫描后自动识别没抹掉季号）
        code, body = client.call("GET", "/api/v1/series")
        if code != 200:
            fail("列剧场失败 %s: %s" % (code, body), tail(log))
        series = [s for s in ((body.get("data") or {}).get("list") or [])
                  if s.get("library_id") == drama_lib["id"]]
        if len(series) != 1 or series[0].get("title") != "某剧":
            fail("短剧库应自动建出 1 部「某剧」，实际 %s" % series)

        code, body = client.call("GET", "/api/v1/series/%s" % series[0]["id"])
        if code != 200:
            fail("读剧集失败 %s: %s" % (code, body), tail(log))
        eps = (body.get("data") or {}).get("list") or []
        if len(eps) != 3:
            fail("「某剧」应有 3 集，实际 %d" % len(eps))
        got = {}
        for ep in eps:
            media_item = ep.get("media") or {}
            got[(ep.get("season"), ep.get("episode"))] = \
                media_item.get("filename") or media_item.get("title") or ep.get("episode_label")
        if (1, 1) not in got or (1, 2) not in got:
            fail("Season 1 的两集季号/集号不对（很可能被扫描后的自动识别抹成 NULL）：%s" % got)
        if not any(k[0] is None for k in got):
            fail("剧目录下直接放的散集应留空季号（不猜），实际 %s" % got)

        # ④ 短视频库那一侧不许被建剧（库类型决定行为）
        if any(s.get("library_id") == short_lib["id"] for s in
               (((client.call("GET", "/api/v1/series")[1].get("data") or {}).get("list")) or [])):
            fail("短视频库里被建出了剧场 —— 库类型没有隔离")

        print("✓ 端到端冒烟通过：首页只出短视频库（2 条）／短剧库 3 条不进首页／"
              "目录自动建剧 1 部 3 集／季号在自动识别后仍在（S1E1、S1E2、散集季号空）")
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
        if os.environ.get("ZV_SMOKE_KEEP"):
            print("（保留了现场：%s）" % work)
        else:
            shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    main()
