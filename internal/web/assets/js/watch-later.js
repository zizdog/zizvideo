// 稍后再看：「我的」里的入口页（用户 2026-09-22 要求）。
// 只有一类记录，所以不复用收藏页的 Tab，但共用同一份行渲染（favorites.js 的 recordRow）。

import { api } from "./api.js";
import { el, clear, banner, setBanner } from "./dom.js";
import { confirmDialog } from "./confirm.js";
import { recordRow } from "./favorites.js";

export function mountWatchLater(view) {
  const note = banner();
  const listBox = el("div", { class: "fav-list", dataset: { role: "watch-later-list" } });
  const status = el("div", { class: "muted small-note", dataset: { role: "clear-status" } });
  const clearBtn = el("button", {
    class: "btn danger small", type: "button", text: "清除记录", dataset: { role: "clear-records" },
  });

  view.append(el("div", { class: "page" },
    el("div", { class: "page-head" },
      el("h2", { class: "page-title", text: "稍后再看" }), clearBtn),
    note, status, listBox));

  async function load() {
    clear(listBox);
    listBox.append(el("div", { class: "muted", text: "加载中…" }));
    let items = [];
    try {
      const data = await api.watchLater();
      const raw = data && Array.isArray(data.list) ? data.list : [];
      items = raw.map((media) => ({ media: media || {}, progress: (media && media.progress) || {} }));
    } catch (err) {
      clear(listBox);
      setBanner(note, err && err.message ? err.message : "加载失败");
      return;
    }
    clear(listBox);
    if (!items.length) {
      listBox.append(el("div", { class: "muted", text: "还没有稍后再看的视频" }));
      return;
    }
    for (const item of items) listBox.append(recordRow({ key: "watch-later" }, item));
  }

  clearBtn.addEventListener("click", async () => {
    const count = listBox.querySelectorAll(".fav-row").length;
    const ok = await confirmDialog({
      title: "清除稍后再看记录",
      message: "将清除全部 " + count + " 条稍后再看记录。只清除记录，不删除视频文件。",
      confirmText: "确认清除",
    });
    if (!ok) return;
    clearBtn.disabled = true;
    try {
      const data = await api.clearWatchLater();
      // 条数以后端返回为准，不拿本地列表凑数。
      const cleared = data && typeof data.cleared === "number" ? data.cleared : 0;
      status.textContent = cleared > 0
        ? ("已清除 " + cleared + " 条稍后再看记录")
        : "没有可清除的稍后再看记录";
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
