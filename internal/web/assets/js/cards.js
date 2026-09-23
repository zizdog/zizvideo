// 统一的"视频卡片 + 记录列表播放"组件（用户 2026-09-22：四个列表必须风格统一，不许一页一套）。
// 谁要渲染"一组视频"，都用这里的 videoGrid/videoCard；谁要"把某个记录列表当播放列表播放"，
// 都用 mountRecordPlay —— 播放本身仍然只有 feed.js 一份实现。

import { el, fmtDuration } from "./dom.js";
import { api } from "./api.js";
import { mountFeed, createMediaVideo } from "./feed.js";

// RECORD_LISTS 是"记录类列表"的唯一定义：标签/空文案/加载/清除/底栏高亮，四处共用。
export const RECORD_LISTS = {
  likes: {
    label: "点赞", empty: "还没有点赞过的视频", clearHint: "只清除点赞记录，不删除视频文件。",
    navKey: "favorites",
    load: async () => (await api.request("GET", "/api/v1/me/likes")).list || [],
    clear: () => api.request("DELETE", "/api/v1/me/likes"),
  },
  favorites: {
    label: "收藏", empty: "还没有收藏的视频", clearHint: "只清除收藏记录，不删除视频文件。",
    navKey: "favorites",
    load: async () => (await api.request("GET", "/api/v1/me/favorites")).list || [],
    clear: () => api.request("DELETE", "/api/v1/me/favorites"),
  },
  history: {
    label: "历史", empty: "还没有观看记录", clearHint: "只清除观看历史，不删除视频文件。",
    navKey: "favorites", badge: "progress",
    // /me/progress 的形状是 {position_ms,…,media}：拍平成 media + progress，卡片才统一
    load: async () => ((await api.myProgress()).list || [])
      .map((e) => Object.assign({}, (e && e.media) || {}, {
        progress: { position_ms: e.position_ms, duration_ms: e.duration_ms, completed: e.completed },
      })),
    clear: () => api.request("DELETE", "/api/v1/me/progress"),
  },
  later: {
    label: "稍后再看", empty: "还没有稍后再看的视频", clearHint: "只清除记录，不删除视频文件。",
    navKey: "favorites", // 稍后再看已并入收藏面板（2026-09-22）
    load: async () => (await api.watchLater()).list || [],
    clear: () => api.clearWatchLater(),
  },
};

// videoCard：16:9 封面 + 角标（时长/已看完/看到几分）+ 观看进度条 + 两行标题。
// options 可覆盖：href（链接目标）、badge（角标文本）、leading（封面左上角节点，如勾选框）、
// meta（标题下的补充行，管理端"去重预览"要用：媒体库/大小/路径…）。
export function videoCard(item, options) {
  const opts = options || {};
  const list = opts.list || null;
  const progress = item.progress || {};
  const duration = Number(item.duration_ms) || 0;
  const position = Number(progress.position_ms) || 0;
  const pct = duration > 0 ? Math.max(0, Math.min(100, Math.round((position / duration) * 100))) : 0;
  let badge;
  if (progress.completed) badge = "已看完";
  else if (list && list.badge === "progress" && position > 0) badge = fmtDuration(position) + "/" + fmtDuration(duration);
  else badge = fmtDuration(duration);
  if (typeof opts.badge === "string" && opts.badge) badge = opts.badge;
  const href = opts.href || (list ? ("#/play/" + encodeURIComponent(list.key) + "/" + encodeURIComponent(item.id)) : "#/feed");
  const cover = item.cover_url
    ? el("img", { src: item.cover_url, alt: "", loading: "lazy" })
    : el("div", { class: "no-cover", text: "无封面" });
  const coverBox = el("div", { class: "video-cover" }, cover,
    el("span", { class: "video-badge", text: badge }),
    pct > 0 && !progress.completed ? el("span", { class: "video-progress", style: { width: pct + "%" } }) : null);
  const titleNode = el("div", { class: "video-title", text: item.title || ("#" + item.id) });
  // 封面+标题放进可点区域；勾选框（leading）挂在**它外面**（同一张卡片的兄弟节点）。
  // 为什么不能让勾选框当 <a> 的子元素：点它会连带触发链接跳转；而 preventDefault 又会
  // 把"切换选中"这个默认动作一起取消 —— 实测"勾选框点不动"就是这么来的。
  // playInline=true 时不是链接而是就地播放（管理端"去重"要对着同一屏逐个看，不许跳页放大）。
  const link = opts.playInline
    ? el("div", { class: "video-open inline-play", role: "button", tabindex: "0",
        title: "点封面就地播放，再点收起" }, coverBox, titleNode)
    : el("a", { class: "video-open", href, title: item.title || ("#" + item.id) }, coverBox, titleNode);
  const card = el("div", {
    class: "video-card", dataset: { role: "video-card", id: String(item.id) },
  }, link);
  if (opts.playInline && item.missing !== true && item.file_exists !== false) attachInlinePlay(link, coverBox, item);
  if (opts.leading) card.append(el("span", { class: "video-lead" }, opts.leading));
  // meta 行（媒体库/大小/路径…，管理端"去重预览"用）收在一个容器里，便于样式化
  if (opts.meta && opts.meta.length) {
    const box = el("div", { class: "video-meta" });
    for (const line of opts.meta) box.append(line instanceof Node ? line : el("div", { text: String(line) }));
    card.append(box);
  }
  return card;
}

