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
  const count = el("span", { class: "muted small-note", dataset: { role: "series-count" } });
  const tabsNav = el("nav", { class: "tabs", dataset: { role: "series-tabs" } });
  const body = el("div", { dataset: { role: "series-body" } });
  view.append(el("div", { class: "page" },
    el("div", { class: "page-head" }, el("h2", { class: "page-title", text: "剧场" }), count),
    tabsNav, note, body));

  let list = [];
  let current = "watching";  // watching（默认最前）| all | done | category
  let currentLib = "";       // 分类板块里选中的媒体库

  async function load() {
    clear(body);
    count.hidden = true;
    body.append(el("div", { class: "muted", text: "加载中…" }));
    try {
      const data = await api.request("GET", "/api/v1/series");
      list = asArray(data && data.list);
    } catch (err) {
      clear(body);
      setBanner(note, err && err.message ? err.message : "加载失败");
      return;
    }
    renderTabs();
    render();
  }

  // 用户 2026-09-24（第二次澄清）：这四个是**平级**页签，且「观看中」排最前
  // （原话："这 4 个选项应该是平级的，现在你把观看中单独放在其余 3 个的下面了"）。
  function renderTabs() {
    clear(tabsNav);
    const defs = [["watching", "观看中"], ["all", "所有内容"], ["done", "已看完"], ["category", "分类"]];
    for (const [key, label] of defs) {
      tabsNav.append(el("button", {
        class: "tab" + (key === current ? " on" : ""), type: "button", text: label,
        dataset: { role: "series-tab", tab: key },
        onclick: () => { current = key; renderTabs(); render(); },
      }));
    }
  }

  // 观看中 = 有进度但**没全看完**；已看完 = 每一集都看完（completed_count 由后端按当前用户聚合）
  // 用户 2026-09-23 的语义：看完的剧如果又打开某一集、没看完就退出，那集 completed 会被改回 0
  // ⇒ 它自动回到「观看中」（进度上报天然做到，前端不需要特殊逻辑）。
  function watching() {
    return list.filter((it) => {
      const total = Number(it.episode_count) || 0;
      const seen = Number(it.watched_count) || 0;
      const done = Number(it.completed_count) || 0;
      return seen > 0 && !(total > 0 && done >= total);
    });
  }

  function finished() {
    return list.filter((it) => {
      const total = Number(it.episode_count) || 0;
      const done = Number(it.completed_count) || 0;
      return total > 0 && done >= total;
    });
  }

  function render() {
    clear(body);
    if (!list.length) {
      count.hidden = true;
      body.append(el("div", { class: "muted", text: "还没有短剧：先在后台建一个「短剧库」，把每部剧放成库下的一个目录" }));
      return;
    }
    count.hidden = false;
    if (current === "watching") {
      const items = watching();
      count.textContent = items.length + " 个在追";
      if (!items.length) {
        body.append(el("div", { class: "muted", text: "还没有在追的剧场" }));
        return;
      }
      body.append(posterGrid(items, { progress: true }));
      return;
    }
    if (current === "done") {
      const items = finished();
      count.textContent = items.length + " 个已看完";
      body.append(items.length ? posterGrid(items, { finished: true }) : el("div", { class: "muted", text: "还没有看完的剧场" }));
      return;
    }
    if (current === "category") {
      const libs = [];
      for (const it of list) {
        const id = it.library_id || "";
        if (!libs.some((l) => l.id === id)) libs.push({ id, name: it.library_name || it.library_id || "未指定媒体库" });
      }
      count.textContent = list.length + " 个剧场 · " + libs.length + " 个库";
      const bar = el("nav", { class: "tabs", dataset: { role: "series-libs" } });
      if (!currentLib && libs.length) currentLib = libs[0].id;
      for (const lib of libs) {
        bar.append(el("button", {
          class: "tab" + (lib.id === currentLib ? " on" : ""), type: "button", text: lib.name,
          dataset: { role: "series-lib", id: lib.id },
          onclick: () => { currentLib = lib.id; render(); },
        }));
      }
      body.append(bar);
      const items = list.filter((it) => (it.library_id || "") === currentLib);
      body.append(items.length ? posterGrid(items, {}) : el("div", { class: "muted", text: "这个短剧库里还没有剧" }));
      return;
    }
    // 所有内容（不再往里塞"观看中"板块：四个页签平级）
    count.textContent = "共：" + list.length + " 个剧场";
    body.append(posterGrid(list, {}));
  }

  load();
}

function posterGrid(items, opts) {
  const grid = el("div", { class: "series-grid" });
  for (const item of items) grid.append(seriesPoster(item, opts));
  return grid;
}

// 抖音式竖版海报卡（用户 2026-09-22）：封面铺满、底部压两行标题、右上角集数徽标。
// 没封面时不留破图：灰底 + "无封面"。
// opts.progress（用户 2026-09-23）：观看中板块要**在海报上直接给播放按钮 + 观看进度**，点一下接着看。
function seriesPoster(item, opts) {
  const options = opts || {};
  const cover = item.cover_url
    ? el("img", { src: item.cover_url, alt: "", loading: "lazy" })
    : el("div", { class: "no-cover", text: "无封面" });
  const total = Number(item.episode_count) || 0;
  const seen = Number(item.watched_count) || 0;
  const pct = total > 0 ? Math.max(0, Math.min(100, Math.round((seen / total) * 100))) : 0;
  const card = el("a", {
    class: "series-poster", href: "#/series/" + encodeURIComponent(item.id),
    dataset: { role: "series-card", id: String(item.id) },
    title: item.title || "-",
  }, cover,
    el("span", { class: "poster-count", text: total + " 集" }),
    options.progress ? el("span", { class: "poster-play", text: "▶" }) : null,
    options.progress && seen > 0
      ? el("span", { class: "poster-progress" }, el("span", { style: { width: pct + "%" } }))
      : null,
    options.progress && seen > 0
      ? el("span", { class: "poster-seen", text: "看到 " + seen + "/" + total + " 集" })
      : null,
    options.finished && total > 0
      ? el("span", { class: "poster-seen done", text: "全 " + total + " 集看完" })
      : null,
    el("div", { class: "poster-mask" },
      el("div", { class: "poster-name", text: item.title || "-" })));
  return card;
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
        // 用户 2026-09-24：播放页要能"一键回剧场"（图3 的「合集 · … 更新至 N 集 >」）
        seriesId: seriesID,
        episodeCount: items.length,
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
