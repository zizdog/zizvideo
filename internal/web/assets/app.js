// 入口：hash 路由 + 启动引导（setup 判定 → 会话判定）

import { api } from "./js/api.js";
import { clear, el } from "./js/dom.js";
import { session, loadMe, mountLogin, mountRegister, mountSetup, doLogout } from "./js/auth.js";
import { mountFeed } from "./js/feed.js";
import { mountAdmin } from "./js/admin.js";
import { mountNav } from "./js/nav.js";
import { mountSeries, mountSeriesPlay } from "./js/series.js";
import { mountFavorites } from "./js/favorites.js";
import { mountRecordPlay } from "./js/cards.js";
import { mountMe, mountCached } from "./js/me.js";
import { mountSettings } from "./js/settings.js";
import { mountUpload, mountMyUploads } from "./js/upload.js";
import { mountSearch } from "./js/search.js";
import { renderTopBar } from "./js/topbar.js";

const viewEl = document.getElementById("view");
const headerEl = document.getElementById("header");

// 应用内来路（顶部返回键用）：不依赖 history.length（那可能是别的站点），也绝不会把用户带出应用。
let currentPath = "";
const trail = [];
const AUTH_PATHS = ["/login", "/register", "/setup"];
function notePath(path) {
  if (path === currentPath) return;
  // 登录/注册/初始化不算"来路"（进和出都算）：否则登录后落在首页，返回键会把人送回登录页，
  // 而登录页又把已登录的人打回首页 —— 一个点了没用的死循环按钮。
  if (AUTH_PATHS.includes(path) || AUTH_PATHS.includes(currentPath)) {
    trail.length = 0;
    currentPath = path;
    return;
  }
  if (trail.length && trail[trail.length - 1] === path) trail.pop(); // 回退
  else if (currentPath) trail.push(currentPath); // 前进
  currentPath = path;
}
function backTarget() { return trail.length ? trail[trail.length - 1] : "/feed"; }
function canGoBack() { return trail.length > 0 || currentPath !== "/feed"; }

let needsSetup = false;
let current = null;

function teardown() {
  if (current && typeof current.cleanup === "function") {
    try { current.cleanup(); } catch (err) { /* 视图清理失败不阻塞路由 */ }
  }
  current = null;
}

// 播放页（首页/剧场播放/记录播放）：顶栏浮在视频上（菜单 + 搜索）。
// 用户 2026-09-24："菜单和搜索只在播放页面显示，其它所有页面都不需要" —— 其余路由整条顶栏不显示。
const PLAYER_ROUTES = [/^\/feed$/, /^\/series\//, /^\/play\//, /^\/later\//];
function isPlayerRoute(path) { return PLAYER_ROUTES.some((re) => re.test(path || "")); }

function show(mount) {
  teardown();
  clear(viewEl);
  const path = (location.hash || "").replace(/^#/, "");
  if (isPlayerRoute(path)) {
    renderTopBar(headerEl, {
      showBack: canGoBack(),
      onBack: () => { location.hash = "#" + backTarget(); },
      onMenu: () => openSidePanel(),
      onSearch: () => { location.hash = "#/search"; },
    });
  } else {
    // 非播放页：顶栏既不放按钮也不占高度（header 的 52px 一起还回去）
    clear(headerEl);
    headerEl.hidden = true;
  }
  current = { cleanup: mount(viewEl) || null };
}

// 侧面板（用户 2026-09-23 要求）：**内容先留空**，后续再往里放功能。
function openSidePanel() {
  if (document.querySelector(".side-panel")) return;
  const panel = el("aside", { class: "side-panel", dataset: { role: "side-panel" } });
  const mask = el("div", { class: "side-mask", dataset: { role: "side-mask" } });
  const close = () => { panel.remove(); mask.remove(); };
  mask.addEventListener("click", close);
  panel.append(
    el("div", { class: "side-panel-head" },
      el("span", { text: "菜单" }),
      el("button", { class: "btn small", type: "button", text: "关闭", onclick: close })),
    el("div", { class: "side-panel-body", text: "这里先留空，后续再放内容。" }));
  document.body.append(mask, panel);
  requestAnimationFrame(() => panel.classList.add("open"));
}

function route() {
  const path = (location.hash || "").replace(/^#/, "");
  notePath(path);
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
  if (path === "/search" || path.startsWith("/search/")) {
    const q = path === "/search" ? "" : decodeURIComponent(path.slice("/search/".length));
    show((view) => withNav(view, "feed", () => mountSearch(view, q)));
    return;
  }
  if (path === "/settings") {
    show((view) => withNav(view, "me", () => mountSettings(view)));
    return;
  }
  if (path === "/me") {
    show((view) => withNav(view, "me", () => mountMe(view, { onLogout })));
    return;
  }
  // 用户上传（UGC）：上传页与「我的上传」；有没有权限由后端 403 说了算（这里不猜）。
  if (path === "/upload") {
    show((view) => withNav(view, "upload", () => mountUpload(view)));
    return;
  }
  if (path === "/me/uploads") {
    show((view) => withNav(view, "me", () => mountMyUploads(view)));
    return;
  }
  // 手机 App 的离线缓存管理（清单/删除走原生桥，播放在 App 里交给原生播放器）
  if (path === "/me/cached") {
    show((view) => withNav(view, "me", () => mountCached(view)));
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