// videoGrid：一组视频 → 卡片网格（四个列表共用同一套 DOM 与样式）。
export function videoGrid(items, options) {
  const opts = options || {};
  const list = opts.list ? Object.assign({ key: opts.kind || "" }, opts.list) : null;
  const grid = el("div", { class: "video-grid", dataset: { role: opts.role || "video-grid" } });
  if (!items || !items.length) {
    grid.append(el("div", { class: "muted", text: (opts.list && opts.list.empty) || "还没有视频" }));
    return grid;
  }
  for (const item of items) grid.append(videoCard(item, { list }));
  return grid;
}

// mountRecordPlay：点卡片后的播放页 —— 把该记录列表交给唯一那份播放器（从 mediaId 开始）。
export function mountRecordPlay(view, kind, mediaId) {
  const list = RECORD_LISTS[kind];
  const box = el("div", { class: "page" });
  view.append(box);
  if (!list) {
    box.append(el("div", { class: "card info", text: "未知的记录类型：" + String(kind) }));
    return null;
  }
  let cleanup = null;
  let cancelled = false;
  list.load().then((items) => {
    if (cancelled) return;
    // 文件已不在的记录不进连播队列（否则连播会撞到"这个视频放不了 状态：ready"）；
    // 但用户**点名**点开的那一条要留着 —— 宁可如实报"放不了"，也不许悄悄跳到别的视频。
    const usable = (items || []).filter(Boolean)
      .filter((it) => !it.missing || String(it.id) === String(mediaId));
    if (!usable.length) {
      box.append(el("div", { class: "card info", text: list.empty }));
      return;
    }
    cleanup = mountFeed(box, {
      playlist: { title: list.label, items: usable, startId: mediaId, navKey: list.navKey },
    });
  }).catch((err) => {
    if (cancelled) return;
    box.append(el("div", { class: "card info", text: err && err.message ? err.message : "加载失败" }));
  });
  return function cleanupRecordPlay() {
    cancelled = true;
    if (cleanup) cleanup();
  };
}

// 卡片"就地播放"（管理端"去重"专用）：点封面把共享的 <video> 挂进这张卡的封面框里，
// 再点收起；同一屏同时只留一个在播（避免几路声音一起响）。播放器实现不在这里，见 feed.js。
const inlineStops = new Set();

// stopInlinePlayers 收掉页面上所有就地播放（路由切走/重新加载时调用，别让声音留着）。
export function stopInlinePlayers() {
  for (const stop of Array.from(inlineStops)) stop();
  inlineStops.clear();
}

function attachInlinePlay(opener, box, item) {
  let video = null;
  let stopBtn = null;
  const stop = () => {
    inlineStops.delete(stop);
    if (!video) return;
    video.pause();
    video.remove();
    video = null;
    if (stopBtn) { stopBtn.remove(); stopBtn = null; }
    box.classList.remove("playing");
  };
  const toggle = () => {
    if (video) { stop(); return; }
    stopInlinePlayers();
    video = createMediaVideo(item, { class: "card-video", controls: true });
    box.classList.add("playing");
    box.append(video);
    // 收起要有**明确**的按钮：视频自带控件会把点表面的点击吃掉（实测点第二下收不起来），
    // 所以点视频 = 原生播放/暂停，收起只认这个按钮（或点标题）。
    stopBtn = el("button", {
      class: "btn small inline-stop", type: "button", text: "✕ 收起",
      dataset: { role: "inline-stop" },
    });
    stopBtn.addEventListener("click", (event) => { event.stopPropagation(); stop(); });
    box.append(stopBtn);
    inlineStops.add(stop);
    const started = video.play();
    if (started && typeof started.catch === "function") started.catch(() => {}); // 被拒也不炸，控件还在
  };
  const fromChrome = (event) => !!(event.target && event.target.closest
    && event.target.closest("video, button, [data-role='inline-stop']"));
  opener.addEventListener("click", (event) => {
    if (video && fromChrome(event)) return; // 视频控件/收起按钮自己的点击不算"再点一次"
    event.preventDefault();
    toggle();
  });
  opener.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    if (fromChrome(event)) return;
    event.preventDefault();
    toggle();
  });
}
