// 稍后再看：卡片网格（用户 2026-09-22："不要一整行，要卡片"）。
// 点卡片 = 用**首页那套播放器**按"稍后再看"列表连播（从点到的那条开始）；
// 播放逻辑不在这里复制一份（唯一实现见 feed.js 的 playlist 模式）。

import { api } from "./api.js";
import { el, clear, banner, setBanner, fmtDuration } from "./dom.js";
import { confirmDialog } from "./confirm.js";
import { mountFeed } from "./feed.js";

const EMPTY = "还没有稍后再看的视频";

function videoCard(item) {
  const cover = item.cover_url
    ? el("img", { src: item.cover_url, alt: "", loading: "lazy" })
    : el("div", { class: "no-cover", text: "无封面" });
  const progress = item.progress || {};
  const duration = Number(item.duration_ms) || 0;
  const pct = duration > 0
    ? Math.max(0, Math.min(100, Math.round(((Number(progress.position_ms) || 0) / duration) * 100)))
    : 0;
  return el("a", {
    class: "video-card", href: "#/later/" + encodeURIComponent(item.id),
    dataset: { role: "later-card", id: String(item.id) },
    title: item.title || ("#" + item.id),
  },
    el("div", { class: "video-cover" }, cover,
      el("span", { class: "video-badge", text: progress.completed ? "已看完" : fmtDuration(duration) }),
      pct > 0 && !progress.completed ? el("span", { class: "video-progress", style: { width: pct + "%" } }) : null),
    el("div", { class: "video-title", text: item.title || ("#" + item.id) }));
}

export function mountWatchLater(view) {
  const note = banner();
  const grid = el("div", { class: "video-grid", dataset: { role: "watch-later-list" } });
  const status = el("div", { class: "muted small-note", dataset: { role: "clear-status" } });
  const count = el("span", { class: "muted small-note", dataset: { role: "watch-later-count" } });
  const clearBtn = el("button", {
    class: "btn danger small", type: "button", text: "清除记录", dataset: { role: "clear-records" },
  });

  view.append(el("div", { class: "page" },
    el("div", { class: "page-head" },
      el("h2", { class: "page-title", text: "稍后再看" }), count, clearBtn),
    note, status, grid));

  async function load() {
    clear(grid);
    grid.append(el("div", { class: "muted", text: "加载中…" }));
    let items = [];
    try {
      const data = await api.watchLater();
      items = (data && Array.isArray(data.list) ? data.list : []).filter(Boolean);
    } catch (err) {
      clear(grid);
      setBanner(note, err && err.message ? err.message : "加载失败");
      return;
    }
    clear(grid);
    count.textContent = items.length ? (items.length + " 个") : "";
    clearBtn.hidden = !items.length;
    if (!items.length) {
      grid.append(el("div", { class: "muted", text: EMPTY }));
      return;
    }
    for (const item of items) grid.append(videoCard(item));
  }

  clearBtn.addEventListener("click", async () => {
    const n = grid.querySelectorAll(".video-card").length;
    const ok = await confirmDialog({
      title: "清除稍后再看记录",
      message: "将清除全部 " + n + " 条稍后再看记录。只清除记录，不删除视频文件。",
      confirmText: "确认清除",
    });
    if (!ok) return;
    clearBtn.disabled = true;
    try {
      const data = await api.clearWatchLater();
      const cleared = data && typeof data.cleared === "number" ? data.cleared : 0;
      status.textContent = cleared > 0 ? ("已清除 " + cleared + " 条稍后再看记录") : "没有可清除的稍后再看记录";
      setBanner(note, "");
      await load();
    } catch (err) {
      setBanner(note, err && err.message ? err.message : "清除失败");
    } finally {
      clearBtn.disabled = false;
    }
  });

  load();
  return null;
}

// 点卡片后的播放页：把"稍后再看"当成播放列表交给唯一那份播放器（从 mediaId 开始）。
export function mountWatchLaterPlay(view, mediaId) {
  const box = el("div", { class: "page" });
  view.append(box);
  let cleanup = null;
  let cancelled = false;
  api.watchLater().then((data) => {
    if (cancelled) return;
    const items = (data && Array.isArray(data.list) ? data.list : []).filter(Boolean);
    if (!items.length) {
      box.append(el("div", { class: "card info", text: EMPTY }));
      return;
    }
    cleanup = mountFeed(box, {
      playlist: { title: "稍后再看", items, startId: mediaId, navKey: "me" },
    });
  }).catch((err) => {
    if (cancelled) return;
    clear(box);
    box.append(el("div", { class: "card info", text: err && err.message ? err.message : "加载失败" }));
  });
  return function cleanupWatchLaterPlay() {
    cancelled = true;
    if (cleanup) cleanup();
  };
}
