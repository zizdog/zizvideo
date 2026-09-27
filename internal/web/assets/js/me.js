// 我的：账号、内容入口、设置入口、版本、退出登录（条目 10）
// 用户 2026-09-22：入口要"简单" —— 不再用整行大按钮；版本号直接写在这一页，不再单独做「关于」页。

import { el, fmtDate, fmtBytes, clear, banner, setBanner } from "./dom.js";
import { api } from "./api.js";
import { session } from "./auth.js";
import { videoCard } from "./cards.js";

function kv(label, value) {
  return el("div", { class: "kv" },
    el("span", { class: "k", text: label }),
    el("span", { class: "v", text: value === null || value === undefined || value === "" ? "-" : String(value) }));
}

// cell 是一行"简单入口"：左标签 + 右侧说明 + ›，不是占满整行的大按钮。
function cell(href, label, note, role) {
  return el("a", { class: "cell", href, dataset: role ? { role } : undefined },
    el("span", { class: "cell-label", text: label }),
    note ? el("span", { class: "cell-note", text: note }) : null,
    el("span", { class: "cell-chevron", text: "›" }));
}

export function mountMe(view, options) {
  const opts = options || {};
  const user = session.user || {};
  const account = el("div", { class: "panel", dataset: { role: "me-account" } },
    el("div", { class: "panel-title", text: "账号" }),
    kv("用户名", user.username),
    kv("显示名", user.display_name),
    kv("角色", user.role === "admin" ? "管理员" : "普通用户"),
    kv("上次登录", user.last_login_at ? fmtDate(user.last_login_at) : "首次"));
  // 可访问媒体库：数值来自唯一判据的 /me/libraries（P3 / B.6）
  const libraryLine = kv("可访问媒体库", "-");
  account.append(libraryLine);
  api.myLibraries().then((list) => {
    const n = Array.isArray(list) ? list.length : 0;
    libraryLine.lastChild.textContent = n ? (n + " 个") : "未授权任何媒体库";
  }).catch(() => { libraryLine.lastChild.textContent = "未复核"; });

  // 用户 2026-09-23：这里**不再放**播放设置（首页右上 ⚙ 有）和稍后再看（收藏面板里有 Tab），
  // 与收藏板块重合的功能不重复列；以后想清楚了再加别的。
  const settings = el("div", { class: "panel", dataset: { role: "me-settings" } },
    el("div", { class: "panel-title", text: "设置" }));
  // 离线缓存（手机 App 才有）：入口只在原生桥在的时候出现（用户 2026-09-24：
  // "下载完成后应该出现在我的-已缓存里面"）
  if (window.ZvAndroid && typeof window.ZvAndroid.listCached === "function") {
    const cachedCell = cell("#/me/cached", "已缓存", "读取中…", "me-cached");
    settings.append(cachedCell);
    try {
      const list = JSON.parse(window.ZvAndroid.listCached() || "[]");
      const bytes = list.reduce((sum, it) => sum + (Number(it.size) || 0), 0);
      cachedCell.querySelector(".cell-note").textContent = list.length
        ? (list.length + " 集 · " + fmtBytes(bytes)) : "还没有缓存";
    } catch (err) {
      cachedCell.querySelector(".cell-note").textContent = "读取失败";
    }
  }
  if (user.role === "admin") settings.append(cell("#/admin", "管理后台", "", "me-admin"));
  // 扫码登录电视（用户 2026-09-27）：手机 App 开相机扫电视上那张码，电视就直接登录，不用在电视上打字。
  // 只在原生桥在的时候出现（网页端没有相机扫描口，网页那边走 #/qrlogin 出码）。
  if (window.ZvAndroid && typeof window.ZvAndroid.startQrScan === "function") {
    const scanCell = cell("#/me", "扫码登录电视", "扫电视上的二维码", "me-qrscan");
    settings.append(scanCell);
    scanCell.addEventListener("click", (event) => {
      event.preventDefault(); // 不跳页：相机页由原生拉起，结果也由原生提示
      try { window.ZvAndroid.startQrScan(""); } catch (err) { /* 老版本 App 没这个口 */ }
    });
  }
  // 检查更新（App 才有原生桥；用户 2026-09-25："给 app 加自动检查更新，不想再一次次手动下载安装"）：
  // 平时进 App 就自动查一次，这里是"手动再查一次"的入口（自动那次被划掉/错过时用）。
  if (window.ZvAndroid && typeof window.ZvAndroid.checkUpdate === "function") {
    const updateCell = cell("#/me", "检查更新", "App 读取中…", "me-update");
    settings.append(updateCell);
    const note = updateCell.querySelector(".cell-note");
    try {
      note.textContent = "App " + (window.ZvAndroid.appVersion ? window.ZvAndroid.appVersion() : "?");
    } catch (err) {
      note.textContent = "App 版本读取失败";
    }
    updateCell.addEventListener("click", (event) => {
      event.preventDefault(); // 不跳页：就地让原生去查（弹窗/提示都由原生给）
      try { window.ZvAndroid.checkUpdate(true); } catch (err) { /* 老版本 App 没这个口 */ }
    });
  }
  // 换 App 图标（用户 2026-09-25）：desktop 图标是原生的事，这里只做一个入口 + 显示当前用的是哪个。
  if (window.ZvAndroid && typeof window.ZvAndroid.chooseAppIcon === "function") {
    const iconCell = cell("#/me", "App 图标", "读取中…", "me-icon");
    settings.append(iconCell);
    const note = iconCell.querySelector(".cell-note");
    const paint = () => {
      try { note.textContent = window.ZvAndroid.appIcon() === "fig2" ? "图2（音符）" : "默认（狗头标）"; }
      catch (err) { note.textContent = "读取失败"; }
    };
    paint();
    window.__zvPaintIcon = paint; // 原生切完图标回调它刷新这一行
    iconCell.addEventListener("click", (event) => {
      event.preventDefault();
      try { window.ZvAndroid.chooseAppIcon(); } catch (err) { /* 老版本 App 没这个口 */ }
    });
  }
  // 用户上传（UGC）：只有开了白名单的账号才显示入口（管理员天然有）
  if (user.role === "admin" || user.can_upload) {
    settings.append(cell("#/upload", "上传视频", "进了待审区，管理员通过后入库", "me-upload"));
    settings.append(cell("#/me/uploads", "我的上传", "状态 / 驳回原因", "me-uploads"));
  }

  // 版本号就几个字，直接写在这一页（不再单独一个「关于」页）
  const version = el("div", { class: "muted small-note center version", dataset: { role: "app-version" }, text: "zizvideo" });
  api.setupStatus().then((status) => {
    version.textContent = (status && status.version) ? ("zizvideo " + status.version) : "zizvideo 版本未复核";
  }).catch(() => { version.textContent = "zizvideo 版本未复核"; });

  const logout = el("button", {
    class: "btn danger", type: "button", text: "退出登录", dataset: { role: "logout" },
    onclick: () => { if (opts.onLogout) opts.onLogout(); },
  });
  view.append(el("div", { class: "page" },
    el("div", { class: "page-head" }, el("h2", { class: "page-title", text: "我的" })),
    account, settings,
    el("div", { class: "actions" }, logout), version));
  return null;
}

