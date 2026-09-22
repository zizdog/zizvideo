// 稍后再看：单列表页（卡片网格，与 点赞/收藏/历史 共用 cards.js 那一套）+ 点卡片连播。

import { el, clear, banner, setBanner } from "./dom.js";
import { confirmDialog } from "./confirm.js";
import { RECORD_LISTS, videoGrid, mountRecordPlay } from "./cards.js";

const DEF = RECORD_LISTS.later;

export function mountWatchLater(view) {
  const note = banner();
  const listBox = el("div");
  const status = el("div", { class: "muted small-note", dataset: { role: "clear-status" } });
  const count = el("span", { class: "muted small-note", dataset: { role: "watch-later-count" } });
  const clearBtn = el("button", {
    class: "btn danger small", type: "button", text: "清除记录", dataset: { role: "clear-records" },
  });

  view.append(el("div", { class: "page" },
    el("div", { class: "page-head" },
      el("h2", { class: "page-title", text: DEF.label }), count, clearBtn),
    note, status, listBox));

  async function load() {
    clear(listBox);
    listBox.append(el("div", { class: "muted", text: "加载中…" }));
    let items = [];
    try {
      items = (await DEF.load()).filter(Boolean);
    } catch (err) {
      clear(listBox);
      setBanner(note, err && err.message ? err.message : "加载失败");
      return;
    }
    clear(listBox);
    count.textContent = items.length ? (items.length + " 个") : "";
    clearBtn.hidden = !items.length;
    listBox.append(videoGrid(items, { kind: "later", list: DEF, role: "watch-later-list" }));
  }

  clearBtn.addEventListener("click", async () => {
    const n = listBox.querySelectorAll(".video-card").length;
    const ok = await confirmDialog({
      title: "清除稍后再看记录",
      message: "将清除全部 " + n + " 条稍后再看记录。" + DEF.clearHint,
      confirmText: "确认清除",
    });
    if (!ok) return;
    clearBtn.disabled = true;
    try {
      const data = await DEF.clear();
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

// 点卡片后的播放：交给 cards.js 的通用实现（唯一那份播放器）。
export function mountWatchLaterPlay(view, mediaId) {
  return mountRecordPlay(view, "later", mediaId);
}
