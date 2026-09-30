// 入口：hash 路由 + 启动引导（setup 判定 → 会话判定）

import { api } from "./js/api.js";
import { clear, el } from "./js/dom.js";
import { icon } from "./js/icons.js";
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
import { mountQrLogin } from "./js/qrlogin.js";
import { renderTopBar } from "./js/topbar.js";
import { installTvKeys, focusFirst, tvMode } from "./js/tv.js";

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
  const player = isPlayerRoute(path);
  if (player) {
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
  // 电视端（遥控器）：非播放页把焦点落到第一个可点元素，否则"按了没反应"。
  // 播放页不抢焦点 —— 那边方向键的语义由 feed.js 决定（见 tv.js 的说明）。
  if (!player) setTimeout(focusFirst, 0);
}

// 侧面板（菜单）：照抖音的排版重做（用户 2026-09-27："你参考抖音的图标、排版、设置边栏"）。
// 结构：顶部一排大图标（扫一扫/已缓存/设置）+ 分区标题 + 三列图标网格。
// ⚠️ 这一块**故意不用 flex gap**：老电视 WebView 没有 flex gap（Chrome 84+），间距会全塌，
//    所以统一用 margin 撑开 —— 新写的样式别图省事用 gap。
function sideCell(iconName, label, onClick, role) {
  const btn = el("button", { class: "sp-cell", type: "button", dataset: role ? { role } : undefined },
    el("span", { class: "sp-cell-icon" }, icon(iconName)),
    el("span", { class: "sp-cell-label", text: label }));
  btn.addEventListener("click", onClick);
  return btn;
}

function sideSection(title, cells) {
  return el("div", { class: "sp-section" },
    title ? el("div", { class: "sp-title", text: title }) : null,
    el("div", { class: "sp-grid" }, cells));
}

function openSidePanel() {
  // 电视端不出现边栏（用户 2026-09-27：目前这些功能在电视上有底栏/播放页按键就够，
  // 侧栏里的"扫一扫"在电视上更是没意义 —— 电视没有相机，它只负责显示二维码）。
  if (tvMode()) return;
  if (document.querySelector(".side-panel")) return;
  const panel = el("aside", { class: "side-panel", dataset: { role: "side-panel" } });
  const mask = el("div", { class: "side-mask", dataset: { role: "side-mask" } });
  const close = () => { panel.remove(); mask.remove(); };
  mask.addEventListener("click", close);
  const go = (hash) => { close(); location.hash = hash; };
  const app = window.ZvAndroid || null;
  const hasScan = !!(app && typeof app.startQrScan === "function");
  const hasCache = !!(app && typeof app.listCached === "function");
  const hasUpdate = !!(app && typeof app.checkUpdate === "function");

  // ① 顶部：最多三个大图标（抖音那排"扫一扫/我的钱包/券包"的位置）
  const quick = [];
  if (hasScan) {
    quick.push(sideCell("scan", "扫一扫", () => {
      close();
      try { app.startQrScan(""); } catch (err) { /* 老版本 App 没这个口 */ }
    }, "side-qrscan"));
  }
  if (hasCache) quick.push(sideCell("download", "已缓存", () => go("#/me/cached"), "side-cached"));
  quick.push(sideCell("gear", "设置", () => go("#/settings"), "side-settings"));
  if (quick.length < 2) quick.push(sideCell("search", "搜索", () => go("#/search"), "side-search"));

  // ② 常用功能：三列网格（首页/剧场/收藏 已在底栏，但侧栏进来的多，留着更快）
  const grid = [
    sideCell("home", "首页", () => go("#/feed")),
    sideCell("theater", "剧场", () => go("#/series")),
    sideCell("heart", "收藏", () => go("#/favorites")),
    sideCell("clock", "观看历史", () => go("#/favorites/history")),
    sideCell("down", "稍后再看", () => go("#/favorites/later")),
  ];
  if (session.user && session.user.role === "admin") grid.push(sideCell("grid", "管理后台", () => go("#/admin")));
  if (hasUpdate) {
    grid.push(sideCell("speed", "检查更新", () => {
      close();
      try { app.checkUpdate(true); } catch (err) { /* 老版本 App 没这个口 */ }
    }, "side-update"));
  }
  grid.push(sideCell("person", "我的", () => go("#/me")));
  grid.push(sideCell("back", "退出登录", async () => { close(); await onLogout(); }, "side-logout"));

  panel.append(
    el("div", { class: "side-panel-head" },
      el("span", { class: "sp-head-title", text: "菜单" }),
      el("button", { class: "btn small", type: "button", text: "关闭", onclick: close })),
    el("div", { class: "side-panel-body" },
      sideSection("", quick),
      sideSection("常用功能", grid),
      el("div", { class: "sp-foot", text: "zizvideo" + (window.ZvAndroid && window.ZvAndroid.appVersion ? " · App " + window.ZvAndroid.appVersion() : "") })));
  document.body.append(mask, panel);
  requestAnimationFrame(() => panel.classList.add("open"));
  if (focusFirst) setTimeout(focusFirst, 0); // 电视端：面板开了要能落焦
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
  // 扫码登录：电视/桌面显示二维码，手机 App 扫。未登录也能进（它就是为了"不用输账号"）。
  if (path === "/qrlogin") {
    show((view) => mountQrLogin(view, async () => {
      // 扫码成功后**必须重新拉一次会话**：这一页是"未登录也能进"的，内存里的 session.user 还是 null，
      // 直接 go("#/feed") 会被路由当成未登录又踢回 #/login（实测踩到）。
      try { await loadMe(); } catch (err) { /* 拉不到就走下面，路由会按实际情况处理 */ }
      go("#/feed");
    }));
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

// withNav 给新页面挂导航：手机/网页端固定在底部；电视端挪到**顶部**（用户 2026-09-28 参考鲜时光 TV：
// 导航是顶部那排 pills）—— 与首页（mountFeed 里的 tvBar）保持一致，免得两个页面两套结构。
function withNav(view, active, mount) {
  const tv = tvMode();
  const nav = mountNav(active);
  if (tv) view.append(nav);
  const cleanup = mount();
  if (!tv) view.append(nav);
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
  // 电视端：先把遥控器按键装上（路由渲染前就要在），其它一律不变。
  installTvKeys();
  try {
    const status = await api.setupStatus();
    needsSetup = !!(status && status.needs_setup);
  } catch (err) {
    needsSetup = false;
  }
  if (needsSetup) { go("#/setup"); return; }
  // ⚠️ 只有"服务器明确说没登录（401）"才算未登录。loadMe() 内部已经把 401 收敛成 user=null，
  // 能抛到这里的都是**网络/服务端偶发错误** —— 老代码一律当"没登录"，于是原生刚登录成功、
  // 网页第一个请求没成的用户会被踢回登录页（用户 2026-09-27 真机症状："闪一下又回到登录页"）。
  // 现在：偶发错误重试一次；两次都不成才算没登录，并把"连不上"告诉登录页，别静默。
  let bootFailed = false;
  try {
    await loadMe();
  } catch (err) {
    await new Promise((resolve) => setTimeout(resolve, 600));
    try {
      await loadMe();
    } catch (err2) {
      session.user = null;
      bootFailed = true;
    }
  }
  if (bootFailed) { try { sessionStorage.setItem("zv_boot_failed", "1"); } catch (err) { /* 忽略 */ } }
  if (!location.hash) history.replaceState(null, "", session.user ? "#/feed" : "#/login");
  route();
}

window.addEventListener("hashchange", route);
boot();
