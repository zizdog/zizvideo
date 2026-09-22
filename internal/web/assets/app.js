// 入口：hash 路由 + 启动引导（setup 判定 → 会话判定）

import { api } from "./js/api.js";
import { clear } from "./js/dom.js";
import { session, loadMe, renderHeader, mountLogin, mountRegister, mountSetup, doLogout } from "./js/auth.js";
import { mountFeed } from "./js/feed.js";
import { mountAdmin } from "./js/admin.js";
import { mountNav } from "./js/nav.js";
import { mountSeries, mountSeriesPlay } from "./js/series.js";
import { mountFavorites } from "./js/favorites.js";
import { mountWatchLater, mountWatchLaterPlay } from "./js/watch-later.js";
import { mountRecordPlay, mountSinglePlay } from "./js/cards.js";
import { mountMe } from "./js/me.js";

const headerEl = document.getElementById("header");
const viewEl = document.getElementById("view");

let needsSetup = false;
let current = null;

function teardown() {
  if (current && typeof current.cleanup === "function") {
    try { current.cleanup(); } catch (err) { /* 视图清理失败不阻塞路由 */ }
  }
  current = null;
}

function show(mount, hideHeader) {
  teardown();
  clear(viewEl);
  renderHeader(headerEl, onLogout, hideHeader);
  current = { cleanup: mount(viewEl) || null };
}

function route() {
  const path = (location.hash || "").replace(/^#/, "");
  if (path === "/setup") {
    if (!needsSetup) { replace(session.user ? "#/feed" : "#/login"); return; }
    show((view) => mountSetup(view, () => { needsSetup = false; go("#/feed"); }), true);
    return;
  }
  if (path === "/login") {
    if (session.user) { replace("#/feed"); return; }
    show((view) => mountLogin(view, () => go("#/feed")), true);
    return;
  }
  // 自助注册：只由登录页「注册」链接进入；开关由后端再拦一次（AUTH_REGISTER_DISABLED）。
  if (path === "/register") {
    if (session.user) { replace("#/feed"); return; }
    show((view) => mountRegister(view, () => go("#/feed")), true);
    return;
  }
  if (path === "/admin" || path.startsWith("/admin/")) {
    if (!session.user) { replace("#/login"); return; }
    if (session.user.role !== "admin") { replace("#/feed"); return; }
    // #/admin/roots 直达允许根页签，剧场空状态卡片的「去加允许根」用得到。
    const tab = path.startsWith("/admin/") ? decodeURIComponent(path.slice("/admin/".length)) : "";
    show((view) => mountAdmin(view, tab), false);
    return;
  }
  if (!session.user) { replace("#/login"); return; }
  if (path === "/series") {
    show((view) => withNav(view, "series", () => mountSeries(view)), false);
    return;
  }
  if (path.startsWith("/series/")) {
    const id = decodeURIComponent(path.slice("/series/".length));
    // 播放页复用首页播放器，底栏由 mountFeed 自己挂（active="series"），
    // 这里不能再包 withNav，否则会出现两条底栏。
    show((view) => mountSeriesPlay(view, id), false);
    return;
  }
  if (path === "/favorites") {
    show((view) => withNav(view, "favorites", () => mountFavorites(view)), false);
    return;
  }
  if (path === "/later") {
    // 从「我的」进来，底栏高亮「我的」。
    show((view) => withNav(view, "me", () => mountWatchLater(view)), false);
    return;
  }
  if (path.startsWith("/later/")) {
    // 点卡片播放：复用首页播放器（它自己挂底栏，navKey=me），这里不能再包 withNav。
    const id = decodeURIComponent(path.slice("/later/".length));
    show((view) => mountWatchLaterPlay(view, id), false);
    return;
  }
  // 单条预览（后台"去重"页点封面）：仍然用唯一那份播放器，列表里只有一条
  if (path.startsWith("/one/")) {
    const id = decodeURIComponent(path.slice("/one/".length));
    show((view) => mountSinglePlay(view, id), false);
    return;
  }
  // 点赞/收藏/历史 的卡片点开：同一套"把记录列表当播放列表"的实现
  if (path.startsWith("/play/")) {
    const rest = path.slice("/play/".length);
    const cut = rest.indexOf("/");
    const kind = cut < 0 ? rest : rest.slice(0, cut);
    const id = cut < 0 ? "" : decodeURIComponent(rest.slice(cut + 1));
    show((view) => mountRecordPlay(view, decodeURIComponent(kind), id), false);
    return;
  }
  if (path === "/watch-later") { location.replace("#/later"); return; } // 旧书签
  if (path === "/me") {
    show((view) => withNav(view, "me", () => mountMe(view, { onLogout })), false);
    return;
  }
  if (path !== "/feed") { replace("#/feed"); return; }
  show((view) => mountFeed(view), false);
}

// withNav 给新页面挂底栏：mount 先执行，底栏固定在底部，路由切换时随 view 一起清空。
function withNav(view, active, mount) {
  const cleanup = mount();
  view.append(mountNav(active));
  return typeof cleanup === "function" ? cleanup : null;
}

function go(hash) {
  if (location.hash === hash) route();
  else location.hash = hash;
}

function replace(hash) {
  if (location.hash === hash) { route(); return; }
  history.replaceState(null, "", hash);
  route();
}

async function onLogout() {
  await doLogout();
  go("#/login");
}

async function boot() {
  try {
    const status = await api.setupStatus();
    needsSetup = !!(status && status.needs_setup);
  } catch (err) {
    needsSetup = false;
  }
  if (needsSetup) { go("#/setup"); return; }
  try { await loadMe(); } catch (err) { session.user = null; }
  if (!location.hash) history.replaceState(null, "", session.user ? "#/feed" : "#/login");
  route();
}

window.addEventListener("hashchange", route);
boot();
