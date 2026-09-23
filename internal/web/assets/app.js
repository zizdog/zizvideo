// 入口：hash 路由 + 启动引导（setup 判定 → 会话判定）

import { api } from "./js/api.js";
import { clear } from "./js/dom.js";
import { session, loadMe, mountLogin, mountRegister, mountSetup, doLogout } from "./js/auth.js";
import { mountFeed } from "./js/feed.js";
import { mountAdmin } from "./js/admin.js";
import { mountNav } from "./js/nav.js";
import { mountSeries, mountSeriesPlay } from "./js/series.js";
import { mountFavorites } from "./js/favorites.js";
import { mountRecordPlay } from "./js/cards.js";
import { mountMe } from "./js/me.js";
import { mountSettings } from "./js/settings.js";

const viewEl = document.getElementById("view");

let needsSetup = false;
let current = null;

function teardown() {
  if (current && typeof current.cleanup === "function") {
    try { current.cleanup(); } catch (err) { /* 视图清理失败不阻塞路由 */ }
  }
  current = null;
}

// 顶栏已经不显示任何东西（用户 2026-09-23："顶部什么都不显示"，退出/设置都进了「我的」），
// 所以这里不再渲染 header，hideHeader 这个参数也一并没用了，别再往回调里塞它。
function show(mount) {
  teardown();
  clear(viewEl);
  current = { cleanup: mount(viewEl) || null };
}

function route() {
  const path = (location.hash || "").replace(/^#/, "");
  if (path === "/setup") {
    if (!needsSetup) { replace(session.user ? "#/feed" : "#/login"); return; }
    show((view) => mountSetup(view, () => { needsSetup = false; go("#/feed"); }));
    return;
  }
  if (path === "/login") {
    if (session.user) { replace("#/feed"); return; }
    show((view) => mountLogin(view, () => go("#/feed")));
    return;
  }
  // 自助注册：只由登录页「注册」链接进入；开关由后端再拦一次（AUTH_REGISTER_DISABLED）。
  if (path === "/register") {
    if (session.user) { replace("#/feed"); return; }
    show((view) => mountRegister(view, () => go("#/feed")));
    return;
  }
  if (path === "/admin" || path.startsWith("/admin/")) {
    if (!session.user) { replace("#/login"); return; }
    if (session.user.role !== "admin") { replace("#/feed"); return; }
    // #/admin/roots 直达允许根页签，剧场空状态卡片的「去加允许根」用得到。
    const tab = path.startsWith("/admin/") ? decodeURIComponent(path.slice("/admin/".length)) : "";
    show((view) => mountAdmin(view, tab));
    return;
  }
  if (!session.user) { replace("#/login"); return; }
  if (path === "/series") {
    show((view) => withNav(view, "series", () => mountSeries(view)));
    return;
  }
  if (path.startsWith("/series/")) {
    const id = decodeURIComponent(path.slice("/series/".length));
    // 播放页复用首页播放器，底栏由 mountFeed 自己挂（active="series"），
    // 这里不能再包 withNav，否则会出现两条底栏。
    show((view) => mountSeriesPlay(view, id));
    return;
  }
  // 收藏面板：点赞 / 收藏 / 稍后再看 / 历史 四个 Tab，支持 #/favorites/later 深链。
  if (path === "/favorites" || path.startsWith("/favorites/")) {
    const tab = path === "/favorites" ? "" : decodeURIComponent(path.slice("/favorites/".length));
    show((view) => withNav(view, "favorites", () => mountFavorites(view, tab)));
    return;
  }
  // 旧的稍后再看入口：列表页已经并进收藏面板，老的链接/书签仍然能用。
  if (path === "/later") { location.replace("#/favorites/later"); return; }
  if (path.startsWith("/later/")) {
    // 点卡片播放：复用首页播放器（唯一那份实现），这里不能再包 withNav。
    const id = decodeURIComponent(path.slice("/later/".length));
    show((view) => mountRecordPlay(view, "later", id));
    return;
  }
  // 点赞/收藏/历史 的卡片点开：同一套"把记录列表当播放列表"的实现
  if (path.startsWith("/play/")) {
    const rest = path.slice("/play/".length);
    const cut = rest.indexOf("/");
    const kind = cut < 0 ? rest : rest.slice(0, cut);
    const id = cut < 0 ? "" : decodeURIComponent(rest.slice(cut + 1));
    show((view) => mountRecordPlay(view, decodeURIComponent(kind), id));
    return;
  }
  if (path === "/watch-later") { location.replace("#/favorites/later"); return; } // 旧书签
  if (path === "/settings") {
    show((view) => withNav(view, "me", () => mountSettings(view)));
    return;
  }
  if (path === "/me") {
    show((view) => withNav(view, "me", () => mountMe(view, { onLogout })));
    return;
  }
  if (path !== "/feed") { replace("#/feed"); return; }
  show((view) => mountFeed(view));
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
