// 我的：账号、内容入口、设置入口、版本、退出登录（条目 10）
// 用户 2026-09-22：入口要"简单" —— 不再用整行大按钮；版本号直接写在这一页，不再单独做「关于」页。

import { el, fmtDate } from "./dom.js";
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

  // 内容：「稍后再看」（收藏面板的 Tab： #/favorites/later，点卡片用首页那套播放器连播）
  const laterNote = el("span", { class: "cell-note" });
  const content = el("div", { class: "panel", dataset: { role: "me-content" } },
    el("div", { class: "panel-title", text: "内容" }),
    el("a", { class: "cell", href: "#/favorites/later", dataset: { role: "me-watch-later" } },
      el("span", { class: "cell-label", text: "稍后再看" }), laterNote,
      el("span", { class: "cell-chevron", text: "›" })));
  api.watchLater().then((data) => {
    const n = data && Array.isArray(data.list) ? data.list.length : 0;
    laterNote.textContent = n ? (n + " 个") : "空";
  }).catch(() => { laterNote.textContent = ""; });

  // 「我的」里不放播放设置（用户 2026-09-22）：入口只留在首页右上 ⚙。
  const settings = el("div", { class: "panel", dataset: { role: "me-settings" } },
    el("div", { class: "panel-title", text: "设置" }));
  if (user.role === "admin") settings.append(cell("#/admin", "管理后台", "", "me-admin"));

  // 版本号就几个字，直接写在这一页（不再单独一个「关于」页）
  const version = el("div", { class: "muted small-note", dataset: { role: "app-version" }, text: "zizvideo" });
  api.setupStatus().then((status) => {
    version.textContent = (status && status.version) ? ("zizvideo " + status.version) : "zizvideo 版本未复核";
  }).catch(() => { version.textContent = "zizvideo 版本未复核"; });

  const logout = el("button", {
    class: "btn danger", type: "button", text: "退出登录", dataset: { role: "logout" },
    onclick: () => { if (opts.onLogout) opts.onLogout(); },
  });
  view.append(el("div", { class: "page" },
    el("div", { class: "page-head" }, el("h2", { class: "page-title", text: "我的" })),
    account, content, settings,
    el("div", { class: "actions" }, logout), version));
  return null;
}
