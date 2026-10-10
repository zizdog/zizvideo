// 媒体目录页签：允许根（从 admin.js 原样搬家，行为不变）

import { api } from "./api.js";
import { el, clear, banner, setBanner, field, input } from "./dom.js";
import { openDirectoryPicker } from "./roots.js";
import { confirmDialog } from "./confirm.js";
import { button, rowOf, emptyRow, gridOf } from "./admin-shared.js";

/* ---------- 媒体允许根 ---------- */

export function mountRoots(root) {
  const note = banner();
  const { table, body } = gridOf(["允许根", "状态", "被哪些库使用", "操作"]);
  const newPath = input({ placeholder: "绝对路径，例如 /Users/你/Movies" });
  const addButton = el("button", { class: "btn primary", type: "submit", text: "添加" });
  const browseButton = button("浏览目录…", () => {
    openDirectoryPicker({
      start: newPath.value.trim() || "/",
      roots: () => roots || [],
      onVisited: (path) => { newPath.value = path; },
      onPicked: (path) => { newPath.value = path; },
      onRootsChanged: refresh,
    });
  });
  const form = el("form", { class: "panel" },
    el("div", { class: "row" }, field("允许根目录", newPath), browseButton, addButton),
    el("div", { class: "muted small-note", text: "改动直接写回 config.json；环境变量 ZV_MEDIA_ALLOW_ROOTS 覆盖时不生效。" }),
    note);
  let roots = [];

  function stateText(item) {
    if (item && item.status === "ok") return "可读";
    if (item && item.status === "unavailable") return item.note || "不可用";
    if (!item.exists) return "不可用（路径不存在）";
    if (!item.is_dir) return "不是目录";
    if (!item.readable) return "不可读";
    return "可读";
  }

  async function remove(item) {
    // 见 renameGroup 的说明：确认框一律用项目自己的（App/电视上原生 confirm 恒假）
    const okDel = await confirmDialog({
      title: "删除允许根「" + item.path + "」",
      message: "只是从这个列表里移除，磁盘上的文件不会删。",
      confirmText: "移除",
    });
    if (!okDel) return;
    setBanner(note, "");
    try {
      await api.removeMediaRoot(item.path);
      await refresh();
    } catch (err) {
      setBanner(note, err && err.message ? err.message : "删除失败");
    }
  }

  async function refresh() {
    setBanner(note, "");
    try {
      const data = await api.mediaRoots();
      const list = data && Array.isArray(data.roots) ? data.roots : [];
      roots = list.map((item) => item.path);
      clear(body);
      if (!list.length) body.append(emptyRow(4, "暂无允许根"));
      for (const item of list) {
        body.append(rowOf([
          item.path,
          stateText(item),
          item.in_use ? (item.libraries || 0) + " 个" : "-",
          button("删除", () => remove(item), "danger"),
        ]));
      }
      if (data && data.env_override) {
        setBanner(note, "ZV_MEDIA_ALLOW_ROOTS 已覆盖，配置改动不生效");
      } else {
        // 脱机的旧根要能看见、能删、如实标注，不阻塞整页。
        const bad = list.filter((item) => item.status === "unavailable");
        if (bad.length) setBanner(note, bad.length + " 条允许根不可用（外接盘拔了？），可直接删除");
      }
    } catch (err) {
      setBanner(note, err && err.message ? err.message : "加载失败");
    }
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const path = newPath.value.trim();
    if (!path) return;
    setBanner(note, "");
    addButton.disabled = true;
    try {
      await api.addMediaRoot(path);
      newPath.value = "";
      await refresh();
    } catch (err) {
      setBanner(note, err && err.message ? err.message : "添加失败");
    } finally {
      addButton.disabled = false;
    }
  });

  root.append(form, table);
  refresh();
}
