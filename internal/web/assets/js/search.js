// 搜索页：标题/路径关键词搜（后端 GET /api/v1/media?q=…，与后台媒体列表同一个筛选）。
// 结果用共用卡片（cards.js 的 videoGrid）渲染，点开走共用播放器（#/play/search/<id>，可左右滑动看下一条）。

import { el, banner, setBanner } from "./dom.js";
import { api } from "./api.js";
import { RECORD_LISTS, videoGrid, setSearchResults } from "./cards.js";

export function mountSearch(view, query) {
  const q = (query || "").trim();
  const input = el("input", { class: "input", type: "search", placeholder: "搜标题或路径", value: q });
  const submit = el("button", { class: "btn primary", type: "submit", text: "搜索" });
  const form = el("form", { class: "search-bar", dataset: { role: "search-form" } }, input, submit);
  const note = banner();
  const results = el("div", { class: "video-grid", dataset: { role: "search-results" } });
  view.append(el("div", { class: "page" },
    el("div", { class: "page-head" }, el("h2", { class: "page-title", text: "搜索" })),
    form, note, results));

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const next = input.value.trim();
    location.hash = next ? ("#/search/" + encodeURIComponent(next)) : "#/search";
  });

  if (!q) {
    setSearchResults([]);
    results.append(el("div", { class: "muted", text: "输入关键词，搜标题或路径" }));
    input.focus();
    return null;
  }
  api.request("GET", "/api/v1/media?per_page=100&q=" + encodeURIComponent(q)).then((data) => {
    const items = (data && Array.isArray(data.list) ? data.list : []).filter(Boolean);
    setSearchResults(items); // 让 #/play/search/<id> 能把这批结果当播放列表
    if (!items.length) {
      results.append(el("div", { class: "muted", text: "没有匹配「" + q + "」的视频" }));
      return;
    }
    results.append(videoGrid(items, { kind: "search", list: RECORD_LISTS.search, role: "search-results" }));
  }).catch((err) => {
    setBanner(note, err && err.message ? err.message : "搜索失败");
  });
  return null;
}
