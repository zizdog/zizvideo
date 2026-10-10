// 竖向全屏短视频流：transform 位移 + 手势锁 + seed 随机游标 + 拖动进度

import { api, patchProgressKeepalive } from "./api.js";
import { icon } from "./icons.js";
import { el, clear, asArray, fmtDuration } from "./dom.js";
import { mountNav } from "./nav.js";
import { session } from "./auth.js";
import { choiceDialog } from "./confirm.js";
import { normalizeFeedSettings, seekSecondsOf, loopEffective } from "./play-settings.js";
import { tvMode, focusFirst, focusSelector, setFeedKeys } from "./tv.js";
import { createFeedRuntime } from "./feed-state.js";
import { createSoundModule } from "./feed-sound.js";
import { createFullscreenModule } from "./feed-fullscreen.js";
import { createNativeModule } from "./feed-native.js";
import { createSettingsPanel } from "./feed-settings-panel.js";
import { createTvModule } from "./feed-tv.js";

const WHEEL_STEP = 40;
const TOUCH_STEP = 50;
const GESTURE_QUIET = 400;   // 一次手势的静默阈值（400ms 内不第二次推进）
const SLIDE_MS = 280;        // 与 .track 的 transition 保持一致
const PROGRESS_EVERY_MS = 5000;
const COMPLETE_TAIL_MS = 1500;
const BATCH = 10;
const WINDOW = 1;

// 手势锁：一次手势只允许前进一条（短内容一次跳两条是回归 bug）
export function createGestureGate({ quietMs = GESTURE_QUIET } = {}) {
  let armed = false;
  let lastInput = -Infinity;
  let animating = false;
  return {
    get animating() { return animating; },
    // 原始输入：距上次输入超过 quietMs 才算一次新手势
    input(now) {
      if (now - lastInput > quietMs) armed = true;
      lastInput = now;
    },
    // 触摸开始：明确开始一次新手势
    begin(now) { armed = true; lastInput = now; },
    // 动画结束（transitionend 或兜底计时器）
    settle() { animating = false; },
    // 取这次手势的推进额度；返回 0 表示本手势已经推进过了
    take(now, direction) {
      if (animating || !armed) return 0;
      armed = false;
      animating = true;
      lastInput = now;
      return direction > 0 ? 1 : -1;
    },
  };
}

function isPlayable(item) {
  if (item.missing) return false; // 文件已不在磁盘上：放不了，别装成能放
  if (item.compatibility && item.compatibility.direct === false) return false;
  if (item.status && item.status !== "ready") return false;
  return true;
}


// inOverlay：事件来自设置面板/遮罩/选集面板 ⇒ 手势不归播放器管（面板要能自己滚）
function inOverlay(target) {
  return !!(target && typeof target.closest === "function" &&
    target.closest(".set-panel, .sheet-scrim, .picker-overlay"));
}

function isInteractive(target) {
  if (!target || typeof target.closest !== "function") return false;
  return !!target.closest("button, input, .bar-wrap, .set-panel, .lib-chip");
}

// 剧场标题："第 3 集 · 片名"；首页没有 episode_label，就是片名。
function titleOf(item, index) {
  const title = item.title || ("#" + item.id);
  const label = item.episode_label || "";
  return label ? (label + " · " + title) : title;
}

// createMediaVideo 是**全站唯一**"给一条媒体造 <video>"的地方：首页/剧场/记录列表/管理端
// 卡片内联播放都用它（用户 2026-09-23："不要重复写播放器，复用即可"）。
// 只负责元素本身（地址、播放属性）；连播/手势/进度上报/声音偏好属于 mountFeed，别塞进来。
export function createMediaVideo(item, opts = {}) {
  const video = el("video", {
    class: opts.class || "video", playsinline: "", "webkit-playsinline": "",
    preload: opts.preload || "metadata",
  });
  video.controls = opts.controls === true;
  video.muted = opts.muted === true;
  video.loop = opts.loop === true;
  // 预览帧：不自动播放时不能只是一块黑（用户 2026-09-24）——用服务端抽好的封面当 poster
  if (item.cover_url) video.poster = item.cover_url;
  // 音量均一化（用户 2026-09-26）：服务端量过响度的会给一个**只衰减**的增益（dB ≤ 0），
  // 直接落在 volume（0..1）上；没量过或不需要调就是 1。每次建元素都按这一条自己的值设。
  const gainDB = Number(item.gain_db) || 0;
  if (gainDB < 0) video.volume = Math.max(0, Math.min(1, Math.pow(10, gainDB / 20)));
  video.src = item.stream_url || ("/api/v1/media/" + encodeURIComponent(item.id) + "/stream");
  return video;
}

