// 沉浸（旋转全屏）与清屏播放：feed 只有一个，状态全局一份（rt.full，见 feed-state.js）。
// 转屏三级策略：原生桥 → screen.orientation.lock → CSS 把播放器整体转 90°。

import { el } from "./dom.js";
import { icon, setIcon } from "./icons.js";

export function createFullscreenModule(ctx) {
  const feed = ctx.feed;
  const rt = ctx.rt;
  const showToast = ctx.core.showToast;
  const togglePlay = ctx.core.togglePlay;

  /* ---------- 清屏播放 / 旋转全屏（用户 2026-09-23） ---------- */

  // 清屏：把边栏/标题/角标都收起来，只留一个小箭头还原（比"点画面切换"更明确，不会和"点画面=暂停"打架）
  /* ---------- 全屏（沉浸）状态：全局一份（feed 只有一个） ---------- */
  //
  // 用户 2026-09-24：「全屏播放时不显示任何按钮/进度、边栏收起；点屏幕切换显示；
  // 左上角显示返回按钮（左箭头）」。所以全屏 = 沉浸态：进去先全收起，点屏幕来回切换。

  let lastImmersive = null;
  function paintImmersive() {
    const on = rt.full.rotated || rt.full.native;
    // CSS 旋转只在"系统没横过来"时用 —— 忘了它会出现"进了全屏但画面没横过来"（我自己踩过）
    feed.classList.toggle("rot", rt.full.rotated);
    // ⚠️ 沉浸态（收顶栏/底栏/控件）**与转屏方式无关**：手机/App 里是系统横屏（native=true、
    // rotated=false），只按 rotated 判断会让顶栏、底栏大喇喇留在屏幕上（用户 2026-09-24 报障：
    // "电脑端显示不出来，手机端无论浏览器还是 App 都显示"）。
    document.body.classList.toggle("rot-play", on);
    feed.classList.toggle("immersive", on);
    feed.classList.toggle("blank", rt.full.uiHidden);
    // 告诉 App 现在是不是全屏：系统返回手势要"先退出全屏"（见 WebActivity.handleOnBackPressed）
    if (on !== lastImmersive) {
      lastImmersive = on;
      try { if (window.ZvAndroid && window.ZvAndroid.setImmersive) window.ZvAndroid.setImmersive(on); } catch (err) { /* 老版本 App 没有这个口 */ }
    }
  }
  function setImmersive(on) {
    rt.full.uiHidden = on;            // 进全屏先收起，退出全屏恢复
    if (on) feed.classList.remove("clean"); // 别和"清屏"那个状态打架
    paintImmersive();
  }
  function immersiveOn() { return rt.full.rotated || rt.full.native; }

  // 清屏状态记在本机（用户 2026-09-24："右侧工具栏折叠样式加记忆功能"）：
  // 下次进来、切条目都保持上次的选择，不用每次手点。
  const CLEAN_KEY = "zv_clean";
  function readCleanPref() {
    try { return localStorage.getItem(CLEAN_KEY) === "on"; } catch (err) { return false; }
  }
  function writeCleanPref(on) {
    try {
      if (on) localStorage.setItem(CLEAN_KEY, "on");
      else localStorage.removeItem(CLEAN_KEY);
    } catch (err) { /* 隐私模式忽略 */ }
  }
  function applyClean(btn, on) {
    feed.classList.toggle("clean", on);
    if (!btn) return;
    btn.title = on ? "显示图标" : "清屏播放";
    // 清屏后显示**反向（向上）箭头**：换 expand 那种四角图标会被看成"箭头没了"（用户报障）
    setIcon(btn, on ? "up" : "down");
  }

  /** 清屏开关（面板里的「清屏播放」行用它；边栏那个按钮已经收进面板）。 */
  function toggleClean() {
    const on = !feed.classList.contains("clean");
    feed.classList.toggle("clean", on);
    writeCleanPref(on);
    applyClean(null, on);
    showToast(on ? "已清屏，长按画面可还原" : "已显示图标");
    return on;
  }

  /** 分享：优先系统分享面板（手机），桌面退回复制链接。 */
  async function shareItem(entry) {
    const item = entry.item || {};
    const url = location.origin + "/#/play/feed/" + encodeURIComponent(item.id || "");
    try {
      if (navigator.share) {
        await navigator.share({ title: item.title || "zizvideo", url });
        return;
      }
      await navigator.clipboard.writeText(url);
      showToast("链接已复制");
    } catch (err) {
      showToast("分享没成功（可手动复制地址）");
    }
  }

  // 旋转全屏（用户 2026-09-24）：**不许依赖系统自动旋转**。
  // 三级策略：① 安卓原生桥能接管就交给它（真·系统横屏）；
  //          ② 否则试全屏 + screen.orientation.lock("landscape")；锁了要**回读真实朝向**（lock 会假装成功）；
  //          ③ 都不行就 CSS 把播放器整体转 90°（竖屏视口里也能横过来看，把手机横过来就行）。
  // 进全屏 = 进沉浸态：控件全收起，点屏幕切换（用户 2026-09-24）。
  // 只有 type 与 matchMedia **两处都说是横屏**才算"系统真的转了"：
  // lock() 在无头/WebView 里会假装成功（实测 type 会短暂变 landscape 但实际没转），只信一处会误判成"已横屏"。
  const isLandscape = () => {
    try {
      const type = screen.orientation && screen.orientation.type ? String(screen.orientation.type) : "";
      const mq = window.matchMedia("(orientation: landscape)").matches;
      return type.startsWith("landscape") && mq;
    } catch (err) { return false; }
  };
  const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

  async function enterFullscreen() {
    const bridge = window.ZvAndroid;
    try {
      if (bridge && typeof bridge.landscape === "function") rt.full.native = bridge.landscape(true) === true;
    } catch (err) { rt.full.native = false; }
    if (!rt.full.native) {
      try {
        if (document.fullscreenElement === null && document.documentElement.requestFullscreen) {
          await document.documentElement.requestFullscreen();
        }
        if (screen.orientation && typeof screen.orientation.lock === "function") {
          await screen.orientation.lock("landscape");
          await sleep(250);
          rt.full.native = isLandscape();
          await sleep(200);              // 再读一次：假成功会自己退回去
          if (!isLandscape()) rt.full.native = false;
        }
      } catch (err) { rt.full.native = false; }
    }
    rt.full.rotated = !rt.full.native;
    setImmersive(true);
    showToast(rt.full.native ? "横屏全屏（点屏幕显隐控件）" : "已旋转横屏：把手机横过来看（点屏幕显隐控件）");
  }

  // 离开播放页（返回/路由切换/清理）也要把全屏状态交还回去：用户 2026-09-24
  // "全屏时点击返回应该同时退出全屏状态，而不是仅仅返回" —— 只清 class 不够，
  // 系统横屏（原生桥）、方向锁、document 全屏都得释放。
  // ⚠️ document.exitFullscreen 与 native 无关：浏览器那条路是我们自己 requestFullscreen 的（踩过）。
  async function releaseSystemFullscreen() {
    try { if (window.ZvAndroid && window.ZvAndroid.landscape) window.ZvAndroid.landscape(false); } catch (err) { /* 忽略 */ }
    try { if (screen.orientation && screen.orientation.unlock) screen.orientation.unlock(); } catch (err) { /* 忽略 */ }
    try { if (document.fullscreenElement) await document.exitFullscreen(); } catch (err) { /* 忽略 */ }
  }

  async function releaseFullscreen() {
    rt.full.rotated = false;
    rt.full.native = false;
    rt.full.uiHidden = false;
    paintImmersive();
    await releaseSystemFullscreen();
  }

  async function exitFullscreen() {
    await releaseFullscreen();
    showToast("已退出横屏");
  }

  function immersiveBack() {
    const btn = el("button", { class: "icon-btn imm-back", type: "button", title: "退出全屏",
      dataset: { role: "imm-back" } }, icon("back"));
    btn.addEventListener("click", (event) => { event.stopPropagation(); exitFullscreen(); });
    return btn;
  }

  // 全屏里的暂停入口：**画面正中的播放/暂停键**（用户 2026-09-24："可以在视频中间显示暂停按钮"）。
  // 只在沉浸态且控件可见时出现；点了就地暂停/继续。
  function centerPlayPause(entry) {
    const btn = el("button", { class: "center-btn center-pause", type: "button", title: "暂停/播放",
      dataset: { role: "center-pause" } }, icon("pause"));
    const paint = () => setIcon(btn, entry.video && !entry.video.paused ? "pause" : "play");
    btn.addEventListener("click", (event) => {
      event.stopPropagation();
      togglePlay(entry);
      paint();
      if (entry.video && entry.video.paused) { rt.full.uiHidden = false; paintImmersive(); }
    });
    entry.paintPlayPause = paint;
    paint();
    return btn;
  }

  // 全屏（旋转全屏）按钮：按用户 2026-09-24 的要求**回到侧栏**（视频下方那排已撤）
  function fullscreenButton() {
    const btn = el("button", { class: "icon-btn", type: "button", title: "旋转全屏",
      dataset: { role: "rail-fullscreen" } }, icon("expand"));
    const paint = () => {
      const on = immersiveOn();
      setIcon(btn, on ? "collapse" : "expand");
      btn.title = on ? "退出横屏" : "旋转全屏";
    };
    btn.addEventListener("click", async (event) => {
      event.stopPropagation();
      if (immersiveOn()) await exitFullscreen();
      else await enterFullscreen();
      paint();
    });
    paint();
    return btn;
  }

  return { immersiveOn, paintImmersive, setImmersive, enterFullscreen, exitFullscreen,
    releaseFullscreen, immersiveBack, centerPlayPause, fullscreenButton, toggleClean };
}
