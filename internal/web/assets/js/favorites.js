// 记录页：点赞 / 收藏 / 稍后再看 / 历史 四个 Tab（用户 2026-09-22：稍后再看也并进收藏面板，
// 全部用同一套卡片，风格统一）。
// 卡片渲染与"点卡片连播"都在 cards.js，一页一套的实现已经删掉。

import { el, clear, banner, setBanner } from "./dom.js";
import { confirmDialog } from "./confirm.js";
import { RECORD_LISTS, videoGrid } from "./cards.js";

const TAB_KEYS = ["likes", "favorites", "later", "history"];

// initialKey 支持 #/favorites/later 这样的深链（「我的」里的稍后再看就指向它）。
export function mountFavorites(view, initialKey) {
  const note = banner();
  const tabsNav = el("nav", { class: "tabs", dataset: { role: "fav-tabs" } });
  const listBox = el("div", { dataset: { role: "fav-list" } });
  const status = el("div", { class: "muted small-note", dataset: { role: "clear-status" } });
  const count = el("span", { class: "muted small-note", dataset: { role: "fav-count" } });
  const clearBtn = el("button", {
    class: "btn danger small", type: "button", text: "清除记录", dataset: { role: "clear-records" },
  });
  const buttons = new Map();
  let currentKey = TAB_KEYS.includes(initialKey) ? initialKey : TAB_KEYS[0];

  view.append(el("div", { class: "page" },
    el("div", { class: "page-head" },
      el("h2", { class: "page-title", text: "收藏" }), count, clearBtn),
    tabsNav, note, status, listBox));

  for (const key of TAB_KEYS) {
    const def = RECORD_LISTS[key];
    const button = el("button", {
      class: "tab", type: "button", text: def.label, dataset: { role: "fav-tab", tab: key },
      onclick: () => select(key),
    });
    buttons.set(key, button);
    tabsNav.append(button);
  }

  function select(key) {
    currentKey = key;
    for (const [k, node] of buttons) node.classList.toggle("on", k === key);
    // 地址栏跟着 Tab 走（可收藏、刷新后还停在这个 Tab），但不触发 hashchange ⇒ 不重新挂载整页。
    history.replaceState(null, "", "#/favorites/" + key);
    clearBtn.dataset.tab = key;
    setBanner(note, "");
    status.textContent = "";
    load();
  }

  async function load() {
    const def = RECORD_LISTS[currentKey];
    clear(listBox);
    listBox.append(el("div", { class: "muted", text: "加载中…" }));
    let items = [];
    try {
      items = (await def.load()).filter(Boolean);
    } catch (err) {
      clear(listBox);
      setBanner(note, err && err.message ? err.message : "加载失败");
      return;
    }
    clear(listBox);
    count.textContent = items.length ? (items.length + " 个") : "";
    clearBtn.hidden = !items.length;
    listBox.append(videoGrid(items, { kind: currentKey, list: def, role: "fav-list" }));
  }

  clearBtn.addEventListener("click", async () => {
    const def = RECORD_LISTS[currentKey];
    const n = listBox.querySelectorAll(".video-card").length;
    const ok = await confirmDialog({
      title: "清除" + def.label + "记录",
      message: "将清除全部 " + n + " 条" + def.label + "记录。" + def.clearHint,
      confirmText: "确认清除",
    });
    if (!ok) return;
    clearBtn.disabled = true;
    try {
      const data = await def.clear();
      const cleared = data && typeof data.cleared === "number" ? data.cleared : 0;
      status.textContent = cleared > 0
        ? ("已清除 " + cleared + " 条" + def.label + "记录")
        : ("没有可清除的" + def.label + "记录");
      setBanner(note, "");
      await load();
    } catch (err) {
      setBanner(note, err && err.message ? err.message : "清除失败");
    } finally {
      clearBtn.disabled = false;
    }
  });

  select(currentKey);
  return null;
}
