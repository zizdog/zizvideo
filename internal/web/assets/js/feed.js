// 竖向全屏短视频流：transform 位移 + 手势锁 + seed 随机游标 + 拖动进度

import { api, patchProgressKeepalive } from "./api.js";
import { el, clear, asArray, fmtDuration } from "./dom.js";
import { mountNav } from "./nav.js";
import { session } from "./auth.js";
import { choiceDialog } from "./confirm.js";
import { createFeedSettingsForm, normalizeFeedSettings, seekSecondsOf, loopEffective } from "./play-settings.js";

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
  try { return localStorage.getItem(SOUND_KEY) === "on"; } catch (err) { return false; }
}

function writeSoundPref(on) {
  try { localStorage.setItem(SOUND_KEY, on ? "on" : "off"); } catch (err) { /* 隐私模式忽略 */ }
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
  const pickerBtn = playlist ? null : el("button", {
    class: "lib-chip hidden", type: "button", text: "选库",
    style: { position: "absolute", zIndex: "8", top: "44px", left: "12px" },
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
    feed.append(track, chip, pickerBtn, picker);
  } else {
    feed.append(track, chip);
  }
  view.append(feed, toast);
  // 底栏挂载点（条目 10）：只加容器与入口，不改播放/进度逻辑
  view.append(mountNav(playlist ? (playlist.navKey || "series") : "feed"));

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
    scope: "", scopeName: "", nextCursor: "",
    libraries: [], librariesLoaded: !!playlist,
    // 剧场：自动连播写死开启、循环写死关闭（用户："自动连播且无法设置"）
    settings: normalizeFeedSettings(playlist ? { autoplay_next: true, loop_play: false } : undefined),
    infoCard: null, emptyCard: null,
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

  function setActive(index, animate) {
    if (index < 0 || index === state.active) return;
    const previous = state.active;
    if (previous >= 0) flushProgress(previous, false);
    state.active = index;
    paintTrack(animate !== false);
    syncWindow(index);
    const entry = state.built.get(index);
    if (entry && entry.video && !entry.broken) tryPlay(entry);
    maybeLoadMore(index);
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
      hint: null, soundHint: null, playBtn: null, flash: null,
      bubble: null, bar: null, barWrap: null, sound: null, gear: null, panel: null,
      settingsForm: null, seekRatio: 0,
      seeking: false, flashTimer: 0, hintTimer: 0,
      resumeDone: false, playRejected: false, broken: false, destroyed: false,
    };
    state.built.set(index, entry);

    entry.fav = el("button", { class: "icon-btn", type: "button", title: "收藏", text: "♥" });
    entry.like = el("button", { class: "icon-btn", type: "button", title: "喜欢", text: "👍" });
    entry.later = el("button", { class: "icon-btn", type: "button", title: "稍后再看", text: "🕒" });
    entry.fav.classList.toggle("on", !!item.favorite);
    entry.like.classList.toggle("on", item.reaction === "like");
    entry.later.classList.toggle("on", !!item.watch_later);
    entry.fav.addEventListener("click", () => toggleFavorite(entry));
    entry.like.addEventListener("click", () => toggleLike(entry));
    entry.later.addEventListener("click", () => toggleWatchLater(entry));
    // 删除入口只给管理员（前台也不放宽权限，接口侧再拦一次）
    entry.del = isAdmin()
      ? el("button", { class: "icon-btn", type: "button", title: "删除这个视频", text: "🗑" })
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
    layer.append(el("div", { class: "ov-rail" },
      entry.fav, entry.like, entry.later, entry.eps, soundButton(entry), gearButton(entry), entry.del));

    // 左上角"来自 <库名>"（点击切范围）：剧场没有切库，跳过。
    if (!playlist) layer.append(libraryCorner(item));

    if (!isPlayable(item)) {
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
    const video = createMediaVideo(item, { muted: !state.soundOn, loop: loopEnabled() });
    entry.video = video;
    video.addEventListener("loadedmetadata", () => onMetadata(entry));
    video.addEventListener("loadeddata", () => checkFrames(entry));
    video.addEventListener("timeupdate", () => paintTime(entry));
    video.addEventListener("play", () => {
      hidePlayButton(entry);
      if (!state.soundOn) showSoundHint(entry);
    });
    video.addEventListener("ended", () => onEnded(entry));
    video.addEventListener("error", () => showBroken(entry));
    video.addEventListener("click", () => togglePlay(entry));
    stage.append(video);
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
    const corner = el("div", { class: "ov-corner left" }, here);
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
      result.catch(() => showPlayButton(entry));
    }
  }

  /* ---------- 声音（角落按钮，不再是单击画面） ---------- */

  function paintSound(entry) {
    if (entry && entry.sound) entry.sound.textContent = state.soundOn ? "🔊" : "🔇";
  }

  function setSound(on) {
    state.soundOn = !!on;
    writeSoundPref(state.soundOn);
    for (const entry of state.built.values()) {
      if (entry.video) entry.video.muted = !state.soundOn;
      paintSound(entry);
      if (state.soundOn) hideSoundHint(entry);
    }
  }

  function soundButton(entry) {
    entry.sound = el("button", { class: "icon-btn", type: "button", title: "声音" });
    paintSound(entry);
    entry.sound.addEventListener("click", (event) => {
      event.stopPropagation();
      setSound(!state.soundOn);
    });
    return entry.sound;
  }

  function showSoundHint(entry) {
    if (entry.destroyed || !entry.layer) return;
    if (!entry.soundHint) {
      entry.soundHint = el("div", { class: "hint low", text: "点右上角喇叭开启声音" });
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

  function togglePlay(entry) {
    if (entry.destroyed || entry.broken || !entry.video) return;
    if (entry.video.paused) {
      const result = entry.video.play();
      if (result && typeof result.catch === "function") result.catch(() => showPlayButton(entry));
      flash(entry, "▶");
    } else {
      entry.video.pause();
      flash(entry, "⏸");
    }
  }

  function showPlayButton(entry) {
    if (entry.playRejected || entry.destroyed || !entry.video || !entry.layer) return;
    entry.playRejected = true;
    entry.playBtn = el("button", {
      class: "center-btn", type: "button", text: "点击播放",
      onclick: () => {
        hidePlayButton(entry);
        setSound(true);
        const result = entry.video.play();
        if (result && typeof result.catch === "function") result.catch(() => {});
      },
    });
    entry.layer.append(entry.playBtn);
  }

  function hidePlayButton(entry) {
    if (entry.playBtn && entry.playBtn.parentNode) entry.playBtn.remove();
    entry.playBtn = null;
  }

  function onEnded(entry) {
    flushProgress(entry.index, false);
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

  function buildPanel(entry) {
    entry.settingsForm = createFeedSettingsForm({
      settings: state.settings,
      onChange: saveSettings,
      // 剧场：自动连播写死开启且**不可设置**（用户要求），只留"跳转秒数"。
      lockAutoplay: !!playlist,
    });
    entry.panel = el("div", { class: "set-panel hidden" }, entry.settingsForm.node);
    entry.panel.addEventListener("click", (event) => event.stopPropagation());
    return entry.panel;
  }

  // 剧场「选集」面板：样式与剧场列表里的选集一致（.ep-list/.ep-item），点一集就跳过去。
  function buildEpisodePanel(entry) {
    const panel = el("div", { class: "set-panel hidden" });
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
    if (picker) picker.classList.add("hidden");
  }

  function gearButton(entry) {
    entry.gear = el("button", { class: "icon-btn", type: "button", title: "播放设置", text: "⚙" });
    entry.gear.addEventListener("click", (event) => {
      event.stopPropagation();
      if (!entry.panel) entry.layer.append(buildPanel(entry));
      const open = entry.panel.classList.contains("hidden");
      closePanels();
      paintPanel(entry);
      if (open) entry.panel.classList.remove("hidden");
    });
    return entry.gear;
  }

  function applySettings() {
    const loop = loopEnabled();
    for (const entry of state.built.values()) {
      if (entry.video) entry.video.loop = loop;
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

  async function toggleLike(entry) {
    const item = entry.item;
    const liked = item.reaction === "like";
    item.reaction = liked ? null : "like";
    entry.like.classList.toggle("on", !liked);
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
      state.emptyCard = el("div", { class: "card info",
        text: noLibrary ? "没有可访问的媒体库，请联系管理员" : "还没有视频" });
      feed.append(state.emptyCard);
    }
    if (state.items.length && state.active < 0) setActive(0, false);
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
      showToast(err && err.message ? err.message : "加载失败");
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
    if (event.touches.length !== 1) return;
    if (isInteractive(event.target)) { touchY = null; return; }
    touchY = event.touches[0].clientY;
    gate.begin(Date.now());
  }

  function onTouchEnd(event) {
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
  window.addEventListener("pagehide", onPageHide);
  document.addEventListener("visibilitychange", onVisibility);

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

  return function cleanup() {
    clearInterval(progressTimer);
    if (toastTimer) clearTimeout(toastTimer);
    if (settleTimer) clearTimeout(settleTimer);
    track.removeEventListener("transitionend", onTransitionEnd);
    feed.removeEventListener("wheel", onWheel);
    feed.removeEventListener("touchstart", onTouchStart);
    feed.removeEventListener("touchend", onTouchEnd);
    document.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("pagehide", onPageHide);
    document.removeEventListener("visibilitychange", onVisibility);
    flushProgress(state.active, false);
    for (const index of Array.from(state.built.keys())) destroyEntry(index);
  };
}
