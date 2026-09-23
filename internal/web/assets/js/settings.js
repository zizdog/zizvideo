// 设置页（我的 → 设置）：播放设置**复用首页 ⚙ 那一份控件**与同一个 PATCH /api/v1/feed/settings，
// 不另写一套表单（用户 2026-09-23：入口收进「我的」，顶部不再显示任何东西）。

import { el, banner, setBanner } from "./dom.js";
import { api } from "./api.js";
import { createFeedSettingsForm, normalizeFeedSettings } from "./play-settings.js";

export function mountSettings(view) {
  const note = banner();
  const box = el("div", { class: "panel" });
  view.append(el("div", { class: "page" },
    el("div", { class: "page-head" }, el("h2", { class: "page-title", text: "设置" })),
    note, box));
  let form = null;
  api.feedSettings().then((data) => {
    form = createFeedSettingsForm({
      settings: normalizeFeedSettings(data),
      onChange: async (partial) => {
        setBanner(note, "");
        try {
          const saved = await api.patchFeedSettings(partial);
          if (saved && form) form.paint(normalizeFeedSettings(saved));
        } catch (err) {
          setBanner(note, err && err.message ? err.message : "保存失败");
        }
      },
    });
    box.append(el("div", { class: "panel-title", text: "播放" }), form.node);
  }).catch((err) => {
    setBanner(note, err && err.message ? err.message : "加载失败");
  });
  return null;
}