// mountFeed 是全站唯一的播放器（用户 2026-09-22 明确要求："剧场直接利用首页，不许两套"）。
// options.playlist = { title, items } 时进入**播放列表模式**（剧场）：
//   · 数据由调用方给（不取随机游标、没有选库）；顺序播、自动连播且不可设置；
//   · 播完最后一集**停止**（首页是无限播放，且一轮内不重复 —— 那是游标逻辑，不在这里）；
//   · 右下图标栏与手势、进度上报、收藏/喜欢/稍后再看/删除全部与首页**同一份代码**；
//   · 只多一个「选集」入口（剧场要选集，首页没有）。
export function mountFeed(view, options = {}) {
  const playlist = options.playlist || null;
  // 电视端（用户 2026-09-28 最新版）：整屏**三栏** ——
  //   左 = 视频列表（同前）· 中 = 播放窗口 · 右 = 媒体库列表（原来顶部那排挪到右边）。
  //   ←→ 在这三栏之间切换（非全屏时）；库里再按 → 露出「剧场/收藏/我的」竖排。
  //   手机/网页端结构一行都不变。
  const tvLayout = tvMode();
  const feed = el("div", { class: "feed" });
  const track = el("div", { class: "track" });
  const chip = el("div", { class: "feed-chip hidden" });
  const toast = el("div", { class: "toast hidden" });
  // tabindex=-1：列表容器只用来"接住"焦点（切库时整批行要重建），不进遥控器的焦点图
  const tvList = tvLayout ? el("div", { class: "tv-list", dataset: { role: "tv-list" }, tabindex: "-1" }) : null;
  const tvStage = tvLayout ? el("div", { class: "tv-stage", dataset: { role: "tv-stage" } }) : null;
  // 右栏：媒体库（竖排）＋ 展开出来的「剧场/收藏/我的」（也竖排）
  const tvLibs = tvLayout ? el("div", { class: "tv-libs collapsed", dataset: { role: "tv-libs" } }) : null;
  // 折叠时露出来的那一条（可聚焦）：焦点一进来就展开媒体库列表（用户 2026-09-29："默认折叠，有焦点再展开"）
  const tvLibsStrip = tvLayout ? el("button", {
    class: "tv-libs-strip", type: "button", text: "媒体库", dataset: { role: "tv-libs-strip" },
  }) : null;
  const tvLibsBody = tvLayout ? el("div", { class: "tv-libs-body" }) : null;
  if (tvLayout) tvLibs.append(tvLibsStrip, tvLibsBody);
  const tvNav = tvLayout ? el("div", { class: "tv-nav", dataset: { role: "tv-nav" } }) : null;
  // 选库入口（P1）：库列表只来自 GET /me/libraries，不再从当前视频反推。
  // 播放列表模式（剧场）没有"切库"概念，所以这两个节点不建。
  const pickerBtn = playlist ? null : el("button", {
    class: "lib-chip hidden", type: "button", text: "选库",
    dataset: { role: "pick-library" },
  });
  const picker = playlist ? null : el("div", {
    class: "set-panel hidden",
    style: { left: "12px", right: "auto", top: "80px" },
  });
  if (tvLayout) {
    // 电视端（用户 2026-09-29 再调整）：从左到右 = 媒体库（默认折叠，有焦点才展开）· 视频列表 · 播放界面。
    // 「剧场/收藏/我的」抽屉在最左边（库里再按 ← 露出来）；「点赞/收藏/设置」那栏贴在播放界面右侧（默认隐藏）。
    feed.classList.add("tv-feed");
    feed.append(el("div", { class: "tv-cols" }, tvNav, tvLibs, tvList, tvStage));
  } else if (picker && pickerBtn) {
    picker.addEventListener("click", (event) => event.stopPropagation());
    pickerBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      picker.classList.toggle("hidden");
    });
    feed.append(track, chip, picker);
  } else {
    feed.append(track, chip);
  }
  view.append(feed, toast);
  // 电视端常驻按键提示（非全屏时挂在左上角，全屏时什么都不显示 —— 用户 2026-09-28 要求）。
  const tvHintMain = el("div", { class: "tv-keyhint-main" });
  const tvHintSub = el("div", { class: "tv-keyhint-sub" });
  const tvHint = el("div", { class: "tv-keyhint" }, tvHintMain, tvHintSub);
  if (tvLayout) feed.append(tvHint);
  // 底栏（应用导航）：电视端搬到右栏、按 → 才露出来的那一列（只留剧场/收藏/我的，见 renderTvNav）。
  const nav = mountNav(playlist ? (playlist.navKey || "series") : "feed");
  if (tvLayout) tvNav.append(nav);
  else view.append(nav);
  // 播放页整屏（用户 2026-09-24）:顶栏改成浮在视频上，否则顶上那 52px 是页面底色（像一条背景横条）
  document.body.classList.add("playing");

  const gate = createGestureGate();
  // 请求世代（generation）：切库（resetFeed）与卸载（cleanup）时 +1。
  // 所有"请求回来后写 state"的地方都要先比对这个值：旧库的在飞响应要是写进新库的列表，
  // 观感就是**内容串库**（切库时 resetFeed 把 loading 清 0 后立刻又发一箭，两条响应谁后到谁写）。
  // ⚠️ 必须用世代计数，不能只靠 AbortController：老 WebView（Chrome 70–86）上它可能根本不存在，
  //    而且 abort 是"尽力而为"——请求已经到达服务端时，响应照样可能回来。
  let feedGen = 0;
  // 另一条独立的世代：播放设置（见 saveSettings）。连点开关时只有最后一次的响应算数。
  let settingsGen = 0;
  // 还挂载着吗？只给"与当前库无关"的响应当判据（见 loadLibraries）：这类数据不属于任何世代，
  // 拿世代去卡它反而会把**有效**的响应丢掉（比如首屏视频比库列表先到、用户点了卡片上的「来自 X」）。
  let alive = true;

  /* ---------- 模块装配 ---------- */
  // 拆出去的几块（feed-state / feed-sound / feed-fullscreen / feed-native /
  // feed-settings-panel / feed-tv）在这里接线：共享状态是同一份对象，互调走显式 ctx
  // （函数声明会提升，建 ctx 时下面这些函数已经在了）。
  const runtime = createFeedRuntime({ playlist });
  const state = runtime.state;
  const rt = runtime.rt;
  const ctx = {
    state, rt, playlist, tvLayout,
    feed, picker,
    tvList, tvStage, tvLibs, tvLibsBody, tvLibsStrip, tvNav, tvHintMain, tvHintSub,
  };
  ctx.core = {
    showToast, isAdmin, toggleWatchLater, askDelete, goTo, ensureEntry, tryPlay, togglePlay,
    maybeLoadMore, switchScope, isPlayable, titleOf, paintPanel, loopEnabled, saveSettings,
    centerMessage,
  };
  ctx.sound = createSoundModule(ctx);
  ctx.fs = createFullscreenModule(ctx);
  ctx.native = createNativeModule(ctx);
  ctx.panels = createSettingsPanel(ctx);
  ctx.tv = createTvModule(ctx);
  // 老调用点一行不改：模块函数在本文件里按原名挂成局部别名。
  const effectiveSoundOn = ctx.sound.effectiveSoundOn;
  const refreshGain = ctx.sound.refreshGain;
  const markSoundBlocked = ctx.sound.markSoundBlocked;
  const clearSoundBlocked = ctx.sound.clearSoundBlocked;
  const soundButton = ctx.sound.soundButton;
  const showSoundHint = ctx.sound.showSoundHint;
  const immersiveOn = ctx.fs.immersiveOn;
  const paintImmersive = ctx.fs.paintImmersive;
  const exitFullscreen = ctx.fs.exitFullscreen;
  const releaseFullscreen = ctx.fs.releaseFullscreen;
  const immersiveBack = ctx.fs.immersiveBack;
  const centerPlayPause = ctx.fs.centerPlayPause;
  const fullscreenButton = ctx.fs.fullscreenButton;
  const paintPip = ctx.native.paintPip;
  const onPipMode = ctx.native.onPipMode;
  const tvNeedsNative = ctx.native.tvNeedsNative;
  const brokenCard = ctx.native.brokenCard;
  const openPanel = ctx.panels.openPanel;
  const closePanels = ctx.panels.closePanels;
  const panelVisible = ctx.panels.panelVisible;
  const anyPanelOpen = ctx.panels.anyPanelOpen;
  const buildEpisodePanel = ctx.panels.buildEpisodePanel;
  const holdCurrent = ctx.panels.holdCurrent;
  const tvRow = ctx.tv.tvRow;
  const paintTvList = ctx.tv.paintTvList;
  const tvStageSet = ctx.tv.tvStageSet;
  const tvPaintLayers = ctx.tv.tvPaintLayers;
  const tvPaint = ctx.tv.tvPaint;
  const tvPaintHint = ctx.tv.tvPaintHint;
  const tvFocusSurface = ctx.tv.tvFocusSurface;
  const tvFocusLibs = ctx.tv.tvFocusLibs;
  const renderTvLibs = ctx.tv.renderTvLibs;
  const renderTvNav = ctx.tv.renderTvNav;
  const tvSetOps = ctx.tv.tvSetOps;
  const tvSetFull = ctx.tv.tvSetFull;
  const onTvFocusIn = ctx.tv.onTvFocusIn;
  const onTvKeyDown = ctx.tv.onTvKeyDown;

  let toastTimer = 0;
  let settleTimer = 0;

  /* ---------- 位移与激活 ---------- */

  function paintTrack(animate) {
    if (tvLayout) { paintTvList(); return; } // 电视端不位移：左列表点亮当前这条即可
    const offset = state.active < 0 ? 0 : -state.active * 100;
    if (animate) {
      track.style.transform = "translate3d(0," + offset + "%,0)";
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = setTimeout(() => { settleTimer = 0; gate.settle(); }, SLIDE_MS + 80);
    } else {
      track.style.transition = "none";
      track.style.transform = "translate3d(0," + offset + "%,0)";
      void track.offsetHeight; // 强制回流，避免位移要下一帧才生效
      track.style.transition = "";
    }
  }

  function onTransitionEnd(event) {
    if (event.target !== track) return;
    if (settleTimer) { clearTimeout(settleTimer); settleTimer = 0; }
    gate.settle();
  }

  function setActive(index, animate, opts) {
    if (index < 0 || index === state.active) return;
    const options = opts || {};
    const previous = state.active;
    // 电视端：焦点**本来就在视频列表里**时，换条（含"自动连播下一集"）要让焦点跟着走 ——
    // 用户 2026-09-30："播放完一集后自动下一集，视频列表的焦点没有跟着变"。
    const prevFocusInList = !!(tvLayout && document.activeElement && document.activeElement.closest &&
      document.activeElement.closest(".tv-list"));
    if (previous >= 0) flushProgress(previous, false);
    state.active = index;
    paintTrack(animate !== false);
    syncWindow(index);
    const entry = state.built.get(index);
    // autoplay=false 只用于"进入首页那一下"（设置里关掉"进入自动播放"）；
    // 用户自己滑/点过来的切换一律照播（options 不传就是 true）。
    const autoplay = options.autoplay !== false;
    if (entry && entry.video && !entry.broken) {
      if (autoplay) tryPlay(entry);
      else showPlayButton(entry);
    }
    refreshGain(index); // 音量均一化：这条要是还没量过，量完把音量落下去
    maybeLoadMore(index);
    warmUpcoming(); // 预加载后面几条：等切过去再拉就来不及
    // 电视端：把"当前这条"的整块画面搬进右侧播放区（见 tvStageSet），再让焦点跟着画面走
    // （否则焦点还留在被搬走的旧 layer 上，遥控器的 ↑↓ 会突然"不响应"——实测过）。
    tvStageSet();
    tvPaintLayers();
    if (tvLayout) tvPaint();
    if (rt.tvSurface) tvFocusSurface();
    if (prevFocusInList) focusSelector(".tv-row.on");
  }

  /**
   * 预加载后面 N 条（首页 2 条、播放列表 1 条）：把壳里的 video 建出来、preload=auto 并 load()。
   * 用户会连着快速滑动，不预热就会"滑过去先转圈"（用户 2026-09-23 明确要求）。
   * 注意：只预热，不播放、不动进度。
   */
  function warmUpcoming() {
    const want = playlist ? 1 : 2;
    for (let k = 1; k <= want; k++) {
      const idx = state.active + k;
      const item = state.items[idx];
      if (!item) break;
      const entry = ensureEntry(idx);
      if (!entry || !entry.video || entry.broken) continue;
      if (entry.video.getAttribute("src") !== item.stream_url) entry.video.src = item.stream_url;
      if (entry.video.preload !== "auto") {
        entry.video.preload = "auto";
        try { entry.video.load(); } catch (err) { /* 忽略：预热失败不影响播放 */ }
      }
    }
  }

  // 一次手势只前进一条：goTo 只按最终目标走一步，不会叠加
  function goTo(index, animate) {
    if (!state.items.length) return;
    if (index > state.items.length - 1 && state.hasMore) {
      const before = state.items.length;
      const gen = feedGen;
      // 翻页回来要是已经切过库/卸载了，这个下标是旧列表的，不能拿去 goTo（同类竞态）
      loadMore().then(() => { if (gen === feedGen && state.items.length > before) goTo(index, animate); });
      return;
    }
    const target = Math.max(0, Math.min(state.items.length - 1, index));
    if (target === state.active) return;
    setActive(target, animate);
  }

  function goToEnd() {
    if (!state.items.length) return;
    goTo(state.items.length - 1);
  }

  /* ---------- 卡片与视频 ---------- */

  function ensureEntry(index) {
    if (state.built.has(index)) return state.built.get(index);
    return buildEntry(index);
  }

  function buildEntry(index) {
    const item = state.items[index];
    const shell = state.shells[index];
    if (!item || !shell) return null;
    // 每次物化都重建整个 layer，销毁时整块移除，避免重复叠加（坑 8）
    // 电视端：**画面自己就是一个可聚焦节点**（抖音 TV 那套"画面态"）。不这样的话方向键永远被
    // 播放语义吃掉，界面里的按钮（含底栏）一个都到不了（用户 2026-09-27 报障）。
    // 只有当前这条 `tabindex=0`（见 tvPaintLayers），其余在翻页轨道里、屏幕外。
    const layer = el("div", { class: "layer" });
    if (tvMode()) {
      layer.tabIndex = index === state.active ? 0 : -1;
      // 当前这条要马上带上"主画面"标记：tv.js 的 visible()／focusFirst() 靠它判断
      // "哪些东西是这条视频里的"（面板刚 append 上来时也要立刻能落焦）。
      if (index === state.active) layer.setAttribute("data-tv-default", "1");
    }
    const stage = el("div", { class: "stage" });
    layer.append(stage);
    shell.append(layer);
    const entry = {
      index, item, layer, video: null, fill: null, elapsed: null, total: null,
      fav: null, like: null, later: null, eps: null, epsPanel: null,
      hint: null, soundHint: null, ffHint: null, playBtn: null, flash: null,
      bubble: null, bar: null, barWrap: null, sound: null, gear: null, panel: null,
      settingsForm: null, seekRatio: 0,
      seeking: false, flashTimer: 0, hintTimer: 0, ffTimer: 0, fastForward: false, suppressClick: false,
      resumeDone: false, playRejected: false, broken: false, destroyed: false,
    };

    // 兜底（用户 2026-09-27 报障"确定没反应"）：有的电视 WebView 把"确定"只做成 click（不送 keydown
    // Enter），而且点到的往往是 body/容器而不是 <video>。这里让**播放区域的点击也当确定**；
    // 按钮/侧栏/面板上的点击不算（它们有自己的处理）。和 keydown 那条用 togglePlay 里 250ms 去重兜住。
    if (tvMode()) {
      layer.addEventListener("click", (event) => {
        const t = event.target;
        if (t && t.closest && t.closest("button, a[href], .ov-rail, .set-panel, .sheet-scrim, .modal-overlay, .imm-back, .center-btn, .lib-chip")) return;
        togglePlay(entry);
      });
    }
    state.built.set(index, entry);

    entry.fav = el("button", { class: "icon-btn", type: "button", title: "收藏" }, icon("heart"));
    entry.like = el("button", { class: "icon-btn", type: "button", title: "喜欢" }, icon("thumb"));
    // 稍后再看已移进设置面板：这里仍然保留节点（toggleWatchLater 要同步它的 .on 状态），只是不挂到边栏
    entry.later = el("button", { class: "icon-btn hidden", type: "button", title: "稍后再看" }, icon("clock"));
    entry.fav.classList.toggle("on", !!item.favorite);
    entry.like.classList.toggle("on", item.reaction === "like");
    entry.later.classList.toggle("on", !!item.watch_later);
    entry.fav.addEventListener("click", () => toggleFavorite(entry));
    entry.like.addEventListener("click", () => toggleLike(entry));
    entry.later.addEventListener("click", () => toggleWatchLater(entry));
    // 删除入口只给管理员（前台也不放宽权限，接口侧再拦一次）
    entry.del = isAdmin()
      ? el("button", { class: "icon-btn", type: "button", title: "删除这个视频" }, icon("trash"))
      : null;
    if (entry.del) {
      entry.del.addEventListener("click", (event) => { event.stopPropagation(); askDelete(entry); });
    }
    // 剧场才有的「选集」（首页没有剧集概念）。图标栏其余部分完全一致。
    entry.eps = playlist
      ? el("button", { class: "icon-btn", type: "button", title: "选集", text: "☰" })
      : null;
    if (entry.eps) {
      entry.eps.addEventListener("click", (event) => {
        event.stopPropagation();
        if (!entry.epsPanel) entry.layer.append(buildEpisodePanel(entry));
        const open = entry.epsPanel.classList.contains("hidden");
        closePanels();
        if (open) entry.epsPanel.classList.remove("hidden");
      });
    }

    // 能不能放：影响工具条画不画画中画/投屏（必须在 append rail 之前算好）
    const playable = isPlayable(item);

    entry.fill = el("span", { class: "bar-fill" });
    entry.elapsed = el("span", { text: "0:00" });
    entry.total = el("span", { text: fmtDuration(item.duration_ms) });
    entry.bubble = el("div", { class: "seek-bubble hidden", text: "0:00" });
    entry.bar = el("div", { class: "bar" }, entry.fill);
    entry.barWrap = el("div", { class: "bar-wrap" }, entry.bar, entry.bubble);
    wireSeek(entry);

    layer.append(el("div", { class: "overlay" },
      el("div", { class: "ov-top" },
        el("div", { class: "ov-title", text: titleOf(item, index) })),
      entry.barWrap,
      el("div", { class: "times" }, entry.elapsed, entry.total)
    ));

    // 抖音式：操作图标竖排在右下角（收藏/喜欢/稍后再看/声音/设置，管理员多一个删除；
    // 剧场再多一个「选集」）—— 与首页**同一份代码**，不许各写一套。
    // 边栏就 4 个（用户 2026-09-24 明确：点赞 / 收藏 / 声音 / 全屏，**不要再往里加**）。
    // 其余入口全在底部设置面板里（长按画面或网页右键打开）；选集/删除也搬进面板，不占边栏。
    // 电视端：这排按钮 + 一个「设置」键会被整体搬来搬去（tvActionsSet）——
    // 边栏模式下在顶部工具行，影院（全屏）模式下回到画面下方的信息条里。
    // ⚙ **只在电视端挂**：用户 2026-09-28 明确"设置键调出设置面板在 tv 端不适用"，
    // 所以 TV 上面板得有个屏幕上点得到的入口。网页/手机端**不挂** —— 那边靠长按画面（App）
    // 或右键（网页）开面板（用户 2026-09-24 定稿），挂上反而会落在画面左上角、**正好压住顶栏的菜单键**
    // （用户 2026-10-01 报障："web 端和手机 app 端这里 2 个按钮重叠：一个三条横线、一个设置轮子"，坑 67）。
    const railKids = [entry.like, entry.fav];
    if (!tvLayout) railKids.push(soundButton(entry), (entry.fullscreen = fullscreenButton()));
    entry.rail = el("div", { class: "ov-rail" }, railKids);
    entry.ops = el("div", { class: "tv-ops" }, entry.rail);
    if (tvLayout) {
      entry.gear = el("button", { class: "icon-btn", type: "button", title: "设置（选集/倍速/清晰度）" }, icon("gear"));
      entry.gear.addEventListener("click", (event) => { event.stopPropagation(); openPanel(entry); });
      entry.ops.append(entry.gear);
    }
    layer.append(entry.ops);
    layer.append(centerPlayPause(entry));

    // 左上角"来自 <库名>"（点击切范围）：剧场没有切库，跳过；电视端也不挂（顶部那排 tabs 就是库）。
    if (!playlist && !tvLayout) layer.append(libraryCorner(item));
    // 全屏（沉浸）时左上角的返回键：点了退出全屏（用户 2026-09-24）
    layer.append(immersiveBack(entry));

    if (!playable) {
      // 文件不在了（改名/移动/掉盘）时如实说，不再打"状态：ready"——那句话自相矛盾（用户报障）。
      if (item.missing) {
        layer.append(centerMessage("文件不在了", "可能已改名或移动；后台「媒体」页可清理这条记录"));
        return entry;
      }
      const reason = item.compatibility && item.compatibility.reason
        ? item.compatibility.reason
        : ("这个视频放不了（" + (item.status || "unknown") + "）");
      layer.append(brokenCard(item, item.compatibility && item.compatibility.direct === false ? "无法直接播放" : "这个视频放不了", reason));
      return entry;
    }

    // 页面级行为（连播/手势/进度上报/声音提示）留在下面；"造 <video>"这一步是共享的。
    const video = createMediaVideo(item, { muted: !effectiveSoundOn(), loop: loopEnabled() });
    entry.video = video;
    video.playbackRate = state.settings.playback_rate; // B5 倍速：造出来就按设置
    // 长按画面 = 弹设置面板（用户 2026-09-24，同抖音）。
    // ⚠️ 这与原来的"长按 2× 快进"是同一个手势，二选一：按用户要求改成弹面板，长按快进随之取消。
    video.addEventListener("pointerdown", () => startLongPress(entry));
    for (const ev of ["pointerup", "pointercancel", "pointerleave"]) {
      video.addEventListener(ev, () => cancelLongPress(entry));
    }
    video.addEventListener("enterpictureinpicture", () => paintPip());
    video.addEventListener("leavepictureinpicture", () => paintPip());
    video.addEventListener("loadedmetadata", () => onMetadata(entry));
    video.addEventListener("loadeddata", () => { hideLoading(entry); checkFrames(entry); });
    video.addEventListener("canplay", () => hideLoading(entry));
    // 播放中途卡住（缓冲/网络慢）也如实提示"在等数据"
    video.addEventListener("waiting", () => showLoading(entry));
    video.addEventListener("timeupdate", () => paintTime(entry));
    video.addEventListener("play", () => {
      if (entry.paintPlayPause) entry.paintPlayPause();
      hideLoading(entry);
      hidePlayButton(entry);
      if (tvLayout) tvPaint();   // 全屏里"进度条只在暂停时显示"：开播就收起来
      if (!effectiveSoundOn()) showSoundHint(entry);
    });
    video.addEventListener("pause", () => {
      if (entry.paintPlayPause) entry.paintPlayPause();
      if (tvLayout) tvPaint();   // 暂停 ⇒ 全屏里把进度条露出来
      // 全屏里**当前这条**暂停要让中间的播放键看得见（收起状态下先展开控件）。
      // ⚠️ 必须是活跃条目：连播切走时上一条会 pause，那时展开控件会莫名其妙弹出来（实测踩到）。
      if (immersiveOn() && entry.index === state.active) { rt.full.uiHidden = false; paintImmersive(); }
      if (!entry.video.ended && !immersiveOn()) showPlayButton(entry);
    });
    video.addEventListener("ended", () => onEnded(entry));
    video.addEventListener("error", () => showBroken(entry));
    // 单击：全屏切换控件显示 / 平时播放暂停；双击：点赞（用户 2026-09-24）。
    // 单击要等 ~260ms 看有没有第二下 —— 这是双击手势的固有代价。
    let tapTimer = 0;
    video.addEventListener("click", () => {
      if (entry.suppressClick) return; // 刚长按快进过：这一下不算点击（别再暂停）
      if (tapTimer) {
        clearTimeout(tapTimer);
        tapTimer = 0;
        doubleTapLike(entry);
        return;
      }
      tapTimer = setTimeout(() => {
        tapTimer = 0;
        if (immersiveOn()) { rt.full.uiHidden = !rt.full.uiHidden; paintImmersive(); return; }
        togglePlay(entry);
      }, 260); // 双击判定窗：安卓系统的双击超时是 300ms，取 260 兼顾"单击不拖沓"与"双击抓得住"
    });
    stage.append(video);
    showLoading(entry); // 用户 2026-09-23：先给"加载中"，别一进来就是个大播放按钮
    return entry;
  }

  function centerMessage(title, sub) {
    return el("div", { class: "center-msg" },
      el("div", { class: "center-inner" },
        el("div", { class: "center-title", text: title }),
        el("div", { class: "center-sub", text: sub })));
  }

  function libraryCorner(item) {
    const name = item.library_name || "未知库";
    const here = el("button", { class: "lib-chip", type: "button", title: "只看这个库", text: "来自 " + name });
    here.addEventListener("click", (event) => {
      event.stopPropagation();
      switchScope(item.library_id, name);
    });
    // 选库按钮跟「来自 X」放同一行（用户 2026-09-23：贴顶栏 15px、且不要一上一下）
    const corner = el("div", { class: "ov-corner left" }, here, pickerBtn);
    if (state.scope) {
      const back = el("button", { class: "lib-chip all", type: "button", text: "全部库" });
      back.addEventListener("click", (event) => {
        event.stopPropagation();
        switchScope("", "");
      });
      corner.append(back);
    }
    return corner;
  }

  function destroyEntry(index) {
    const entry = state.built.get(index);
    if (!entry) return;
    entry.destroyed = true;
    if (entry.hintTimer) clearTimeout(entry.hintTimer);
    if (entry.ffTimer) clearTimeout(entry.ffTimer);
    // 画中画/投屏的按钮已经不在边栏了（进设置面板），这里不再需要摘 paint
    if (entry.flashTimer) clearTimeout(entry.flashTimer);
    if (entry.video) {
      try { entry.video.pause(); } catch (err) { /* ignore */ }
      // 只在这里清 src；活跃卡播放期间绝不 removeAttribute("src")（坑 4）
      entry.video.removeAttribute("src");
      try { entry.video.load(); } catch (err) { /* ignore */ }
    }
    // 电视端：操作键那排被搬进顶部工具行/画面下方信息条了（不在 layer 里）——
    // 只摘 layer 会把它们留在原处，切库几次就叠出一堆重复图标（实测）。所以这里单独摘一次。
    if (entry.ops && entry.ops.parentNode) entry.ops.remove();
    if (entry.layer && entry.layer.parentNode) entry.layer.remove();
    state.built.delete(index);
    // 面板是 entry 的 DOM 子节点：销毁 entry 就等于面板没了。holdCurrent(true) 曾把所有在册条目的
    // loop 写死成 true，这里按销毁后的真实情况重算一次 —— 不复位的话剩下的条目会一直循环下去，
    // 播完也不连播（见 panelVisible 的不变量）。
    holdCurrent(panelVisible());
  }

  function syncWindow(index) {
    for (const builtIndex of Array.from(state.built.keys())) {
      if (Math.abs(builtIndex - index) > WINDOW) destroyEntry(builtIndex);
    }
    for (let offset = -WINDOW; offset <= WINDOW; offset += 1) {
      const target = index + offset;
      if (target >= 0 && target < state.items.length) ensureEntry(target);
    }
    for (const [builtIndex, entry] of state.built) {
      if (!entry.video) continue;
      if (builtIndex === index) { entry.video.preload = "metadata"; continue; }
      entry.video.preload = builtIndex === index + 1 ? "metadata" : "none";
      if (!entry.video.paused) entry.video.pause();
    }
  }

  function tryPlay(entry) {
    const result = entry.video.play();
    if (result && typeof result.catch === "function") {
      result.then(() => {
        // 这次真的按偏好播起来了（有手势之后浏览器就放行）⇒ 解除"被摁静音"的标记
        if (entry.video && !entry.video.muted) clearSoundBlocked();
      }).catch(() => {
        // 浏览器策略：没交互过不许"有声自动播放"。
        // ⚠️ 电视端例外（用户 2026-09-28："任何情况下都不要静音"）：**绝不退回静音自动播** ——
        // 播不了就把播放按钮摆出来，等用户按确定（有手势就放行了，而且那时一定是有声的）。
        if (tvMode()) { showPlayButton(entry); return; }
        // 退回静音自动播（用户要的是"进入就播"），播起来了就提示一句去哪里开声音；真播不了才退回播放按钮。
        if (entry.destroyed || !entry.video || entry.video.muted) { showPlayButton(entry); return; }
        // ⚠️ 只改元素不改图标 = 用户看到"声音开着却没声、得点两下"（用户 2026-09-25 报障）。
        markSoundBlocked();
        const retry = entry.video.play();
        if (retry && typeof retry.then === "function") {
          retry.then(() => showHint(entry, "已静音自动播放，点右下角喇叭开声"))
            .catch(() => showPlayButton(entry));
        } else {
          showPlayButton(entry);
        }
      });
    }
  }

  function showHint(entry, text) {
    if (entry.destroyed || !entry.layer) return;
    if (!entry.hint) {
      entry.hint = el("div", { class: "hint" });
      entry.layer.append(entry.hint);
    }
    entry.hint.textContent = text;
    entry.hint.classList.remove("hidden");
    if (entry.hintTimer) clearTimeout(entry.hintTimer);
    entry.hintTimer = setTimeout(() => { if (entry.hint) entry.hint.classList.add("hidden"); }, 2500);
  }

  /* ---------- 单击播放/暂停（中央 300ms 提示） ---------- */

  function flash(entry, text) {
    if (entry.destroyed || !entry.layer) return;
    if (!entry.flash) {
      entry.flash = el("div", { class: "center-flash" });
      entry.layer.append(entry.flash);
    }
    entry.flash.textContent = text;
    entry.flash.classList.remove("fade");
    if (entry.flashTimer) clearTimeout(entry.flashTimer);
    entry.flashTimer = setTimeout(() => {
      if (entry.flash) entry.flash.classList.add("fade");
    }, 300);
  }

  /* ---------- 长按画面 = 打开设置面板（用户 2026-09-24，同抖音） ---------- */
  // 按下 350ms 没抬手就开面板；松手/移出/取消都取消这个计时器。
  // 开面板后要吞掉随后的那次 click（否则长按会被当成单击把视频暂停）。
  function startLongPress(entry) {
    if (entry.destroyed || entry.ffTimer) return;
    entry.ffTimer = setTimeout(() => {
      entry.ffTimer = 0;
      if (entry.destroyed) return;
      entry.suppressClick = true;
      setTimeout(() => { entry.suppressClick = false; }, 400);
      openPanel(entry);
      if (navigator.vibrate) { try { navigator.vibrate(12); } catch (err) { /* 不支持就算了 */ } }
    }, 350);
  }

  function cancelLongPress(entry) {
    if (entry.ffTimer) { clearTimeout(entry.ffTimer); entry.ffTimer = 0; }
  }

  // 同一个"确定"可能既来 keydown 又来 click（不同 WebView 行为不同）：250ms 内只认第一次，
  // 否则会"暂停又立刻播"，用户看到的就是"按了没反应"。
  let lastToggleAt = 0;

  function togglePlay(entry) {
    const now = Date.now();
    if (now - lastToggleAt < 250) return;
    lastToggleAt = now;
    if (entry.destroyed || entry.broken || !entry.video) return;
    if (entry.video.paused) {
      hidePlayButton(entry);
      const result = entry.video.play();
      if (result && typeof result.catch === "function") result.catch(() => showPlayButton(entry));
    } else {
      // 用户 2026-09-23：不要暂停按钮 —— 暂停后**始终**显示"播放"按钮，不再闪 ⏸
      entry.video.pause();
      showPlayButton(entry);
    }
  }

  /** 暂停/播放失败时显示"播放"按钮；可反复出现（不再 latch 成一次性）。 */
  function showPlayButton(entry) {
    if (entry.destroyed || !entry.video || !entry.layer || entry.playBtn) return;
    if (immersiveOn()) return; // 全屏时用画面正中的播放/暂停键，别两个叠一起
    hideLoading(entry); // 真正需要用户点播时才显示播放按钮
    entry.playBtn = el("button", {
      class: "center-btn", type: "button", text: "点击播放",
      onclick: () => {
        hidePlayButton(entry);
        const result = entry.video.play();
        if (result && typeof result.catch === "function") result.catch(() => showPlayButton(entry));
      },
    });
    entry.layer.append(entry.playBtn);
  }

  // loading 只是"真的在等数据"的提示（用户 2026-09-23）：预加载过、已经有数据的条目**不许闪它**，
  // 所以这里按真实 readyState 判断，而不是一律先显示。
  const READY_ENOUGH = 3; // HAVE_FUTURE_DATA
  function showLoading(entry) {
    if (!entry || !entry.layer || entry.loadingEl) return;
    const v = entry.video;
    if (v && v.readyState >= READY_ENOUGH) return; // 有数据：不需要让用户等
    entry.loadingEl = el("div", { class: "center-loading" },
      el("div", { class: "spinner" }), el("div", { text: "加载中…" }));
    entry.layer.append(entry.loadingEl);
  }

  function hideLoading(entry) {
    if (!entry || !entry.loadingEl) return;
    entry.loadingEl.remove();
    entry.loadingEl = null;
  }

  function hidePlayButton(entry) {
    if (entry.playBtn && entry.playBtn.parentNode) entry.playBtn.remove();
    entry.playBtn = null;
  }

  function onEnded(entry) {
    flushProgress(entry.index, false);
    // 面板开着时：只循环当前这条，不连播、不换条（用户 2026-09-24 的改进 3）
    if (panelVisible()) return;
    if (playlist) {
      // 剧场：自动连播（不可设置）；播完最后一集停止并说明，绝不循环回第一集。
      if (entry.index + 1 < state.items.length) {
        goTo(entry.index + 1);
        return;
      }
      showPlayButton(entry);
      showToast("已播完最后一集");
      return;
    }
    if (state.settings.autoplay_next && (entry.index + 1 < state.items.length || state.hasMore)) {
      goTo(entry.index + 1); // 连播：自动下一个
      return;
    }
    if (!state.settings.loop_play) showPlayButton(entry); // 连播关且循环关：停在末尾等重播
  }

  function onMetadata(entry) {
    if (!entry.resumeDone) {
      entry.resumeDone = true;
      const progress = entry.item.progress || {};
      const position = Number(progress.position_ms) || 0;
      if (position > 0 && !progress.completed) {
        try { entry.video.currentTime = position / 1000; } catch (err) { /* 元数据未就绪则跳过 */ }
        showHint(entry, "已续播");
      }
    }
    paintTime(entry);
  }

  function durationMs(entry) {
    const video = entry.video;
    if (video && Number.isFinite(video.duration) && video.duration > 0) return video.duration * 1000;
    return Number(entry.item.duration_ms) || 0;
  }

  function paintTime(entry) {
    const video = entry.video;
    if (!video || entry.seeking) return; // 拖动中由手指决定显示
    const duration = durationMs(entry);
    const position = Math.max(0, (video.currentTime || 0) * 1000);
    if (entry.fill) entry.fill.style.width = (duration > 0 ? Math.min(100, (position / duration) * 100) : 0) + "%";
    if (entry.elapsed) entry.elapsed.textContent = fmtDuration(position);
    if (entry.total && duration > 0) entry.total.textContent = fmtDuration(duration);
  }

  function showBroken(entry, sub) {
    hideLoading(entry);
    if (entry.broken || entry.destroyed || !entry.layer) return;
    entry.broken = true;
    if (entry.video) { try { entry.video.pause(); } catch (err) { /* ignore */ } }
    if (sub) {
      entry.layer.append(brokenCard(entry.item, "这个视频放不了", sub));
      return;
    }
    entry.layer.append(brokenCard(entry.item, "这个视频放不了", "状态：" + (entry.item.status || "unknown")));
    // <video> 的 error 事件拿不到 HTTP 状态码，所以再问服务端一次"为什么"：
    // 403（路径不在允许的媒体根里）、404（文件没了）这类原文要显示出来 ——
    // 只说"状态：unknown"等于没说（用户 2026-09-27 报障过"报错要说真原因"这一类）。
    probeStreamError(entry);
  }

  function probeStreamError(entry) {
    if (!entry.item || !entry.layer) return;
    const url = entry.item.stream_url || ("/api/v1/media/" + encodeURIComponent(entry.item.id) + "/stream");
    fetch(url, { method: "GET", headers: { Range: "bytes=0-0" }, credentials: "same-origin" })
      .then(async (res) => {
        if (res.ok || res.status === 206) return; // 服务端其实没问题：可能是解码问题，保持原样
        let message = "HTTP " + res.status;
        try {
          const body = await res.json();
          if (body && body.error && body.error.message) message = body.error.message + "（HTTP " + res.status + "）";
        } catch (err) { /* 非 JSON 就用状态码 */ }
        if (entry.destroyed || !entry.layer) return;
        const old = entry.layer.querySelector(".center-msg");
        if (old) old.remove();
        entry.layer.append(centerMessage("这个视频放不了", message));
      })
      .catch(() => { /* 探测失败就保留原来那句 */ });
  }

  // 服务端 direct 会高估（无 HEVC 硬件解码的 Chrome 只出声不出画且不报 error），
  // 首帧解不出来时如实提示，别让用户对着黑屏（坑 11）
  function checkFrames(entry) {
    if (entry.destroyed || entry.broken || !entry.video) return;
    if (entry.video.videoWidth > 0) return;
    const codec = (entry.item.codecs && entry.item.codecs.video) || "该编码";
    // 电视端（有原生桥）：说清"下一步按确定就能用原生播放器放"，别让人以为这条彻底放不了
    if (tvNeedsNative(entry.item)) {
      showBroken(entry, "WebView 解不了 " + String(codec).toUpperCase() + "：按确定用原生播放器播");
      return;
    }
    showBroken(entry, "这台浏览器解不出 " + String(codec).toUpperCase() + " 画面");
  }

  /* ---------- 进度：点击 / 拖动 seek ---------- */

  function wireSeek(entry) {
    const ratioAt = (clientX) => {
      const rect = entry.bar.getBoundingClientRect();
      if (!rect.width) return 0;
      return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    };
    const paintRatio = (ratio) => {
      const duration = durationMs(entry);
      const text = fmtDuration(ratio * duration);
      entry.fill.style.width = (ratio * 100) + "%";
      entry.elapsed.textContent = text;
      entry.bubble.textContent = text;
      entry.bubble.style.left = (ratio * 100) + "%";
    };
    entry.barWrap.addEventListener("pointerdown", (event) => {
      if (!entry.video) return;
      event.preventDefault();
      event.stopPropagation();
      entry.seeking = true;
      entry.seekRatio = ratioAt(event.clientX);
      try { entry.barWrap.setPointerCapture(event.pointerId); } catch (err) { /* 忽略 */ }
      entry.bubble.classList.remove("hidden");
      paintRatio(entry.seekRatio);
    });
    entry.barWrap.addEventListener("pointermove", (event) => {
      if (!entry.seeking) return;
      event.preventDefault();
      entry.seekRatio = ratioAt(event.clientX);
      paintRatio(entry.seekRatio);
    });
    const finish = (event) => {
      if (!entry.seeking) return;
      entry.seeking = false;
      if (event && event.pointerId !== undefined) {
        try { entry.barWrap.releasePointerCapture(event.pointerId); } catch (err) { /* 忽略 */ }
      }
      entry.bubble.classList.add("hidden");
      const duration = durationMs(entry);
      if (entry.video && duration > 0) {
        try { entry.video.currentTime = (entry.seekRatio * duration) / 1000; } catch (err) { /* 元数据未就绪 */ }
      }
      paintTime(entry);
      // 松手立刻上报，不等 5s 定时器（item 3）
      if (!entry.broken) api.patchProgress(entry.item.id, progressPayload(entry)).catch(() => {});
    };
    entry.barWrap.addEventListener("pointerup", finish);
    entry.barWrap.addEventListener("pointercancel", finish);
  }

  /* ---------- 播放设置（右上 ⚙ 二级面板，控件与「我的」共用） ---------- */

  function loopEnabled() {
    return loopEffective(state.settings);
  }

  // 左右键跳转秒数：非法/缺省一律按 10，上限与后端一致（120）。
  function seekSeconds() {
    return seekSecondsOf(state.settings);
  }

  function paintPanel(entry) {
    if (entry.settingsForm) entry.settingsForm.paint(state.settings);
  }

  // 设置入口：**不放边栏**（用户 2026-09-24 定稿：边栏只有 4 个）。
  // 网页端右键（contextmenu）或长按画面打开；App 里只有长按。

  function applySettings() {
    const loop = loopEnabled();
    for (const entry of state.built.values()) {
      if (entry.video) {
        entry.video.loop = panelVisible() ? true : loop;
        // 正在长按快进时不要被设置刷新覆盖（松手时按新倍速还原）
        if (!entry.fastForward) entry.video.playbackRate = state.settings.playback_rate;
      }
      paintPanel(entry);
    }
  }

  async function saveSettings(partial) {
    // 同一个"世代"判据：用户连点两个开关时，先发的那一箭可能后回来 —— 让它把后发的结果盖掉就
    // 是"设置自己跳回去"。所以只有**最后**一次保存的响应允许写 state.settings（乐观更新照旧先落）。
    const gen = settingsGen += 1;
    const before = state.settings;
    state.settings = normalizeFeedSettings(Object.assign({}, state.settings, partial));
    applySettings();
    try {
      const result = await api.patchFeedSettings(partial);
      if (gen === settingsGen && result) state.settings = normalizeFeedSettings(result);
    } catch (err) {
      if (gen !== settingsGen) return; // 旧的那次失败了：别拿它回滚用户后来改的东西
      state.settings = before;
      showToast(err && err.message ? err.message : "设置保存失败");
    }
    if (gen === settingsGen) applySettings();
  }


  /* ---------- 反应 / 收藏 ---------- */

  function showToast(message) {
    toast.textContent = String(message);
    toast.classList.remove("hidden");
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.add("hidden"), 2500);
  }

  async function toggleFavorite(entry) {
    const item = entry.item;
    const next = !item.favorite;
    item.favorite = next;
    entry.fav.classList.toggle("on", next);
    showToast(next ? "已收藏" : "已取消收藏"); // 用户 2026-09-23：图标点完要有提示
    try {
      const result = next ? await api.addFavorite(item.id) : await api.removeFavorite(item.id);
      if (result && typeof result.favorite === "boolean" && result.favorite !== next) {
        item.favorite = result.favorite;
        entry.fav.classList.toggle("on", result.favorite);
      }
    } catch (err) {
      item.favorite = !next;
      entry.fav.classList.toggle("on", !next);
      showToast(err && err.message ? err.message : "操作失败");
    }
  }

  // 稍后再看：与收藏同一套乐观更新（先改本地、失败再回滚并说明）。
  // 播完不自动移除 —— 与收藏一致，只在用户点图标或去「我的-稍后再看」清除。
  async function toggleWatchLater(entry) {
    const item = entry.item;
    const next = !item.watch_later;
    item.watch_later = next;
    entry.later.classList.toggle("on", next);
    showToast(next ? "已加入稍后再看" : "已移出稍后再看");
    try {
      const result = next ? await api.addWatchLater(item.id) : await api.removeWatchLater(item.id);
      if (result && typeof result.watch_later === "boolean" && result.watch_later !== next) {
        item.watch_later = result.watch_later;
        entry.later.classList.toggle("on", result.watch_later);
      }
    } catch (err) {
      item.watch_later = !next;
      entry.later.classList.toggle("on", !next);
      showToast(err && err.message ? err.message : "操作失败");
    }
  }

  // 双击点赞：**只加不减**（再双击也不取消，和抖音一致），中间弹一个大拇指动画。
  // 双击 = 点赞/取消点赞（用户 2026-09-24："加双击取消点赞"）。
  // 原来双击已赞过的只重复播动画、什么都不改 —— 现在它是**开关**：
  // 没赞过 ⇒ 点赞（大拇指放大动画），已赞过 ⇒ 取消（同一个动画调成灰色）。
  // 写接口只有一条路（toggleLike），别在这里再写一份，免得两处状态对不上。
  async function doubleTapLike(entry) {
    if (entry.destroyed || !entry.item) return;
    // 防抖：双击只允许翻转一次。指纹/触屏在某些浏览器里会既发 click 又发 dblclick，
    // 两条路都调这里就变成"翻两次=没反应"（用户 2026-09-24 报障：双击不能取消点赞）。
    const now = Date.now();
    if (entry.lastDblTap && now - entry.lastDblTap < 500) return;
    entry.lastDblTap = now;
    const willLike = entry.item.reaction !== "like";
    burstLike(entry, willLike);
    await toggleLike(entry);
  }

  // burstLike：中央那个"赞"的放大淡出动画（只是反馈，不是按钮）。
  function burstLike(entry, on) {
    if (entry.destroyed || !entry.layer) return;
    if (entry.burst) entry.burst.remove();
    const node = el("div", {
      class: "like-burst" + (on === false ? " off" : ""),
      dataset: { role: "like-burst", off: on === false ? "1" : "0" },
    }, icon("thumb"));
    entry.layer.append(node);
    entry.burst = node;
    setTimeout(() => { if (entry.burst === node) { node.remove(); entry.burst = null; } }, 700);
  }

  async function toggleLike(entry) {
    const item = entry.item;
    const liked = item.reaction === "like";
    item.reaction = liked ? null : "like";
    entry.like.classList.toggle("on", !liked);
    showToast(liked ? "已取消喜欢" : "已喜欢");
    try {
      if (liked) await api.removeReaction(item.id);
      else await api.addReaction(item.id, "like");
    } catch (err) {
      item.reaction = liked ? "like" : null;
      entry.like.classList.toggle("on", liked);
      showToast(err && err.message ? err.message : "操作失败");
    }
  }

  /* ---------- 前台删除（仅管理员） ---------- */

  function isAdmin() { return !!(session.user && session.user.role === "admin"); }

  // 两个选项都算确认：只删记录（文件保留）或连文件一起删（不可恢复）。
  async function askDelete(entry) {
    const item = entry.item || {};
    if (entry.deleting) return;
    const choice = await choiceDialog({
      role: "media-delete-modal",
      title: "删除这个视频",
      message: (item.title || ("#" + item.id)) + "：只删记录则文件保留、重扫会再出现；连文件一起删不可恢复。",
      cancelText: "取消",
      choices: [
        { value: "record", label: "只删记录" },
        { value: "file", label: "连文件一起删", danger: true },
      ],
    });
    if (!choice) return;
    entry.deleting = true;
    entry.del.disabled = true;
    try {
      await api.deleteMedia(item.id, {
        delete_file: choice === "file",
        // 危险操作的后端口令（缺了会被后端按"没确认"拒绝，不是摆设）
        confirm: choice === "file" ? "删除文件" : "",
      });
      // 等接口回来的这段时间用户可能已经切库/换挂载了：entry.index 是**旧列表**的下标，
      // 直接 dropItem 会把新列表里恰好占着这个位置的另一条删掉（同类竞态）。只有"这个位置上
      // 还是刚删掉的那条视频"才允许按它下架。
      const here = state.items[entry.index];
      if (here && String(here.id) === String(item.id)) dropItem(entry.index);
      showToast(choice === "file" ? "已删除记录和文件" : "已删除记录（文件保留）");
    } catch (err) {
      showToast(err && err.message ? err.message : "删除失败");
    } finally {
      entry.deleting = false;
      if (entry.del) entry.del.disabled = false;
    }
  }

  /* ---------- 进度上报 ---------- */

  function progressPayload(entry) {
    const duration = Math.round(durationMs(entry));
    const position = Math.round(Math.max(0, (entry.video.currentTime || 0) * 1000));
    return {
      position_ms: position,
      duration_ms: duration,
      completed: duration > 0 && duration - position <= COMPLETE_TAIL_MS,
    };
  }

  function flushProgress(index, keepalive) {
    const entry = state.built.get(index);
    if (!entry || !entry.video || entry.broken) return;
    const payload = progressPayload(entry);
    if (keepalive) patchProgressKeepalive(entry.item.id, payload);
    else api.patchProgress(entry.item.id, payload).catch(() => {});
  }

  const progressTimer = setInterval(() => {
    const entry = state.built.get(state.active);
    if (!entry || !entry.video || entry.broken) return;
    if (entry.video.paused || entry.video.ended) return; // 暂停中不上报（坑 5）
    api.patchProgress(entry.item.id, progressPayload(entry)).catch(() => {});
  }, PROGRESS_EVERY_MS);

  function onPageHide() { flushProgress(state.active, true); }
  function onVisibility() { if (document.visibilityState === "hidden") flushProgress(state.active, true); }

  /* ---------- 列表加载 ---------- */

  function setLoading(on) {
    if (on) {
      if (!state.items.length) {
        if (!state.infoCard) state.infoCard = el("div", { class: "card info", text: "加载中…" });
        if (!state.infoCard.parentNode) feed.append(state.infoCard);
        return;
      }
      chip.textContent = "加载中…";
      chip.classList.remove("hidden");
      return;
    }
    if (state.infoCard && state.infoCard.parentNode) state.infoCard.remove();
    chip.classList.add("hidden");
  }

  function appendItems(list, meta) {
    if (meta && meta.settings) {
      state.settings = normalizeFeedSettings(meta.settings);
      applySettings();
    }
    // 快照遍历：调用方可能把 state.items 自己传进来（播放列表模式），
    // 一边遍历一边 push 会无限循环把页面卡死（实测踩过，CDP 才定位到）。
    for (const item of Array.from(list || [])) {
      const index = state.items.length;
      // 电视端：左侧列表一行（封面 + 时长 + 标题 + 一行元信息）；手机/网页端仍是整屏卡片。
      const shell = tvLayout
        ? tvRow(item, index)
        : el("article", { class: "card", dataset: { index: String(index), id: String(item.id) } });
      if (!tvLayout) shell.style.top = (index * 100) + "%";
      state.items.push(item);
      state.shells.push(shell);
      (tvLayout ? tvList : track).append(shell);
    }
    state.hasMore = !!(meta && meta.has_more);
    if (!state.items.length && !state.hasMore && !state.emptyCard) {
      const noLibrary = state.librariesLoaded && state.libraries.length === 0;
      const retry = el("button", { class: "btn primary", type: "button", text: "重试", dataset: { role: "feed-retry" } });
      retry.addEventListener("click", (event) => {
        event.stopPropagation();
        state.emptyCard.remove();
        state.emptyCard = null;
        state.hasMore = true;
        loadMore();
      });
      state.emptyCard = el("div", { class: "card info", dataset: { role: "feed-empty" } },
        el("div", { class: "center-title", text: noLibrary ? "没有可访问的媒体库" : "还没有视频" }),
        el("div", { class: "center-sub", text: noLibrary ? "请联系管理员给这个账号授权媒体库" : "换个库看看，或点重试再拉一次" }),
        retry);
      feed.append(state.emptyCard);
      if (tvMode()) { try { retry.focus(); } catch (err) { focusFirst(); } }
    }
    if (state.items.length && state.active < 0) {
      // 首页第一次进来：看"进入自动播放"设置；剧场（playlist）本来就是自动连播
      setActive(0, false, { autoplay: playlist ? true : state.settings.autoplay_enter });
    }
  }

  // 删除成功后本地下掉这一条：重建窗口 + 重排 top/下标，不整页重置（保持当前位置）。
  function dropItem(index) {
    for (const key of Array.from(state.built.keys())) destroyEntry(key);
    const shell = state.shells[index];
    if (shell) shell.remove();
    state.items.splice(index, 1);
    state.shells.splice(index, 1);
    state.shells.forEach((node, i) => {
      node.style.top = (i * 100) + "%";
      node.dataset.index = String(i);
    });
    state.active = -1;
    paintTrack(false);
    gate.settle();
    if (!state.items.length) { loadMore(); return; }
    const next = Math.min(index, state.items.length - 1);
    setActive(next, false);
    maybeLoadMore(next);
  }

  /**
   * 加载失败要在**屏幕上留着**（用户 2026-09-27 报障："没有内容，报错没看清"）：
   * 原来只弹一个 2 秒的 Toast，电视上从沙发上根本读不完，页面还是一片空白。
   * 现在给一张大字错误卡：原因原文 + 一个遥控器能落焦的「重试」。
   */
  function showFeedError(message) {
    if (state.errorCard && state.errorCard.parentNode) state.errorCard.remove();
    const retry = el("button", { class: "btn primary", type: "button", text: "重试", dataset: { role: "feed-retry" } });
    retry.addEventListener("click", (event) => {
      event.stopPropagation();
      if (state.errorCard && state.errorCard.parentNode) state.errorCard.remove();
      state.errorCard = null;
      state.hasMore = true; // 上次失败可能把 hasMore 弄成 false，重试要能再发一次
      loadMore();
    });
    state.errorCard = el("div", { class: "card info error", dataset: { role: "feed-error" } },
      el("div", { class: "center-title", text: "加载失败" }),
      el("div", { class: "center-sub", text: message || "未知原因" }),
      retry);
    feed.append(state.errorCard);
    // 电视端：焦点**直接落到「重试」**上（不是"页面上第一个能聚焦的东西"）——
    // 用户报障那会儿遥控器"按了没反应"，就是错误状态里没有落点（2026-09-27）
    if (tvMode()) { try { retry.focus(); } catch (err) { focusFirst(); } }
  }

  async function loadMore() {
    if (playlist) return false; // 剧场：数据是一次性给的，没有翻页
    if (state.loading || !state.hasMore) return false;
    const gen = feedGen; // 发请求前记下世代：回来后不是这一代 ⇒ 属于旧库/旧挂载，整份丢弃
    state.loading = true;
    setLoading(true);
    try {
      const result = await api.feedNext({
        library_id: state.scope || undefined,
        cursor: state.nextCursor || undefined,
        limit: BATCH,
      });
      // 旧库的在飞响应：绝不 appendItems、绝不写 nextCursor（否则内容串库）
      if (gen !== feedGen) return false;
      const list = result && result.data && Array.isArray(result.data.list) ? result.data.list : [];
      const meta = (result && result.meta) || {};
      state.nextCursor = meta.next_cursor || "";
      // 空批次必须停，否则 has_more 说谎时会无限翻页（坑 9）
      appendItems(list, { has_more: !!meta.has_more && list.length > 0, settings: meta.settings });
      return true;
    } catch (err) {
      // 旧库的报错也别糊到新库的页面上
      if (gen !== feedGen) return false;
      // 用 detail()（带上接口与状态码）：这才是"能定位"的报错
      const message = err && typeof err.detail === "function" ? err.detail() : (err && err.message ? err.message : "加载失败");
      showFeedError(message);
      if (!tvMode()) showToast(message); // 手机上 Toast 够用；电视上靠那张卡
      return false;
    } finally {
      // 只有"还是当前世代"才允许收 loading：否则会把新库刚发出去那一箭的 loading 清掉，
      // 于是新库可以再发一箭，两条响应又开始打架（resetFeed 里那句 state.loading = false 是给新世代让路的）。
      if (gen === feedGen) {
        state.loading = false;
        setLoading(false);
      }
    }
  }

  function maybeLoadMore(index) {
    if (state.hasMore && !state.loading && index >= state.items.length - 3) loadMore();
  }

  /* ---------- 选库（P1：数据来自 /me/libraries） ---------- */

  function renderPicker() {
    clear(picker);
    const all = el("button", { class: "lib-chip" + (state.scope ? "" : " all"),
      type: "button", text: "全部库" });
    all.addEventListener("click", () => { closePanels(); switchScope("", ""); });
    picker.append(all);
    // 按分组显示（用户 2026-09-22）：库多了以后一堆 chip 分不清，先出组名再出库。
    for (const entry of groupLibraries(state.libraries)) {
      if (entry.name) {
        picker.append(el("div", {
          class: "muted small-note", text: entry.name, dataset: { role: "lib-group" },
        }));
      }
      for (const lib of entry.items) {
        const name = lib.name || lib.id;
        const row = el("button", { class: "lib-chip" + (state.scope === lib.id ? " all" : ""),
          type: "button", text: name });
        row.addEventListener("click", () => { closePanels(); switchScope(lib.id, name); });
        picker.append(row);
      }
    }
  }

  // groupLibraries 把可访问库按分组整理（保持后端顺序，未分组排最后）。
  function groupLibraries(list) {
    const out = [];
    const index = new Map();
    for (const lib of asArray(list)) {
      const key = lib.group_id || "";
      let entry = index.get(key);
      if (!entry) {
        entry = { key, name: lib.group_name || "", items: [] };
        index.set(key, entry);
        out.push(entry);
      }
      entry.items.push(lib);
    }
    return out.sort((a, b) => (a.key ? 0 : 1) - (b.key ? 0 : 1));
  }

  async function loadLibraries() {
    if (playlist) return; // 剧场没有切库
    // 可访问库与"当前是哪个库"无关 ⇒ 只按"还挂载着"判（世代判据会把有效的响应丢掉，见 alive 的说明）。
    try {
      const list = asArray(await api.myLibraries());
      if (!alive) return;
      state.libraries = list;
    } catch (err) {
      if (!alive) return;
      state.libraries = [];
    }
    state.librariesLoaded = true;
    if (pickerBtn) pickerBtn.classList.toggle("hidden", state.libraries.length <= 1);
    renderPicker();
    renderTvLibs(); // 电视端：库列表就是右栏那列（同一个数据源）
    if (state.emptyCard && state.libraries.length === 0) {
      state.emptyCard.textContent = "没有可访问的媒体库，请联系管理员";
    }
  }

  /* ---------- 范围切换（来自 <库名>） ---------- */

  function switchScope(libraryID, libraryName) {
    const next = libraryID || "";
    if (state.scope === next) return;
    resetFeed(next, libraryName || "");
  }

  function resetFeed(libraryID, libraryName) {
    // 换代：从这一刻起，旧库所有在飞请求的响应都作废（见 feedGen 的说明）。
    // 必须在 loadMore() 之前 +1 —— 否则两条响应会同时往同一个 state.items 里写。
    feedGen += 1;
    // 电视端：整批行要销毁重建，焦点会先"掉"一下 —— 先把焦点压到列表容器上（能编程聚焦、又不在
    // 空间导航的焦点图里），免得 tv.js 的"节点没了就补焦点"把焦点随便丢到底栏或某个按钮上。
    if (tvLayout) { try { tvList.focus({ preventScroll: true }); } catch (err) { /* 忽略 */ } }
    for (const index of Array.from(state.built.keys())) destroyEntry(index);
    for (const shell of state.shells) shell.remove();
    state.items = [];
    state.shells = [];
    state.active = -1;
    state.hasMore = true;
    // 给新世代让路：不清它，下面那一箭会被 loadMore 自己的"已在加载"挡掉。
    // 旧世代那次请求回来时不会再碰 loading（见 loadMore 的 finally 判据）。
    state.loading = false;
    state.nextCursor = "";
    state.scope = libraryID;
    state.scopeName = libraryName;
    renderPicker();
    renderTvLibs(); // 电视端：切库后右栏要立刻跟着亮
    if (state.emptyCard && state.emptyCard.parentNode) state.emptyCard.remove();
    state.emptyCard = null;
    closePanels();
    gate.settle();
    paintTrack(false);
    showToast(libraryID ? ("只看 " + libraryName) : "已切回全部库");
    loadMore();
  }

  /* ---------- 手势与键盘 ---------- */

  let wheelAcc = 0;
  let touchY = null;

  function onWheel(event) {
    // 面板里滚动时别翻下一条（用户 2026-09-24：web 端面板长了滚不动、一滚就换视频）
    if (inOverlay(event.target)) return;
    event.preventDefault();
    const now = Date.now();
    wheelAcc += event.deltaY;
    gate.input(now);
    if (Math.abs(wheelAcc) < WHEEL_STEP) return;
    const direction = wheelAcc > 0 ? 1 : -1;
    wheelAcc = 0;
    const step = gate.take(now, direction);
    if (step) goTo(state.active + step);
  }

  function onTouchStart(event) {
    if (inOverlay(event.target)) { touchY = null; return; }
    if (event.touches.length !== 1) return;
    if (isInteractive(event.target)) { touchY = null; return; }
    touchY = event.touches[0].clientY;
    gate.begin(Date.now());
  }

  function onTouchEnd(event) {
    if (inOverlay(event.target)) { touchY = null; return; }
    if (touchY === null) return;
    const touch = event.changedTouches && event.changedTouches[0];
    if (!touch) { touchY = null; return; }
    const delta = touchY - touch.clientY;
    touchY = null;
    if (Math.abs(delta) < TOUCH_STEP) return;
    const step = gate.take(Date.now(), delta > 0 ? 1 : -1);
    if (step) goTo(state.active + step);
  }

  // 左右键跳转：clamp 到 [0, duration]，不打断播放状态；元数据未就绪也不能抛错。
  function seekBy(direction) {
    const entry = state.built.get(state.active);
    if (!entry || entry.destroyed || entry.broken || !entry.video) return;
    const seconds = seekSeconds();
    const max = durationMs(entry) / 1000;
    let target = (Number(entry.video.currentTime) || 0) + direction * seconds;
    if (target < 0) target = 0;
    if (max > 0 && target > max) target = max;
    try { entry.video.currentTime = target; } catch (err) { return; }
    paintTime(entry);
    showToast((direction > 0 ? "前进 " : "后退 ") + seconds + " 秒");
  }

  // 网页端：右键 = 打开设置面板（用户 2026-09-24），并且**屏蔽浏览器自己的右键菜单**。
  // 面板/输入框里的右键照旧（不拦），否则编辑数字时没法用系统菜单。
  function onContextMenu(event) {
    if (event.target && typeof event.target.closest === "function" &&
        event.target.closest(".set-panel, .sheet-scrim, input, textarea")) {
      return;
    }
    event.preventDefault();
    const entry = state.built.get(state.active);
    if (entry) openPanel(entry);
  }

  function onKeyDown(event) {
    const target = event.target;
    const tag = target && target.tagName ? target.tagName : "";
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (target && target.isContentEditable)) return;
    if (event.key === " " && tag === "BUTTON") return;
    if (event.key === "Escape") { closePanels(); return; }
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      seekBy(event.key === "ArrowRight" ? 1 : -1);
      return;
    }
    // 空格 = 播放/暂停（用户 2026-09-23："空格就该是暂停，不是下一个"）；下一个只认 ↓/PageDown。
    if (event.key === " " || event.key === "Spacebar") {
      event.preventDefault();
      const here = state.built.get(state.active);
      if (here) togglePlay(here);
      return;
    }
    if (event.key === "ArrowDown" || event.key === "PageDown") {
      event.preventDefault();
      goTo(state.active + 1);
    } else if (event.key === "ArrowUp" || event.key === "PageUp") {
      event.preventDefault();
      goTo(state.active - 1);
    } else if (event.key === "Home") {
      event.preventDefault();
      goTo(0);
    } else if (event.key === "End") {
      event.preventDefault();
      goToEnd();
    }
  }

  track.addEventListener("transitionend", onTransitionEnd);
  feed.addEventListener("wheel", onWheel, { passive: false });
  feed.addEventListener("touchstart", onTouchStart, { passive: true });
  feed.addEventListener("touchend", onTouchEnd, { passive: true });
  document.addEventListener("keydown", onKeyDown);
  document.addEventListener("contextmenu", onContextMenu);
  window.addEventListener("pagehide", onPageHide);
  document.addEventListener("visibilitychange", onVisibility);
  if (tvMode()) {
    setFeedKeys({ down: onTvKeyDown });
    // 焦点一进界面控件就切"控件态"（两态视觉 + 按键提示跟着换）——用户 2026-09-27 报
    // "只能操作上下左右"：原来方向键全被播放语义吃掉，界面里的按钮一个都走不到。
    document.addEventListener("focusin", onTvFocusIn, true);
    document.body.classList.add("tv-surface");
    renderTvNav();
    if (tvLibsStrip) {
      tvLibsStrip.addEventListener("focusin", () => { tvFocusLibs(); });
    }
    tvPaint();
    api.setupStatus().then((st) => {
      const v = st && st.version;
      if (!v) return;
      rt.tvVersion = String(v);
      tvPaintHint();
    }).catch(() => { /* 读不到就不显示，不打扰 */ });
    // 遥控器「设置/菜单」键（用户 2026-09-28 最新版）：播放时弹画面右侧的「点赞/收藏/设置」栏，
    // 焦点直接进栏里；再按一次（或返回键）收起、焦点回画面。
    window.__zvTvMenu = () => {
      if (anyPanelOpen()) { closePanels(); return true; }
      return tvSetOps(!rt.tvOpsOpen);
    };
  }

  if (playlist) {
    // 剧场/稍后再看：数据一次给全，不取游标、不翻页、不选库。
    renderTvLibs(); // 电视端：剧场没有"库"可切，右栏整块藏起来
    appendItems(playlist.items.slice(), { has_more: false }); // 传数据源；state.items 由 appendItems 填
    // 指定从某条开始（点卡片进来时用）；找不到就仍从第一条开始。
    if (playlist.startId) {
      const start = state.items.findIndex((item) => String(item.id) === String(playlist.startId));
      if (start > 0) setActive(start, false);
    }
    if (playlist.note) setTimeout(() => showToast(playlist.note), 800);
  } else {
    loadLibraries();
    loadMore();
  }

  // App 把播放收回网页：函数体在 feed-native.js（resumeNative）
  window.zvResumeNative = ctx.native.resumeNative;
  // App 进/出原生小窗、回到前台：函数体在 feed-native.js（onPipMode / soundNudge）
  window.zvPipMode = onPipMode;

  window.__zvSoundNudge = ctx.native.soundNudge;
  // App 的返回手势/返回键先问这里：
  //   ① 有面板开着 ⇒ 只关面板（播放内容一点不动）；
  //   ② 电视端在影院（全屏）⇒ 回到有边栏的界面（用户 2026-09-28）；
  //   ③ 在全屏 ⇒ 退全屏；
  //   ④ 都没有 ⇒ 返回 false，交给路由（返回上一页）。
  // 电视端：什么都开着的时候，返回键**第一次只提示**"再按一次退出"（用户 2026-09-30：
  // "视频播放页面获得焦点时点返回会直接退回软件，很容易误操作"）。第二次（2.5 秒内）才放行给原生退出。
  // 选这个方案而不是"返回键只移动焦点"：① ←/→ 已经在四栏之间走，返回再管移动就是重复；
  // ② 返回键在安卓/TV 上的语义就是"退出上一层"，改成移动焦点会让所有人误判；③ "再按一次退出"是 TV 通行做法。
  let tvExitArmed = 0;
  function tvBackWantsExit() {
    const now = Date.now();
    if (tvExitArmed && now - tvExitArmed < 2500) { tvExitArmed = 0; return true; }
    tvExitArmed = now;
    showToast(rt.tvFull ? "再按一次返回键退出" : "再按一次返回键退出应用");
    return false;
  }
  window.__zvExitFullscreen = () => {
    if (anyPanelOpen()) { closePanels(); return true; }
    if (tvLayout && rt.tvOpsOpen) { tvSetOps(false); return true; }
    if (tvLayout && rt.tvFull) { tvSetFull(false); return true; }
    // 电视端：没别的可退时，第一次吃掉这一下并提示，第二次才真的退出（手机/网页端行为不变）
    if (tvLayout) return !tvBackWantsExit();
    if (!immersiveOn()) return false;
    exitFullscreen();
    return true;
  };
  window.__zvBackHandler = window.__zvExitFullscreen;

  // 系统/浏览器自己退出了全屏（比如切走、按了系统的退出全屏）：同步收掉沉浸态，
  // 别让界面卡在"以为还在全屏"（顶栏底栏一直藏着）。
  const onFullscreenChange = () => {
    if (document.fullscreenElement) return;
    if (rt.full.rotated || rt.full.native) releaseFullscreen();
  };
  document.addEventListener("fullscreenchange", onFullscreenChange);

  return function cleanup() {
    alive = false;
    feedGen += 1; // 卸载后旧世代的一切在飞响应都作废（见 feedGen 的说明）
    document.removeEventListener("fullscreenchange", onFullscreenChange);
    try { delete window.__zvExitFullscreen; } catch (err) { window.__zvExitFullscreen = null; }
    try { delete window.__zvBackHandler; } catch (err) { window.__zvBackHandler = null; }
    document.body.classList.remove("pip");
    if (window.zvPipMode === onPipMode) {
      try { delete window.zvPipMode; } catch (err) { window.zvPipMode = null; }
    }
    try { delete window.__zvSoundNudge; } catch (err) { window.__zvSoundNudge = null; }
    try { delete window.zvResumeNative; } catch (err) { window.zvResumeNative = null; }
    releaseFullscreen(); // 返回/换页时把系统横屏与 document 全屏一并交还
    document.body.classList.remove("playing");
    document.body.classList.remove("rot-play");
    clearInterval(progressTimer);
    if (toastTimer) clearTimeout(toastTimer);
    if (settleTimer) clearTimeout(settleTimer);
    track.removeEventListener("transitionend", onTransitionEnd);
    feed.removeEventListener("wheel", onWheel);
    feed.removeEventListener("touchstart", onTouchStart);
    feed.removeEventListener("touchend", onTouchEnd);
    document.removeEventListener("keydown", onKeyDown);
    document.removeEventListener("contextmenu", onContextMenu);
    window.removeEventListener("pagehide", onPageHide);
    document.removeEventListener("visibilitychange", onVisibility);
    if (tvMode()) {
      setFeedKeys(null);
      document.removeEventListener("focusin", onTvFocusIn, true);
      document.body.classList.remove("tv-surface");
      try { delete window.__zvTvMenu; } catch (err) { window.__zvTvMenu = null; }
    }
    flushProgress(state.active, false);
    for (const index of Array.from(state.built.keys())) destroyEntry(index);
  };
}
