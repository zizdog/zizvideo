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

  // 用户 2026-09-23：这里**不再放**播放设置（首页右上 ⚙ 有）和稍后再看（收藏面板里有 Tab），
  // 与收藏板块重合的功能不重复列；以后想清楚了再加别的。
  const settings = el("div", { class: "panel", dataset: { role: "me-settings" } },
    el("div", { class: "panel-title", text: "设置" }));
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
