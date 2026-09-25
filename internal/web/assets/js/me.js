// 我的：账号、内容入口、设置入口、版本、退出登录（条目 10）
// 用户 2026-09-22：入口要"简单" —— 不再用整行大按钮；版本号直接写在这一页，不再单独做「关于」页。

import { el, fmtDate, fmtBytes, clear, banner, setBanner } from "./dom.js";
import { api } from "./api.js";
import { session } from "./auth.js";

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
// 缓存文件在 App 私有目录里，网页看不见 ⇒ 清单与删除都走原生桥；
// 标题按 media id 去 API 查（查不到就显示 id —— 库里的记录可能已经删了，但文件还在）。
export function mountCached(view, options) {
  const opts = options || {};
  const note = banner();
  const listBox = el("div", { class: "panel", dataset: { role: "cached-list" } });
  const head = el("div", { class: "page-head" },
    el("h2", { class: "page-title", text: "已缓存" }),
    el("a", { class: "link small-note", href: "#/me", text: "‹ 我的" }));
  view.append(el("div", { class: "page" }, head, note, listBox));

  const bridge = window.ZvAndroid;
  if (!bridge || typeof bridge.listCached !== "function") {
    listBox.append(el("div", { class: "muted small-note", text: "这个界面只在手机 App 里有（网页端没有本机缓存）。" }));
    return null;
  }

  async function refresh() {
    let items = [];
    try {
      items = JSON.parse(bridge.listCached() || "[]");
    } catch (err) {
      setBanner(note, "读取缓存清单失败");
      return;
    }
    clear(listBox);
    if (!items.length) {
      listBox.append(el("div", { class: "muted small-note", text: "还没有缓存。播放页长按弹面板 →「缓存视频」。" }));
      return;
    }
    const total = items.reduce((sum, it) => sum + (Number(it.size) || 0), 0);
    listBox.append(el("div", { class: "muted small-note",
      text: "共 " + items.length + " 集 · " + fmtBytes(total) + "（存在手机里，删掉不影响服务器）" }));
    for (const it of items) {
      const title = el("span", { class: "cell-label", text: it.id });
      const row = el("div", { class: "cell", dataset: { role: "cached-row", media: String(it.id) } },
        title,
        el("span", { class: "cell-note", text: fmtBytes(Number(it.size) || 0) }));
      // 播放：走深链交给原生播放器（它会优先用本地文件）
      const play = el("button", { class: "btn small primary", type: "button", text: "播放",
        dataset: { role: "cached-play" } });
      play.addEventListener("click", (event) => {
        event.stopPropagation();
        location.hash = "#/play/feed/" + encodeURIComponent(it.id);
      });
      const del = el("button", { class: "btn small danger", type: "button", text: "删除",
        dataset: { role: "cached-delete" } });
      del.addEventListener("click", (event) => {
        event.stopPropagation();
        if (!window.confirm("删掉这一集的离线缓存？（只删手机上的文件）")) return;
        try { bridge.deleteCached(String(it.id)); } catch (err) { /* 老版本 App 没有这个口 */ }
        refresh();
      });
      row.append(el("span", { class: "actions" }, play, del));
      listBox.append(row);
    }
    // 标题：按 id 查 API（有就换成真标题；没有就算了，别编）
    for (const it of items) {
      api.media(String(it.id)).then((m) => {
        if (m && m.title) {
          const row = listBox.querySelector('[data-role="cached-row"][media="' + it.id + '"] .cell-label');
          if (row) row.textContent = m.title;
        }
      }).catch(() => { /* 记录没了就显示 id */ });
    }
  }

  refresh();
  return null;
}
