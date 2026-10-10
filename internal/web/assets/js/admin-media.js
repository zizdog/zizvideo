// 散片管理页签：短视频库的媒体列表 / 清理缺失记录 / 转码（从 admin.js 原样搬家）

import { api } from "./api.js";
import { el, clear, banner, setBanner, input, fmtDuration, fmtBytes } from "./dom.js";
import { confirmDialog } from "./confirm.js";
import { button, rowOf, emptyRow, gridOf, selectFrom } from "./admin-shared.js";

/* ---------- 媒体 ---------- */

export function mountMedia(root) {
  const note = banner();
  const librarySelect = selectFrom([{ value: "", label: "全部媒体库" }]);
  const query = input({ placeholder: "标题关键词" });
  const statusSelect = selectFrom([
    { value: "", label: "全部状态" },
    { value: "ready", label: "ready" },
    { value: "probe_failed", label: "probe_failed" },
    { value: "missing", label: "missing" },
  ]);
  const info = el("div", { class: "muted" });
  const { table, body } = gridOf(["", "标题", "媒体库", "时长", "分辨率", "视频编码", "状态", "大小", "操作"]);
  // C8 批量转码：本页勾选（翻页/换筛选就清空，避免"选了看不见的条目"）
  const picked = new Set();
  const pickAll = el("input", { type: "checkbox", dataset: { role: "media-pick-all" }, title: "选中本页" });
  table.querySelector("thead th").append(pickAll);
  const pickCount = el("span", { class: "muted small-note", dataset: { role: "media-pick-count" }, text: "未选" });
  const batchBtn = el("button", {
    class: "btn small primary", type: "button", text: "转码所选",
    dataset: { role: "media-transcode-batch" }, disabled: true,
  });
  function paintPick() {
    pickCount.textContent = picked.size ? ("已选 " + picked.size + " 条") : "未选";
    batchBtn.disabled = picked.size === 0;
    batchBtn.textContent = picked.size ? ("转码所选（" + picked.size + "）") : "转码所选";
  }
  pickAll.addEventListener("change", () => {
    for (const node of body.querySelectorAll('input[data-role="media-pick"]')) {
      node.checked = pickAll.checked;
      if (pickAll.checked) picked.add(node.value); else picked.delete(node.value);
    }
    paintPick();
  });
  batchBtn.addEventListener("click", async () => {
    if (!picked.size) return;
    batchBtn.disabled = true;
    try {
      const height = Number(transcodeSize.value) || 0;
      const data = await api.transcode(Array.from(picked), height);
      setBanner(note, "");
      picked.clear();
      pickAll.checked = false;
      paintPick();
      pollTranscode(data.job_id);
      await refresh(); // 立刻把"转码中"标到行上
    } catch (err) {
      setBanner(note, err && err.message ? err.message : "转码排队失败");
    } finally {
      paintPick();
    }
  });
  const prev = button("上一页", () => { page = Math.max(1, page - 1); refresh(); });
  const next = button("下一页", () => { page += 1; refresh(); });
  const names = new Map();
  let page = 1;

  async function loadLibraries() {
    try {
      const result = await api.libraries();
      const list = result && Array.isArray(result.list) ? result.list : [];
      for (const library of list) {
        names.set(String(library.id), library.name || String(library.id));
        // 只列**短视频库**：这一块管的是散片，短剧库的剧集在「短剧管理」里按剧组织
        // （用户 2026-10-10："后台各管各的"）。老服务端不返回 kind 时按 short 处理。
        if (library.kind === "drama") continue;
        librarySelect.append(el("option", { value: String(library.id), text: library.name || String(library.id) }));
      }
    } catch (err) {
      setBanner(note, err && err.message ? err.message : "媒体库加载失败");
    }
  }

  async function refresh() {
    setBanner(note, "");
    try {
      const result = await api.mediaList({
        page,
        per_page: 20,
        library_id: librarySelect.value,
        q: query.value.trim(),
        status: statusSelect.value,
        // 这一块只管**短视频库**（散片）：短剧库的剧集在「短剧管理」里按剧组织，
        // 两边各管各的（用户 2026-10-10）；不加这个过滤就会把剧集混进来。
        kind: "short",
      });
      const list = result && result.data && Array.isArray(result.data.list) ? result.data.list : [];
      const meta = (result && result.meta) || {};
      clear(body);
      picked.clear();          // 翻页/换筛选后旧的选中看不见了，必须清掉
      pickAll.checked = false;
      paintPick();
      if (!list.length) body.append(emptyRow(8, "没有数据"));
      for (const item of list) {
        const resolution = item.width && item.height ? item.width + "×" + item.height : "-";
        // missing 要如实显示：status 列在这里仍是 ready（扫描只写 missing_since），
        // 直接显示 ready 会让人以为"能放"——用户就是这么被误导的。
        let stateText = item.missing ? "missing（文件不在了）" : item.status;
        // 转码状态与"能不能播"分开显示（转码失败时 status 仍是 ready —— 这条还能播，如实说）
        if (item.transcode_state === "done") stateText += " · 已转码";
        if (item.transcode_state === "running") stateText += " · 转码中";
        if (item.transcode_state === "failed") stateText += " · 转码失败";
        const check = el("input", { type: "checkbox", dataset: { role: "media-pick" }, value: String(item.id) });
        check.addEventListener("change", () => {
          if (check.checked) picked.add(String(item.id)); else picked.delete(String(item.id));
          paintPick();
        });
        // C8：失败的给「重试」（同一个接口，语义更清楚）；成功的还能再转（换更小尺寸）
        const isRetry = item.transcode_state === "failed";
        const transcodeBtn = button(isRetry ? "重试" : "转码", null);
        transcodeBtn.dataset.role = isRetry ? "media-retry" : "media-transcode";
        transcodeBtn.addEventListener("click", async () => {
          transcodeBtn.disabled = true;
          try {
            const height = Number(transcodeSize.value) || 0;
            const data = await api.transcode([item.id], height);
            setBanner(note, "");
            pollTranscode(data.job_id);
          } catch (err) {
            setBanner(note, err && err.message ? err.message : "转码排队失败");
          } finally {
            transcodeBtn.disabled = false;
          }
        });
        const holder = el("td", null, transcodeBtn);
        if (item.transcode_state === "failed" && item.transcode_note) holder.title = item.transcode_note;
        // C8 前后对比：转码结论里带着「体积 265.3MB→181.1MB（小 32%）」，直接摊在行里，
        // 不用点开任务中心才知道到底压小没有（失败的写失败原因）。
        let stateCell = null;
        if (item.transcode_state === "done" && item.transcode_note) {
          stateCell = el("td", null, el("div", { text: stateText }),
            el("div", { class: "muted small-note", dataset: { role: "transcode-note" }, text: item.transcode_note }));
        } else if (item.transcode_state === "failed" && item.transcode_note) {
          stateCell = el("td", null, el("div", { text: stateText }),
            el("div", { class: "danger small-note", dataset: { role: "transcode-note" }, text: item.transcode_note }));
        }
        const row = rowOf([check, item.title, names.get(String(item.library_id)) || item.library_id,
          fmtDuration(item.duration_ms), resolution, item.codecs ? item.codecs.video : "-",
          stateText, fmtBytes(item.size), holder]);
        if (stateCell) row.replaceChild(stateCell, row.children[6]);
        body.append(row);
      }
      // 清理按钮只在选中具体库时出现（清理是"针对某个库"的动作，不做全局一头雾水的清）。
      purgeBtn.hidden = !librarySelect.value;
      purgeInfo.textContent = librarySelect.value
        ? "清理只删记录、不动文件；清理后这些视频会从首页消失。"
        : "先在左边选一个媒体库，才能清理它的缺失记录。";
      const current = Number(meta.page) || page;
      info.textContent = "第 " + current + " 页 / 共 " + (Number(meta.total) || 0) + " 条";
      prev.disabled = current <= 1;
      next.disabled = !meta.has_more;
    } catch (err) {
      setBanner(note, err && err.message ? err.message : "加载失败");
    }
  }

  // 转码进度：任务中心里的 percent 就是"当前这一件"的百分比（转码是分钟级动作，得看得见）。
  // timers 是本页自己的定时器集合（原来忘了声明 ⇒ 点转码报 "Can't find variable: timers"）。
  const timers = [];
  const transcodeInfo = el("div", { class: "muted small-note", dataset: { role: "transcode-progress" } });
  // 转码尺寸（用户 2026-09-24）：很多视频已经压到极限，再压只能缩画面。
  const transcodeSize = el("select", { class: "input", dataset: { role: "transcode-size" } },
    ...[["", "保持原分辨率"], ["720", "720p 上限"], ["480", "480p 上限"], ["360", "360p 上限"], ["240", "240p 上限"]]
      .map(([value, label]) => el("option", { value, text: label })));
  let transcodeTimer = 0;
  function pollTranscode(jobId) {
    if (transcodeTimer) clearInterval(transcodeTimer);
    transcodeInfo.textContent = "转码已排队…";
    transcodeTimer = setInterval(async () => {
      let task = null;
      try { task = await api.jobTask(jobId); }
      catch (err) {
        clearInterval(transcodeTimer); transcodeTimer = 0;
        transcodeInfo.textContent = "";
        setBanner(note, err && err.message ? err.message : "查询转码任务失败");
        return;
      }
      if (task.status === "pending" || task.status === "running") {
        transcodeInfo.textContent = "转码中 " + (Number(task.processed) || 0) + "/"
          + (Number(task.total) || 0) + " · 当前 " + (Number(task.percent) || 0) + "%";
        return;
      }
      clearInterval(transcodeTimer);
      transcodeTimer = 0;
      const summary = task.summary || {};
      let text = (task.status === "success" ? "转码完成：" : "转码有失败：")
        + "成功 " + (Number(summary.succeeded) || 0) + " / 失败 " + (Number(summary.failed) || 0);
      if (task.error) text += "；" + task.error;
      // 每条结论都带上"体积变化"（用户要看"到底压小没有"）
      if (Array.isArray(summary.results) && summary.results.length) {
        text += "（" + summary.results.join("；") + "）";
      }
      transcodeInfo.textContent = text;
      refresh();
    }, 1200);
    timers.push(transcodeTimer);
  }

  const filters = el("div", { class: "row" }, librarySelect, query, statusSelect, transcodeSize);
  // 清理缺失记录（用户 2026-09-22 报障）：整库改名后缺失比例会超过扫描的自动删除阈值，
  // 自动路径按设计不删，必须给一个明确的、要确认的清理入口。只删记录、不动文件。
  const purgeBtn = el("button", {
    class: "btn danger small", type: "button", text: "清理缺失记录", hidden: true,
    dataset: { role: "purge-missing" },
    title: "删除这个库里「文件已不在磁盘上」的记录（只删记录，不动文件）",
  });
  const purgeInfo = el("div", { class: "muted small-note", dataset: { role: "purge-info" } });
  purgeBtn.addEventListener("click", async () => {
    const libID = librarySelect.value;
    if (!libID) return;
    const libName = names.get(String(libID)) || libID;
    // 见 renameGroup 的说明：确认框一律用项目自己的（App/电视上原生 confirm 恒假）
    const okPurge = await confirmDialog({
      title: "清理「" + libName + "」的缺失记录",
      message: "只删数据库里「文件已不在磁盘上」的记录，不删除任何文件；被清理的视频会从首页消失" +
        "（下次扫描若文件回来了会重新入库）。",
      confirmText: "清理记录",
    });
    if (!okPurge) return;
    setBanner(note, "");
    purgeBtn.disabled = true;
    try {
      const data = await api.purgeMissing(libID);
      const deleted = Number(data && data.deleted) || 0;
      await refresh();
      setBanner(note, deleted > 0
        ? ("已清理 " + deleted + " 条缺失记录（文件未动）")
        : "没有可清理的缺失记录");
    } catch (err) {
      setBanner(note, err && err.message ? err.message : "清理失败");
    } finally {
      purgeBtn.disabled = false;
    }
  });
  function onFilter() { page = 1; refresh(); }
  librarySelect.addEventListener("change", onFilter);
  statusSelect.addEventListener("change", onFilter);
  query.addEventListener("change", onFilter);
  root.append(note, el("div", { class: "panel" }, filters,
      el("div", { class: "row" }, batchBtn, pickCount, purgeBtn, purgeInfo),
      transcodeInfo),
    el("div", { class: "actions" }, prev, next, info), table);
  loadLibraries().then(refresh);
  return () => { for (const timer of timers) if (timer) clearInterval(timer); };
}
