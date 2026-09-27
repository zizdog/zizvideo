// 扫码登录（用户 2026-09-27："开发一个扫码登录的功能，手机 app 直接扫码不需要输入信息即可登录"）。
//
// 这一页给"要登录的那台设备"看（电视 App 的 WebView、或桌面浏览器）：
// 出一张二维码，手机 App 用相机扫 → 手机用自己的会话确认 → 本页轮询到确认，
// 此时 /qr/poll 的响应里已经带上了会话 cookie（浏览器/WebView 自己会存），直接进首页。
//
// 为什么二维码由服务端出 PNG（/api/v1/auth/qr/image/...）：电视端只要 <img>，
// App 里不必背一个 QR 编码器；二维码内容是 zizvideo:// 深链，用系统相机扫也能拉起 App。

import { api } from "./api.js";
import { el, setBanner } from "./dom.js";
import { tvMode, focusFirst } from "./tv.js";

const POLL_MS = 2000;

export function mountQrLogin(view, onSuccess) {
  const code = el("img", { class: "qr-code", alt: "扫码登录二维码" });
  const note = el("div", { class: "muted small-note center", dataset: { role: "qr-status" }, text: "正在生成二维码…" });
  const again = el("button", {
    class: "btn primary", type: "button", text: "刷新二维码", hidden: true,
    dataset: { role: "qr-refresh" },
  });
  const panel = el("div", { class: "panel narrow qr-panel" },
    el("h1", { class: "title", text: "扫码登录" }),
    el("div", { class: "qr-box" }, code),
    // 一句话说清"用什么扫"（≤40 字）
    el("div", { class: "center", text: "用手机上的 zizvideo App 扫这个码" }),
    note,
    el("div", { class: "actions" }, again),
    el("div", { class: "muted small-note center", text: "同一个账号、同一个服务器；手机没登录时先在手机上登一下" }));
  view.append(panel);

  let timer = null;
  // 两个标志分清楚：stopped = 别再轮询了；cancelled = 路由已经切走（这时不许再跳页）
  let stopped = false;
  let cancelled = false;
  let id = "";
  let secret = "";
  let refreshes = 0;

  function stop() {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
  }

  async function start() {
    if (stopped) return;
    again.hidden = true;
    note.textContent = "正在生成二维码…";
    code.removeAttribute("src");
    let data;
    try {
      data = await api.qrStart();
    } catch (err) {
      note.textContent = "生成二维码失败：" + (err && err.message ? err.message : "未知原因");
      again.hidden = false;
      return;
    }
    if (stopped) return;
    id = data.id;
    secret = data.secret;
    code.src = data.image; // 服务端出的 PNG（绝对路径，跟当前站点同源）
    // id/secret 挂到 DOM 上：不是为了好看，是给验收脚本用（它要替"手机"去 claim；
    // 二维码图本身没法在测试里解码）。它们本来就画在图上，暴露给页面不算多泄露。
    code.dataset.qrId = data.id;
    code.dataset.qrSecret = data.secret;
    code.dataset.qrBase = data.base || "";
    note.textContent = "等待手机确认…（" + Math.round((data.expires_in || 120) / 60) + " 分钟内有效）";
    schedulePoll();
    if (tvMode()) setTimeout(() => focusFirst(), 0); // 遥控器：刷新按钮要能被选中
  }

  function schedulePoll() {
    if (stopped) return;
    timer = setTimeout(poll, POLL_MS);
  }

  async function poll() {
    if (stopped) return;
    try {
      const data = await api.qrPoll(id, secret);
      if (stopped) return;
      if (data.status === "claimed") {
        const who = data.user ? (data.user.display_name || data.user.username) : "";
        note.textContent = who ? "已确认：" + who + "，正在进入…" : "已确认，正在进入…";
        stop();
        // 会话 cookie 已随这次响应落到浏览器/WebView 里，等一下再跳（让用户看清是谁登的）
        // ⚠️ 这里只能看 cancelled（路由切走），不能看 stopped —— 上一版就是被自己刚置的
        // stopped 挡住，结果"登上了却不跳页"（实测踩到）。
        setTimeout(() => { if (!cancelled) onSuccess(); }, 500);
        return;
      }
      if (data.status === "used") {
        note.textContent = "这个码已经用过了，请刷新后重扫";
        again.hidden = false;
        return;
      }
      if (data.status === "expired") {
        note.textContent = refreshes > 2 ? "二维码又过期了，点下面刷新重试" : "二维码已过期，点下面刷新";
        again.hidden = false;
        return;
      }
      note.textContent = "等待手机确认…";
    } catch (err) {
      // 网络抖一下不该把整页废掉：继续轮询（真连不上时下面的刷新按钮还在）
      note.textContent = "网络不稳，正在重试…";
    }
    schedulePoll();
  }

  again.addEventListener("click", () => { refreshes += 1; start(); });
  start();
  // 路由切换时：停轮询 + 标记已取消（show() 会把返回值当 cleanup 调用）
  return () => { cancelled = true; stop(); };
}