// mountCached：手机 App 的「已缓存」列表（离线缓存管理，用户 2026-09-24 要求）。
// 缓存文件在 App 私有目录里，网页看不见 ⇒ 清单与删除都走原生桥。
// 显示逻辑**必须与收藏/点赞列表一致**（用户 2026-09-25 报障：原来只有一串 med_xxxx、没有封面）：
//   · 下载时就把标题/封面/时长写进本地副档（App 侧 OfflineStore）⇒ 离线也看得懂；
//   · 老缓存没有副档，才回落到按 id 查 API；
//   · 渲染复用 cards.js 的 videoGrid/videoCard（16:9 封面 + 时长角标 + 两行标题），不另做一套。
export function mountCached(view, options) {
  const opts = options || {};
  const note = banner();
  const listBox = el("div", { class: "panel", dataset: { role: "cached-list" } });
  const countLine = el("div", { class: "muted small-note", dataset: { role: "cached-count" } });
  const head = el("div", { class: "page-head" },
    el("h2", { class: "page-title", text: "已缓存" }),
    el("a", { class: "link small-note", href: "#/me", text: "‹ 我的" }));
  view.append(el("div", { class: "page" }, head, note, countLine, listBox));

  const bridge = window.ZvAndroid;
  if (!bridge || typeof bridge.listCached !== "function") {
    listBox.append(el("div", { class: "muted small-note", text: "这个界面只在手机 App 里有（网页端没有本机缓存）。" }));
    return null;
  }

  // 回落到 API 补齐的元数据（只有老缓存才用得上），键是 media id。
  const fetched = {};

  function itemsFromBridge() {
    let raw = [];
    try {
      raw = JSON.parse(bridge.listCached() || "[]");
    } catch (err) {
      return null;
    }
    return raw.map((it) => {
      const id = String(it.id || "");
      const extra = fetched[id] || {};
      const cover = it.cover || extra.cover_url || (id ? ("/api/v1/media/" + encodeURIComponent(id) + "/cover") : "");
      return {
        id,
        title: it.title || extra.title || "",
        cover_url: cover,
        duration_ms: Number(it.duration_ms) || Number(extra.duration_ms) || 0,
        size: Number(it.size) || 0,
        progress: {},
      };
    }).filter((it) => it.id);
  }

  function render() {
    const items = itemsFromBridge();
    if (items === null) {
      clear(listBox);
      setBanner(note, "读取缓存清单失败");
      return;
    }
    clear(listBox);
    if (!items.length) {
      countLine.textContent = "";
      listBox.append(el("div", { class: "muted small-note", text: "还没有缓存。播放页长按弹面板 →「缓存视频」。" }));
      return;
    }
    const total = items.reduce((sum, it) => sum + it.size, 0);
    countLine.textContent = "共 " + items.length + " 集 · " + fmtBytes(total) + "（存在手机里，删掉不影响服务器）";
    // 网格自己拼：videoGrid 只接受"数据项"、卡片选项由它自己定；这里每条要带自己的
    // 深链与「删除缓存」按钮，所以直接用同一个 videoCard（样式/DOM 仍然只有一份）。
    const grid = el("div", { class: "video-grid", dataset: { role: "cached-grid" } });
    for (const it of items) grid.append(cachedCard(it));
    listBox.append(grid);
    hydrate(items);
  }

  // cachedCard：同一套卡片，角标给时长（和收藏一致），大小 + 删除放在标题下面的补充行里。
  function cachedCard(item) {
    const del = el("button", { class: "btn small danger", type: "button", text: "删除缓存",
      dataset: { role: "cached-delete", media: item.id } });
    del.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!window.confirm("删掉这一集的离线缓存？（只删手机上的文件）")) return;
      try { bridge.deleteCached(item.id); } catch (err) { /* 老版本 App 没有这个口 */ }
      render();
    });
    const card = videoCard(item, {
      list: { key: "cached", navKey: "feed" },
      href: "#/play/feed/" + encodeURIComponent(item.id),
      meta: [el("span", { class: "muted small-note", text: fmtBytes(item.size) }), del],
    });
    card.dataset.role = "cached-row";
    card.dataset.media = item.id;
    const open = card.querySelector(".video-open");
    if (open) open.dataset.role = "cached-play";
    return card;
  }

  // 老缓存（升级前下的）本地没有标题：按 id 查一次 API 补上，补完重绘一次。
  // 查不到就如实显示 #id（服务器记录可能已经删了，但手机上的文件还在）。
  let hydrating = false;
  function hydrate(items) {
    const missing = items.filter((it) => !fetched[it.id] && (!it.title || !it.duration_ms));
    if (hydrating || !missing.length) return;
    hydrating = true;
    Promise.all(missing.map((it) => api.media(it.id).then((m) => { if (m) fetched[it.id] = m; })
      .catch(() => { fetched[it.id] = { title: "", duration_ms: 0 }; })))
      .then(() => { hydrating = false; render(); })
      .catch(() => { hydrating = false; });
  }

  render();
  return null;
}
