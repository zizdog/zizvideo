// 竖向全屏短视频流：transform 位移 + 手势锁 + seed 随机游标 + 拖动进度

import { api, patchProgressKeepalive } from "./api.js";
import { icon, setIcon } from "./icons.js";
import { el, clear, asArray, fmtDuration } from "./dom.js";
import { mountNav } from "./nav.js";
import { session } from "./auth.js";
import { choiceDialog } from "./confirm.js";
import { createFeedSettingsForm, normalizeFeedSettings, seekSecondsOf, loopEffective } from "./play-settings.js";
import { setFeedKeys, tvMode, focusFirst } from "./tv.js";

const WHEEL_STEP = 40;
const TOUCH_STEP = 50;
const GESTURE_QUIET = 400;   // 一次手势的静默阈值（400ms 内不第二次推进）
const SLIDE_MS = 280;        // 与 .track 的 transition 保持一致
const PROGRESS_EVERY_MS = 5000;
const COMPLETE_TAIL_MS = 1500;
const BATCH = 10;
const WINDOW = 1;
const SOUND_KEY = "zv_sound";

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

function readSoundPref() {
  // 没存过 = **默认开声**（用户 2026-09-27："默认视频应该是打开声音的，我测试时默认静音"）。
  // 只有用户自己按过喇叭（存了 "off"）才静音。浏览器不许"有声自动播放"时，
  // 下面的 tryPlay() 会退回静音自动播 + 提示去哪里开声，这条路不变。
  try {
    const saved = localStorage.getItem(SOUND_KEY);
    return saved === null ? true : saved === "on";
  } catch (err) {
    return true;
  }
}

function writeSoundPref(on) {
  try { localStorage.setItem(SOUND_KEY, on ? "on" : "off"); } catch (err) { /* 隐私模式忽略 */ }
}

