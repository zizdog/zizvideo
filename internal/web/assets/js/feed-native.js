// 安卓原生桥（window.ZvAndroid）：画中画／投屏／缓存、原生播放器接力、后台播放收回网页、
// 回到前台解除“被浏览器策略摁成的静音”。网页端没有这些口时一律“能力探测 → 不画按钮 /
// 退回 hash 深链”，绝不假装成功。

import { el } from "./dom.js";

// B4：画中画 / 投屏的能力探测 —— 浏览器支持才画按钮，绝不画个点了没反应的图标。
// 安卓 App 的画中画是"整个 App 缩成小窗"（WebView 里的视频继续放），由原生桥 enterPip 接管。
function nativePipAvailable() {
  return typeof window !== "undefined" && !!window.ZvAndroid
    && typeof window.ZvAndroid.enterPip === "function";
}
export function pipAvailable() {
  if (nativePipAvailable()) return true;
  return typeof document !== "undefined" && document.pictureInPictureEnabled === true
    && typeof document.exitPictureInPicture === "function";
}
// Remote Playback 是标准的"投到电视/盒子"接口（Chrome 的 Cast、Safari 的 AirPlay 都走它）。
export function castAvailable() {
  return typeof HTMLVideoElement !== "undefined"
    && !!HTMLVideoElement.prototype && "remote" in HTMLVideoElement.prototype;
}

// 缓存视频：只有 App 里有原生桥（ZvAndroid.cacheVideo）才显示 —— 网页端下不了"到本机离线看"
export function nativeCacheAvailable() {
  return !!(window.ZvAndroid && typeof window.ZvAndroid.cacheVideo === "function");
}

export function createNativeModule(ctx) {
  const state = ctx.state;
  const tvLayout = ctx.tvLayout;
  const showToast = ctx.core.showToast;
  const goTo = ctx.core.goTo;
  const tryPlay = ctx.core.tryPlay;
  const ensureEntry = ctx.core.ensureEntry;
  const centerMessage = ctx.core.centerMessage;
  const clearSoundBlocked = ctx.sound.clearSoundBlocked;

  /** 交给原生播放器前，先把网页这边的声音关掉：两边同时放就是"两个声音"（用户 2026-09-30 反馈过）。 */
  function pauseWebPlayback() {
    for (const entry of state.built.values()) {
      if (entry.video && !entry.video.paused) {
        try { entry.video.pause(); } catch (err) { /* ignore */ }
      }
    }
  }

  /**
   * 电视端：让**原生播放器**播这一条（ExoPlayer 走平台 MediaCodec —— 小米电视这类机器有硬件 HEVC 解码器）。
   * 用户 2026-09-29："播放不了 hevc！我的小米电视硬件是支持的"：WebView 的 <video> 放不了的编码，
   * 由原生播放页接手。
   * ⚠️ 优先走原生桥（App 0.4.3+）：**不改 hash**。改 hash 会被前端路由器当成一次真跳转
   * （首页整个重挂、列表重新拉一遍 ⇒ 用户返回时"列表都变了"），再叠加 App 那边的 web.goBack()
   * 就把用户正在看的列表冲掉了（用户 2026-10-01 报障）。老 App 没有这个桥，退回 hash 深链兜底。
   */
  function tvNativePlay(item) {
    if (!item || !item.id) return false;
    ctx.panels.closePanels();
    pauseWebPlayback();
    const bridge = typeof window !== "undefined" ? window.ZvAndroid : null;
    if (bridge && typeof bridge.playNative === "function") {
      try {
        if (bridge.playNative(String(item.id), "single")) return true;
      } catch (err) { /* 桥出错就退回 hash 深链 */ }
    }
    location.hash = "#/play/single/" + encodeURIComponent(item.id);
    return true;
  }

  /**
   * 这条**必须**交给原生播放器吗？电视端 + 原生桥在 + 编码是 WebView 解不出的（HEVC/AV1）——
   * 用户 2026-09-30 实测："hevc 视频还是提示'这台浏览器解不出 hevc 画面'"：服务端已经不拦了，
   * 但 WebView 自己解不出来（Android WebView 的 <video> 走的是 Chromium 的解码路径，
   * 跟设备有没有硬件 HEVC 解码器不是一回事）。所以这类编码**别喂给 <video>**，直接原生硬解。
   */
  function tvNeedsNative(item) {
    if (!tvLayout || !item) return false;
    if (typeof window === "undefined" || !window.ZvAndroid) return false;
    const codec = String((item.codecs && item.codecs.video) || "").toLowerCase();
    return codec === "hevc" || codec === "h265" || codec === "av1";
  }

  /** 放不了的卡片：电视端多一个"用原生播放器打开"的按钮（WebView 解不了的编码走原生硬解）。 */
  function brokenCard(item, title, sub) {
    const card = centerMessage(title, sub);
    if (!tvLayout || !item || !item.id) return card;
    const btn = el("button", { class: "btn primary center-action", type: "button", text: "用原生播放器打开",
      dataset: { role: "tv-native-play" } });
    btn.addEventListener("click", (event) => { event.stopPropagation(); tvNativePlay(item); });
    const inner = card.querySelector ? card.querySelector(".center-inner") : null;
    if (inner) inner.append(btn);
    return card;
  }

  // B4：画中画状态。原生（安卓整窗小窗）时由 App 回调 window.zvPipMode 同步过来。
  let nativePip = false;
  const pipPaints = new Set();
  function pipOn() {
    if (nativePip) return true;
    return typeof document !== "undefined" && !!document.pictureInPictureElement;
  }
  function paintPip() { for (const fn of pipPaints) fn(); }

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

  /**
   * 原生把播放收回网页时调它（见 WebActivity.onResume）：
   *   · 后台自动播到了**别的**剧集 ⇒ 网页跟着跳到那一条（用户 2026-09-26 报障：
   *     后台听到 F 了，回前台却又回到最早的 A）；
   *   · 还是同一条 ⇒ 就地 seek 回去接着播。
   * 返回 true = 认领成功；false = 这一条不在网页当前列表里（原生据此如实提示，不假装成功）。
   */
  const resumeNative = (mediaId, positionMs) => {
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
  // App（WebView）回到前台时由原生调它：WebView 设了 mediaPlaybackRequiresUserGesture=false，
  // 只要页面可见就该有声 ⇒ 那次"被浏览器策略摁成的静音"可以自动恢复，用户不用再点一下喇叭。
  // 网页端没有这个口（那种情况下浏览器一定要用户手势，只能由用户点）。
  const soundNudge = () => {
    if (!state.soundBlocked || !state.soundOn) return false;
    clearSoundBlocked();
    return true;
  };

  return { tvNativePlay, tvNeedsNative, brokenCard, paintPip, onPipMode, soundNudge, resumeNative,
    togglePip, toggleCast };
}
