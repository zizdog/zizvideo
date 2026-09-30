// 电视端（Android TV / 盒子）遥控器导航（用户 2026-09-25："利用现在安卓手机 app，同时开发电视端 app"）。
//
// 为什么自己写一套：遥控器只有「上下左右 + 确定 + 返回 + 菜单」，而页面里大量可点元素是 div
// （卡片、面板行），浏览器自带的焦点导航（Tab 序 / 方向键滚屏）够不着它们 —— 实测方向键只会滚页面。
// 所以这里做两件事：
//   ① 空间导航：方向键 → 找"当前焦点那个方向、几何上最近"的可聚焦元素（不是 Tab 顺序，电视上斜着跳很难用）；
//   ② 播放页让位：播放页有自己的语义（画面态：↑↓ 换视频/换集、确定 播放/暂停、← 呼出底栏、→ 呼出功能轮盘；
//      焦点进了界面按钮就是普通焦点导航）。它注册进来的处理器先跑，返回 true 表示"这次按键我吃了"。
//      ⚠️ 长按**不再是任何入口**（用户 2026-09-27："长按为什么要设置？！"）—— 设置面板由遥控器
//      「设置/菜单」键打开（原生 WebActivity 的 __zvTvMenu 口子）。
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
  if (!(rect.width > 1 && rect.height > 1)) return false;
  // 翻页轨道（.track）里**只有当前这条视频**看得见（用户 2026-09-27："方向键够不到底栏"／"按了没反应"）：
  // 没轮到的视频在屏幕外，但它的按钮 getBoundingClientRect 照样有尺寸（外壳是 top:i*100% 摆的），
  // 不加这一条，遥控器就会把焦点送到**屏幕外那条视频**的按钮上。
  // 判据用"当前画面"的标记（tv.js 的 focusFirst 也认它），不用几何裁剪 —— 几何裁剪会把
  // 正在滑入的面板行一起裁掉（实测：面板开了、面板里的行全被判成"看不见"，焦点落不进去）。
  const track = el.closest(".track");
  if (track) {
    const layer = el.closest(".layer");
    if (!layer || layer.getAttribute("data-tv-default") !== "1") return false;
  }
  return true;
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
 * scope：可选，把候选限制在某个容器里（底栏这种横排：←→ 只在条目间走，走到头就停住；
 * 不限制的话"从最左边再往左"会跳到屏幕另一头去，遥控器上就是"按了乱跑"）。
 */
function moveFocus(dir, scope) {
  let list = focusables();
  if (scope) {
    const root = document.querySelector(scope);
    const inside = root ? list.filter((el) => root.contains(el)) : [];
    if (inside.length) list = inside;
  }
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

/** 在某个容器里做空间导航（底栏那种横排用）：导出给播放页用，见 moveFocus 的 scope 说明。 */
export function moveFocusIn(dir, scope) {
  return moveFocus(dir, scope);
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

/** 页面重绘后把焦点拉回"主区"（否则遥控器"按了没反应"）。
 *  主区 = 带 data-tv-default="1" 的元素（播放页是视频画面）—— 用户 2026-09-27 要求
 *  "方向键要能操作整个界面，包括底栏"，所以界面里的按钮是一等公民，但**默认落点仍是画面**：
 *  遥控器一进来就能 ↑↓ 换视频，而不是先跳到一个说不清的按钮上。 */
export function focusFirst() {
  if (!tvMode()) return false;
  const list = focusables();
  // 有浮层（设置面板/选集/弹窗）时**不许**把焦点送回画面：那会让"面板开了、遥控器却按不到面板"。
  // 浮层开着时 focusables() 本来就只返回浮层里的元素，data-tv-default 那条画面不在其中。
  const home = overlayRoots().length ? null : list.find((el) => el.getAttribute("data-tv-default") === "1");
  if (home) return focusEl(home);
  // 默认焦点别落在危险操作上：收藏页 DOM 里第一个可聚焦元素是「清除记录」，一按确定就弹删除框
  const safe = list.find((el) => !el.classList.contains("danger") && el.getAttribute("data-danger") !== "1");
  return focusEl(safe || list[0]);
}

/** 把焦点送到选择器命中的第一个"看得见"的元素（电视端"呼出"某块界面：轮盘 / 底栏 / 顶栏）。 */
export function focusSelector(selector) {
  if (!tvMode()) return false;
  const roots = overlayRoots();
  for (const root of (roots.length ? roots : [document])) {
    for (const el of root.querySelectorAll(selector)) {
      if (visible(el)) return focusEl(el);
    }
  }
  return false;
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
      // ⚠️ "节点还在"不等于"焦点还在"：节点被 **display:none 藏起来**时浏览器会把焦点丢给 body，
      // 而节点仍然 isConnected —— 老判据在这里直接 return，于是焦点框留在原处、实际焦点没了
      // （用户 2026-09-30：进全屏后"焦点框在列表、按上下键却在切播放"）。
      // 判据改成"元素现在**看得见**"：看得见但被主动 blur 的（播放页侧栏退出）仍旧不抢。
      const prevVisible = !!(prev && prev.isConnected && prev.getClientRects && prev.getClientRects().length > 0);
      if (prevVisible) return;
      focusFirst();
    }, 0);
  }, true);
}