// B4：画中画 / 投屏的能力探测 —— 浏览器支持才画按钮，绝不画个点了没反应的图标。
// 安卓 App 的画中画是"整个 App 缩成小窗"（WebView 里的视频继续放），由原生桥 enterPip 接管。
function nativePipAvailable() {
  return typeof window !== "undefined" && !!window.ZvAndroid
    && typeof window.ZvAndroid.enterPip === "function";
}
function pipAvailable() {
  if (nativePipAvailable()) return true;
  return typeof document !== "undefined" && document.pictureInPictureEnabled === true
    && typeof document.exitPictureInPicture === "function";
}
// Remote Playback 是标准的"投到电视/盒子"接口（Chrome 的 Cast、Safari 的 AirPlay 都走它）。
function castAvailable() {
  return typeof HTMLVideoElement !== "undefined"
    && !!HTMLVideoElement.prototype && "remote" in HTMLVideoElement.prototype;
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
  const feed = el("div", { class: "feed" });
  const track = el("div", { class: "track" });
  const chip = el("div", { class: "feed-chip hidden" });
  const toast = el("div", { class: "toast hidden" });
  // 选库入口（P1）：库列表只来自 GET /me/libraries，不再从当前视频反推。
  // 播放列表模式（剧场）没有"切库"概念，所以这两个节点不建。
  // 用户 2026-09-23：「来自 X」与「选库」贴顶栏（15px）且**同一行**，不再一上一下还互相压住
  const pickerBtn = playlist ? null : el("button", {
    class: "lib-chip hidden", type: "button", text: "选库",
    dataset: { role: "pick-library" },
  });
  const picker = playlist ? null : el("div", {
    class: "set-panel hidden",
    style: { left: "12px", right: "auto", top: "80px" },
  });
  if (picker && pickerBtn) {
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
  // 底栏挂载点（条目 10）：只加容器与入口，不改播放/进度逻辑
  view.append(mountNav(playlist ? (playlist.navKey || "series") : "feed"));
  // 播放页整屏（用户 2026-09-24）:顶栏改成浮在视频上，否则顶上那 52px 是页面底色（像一条背景横条）
  document.body.classList.add("playing");

  const gate = createGestureGate();
  const state = {
    // ⚠️ items 必须**从空开始**：数据统一由 appendItems 追加（它按 state.items.length 决定下标与
    // 外壳 top）。播放列表模式若在这里预填，appendItems 会再加一遍 ⇒ 外壳下标/位置错位，
    // 卡片被推到 top:100% 的视口外 —— 观感就是"点开一片黑"（用户 2026-09-22 报障）。
    items: [],
    shells: [], built: new Map(),
    active: -1,
    // 首页靠游标无限翻页；播放列表模式一次给全，没有"更多页"（goTo 到末尾就 clamp）
    hasMore: !playlist, loading: false,
    soundOn: readSoundPref(), // 与首页共用同一个偏好（localStorage 同一个键）
    // 浏览器把"有声自动播放"摁掉过一次（没有用户手势时一定会被摁）⇒ 这一页实际是静音的。
    // 图标必须跟着它走，否则就是用户报障的"图标显示有声、其实没声，要点两下"（2026-09-25）。
    soundBlocked: false,
    scope: "", scopeName: "", nextCursor: "",
    libraries: [], librariesLoaded: !!playlist,
    // 剧场：自动连播写死开启、循环写死关闭（用户："自动连播且无法设置"）
    settings: normalizeFeedSettings(playlist ? { autoplay_next: true, loop_play: false } : undefined),
    infoCard: null, emptyCard: null, errorCard: null,
  };
  let toastTimer = 0;
  let settleTimer = 0;

  /* ---------- 位移与激活 ---------- */

  function paintTrack(animate) {
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
      loadMore().then(() => { if (state.items.length > before) goTo(index, animate); });
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
    const layer = el("div", { class: "layer" });
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
    layer.append(el("div", { class: "ov-rail" },
      entry.like, entry.fav, soundButton(entry), (entry.fullscreen = fullscreenButton())));
    layer.append(centerPlayPause(entry));

    // 左上角"来自 <库名>"（点击切范围）：剧场没有切库，跳过。
    if (!playlist) layer.append(libraryCorner(item));
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
      layer.append(centerMessage(item.compatibility && item.compatibility.direct === false ? "无法直接播放" : "这个视频放不了", reason));
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
      if (!effectiveSoundOn()) showSoundHint(entry);
    });
    video.addEventListener("pause", () => {
      if (entry.paintPlayPause) entry.paintPlayPause();
      // 全屏里**当前这条**暂停要让中间的播放键看得见（收起状态下先展开控件）。
      // ⚠️ 必须是活跃条目：连播切走时上一条会 pause，那时展开控件会莫名其妙弹出来（实测踩到）。
      if (immersiveOn() && entry.index === state.active) { full.uiHidden = false; paintImmersive(); }
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
        if (immersiveOn()) { full.uiHidden = !full.uiHidden; paintImmersive(); return; }
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
    if (entry.layer && entry.layer.parentNode) entry.layer.remove();
    state.built.delete(index);
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
        // 浏览器策略：没交互过不许"有声自动播放"。退回静音自动播（用户要的是"进入就播"），
        // 播起来了就提示一句去哪里开声音；真播不了才退回播放按钮。
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

  /* ---------- 声音（角落按钮，不再是单击画面） ---------- */

  // 唯一的判据：**这一刻实际听不听得到**。偏好（localStorage）说"开"、但浏览器把有声自动播放
  // 摁掉了（soundBlocked）时，实际是静音 —— 图标/提示/元素三者都必须按这个来。
  // 原来只有"用户点喇叭"那一处会同步元素，被策略摁静音那次不同步 ⇒ 图标显示有声、实际没声，
  // 用户得点两下（先静音、再开声）才有声音（用户 2026-09-25 报障）。
  function effectiveSoundOn() {
    return state.soundOn && !state.soundBlocked;
  }

  /**
   * 音量均一化补一次：列表是**打开页面时**取的，那时这条可能还没量过响度（gain_db=0），
   * 而服务端是"第一次播它"时才开始在后台量（量完才写库）⇒ 本次会话里这条拿不到增益。
   * 所以开播后过几秒回查一次这一条：量到了就把音量落下去（用户 2026-09-26："不同视频音量不同"）。
   * 只查一次、只查没量过的那些，避免每条都多打一个请求。
   */
  function refreshGain(index) {
    const item = state.items[index];
    if (!item || Number(item.gain_db) < 0 || item.__gainChecked) return;
    item.__gainChecked = true;
    setTimeout(() => {
      api.media(String(item.id)).then((m) => {
        const gain = m && Number(m.gain_db);
        if (!(gain < 0)) return;
        item.gain_db = gain;
        const entry = state.built.get(index);
        if (entry && entry.video) {
          entry.video.volume = Math.max(0, Math.min(1, Math.pow(10, gain / 20)));
        }
      }).catch(() => { /* 查不到就算了，下次打开页面还有机会 */ });
    }, 6000);
  }

  /** 把"实际该不该有声"落到**所有**已建条目上，并同步图标/提示（只此一处改 audio 状态）。 */
  function applySound() {
    const on = effectiveSoundOn();
    for (const entry of state.built.values()) {
      if (entry.video) entry.video.muted = !on;
      paintSound(entry);
      if (on) hideSoundHint(entry);
    }
  }

  function paintSound(entry) {
    if (!entry || !entry.sound) return;
    const on = effectiveSoundOn();
    setIcon(entry.sound, on ? "volume" : "mute");
    entry.sound.dataset.sound = on ? "on" : "off"; // 给验收脚本一个稳的判据（不是文案）
  }

  /** 浏览器不许"有声自动播放"：标记 + 图标与元素一起变静音（偏好不动，等用户点一下）。 */
  function markSoundBlocked() {
    if (state.soundBlocked) return;
    state.soundBlocked = true;
    applySound();
  }

  /** 有手势之后浏览器放行了：解除标记，按用户偏好恢复（图标与元素同时回到"有声"）。 */
  function clearSoundBlocked() {
    if (!state.soundBlocked) return;
    state.soundBlocked = false;
    applySound();
  }

  let soundToastReady = false
  function setSound(on) {
    const before = effectiveSoundOn();
    // 这个调用只来自"用户点了喇叭/按了确定"⇒ 已经是手势，策略不再拦
    state.soundBlocked = false;
    state.soundOn = !!on;
    writeSoundPref(state.soundOn);
    applySound();
    const after = effectiveSoundOn();
    if (soundToastReady && before !== after) showToast(after ? "声音已开" : "已静音");
    soundToastReady = true;
  }

  function soundButton(entry) {
    entry.sound = el("button", { class: "icon-btn", type: "button", title: "声音" });
    paintSound(entry);
    entry.sound.addEventListener("click", (event) => {
      event.stopPropagation();
      // 按"实际听不听得到"决定下一次 —— 被策略摁成静音时，点一下就该有声（不是先静音再开声）
      setSound(!effectiveSoundOn());
    });
    return entry.sound;
  }

  function showSoundHint(entry) {
    if (entry.destroyed || !entry.layer) return;
    if (!entry.soundHint) {
      entry.soundHint = el("div", { class: "hint low", text: "点右下角的喇叭开启声音" });
      entry.layer.append(entry.soundHint);
    }
    entry.soundHint.classList.remove("hidden");
  }

  function hideSoundHint(entry) {
    if (entry.soundHint) entry.soundHint.classList.add("hidden");
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

  function togglePlay(entry) {
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
    if (state.panelOpen) return;
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
    entry.layer.append(centerMessage("这个视频放不了", sub || ("状态：" + (entry.item.status || "unknown"))));
  }

  // 服务端 direct 会高估（无 HEVC 硬件解码的 Chrome 只出声不出画且不报 error），
  // 首帧解不出来时如实提示，别让用户对着黑屏（坑 11）
  function checkFrames(entry) {
    if (entry.destroyed || entry.broken || !entry.video) return;
    if (entry.video.videoWidth > 0) return;
    const codec = (entry.item.codecs && entry.item.codecs.video) || "该编码";
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

  // 面板外的遮罩：**吞掉点击**（点外面只关面板，不触发播放/暂停等外部操作 —— 用户明确要求）。
  let sheetScrim = null;
  function ensureScrim() {
    if (sheetScrim) return sheetScrim;
    sheetScrim = el("div", { class: "sheet-scrim hidden", dataset: { role: "sheet-scrim" } });
    sheetScrim.addEventListener("pointerdown", (event) => event.stopPropagation(), true);
    sheetScrim.addEventListener("click", (event) => {
      event.stopPropagation();
      closePanels();
    });
    return sheetScrim;
  }

  function toolButton(label, onClick, extra) {
    const btn = el("button", {
      class: "sheet-tool" + (extra ? " " + extra : ""), type: "button", text: label,
    });
    btn.addEventListener("click", (event) => {
      event.stopPropagation();
      onClick();
    });
    return btn;
  }

  // 底部设置面板（用户 2026-09-24：参考抖音 —— 分组卡片 + 每行"图标+文字+右侧值/开关"）
  function buildPanel(entry) {
    entry.settingsForm = createFeedSettingsForm({
      settings: state.settings,
      onChange: saveSettings,
      // 剧场：自动连播写死开启且**不可设置**（用户要求），只留"跳转秒数"。
      lockAutoplay: !!playlist,
      variant: "sheet",
      // 左右键跳转只在 web 有意义，App 里不显示这一行（用户 2026-09-24）
      hideSeek: inAppWebView(),
    });

    // 第 1 组：投屏 / 小窗播放 / 缓存视频（能做才显示）
    const tools = el("div", { class: "sheet-group" });
    if (castAvailable()) tools.append(actionRow("cast", "投屏", () => { closePanels(); toggleCast(entry); }));
    if (pipAvailable()) tools.append(actionRow("pip", "小窗播放", () => { closePanels(); togglePip(entry); }));
    if (nativeCacheAvailable()) {
      tools.append(actionRow("download", "缓存视频", () => {
        // 元数据跟着文件一起落盘（标题/封面/时长/原始 id）⇒「我的 → 已缓存」离线也能显示
        // 标题和封面，不再是一串 med_xxxx（用户 2026-09-25 报障）。
        const meta = JSON.stringify({
          id: String(entry.item.id),
          title: entry.item.title || "",
          cover: entry.item.cover_url || "",
          duration_ms: Number(entry.item.duration_ms) || 0,
        });
        try {
          if (typeof window.ZvAndroid.cacheVideo2 === "function") window.ZvAndroid.cacheVideo2(String(entry.item.id), meta);
          else window.ZvAndroid.cacheVideo(String(entry.item.id), entry.item.title || "");
          showToast("开始缓存，看通知栏进度");
          closePanels();
        } catch (err) { showToast("这台设备缓存不了"); }
      }));
    }

    // 电视端（遥控器）够不着右侧栏（没有触摸）⇒ 把侧栏那 4 个动作原样搬一份到这里
    // （用户 2026-09-25 选了"复用网页界面 + 方向键"，手机上/网页上这一组不显示）。
    // 只是"换个地方放"，不新增任何功能。
    const tvQuick = tvMode() ? el("div", { class: "sheet-group" }) : null;
    if (tvQuick) {
      tvQuick.append(
        actionRow("thumb", "点赞", () => { entry.like.click(); }),
        actionRow("heart", "收藏", () => { entry.fav.click(); }),
        actionRow("volume", "声音", () => { entry.sound.click(); }),
        actionRow("expand", "全屏", () => { entry.fullscreen.click(); }),
        // 搜索：顶栏那颗按钮遥控器够不到（播放页方向键全被"换集/快进"占用），这里补一个入口
        actionRow("search", "搜索", () => { location.hash = "#/search"; }),
      );
    }

    // 第 2 组：常用（清屏/稍后再看 + 播放设置那一堆行，同一张卡片里）
    const common = el("div", { class: "sheet-group" });
    if (playlist) {
      // 剧场：选集（原来在边栏，边栏只留 4 个后搬到这里）
      common.append(actionRow("theater", "选集", () => {
        closePanels();
        if (!entry.epsPanel) entry.layer.append(buildEpisodePanel(entry));
        entry.epsPanel.classList.remove("hidden");
      }, state.items.length + " 集"));
    }
    // 清屏播放图标 = 用户给的图1（一把刷子，2026-09-25）
    const cleanRow = actionRow("clean", "清屏播放", () => { toggleClean(); paintCommon(); });
    cleanRow.dataset.role = "sheet-clean";
    common.append(cleanRow);
    const laterRow = actionRow("clock", "稍后再看", () => { toggleWatchLater(entry); paintCommon(); });
    laterRow.dataset.role = "sheet-later";
    common.append(laterRow);
    if (isAdmin()) {
      // 管理员：删除入口（原来在边栏）。删除要弹确认框，所以这里**不自动收面板**
      const delRow = actionRow("trash", "删除这个视频", () => askDelete(entry), "", false);
      delRow.dataset.role = "sheet-delete";
      common.append(delRow);
    }
    common.append(entry.settingsForm.node);

    const groups = [];
    if (tools.childNodes.length) groups.push(tools);
    if (tvQuick) groups.push(tvQuick);
    groups.push(common);

    // 第 3 组：剧场入口（图3 的「合集 · 这是一个小短剧 更新至 N 集 >」）
    if (playlist && playlist.seriesId) {
      // tabindex=0：跟 actionRow 一样，电视端遥控器得能落焦（div 默认不可聚焦 ⇒ 点了没反应）
      const row = el("div", { class: "sheet-row sheet-series", tabindex: "0", dataset: { role: "sheet-series" } },
        icon("theater"),
        el("span", { class: "sheet-label", text: "剧场 · " + (playlist.title || "") }),
        el("span", { class: "sheet-right muted", text: "共 " + (playlist.episodeCount || state.items.length) + " 集" }),
        el("span", { class: "sheet-arrow", text: "›" }));
      row.addEventListener("click", (event) => {
        event.stopPropagation();
        location.hash = "#/series/" + encodeURIComponent(playlist.seriesId);
      });
      groups.push(el("div", { class: "sheet-group" }, row));
    }

    // 门禁要求：展开只能用数组（groups 是数组没错，但为了可读性显式用循环拼）
    const panel = el("div", { class: "set-panel sheet hidden", dataset: { role: "settings-sheet" } },
      el("div", { class: "sheet-handle" }));
    for (const g of groups) panel.append(g);
    entry.panel = panel;
    entry.panel.addEventListener("click", (event) => event.stopPropagation());
    // 面板自己能滚：滚轮/触摸就地消化，别冒泡到 feed（否则一滚就换下一条视频）
    entry.panel.addEventListener("wheel", (event) => event.stopPropagation(), { passive: true });
    entry.panel.addEventListener("touchmove", (event) => event.stopPropagation(), { passive: true });

    // 行上的状态文字（清屏开/关、稍后再看已添加/未添加）跟着真实状态刷
    function paintCommon() {
      const cleanRow = common.querySelector('[data-role="sheet-clean"] .sheet-right');
      if (cleanRow) cleanRow.textContent = feed.classList.contains("clean") ? "已开启" : "关闭";
      const laterRight = common.querySelector('[data-role="sheet-later"] .sheet-right');
      if (laterRight) laterRight.textContent = (entry.item && entry.item.watch_later) ? "已添加" : "未添加";
    }
    entry.paintSheet = paintCommon;
    entry.panel.__zvPaintCommon = paintCommon;
    return entry.panel;
  }

  // 抖音式行：[图标] 标签 ………… 右侧值
  // collapse=true（默认）：点完**立刻收起面板**回到播放（用户 2026-09-24：
  // "任何操作完成都应该收起面板，如点了稍后再看后立刻收起，显示视频播放"）。
  function actionRow(iconName, label, onClick, rightText, collapse) {
    const right = el("span", { class: "sheet-right muted", text: rightText || "" });
    // tabindex=0：电视端遥控器要能落焦到这一行（div 默认不可聚焦），确定键由 tv.js 代点
    const row = el("div", { class: "sheet-row", tabindex: "0", dataset: { role: "sheet-action" } },
      icon(iconName), el("span", { class: "sheet-label", text: label }), right);
    row.addEventListener("click", (event) => {
      event.stopPropagation();
      onClick();
      if (collapse !== false) closePanels();
    });
    return row;
  }

  function openPanel(entry) {
    if (entry.destroyed || !entry.layer) return;
    if (!entry.panel) entry.layer.append(ensureScrim(), buildPanel(entry));
    closePanels();
    holdCurrent(true);   // 面板开着期间：当前这条一直循环，不许自动下一个
    // 长按/右键可能顺带选中了底下的文字，进而弹出系统选择菜单（用户报障）——开面板时清掉选区
    try { const sel = window.getSelection(); if (sel) sel.removeAllRanges(); } catch (err) { /* 忽略 */ }
    paintPanel(entry);
    ensureScrim().classList.remove("hidden");
    entry.panel.classList.remove("hidden");
    if (entry.paintSheet) entry.paintSheet();
  }

  // 剧场「选集」面板：样式与剧场列表里的选集一致（.ep-list/.ep-item），点一集就跳过去。
  function buildEpisodePanel(entry) {
    const panel = el("div", { class: "set-panel eps hidden" });
    const list = el("div", { class: "ep-list" });
    state.items.forEach((item, i) => {
      list.append(el("button", {
        class: "ep-item" + (i === entry.index ? " on" : ""), type: "button",
        dataset: { role: "ep-item", index: String(i) },
        onclick: () => { panel.classList.add("hidden"); goTo(i); },
      },
        el("span", { class: "ep-no", text: item.episode_label || ("第 " + (i + 1) + " 集") }),
        el("span", { class: "ep-title", text: item.title || ("#" + item.id) }),
        el("span", { class: "ep-pct muted", text: fmtDuration(item.duration_ms) })));
    });
    panel.append(el("div", { class: "panel-title", text: (playlist.title || "剧场") + " · 选集" }), list);
    panel.addEventListener("click", (event) => event.stopPropagation());
    entry.epsPanel = panel;
    return panel;
  }

  function closePanels() {
    for (const entry of state.built.values()) {
      if (entry.panel) entry.panel.classList.add("hidden");
      if (entry.epsPanel) entry.epsPanel.classList.add("hidden");
    }
    if (sheetScrim) sheetScrim.classList.add("hidden");
    if (picker) picker.classList.add("hidden");
    holdCurrent(false); // 面板收起 ⇒ 恢复用户设置的连播/循环行为
  }

  // 面板开着时：当前这条一直循环，绝不自动下一个（用户 2026-09-24 的改进 3）。
  // 收起后怎么播由用户的设置决定：开了连播/循环就照旧，都没开就播完暂停。
  function holdCurrent(on) {
    state.panelOpen = !!on;
    const loop = on ? true : loopEnabled();
    for (const entry of state.built.values()) {
      if (entry.video) entry.video.loop = loop;
    }
  }

  // 有面板开着吗？（返回手势/App 返回键先关它，再管全屏）
  function anyPanelOpen() {
    for (const entry of state.built.values()) {
      if (entry.panel && !entry.panel.classList.contains("hidden")) return true;
      if (entry.epsPanel && !entry.epsPanel.classList.contains("hidden")) return true;
    }
    return !!(picker && !picker.classList.contains("hidden"));
  }

  // App 里的判定：原生桥在（window.ZvAndroid）或 URL 带 zv=app（WebActivity 会加）。
  // App 不显示设置按钮 —— 抖音就是长按弹面板，用户 2026-09-24 明确要一致。
  function inAppWebView() {
    return !!window.ZvAndroid || /[?&]zv=app(&|#|$)/.test(location.search + location.hash);
  }

  // 设置入口：**不放边栏**（用户 2026-09-24 定稿：边栏只有 4 个）。
  // 网页端右键（contextmenu）或长按画面打开；App 里只有长按。

  function applySettings() {
    const loop = loopEnabled();
    for (const entry of state.built.values()) {
      if (entry.video) {
        entry.video.loop = state.panelOpen ? true : loop;
        // 正在长按快进时不要被设置刷新覆盖（松手时按新倍速还原）
        if (!entry.fastForward) entry.video.playbackRate = state.settings.playback_rate;
      }
      paintPanel(entry);
    }
  }

  async function saveSettings(partial) {
    const before = state.settings;
    state.settings = normalizeFeedSettings(Object.assign({}, state.settings, partial));
    applySettings();
    try {
      const result = await api.patchFeedSettings(partial);
      if (result) state.settings = normalizeFeedSettings(result);
    } catch (err) {
      state.settings = before;
      showToast(err && err.message ? err.message : "设置保存失败");
    }
    applySettings();
  }

  /* ---------- 清屏播放 / 旋转全屏（用户 2026-09-23） ---------- */

  // 清屏：把边栏/标题/角标都收起来，只留一个小箭头还原（比"点画面切换"更明确，不会和"点画面=暂停"打架）
  /* ---------- 全屏（沉浸）状态：全局一份（feed 只有一个） ---------- */
  //
  // 用户 2026-09-24：「全屏播放时不显示任何按钮/进度、边栏收起；点屏幕切换显示；
  // 左上角显示返回按钮（左箭头）」。所以全屏 = 沉浸态：进去先全收起，点屏幕来回切换。
  const full = { rotated: false, native: false, uiHidden: false };
  // B4：画中画状态。原生（安卓整窗小窗）时由 App 回调 window.zvPipMode 同步过来。
  let nativePip = false;
  const pipPaints = new Set();
  function pipOn() {
    if (nativePip) return true;
    return typeof document !== "undefined" && !!document.pictureInPictureElement;
  }
  function paintPip() { for (const fn of pipPaints) fn(); }
  let lastImmersive = null;
  function paintImmersive() {
    const on = full.rotated || full.native;
    // CSS 旋转只在"系统没横过来"时用 —— 忘了它会出现"进了全屏但画面没横过来"（我自己踩过）
    feed.classList.toggle("rot", full.rotated);
    // ⚠️ 沉浸态（收顶栏/底栏/控件）**与转屏方式无关**：手机/App 里是系统横屏（native=true、
    // rotated=false），只按 rotated 判断会让顶栏、底栏大喇喇留在屏幕上（用户 2026-09-24 报障：
    // "电脑端显示不出来，手机端无论浏览器还是 App 都显示"）。
    document.body.classList.toggle("rot-play", on);
    feed.classList.toggle("immersive", on);
    feed.classList.toggle("blank", full.uiHidden);
    // 告诉 App 现在是不是全屏：系统返回手势要"先退出全屏"（见 WebActivity.handleOnBackPressed）
    if (on !== lastImmersive) {
      lastImmersive = on;
      try { if (window.ZvAndroid && window.ZvAndroid.setImmersive) window.ZvAndroid.setImmersive(on); } catch (err) { /* 老版本 App 没有这个口 */ }
    }
  }
  function setImmersive(on) {
    full.uiHidden = on;            // 进全屏先收起，退出全屏恢复
    if (on) feed.classList.remove("clean"); // 别和"清屏"那个状态打架
    paintImmersive();
  }
  function immersiveOn() { return full.rotated || full.native; }

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

  // 缓存视频：只有 App 里有原生桥（ZvAndroid.cacheVideo）才显示 —— 网页端下不了"到本机离线看"
  function nativeCacheAvailable() {
    return !!(window.ZvAndroid && typeof window.ZvAndroid.cacheVideo === "function");
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
      if (bridge && typeof bridge.landscape === "function") full.native = bridge.landscape(true) === true;
    } catch (err) { full.native = false; }
    if (!full.native) {
      try {
        if (document.fullscreenElement === null && document.documentElement.requestFullscreen) {
          await document.documentElement.requestFullscreen();
        }
        if (screen.orientation && typeof screen.orientation.lock === "function") {
          await screen.orientation.lock("landscape");
          await sleep(250);
          full.native = isLandscape();
          await sleep(200);              // 再读一次：假成功会自己退回去
          if (!isLandscape()) full.native = false;
        }
      } catch (err) { full.native = false; }
    }
    full.rotated = !full.native;
    setImmersive(true);
    showToast(full.native ? "横屏全屏（点屏幕显隐控件）" : "已旋转横屏：把手机横过来看（点屏幕显隐控件）");
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
    full.rotated = false;
    full.native = false;
    full.uiHidden = false;
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
      if (entry.video && entry.video.paused) { full.uiHidden = false; paintImmersive(); }
    });
    entry.paintPlayPause = paint;
    paint();
    return btn;
  }

  /* ---------- B4 画中画 / 投屏 ---------- */

  /** 小窗播放开关（面板里的按钮调它；原来的边栏按钮已移除）。 */
  async function togglePip(entry) {
    try {
      if (nativePip) return; // 已经在原生小窗里
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else if (nativePipAvailable()) { window.ZvAndroid.enterPip(); return; }
      else if (entry.video) await entry.video.requestPictureInPicture();
      else showToast("这条放不了，开不了小窗");
    } catch (err) {
      showToast(pipFailText(err));
    }
    paintPip();
  }

  function pipFailText(err) {
    const name = err && err.name ? err.name : "";
    if (name === "NotAllowedError") return "这个浏览器不让直接开小窗，先点一下画面再试";
    if (name === "NotSupportedError") return "这段视频不支持画中画";
    return "开不了画中画：" + (err && err.message ? err.message : "未知原因");
  }

  /** 投屏（标准 Remote Playback；面板里的按钮调它）。 */
  async function toggleCast(entry) {
    const remote = entry.video && entry.video.remote;
    if (!remote || typeof remote.prompt !== "function") { showToast("这个浏览器不支持投屏"); return; }
    try {
      await remote.prompt();
    } catch (err) {
      // 绝大多数是"附近没有可投屏的设备"——如实说，别装作投上了
      showToast("没找到可投屏的设备（电视/盒子要和手机在同一 Wi-Fi）");
    }
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
      dropItem(entry.index);
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
      const shell = el("article", { class: "card", dataset: { index: String(index), id: String(item.id) } });
      shell.style.top = (index * 100) + "%";
      state.items.push(item);
      state.shells.push(shell);
      track.append(shell);
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
    state.loading = true;
    setLoading(true);
    try {
      const result = await api.feedNext({
        library_id: state.scope || undefined,
        cursor: state.nextCursor || undefined,
        limit: BATCH,
      });
      const list = result && result.data && Array.isArray(result.data.list) ? result.data.list : [];
      const meta = (result && result.meta) || {};
      state.nextCursor = meta.next_cursor || "";
      // 空批次必须停，否则 has_more 说谎时会无限翻页（坑 9）
      appendItems(list, { has_more: !!meta.has_more && list.length > 0, settings: meta.settings });
      return true;
    } catch (err) {
      // 用 detail()（带上接口与状态码）：这才是"能定位"的报错
      const message = err && typeof err.detail === "function" ? err.detail() : (err && err.message ? err.message : "加载失败");
      showFeedError(message);
      if (!tvMode()) showToast(message); // 手机上 Toast 够用；电视上靠那张卡
      return false;
    } finally {
      state.loading = false;
      setLoading(false);
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
    try {
      state.libraries = asArray(await api.myLibraries());
    } catch (err) {
      state.libraries = [];
    }
    state.librariesLoaded = true;
    if (pickerBtn) pickerBtn.classList.toggle("hidden", state.libraries.length <= 1);
    renderPicker();
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
    for (const index of Array.from(state.built.keys())) destroyEntry(index);
    for (const shell of state.shells) shell.remove();
    state.items = [];
    state.shells = [];
    state.active = -1;
    state.hasMore = true;
    state.loading = false;
    state.nextCursor = "";
    state.scope = libraryID;
    state.scopeName = libraryName;
    renderPicker();
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

  // 电视端（遥控器）：按键语义与键盘不同（用户 2026-09-25）。
  //   ↑↓ 换视频（电视就是"换台"）· ←→ 快退快进 · 确定 播放/暂停
  //   长按确定（或遥控器菜单键）开设置面板 · 面板里 ↑↓ 走焦点、← 收面板
  // 只在 tv 模式下注册；返回 true = 这次按键播放页吃了，通用空间导航不再插手（见 tv.js）。
  let tvEnterTimer = null;
  function tvPanelOpen() {
    const entry = state.built.get(state.active);
    return !!(entry && entry.panel && !entry.panel.classList.contains("hidden"));
  }
  function onTvKeyDown(event) {
    const entry = state.built.get(state.active);
    if (!entry || entry.destroyed) return false;
    if (tvPanelOpen()) {
      // 面板开着：↑↓ 交给通用焦点导航（行与行之间走），← 收面板
      if (event.key === "ArrowLeft") { closePanels(); return true; }
      return false;
    }
    const active = document.activeElement;
    if (active && active.closest && active.closest(".ov-rail")) {
      // 焦点在侧栏上：←→ 退出侧栏回画面，↑↓ 交给通用导航在侧栏里走
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        if (active.blur) active.blur();
        return true;
      }
      return false;
    }
    // 焦点已经落在真正的控件上（顶栏按钮 / 来自X·全部库 chips / 侧栏 / 选集…）时，**确定键不许抢**：
    // 原来播放页把任何确定键都当"播放/暂停"，实测顶栏「搜索」拿得到焦点却永远按不动（用户 2026-09-25 同类报障）。
    // 方向键仍旧保留播放页语义（↑↓ 换视频、←→ 快进），这是电视上看片的主动作。
    if (event.key === "Enter" && active && active !== document.body && active.closest &&
        active.closest("button, a[href], [tabindex]:not([tabindex='-1'])")) {
      return false;
    }
    switch (event.key) {
      case "ArrowDown": goTo(state.active + 1); return true;
      case "ArrowUp": goTo(state.active - 1); return true;
      case "ArrowLeft": seekBy(-1); return true;
      case "ArrowRight": seekBy(1); return true;
      case "Enter":
        // 短按 = 播放/暂停，长按 = 开面板（手机上就是长按弹面板）：动作等 keyup/超时再定。
        // 400ms 不是 550ms：`input keyevent --longpress` 只按住 ~500ms，阈值太贴近会"长按当短按"。
        if (!event.repeat) {
          if (tvEnterTimer) clearTimeout(tvEnterTimer);
          tvEnterTimer = setTimeout(() => { tvEnterTimer = null; openPanel(entry); }, 400);
        }
        return true;
      case "ContextMenu": openPanel(entry); return true; // 遥控器"菜单"键（部分机型能到 JS）
      default: return false;
    }
  }
  function onTvKeyUp(event) {
    if (event.key !== "Enter" || !tvEnterTimer) return false;
    clearTimeout(tvEnterTimer);
    tvEnterTimer = null;
    const entry = state.built.get(state.active);
    if (entry && !entry.destroyed) togglePlay(entry);
    return true;
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
  // 电视端：把遥控器按键接过来（tv.js 的通用空间导航在它之后跑）
  if (tvMode()) {
    setFeedKeys({ down: onTvKeyDown, up: onTvKeyUp });
    // 遥控器"菜单"键：实测 WebView 不一定把它交给网页 ⇒ 原生按键口子直接调这个（见 WebActivity.onKeyDown）
    window.__zvTvMenu = () => {
      const entry = state.built.get(state.active);
      if (!entry || entry.destroyed) return false;
      openPanel(entry);
      return true;
    };
    setTimeout(() => showToast("遥控器：↑↓ 换视频，← → 快退快进，确定 播放/暂停，长按确定 设置"), 900);
  }

  if (playlist) {
    // 剧场/稍后再看：数据一次给全，不取游标、不翻页、不选库。
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

  /**
   * 原生把播放收回网页时调它（见 WebActivity.onResume）：
   *   · 后台自动播到了**别的**剧集 ⇒ 网页跟着跳到那一条（用户 2026-09-26 报障：
   *     后台听到 F 了，回前台却又回到最早的 A）；
   *   · 还是同一条 ⇒ 就地 seek 回去接着播。
   * 返回 true = 认领成功；false = 这一条不在网页当前列表里（原生据此如实提示，不假装成功）。
   */
  window.zvResumeNative = (mediaId, positionMs) => {
    const id = String(mediaId || "");
    if (!id) return false;
    const index = state.items.findIndex((it) => String(it.id) === id);
    if (index < 0) return false;
    if (index !== state.active) goTo(index);
    const entry = state.built.get(index) || ensureEntry(index);
    if (!entry || !entry.video) return index === state.active;
    const seek = () => {
      try {
        const d = entry.video.duration || 0;
        let t = (Number(positionMs) || 0) / 1000;
        if (d > 0 && t > d - 1) t = 0; // 后台可能已经播到结尾：从头开始比"卡在最后一秒"合理
        entry.video.currentTime = t;
      } catch (err) { /* 还没 metadata，等 loadedmetadata 再设 */ }
    };
    if (entry.video.readyState >= 1) seek();
    else entry.video.addEventListener("loadedmetadata", seek, { once: true });
    if (entry.video.paused) tryPlay(entry);
    return true;
  };

  // App 的系统返回手势进来先问这里：全屏中就只退出全屏（符合播放器习惯），否则交给路由。
  // App 进/出小窗（原生画中画）时通知这里，好让按钮状态和真实情况一致
  const onPipMode = (on) => {
    nativePip = !!on;
    // 安卓的"画中画"是整窗缩放：小窗里只该有画面，顶栏/底栏/工具条全收起
    document.body.classList.toggle("pip", nativePip);
    paintPip();
  };
  window.zvPipMode = onPipMode;

  // App（WebView）回到前台时由原生调它：WebView 设了 mediaPlaybackRequiresUserGesture=false，
  // 只要页面可见就该有声 ⇒ 那次"被浏览器策略摁成的静音"可以自动恢复，用户不用再点一下喇叭。
  // 网页端没有这个口（那种情况下浏览器一定要用户手势，只能由用户点）。
  window.__zvSoundNudge = () => {
    if (!state.soundBlocked || !state.soundOn) return false;
    clearSoundBlocked();
    return true;
  };

  // App 的返回手势/返回键先问这里：
  //   ① 有面板开着 ⇒ 只关面板（播放内容一点不动）；
  //   ② 在全屏 ⇒ 退全屏；
  //   ③ 都没有 ⇒ 返回 false，交给路由（返回上一页）。
  window.__zvExitFullscreen = () => {
    if (anyPanelOpen()) { closePanels(); return true; }
    if (!immersiveOn()) return false;
    exitFullscreen();
    return true;
  };
  window.__zvBackHandler = window.__zvExitFullscreen;

  // 系统/浏览器自己退出了全屏（比如切走、按了系统的退出全屏）：同步收掉沉浸态，
  // 别让界面卡在"以为还在全屏"（顶栏底栏一直藏着）。
  const onFullscreenChange = () => {
    if (document.fullscreenElement) return;
    if (full.rotated || full.native) releaseFullscreen();
  };
  document.addEventListener("fullscreenchange", onFullscreenChange);

  return function cleanup() {
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
      if (tvEnterTimer) clearTimeout(tvEnterTimer);
      setFeedKeys(null);
      try { delete window.__zvTvMenu; } catch (err) { window.__zvTvMenu = null; }
    }
    flushProgress(state.active, false);
    for (const index of Array.from(state.built.keys())) destroyEntry(index);
  };
}
