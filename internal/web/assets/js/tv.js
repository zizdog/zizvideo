// 电视端（Android TV / 盒子）遥控器导航（用户 2026-09-25："利用现在安卓手机 app，同时开发电视端 app"）。
//
// 为什么自己写一套：遥控器只有「上下左右 + 确定 + 返回 + 菜单」，而页面里大量可点元素是 div
// （卡片、面板行），浏览器自带的焦点导航（Tab 序 / 方向键滚屏）够不着它们 —— 实测方向键只会滚页面。
// 所以这里做两件事：
//   ① 空间导航：方向键 → 找"当前焦点那个方向、几何上最近"的可聚焦元素（不是 Tab 顺序，电视上斜着跳很难用）；
//   ② 播放页让位：播放页有自己的语义（↑↓ 换视频、←→ 快退快进、确定 播放/暂停、长按确定 开面板），
//      它注册进来的处理器先跑，返回 true 就表示"这次按键我吃了"，不再走通用导航。
//
// 只在 tv 模式生效（原生带 ?tv=1 进来）；网页端与手机 App 一行都不变。

// `summary` 要收：后台「新建媒体库 / 新建分组」是 <details><summary>，不收就永远打不开；
// `[tabindex="-1"]` 要排掉：那是"只给脚本聚焦"的钩子，遥控器停在它上面等于没有焦点。
const FOCUSABLE = "a[href], button, input, select, textarea, summary, [tabindex]:not([tabindex='-1'])";

let feedHandler = null;
let installed = false;

