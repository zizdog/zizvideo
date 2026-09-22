// 剧场（短剧）：列表 + 播放页。
// 播放页**直接复用首页播放器**（feed.js 的 playlist 模式）—— 全站只有一份播放实现：
// 手势（含"一次手势只走一格"的闸门）、右下图标栏、进度上报、静音偏好、
// 收藏/喜欢/稍后再看/删除 全部取自首页；剧场只多「选集」、自动连播（不可设置）
// 和"播完最后一集停止"。顺序由后端 position 决定；观看面只负责看与播，
// 新建/导入/识别/上传等管理都在后台（#/admin/series）。

import { api } from "./api.js";
import { mountFeed } from "./feed.js";
import { el, clear, banner, setBanner, asArray } from "./dom.js";

/* ---------- 剧场列表 ---------- */

export function mountSeries(view) {
  const note = banner();
  const box = el("div", { class: "series-grid", dataset: { role: "series-list" } });
  const count = el("span", { class: "muted small-note", dataset: { role: "series-count" } });
  const head = el("div", { class: "page-head" },
    el("h2", { class: "page-title", text: "剧场" }), count);
  view.append(el("div", { class: "page" }, head, note, box));

  async function load() {
    clear(box);
    count.hidden = true;
    box.append(el("div", { class: "muted", text: "加载中…" }));
    let list = [];
    try {
      const data = await api.request("GET", "/api/v1/series");
      list = data && Array.isArray(data.list) ? data.list : [];
    } catch (err) {
      clear(box);
      setBanner(note, err && err.message ? err.message : "加载失败");
      return;
    }
    clear(box);
    if (!list.length) {
      count.hidden = true;
      box.append(el("div", { class: "muted", text: "还没有剧场" }));
      return;
    }
    count.textContent = list.length + " 个剧场";
    count.hidden = false;
    for (const item of list) box.append(seriesPoster(item));
  }

  load();
}

// 抖音式竖版海报卡（用户 2026-09-22）：封面铺满、底部压两行标题、右上角集数徽标。
// 没封面时不留破图：灰底 + "无封面"。
function seriesPoster(item) {
  const cover = item.cover_url
    ? el("img", { src: item.cover_url, alt: "", loading: "lazy" })
    : el("div", { class: "no-cover", text: "无封面" });
  return el("a", {
    class: "series-poster", href: "#/series/" + encodeURIComponent(item.id),
    dataset: { role: "series-card", id: String(item.id) },
    title: item.title || "-",
  }, cover,
    el("span", { class: "poster-count", text: (item.episode_count || 0) + " 集" }),
    el("div", { class: "poster-mask" },
      el("div", { class: "poster-name", text: item.title || "-" })));
}

/* ---------- 剧场播放页（按序连播） ---------- */

/* ---------- 剧场播放页：直接复用首页那套播放器（唯一一份） ---------- */
//
// 用户 2026-09-22 明确要求："剧场播放界面逻辑直接利用首页就行"，不许两套实现。
// 所以这里只做三件事：取剧集数据 → 交给 mountFeed 的播放列表模式 → 返回它的清理函数。
// 差异只在 mountFeed 内部的 playlist 分支里：自动连播（不可设置）、播完最后一集停止、
// 多一个「选集」；手势/图标栏/进度/收藏/静音偏好与首页**同一份代码**。

export function mountSeriesPlay(view, seriesID) {
  const box = el("div", { class: "page" });
  view.append(box);
  let cleanup = null;
  let cancelled = false;

  api.request("GET", "/api/v1/series/" + encodeURIComponent(seriesID)).then((data) => {
    if (cancelled) return;
    const raw = data && Array.isArray(data.list) ? data.list : [];
    const items = raw.map((entry) => {
      const item = entry.media || {};
      item.episode_label = entry.episode_label || "";
      item.episode_source = entry.episode_source || "";
      return item;
    }).filter(Boolean);
    const title = (data && data.series && data.series.title) || "剧场";
    if (!items.length) {
      // 空剧场不留空白页：沿用后端给的"下一步做什么"提示。
      const guide = (data && data.guide) || {};
      const steps = asArray(guide.steps);
      const STEP_LABELS = { import_dir: "从目录导入", upload: "上传", batch: "批量建" };
      box.append(el("div", { class: "panel guide-box", dataset: { role: "series-empty-guide" } },
        el("div", { class: "panel-title", text: guide.title || "这个剧场还没有剧集" }),
        el("div", { class: "muted small-note", text: guide.where || "文件放在某个媒体库目录的子文件夹里" }),
        el("div", { class: "muted small-note", text: guide.naming || "" }),
        el("div", { class: "muted small-note", text: guide.naming_note || "" }),
        ...steps.map((step) => el("div", { class: "guide-step" },
          el("span", { class: "guide-key", text: STEP_LABELS[step.key] || step.key || "步骤" }),
          el("span", { class: "ep-title", text: step.text || "" }))),
        el("div", { class: "actions" },
          el("a", { class: "btn small", href: "#/series", text: "← 返回剧场列表" }))));
      return;
    }
    const unrecognized = items.filter((item) => item.episode_label === "未识别").length;
    cleanup = mountFeed(box, {
      playlist: {
        title,
        items,
        note: unrecognized > 0 ? ("未识别（按文件名排）共 " + unrecognized + " 集") : "",
      },
    });
  }).catch((err) => {
    if (cancelled) return;
    clear(box);
    box.append(el("div", { class: "card info", text: err && err.message ? err.message : "加载失败" }));
  });

  return function cleanupSeriesPlay() {
    cancelled = true;
    if (cleanup) cleanup();
  };
}