/** 是否是电视端（原生 WebActivity 带 ?tv=1）。 */
export function tvMode() {
  return /[?&]tv=1(&|#|$)/.test(location.search + location.hash);
}

/**
 * 播放页把遥控器处理注册进来：
 *   handler.down(event) 返回 true = 已消费；handler.up(event) 同理（长按确定要靠 up 收尾）。
 */
export function setFeedKeys(handler) {
  feedHandler = handler || null;
}

function visible(el) {
  if (!el || el.disabled || el.hidden) return false;
  if (el.closest(".hidden, [hidden]")) return false;
  // 折叠的 <details>：里面的控件在 Chromium 里**仍有尺寸**（实测 rect 非零），浏览器却不肯把焦点给它 ——
  // 不排掉的话遥控器会"选中"一个看不见的东西，然后按确定没反应。
  const det = el.closest("details");
  if (det && !det.open) return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 1 && rect.height > 1;
}

/**
 * 有浮层（设置面板/选集/选择器/侧栏/弹窗）时，焦点只在浮层里走。
 * 不然 scrim 后面的视频卡片照样"看得见"（有尺寸），焦点会跑到面板底下去。
 *
 * 弹窗（.modal-overlay，z-index 60）**优先**：它永远压在最上层，如果只把它并进下面的面板里，
 * 焦点会被"锁"在弹窗背后那层面板里 —— 实测（2026-09-27 电视端）播放页「删除这个视频」弹出的
 * 选择框就是这么进不去的（3 个按钮遥控器一个都够不到）。
 */
function overlayRoots() {
  const modal = document.querySelectorAll(".modal-overlay");
  if (modal.length) return Array.from(modal);
  const sel = ".set-panel:not(.hidden), .sheet-scrim:not(.hidden), .side-panel, .picker-overlay";
  return Array.from(document.querySelectorAll(sel));
}

function focusables() {
  const roots = overlayRoots();
  const list = [];
  for (const root of (roots.length ? roots : [document])) {
    for (const el of root.querySelectorAll(FOCUSABLE)) if (visible(el)) list.push(el);
  }
  return list;
}

function centerOf(el) {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

function paintFocus(el) {
  for (const old of Array.from(document.querySelectorAll(".tv-focus"))) old.classList.remove("tv-focus");
  if (el && el.classList) el.classList.add("tv-focus");
}

function focusEl(el) {
  if (!el) return false;
  paintFocus(el);
  try { el.focus({ preventScroll: true }); } catch (err) { try { el.focus(); } catch (err2) { /* 忽略 */ } }
  try { el.scrollIntoView({ block: "nearest", inline: "nearest" }); } catch (err) { /* 忽略 */ }
  return true;
}

/**
 * 空间导航：从当前焦点往某个方向找最近的元素。
 * 打分 = 主轴距离 + 2.5 × 垂直偏移 —— 电视上"正下方第二行"要赢过"斜右侧贴着的那个"。
 */
export function moveFocus(dir) {
  const list = focusables();
  if (!list.length) return false;
  const cur = list.indexOf(document.activeElement) >= 0 ? document.activeElement : null;
  if (!cur) {
    // 还没有焦点：先落到"最靠上/最靠左"的那个（第一次按方向键别乱跳）
    const sorted = list.slice().sort((a, b) => {
      const ca = centerOf(a), cb = centerOf(b);
      return dir === "up" || dir === "down" ? (ca.y - cb.y) || (ca.x - cb.x) : (ca.x - cb.x) || (ca.y - cb.y);
    });
    return focusEl(sorted[0]);
  }
  const c = centerOf(cur);
  let best = null;
  let bestScore = Infinity;
  for (const el of list) {
    if (el === cur) continue;
    const p = centerOf(el);
    const dx = p.x - c.x;
    const dy = p.y - c.y;
    let main;
    let cross;
    if (dir === "left") { main = -dx; cross = Math.abs(dy); }
    else if (dir === "right") { main = dx; cross = Math.abs(dy); }
    else if (dir === "up") { main = -dy; cross = Math.abs(dx); }
    else { main = dy; cross = Math.abs(dx); }
    if (main < 8) continue; // 不在这个方向（8px 容差：同一行的两个按钮不算）
    const score = main + cross * 2.5;
    if (score < bestScore) { bestScore = score; best = el; }
  }
  if (!best) return false;
  return focusEl(best);
}

/** 确定键：原生按钮/链接交给浏览器自己点（免得点两次），其它（div 行）这里代点。 */
function activate() {
  const el = document.activeElement;
  if (!el || el === document.body) return false;
  const tag = el.tagName;
  if (tag === "BUTTON" || tag === "A" || tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return false;
  if (typeof el.click === "function") { el.click(); return true; }
  return false;
}

function onKeyDown(event) {
  if (!tvMode()) return;
  const target = event.target;
  const tag = target && target.tagName ? target.tagName : "";
  const dirs = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down" };
  const dir = dirs[event.key];
  // 多行输入里方向键是移光标，别抢
  if (tag === "TEXTAREA" || (target && target.isContentEditable)) return;
  // 下拉框：↑↓ 留给它自己（换选项；实测这台 WebView 里 ↑↓ 会被我们抢走，导致遥控器**改不了任何 select**），
  // ←→ 才用来离开这个框。确定键也别抢 —— 交给浏览器开选择器。
  if (tag === "SELECT") {
    if (dir === "left" || dir === "right") {
      if (moveFocus(dir)) { event.preventDefault(); event.stopPropagation(); }
    }
    return;
  }
  // 单行输入框：↑↓ 是"离开这个框"（遥控器没有 Tab，也没法点）。
  // 用户 2026-09-25 报障："登录界面确认按钮无法获得焦点，输入完信息无法操作登录" ——
  // 原先把 INPUT 一律放行，于是焦点卡在口令框里出不来，下面的登录按钮永远够不着；
  // ←→ 仍旧留给光标（range 调值、文本移光标）。
  if (tag === "INPUT") {
    if (dir === "up" || dir === "down") {
      if (moveFocus(dir)) { event.preventDefault(); event.stopPropagation(); }
    }
    return;
  }
  if (feedHandler && feedHandler.down && feedHandler.down(event)) {
    event.preventDefault();
    event.stopPropagation();
    return;
  }
  if (dir) {
    if (moveFocus(dir)) { event.preventDefault(); event.stopPropagation(); }
    return;
  }
  if (event.key === "Enter") {
    if (activate()) { event.preventDefault(); event.stopPropagation(); }
  }
}

function onKeyUp(event) {
  if (!tvMode()) return;
  if (feedHandler && feedHandler.up && feedHandler.up(event)) {
    event.preventDefault();
    event.stopPropagation();
  }
}

/** 页面重绘后把焦点拉回第一个可聚焦元素（否则遥控器"按了没反应"）。 */
export function focusFirst() {
  if (!tvMode()) return false;
  const list = focusables();
  // 默认焦点别落在危险操作上：收藏页 DOM 里第一个可聚焦元素是「清除记录」，一按确定就弹删除框
  const safe = list.find((el) => !el.classList.contains("danger") && el.getAttribute("data-danger") !== "1");
  return focusEl(safe || list[0]);
}

export function installTvKeys() {
  if (installed || !tvMode()) return;
  installed = true;
  document.documentElement.classList.add("tv");
  // capture 阶段：抢在页面自己的 keydown（播放页的 ←→ 快进等）之前决定谁处理
  document.addEventListener("keydown", onKeyDown, true);
  document.addEventListener("keyup", onKeyUp, true);
  document.addEventListener("focusin", (event) => paintFocus(event.target), true);
  // 列表刷新/轮询重建 DOM 时，正在聚焦的那个节点被删掉 ⇒ 浏览器把焦点丢给 body ⇒ 遥控器"按了没反应"。
  // 只在"**刚才那个节点已经不在文档里**"时才补焦点（主动 blur 的元素还在，就别抢 —— 播放页侧栏退出靠它）。
  document.addEventListener("focusout", (event) => {
    const prev = event.target;
    setTimeout(() => {
      const now = document.activeElement;
      if (now && now !== document.body) return;
      if (prev && prev.isConnected) return;
      focusFirst();
    }, 0);
  }, true);
}
