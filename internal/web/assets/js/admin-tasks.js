// 任务中心页签：转码 / 扫描 / 识别的进度、取消、重试（从 admin.js 原样搬家）

import { api } from "./api.js";
import { el, clear, banner, setBanner } from "./dom.js";
import { button, emptyRow, gridOf } from "./admin-shared.js";

/* ---------- ② 任务中心（转码 / 扫描 / 识别：看进度、取消、重试） ---------- */

export function mountTasks(root) {
  const note = banner();
  const box = el("div", { class: "panel" });
  const info = el("div", { class: "muted small-note", dataset: { role: "tasks-info" }, text: "加载中…" });
  const { table, body } = gridOf(["类型", "状态", "进度", "时间", "结果", "操作"]);
  const refreshBtn = button("刷新", () => refresh());
  root.append(note, el("div", { class: "panel" },
    el("div", { class: "row" }, refreshBtn),
    el("div", { class: "muted small-note",
      text: "转码/扫描/识别都在这儿：正在跑的可以取消（转码会中止当前那条，原文件保持可用），失败或中断的可以重试。" }),
    info), table);

  const STATUS_TEXT = {
    pending: "排队中", running: "进行中", success: "已完成",
    failed: "失败", interrupted: "已取消/中断",
  };
  let timer = 0;

  function statusCell(row) {
    const label = STATUS_TEXT[row.status] || row.status;
    const cls = row.status === "failed" ? "danger small-note"
      : (row.status === "running" || row.status === "pending" ? "small-note" : "muted small-note");
    return el("div", { class: cls, dataset: { role: "task-status" }, text: label });
  }

  function progressText(row) {
    // 扫描没有 percent（只有已扫条数）；转码有 percent（当前这一件的进度）
    const base = (row.processed || 0) + "/" + (row.total || 0);
    if (row.source === "job" && (row.status === "running" || row.status === "pending")) {
      return base + "（当前 " + (row.percent || 0) + "%）";
    }
    return base;
  }

  function actionCell(row) {
    const cell = el("td");
    if (row.can_cancel) {
      const c = button("取消", async () => {
        c.disabled = true;
        setBanner(note, "");
        try {
          await api.cancelTask(row.id);
          setBanner(note, "已请求取消（正在跑的那条会中止，原文件保持可用）");
        } catch (err) {
          setBanner(note, err && err.message ? err.message : "取消失败");
        }
        await refresh();
      }, "danger");
      c.dataset.role = "task-cancel";
      cell.append(c);
    }
    if (row.can_retry) {
      const r = button("重试", async () => {
        r.disabled = true;
        setBanner(note, "");
        try {
          await api.retryTask(row.id);
          setBanner(note, "已重新排队");
        } catch (err) {
          setBanner(note, err && err.message ? err.message : "重试失败");
        }
        await refresh();
      });
      r.dataset.role = "task-retry";
      cell.append(r);
    }
    if (!cell.childNodes.length) cell.textContent = "-";
    return cell;
  }

  async function refresh() {
    try {
      const data = await api.taskList(50);
      const list = (data && data.list) || [];
      clear(body);
      if (!list.length) body.append(emptyRow(6, "还没有任务"));
      for (const row of list) {
        const title = el("td");
        title.append(el("div", { text: row.title || row.kind }));
        title.append(el("div", { class: "muted small-note", text: row.source === "job" ? "后台任务" : "媒体库扫描" }));
        const result = (row.summary || "") + (row.error ? ((row.summary ? "；" : "") + row.error) : "");
        const when = (row.created_at || "").replace("T", " ").slice(0, 19);
        const tr = el("tr", { dataset: { role: "task-row", task: row.id, status: row.status } },
          title, statusCell(row), el("td", { text: progressText(row) }),
          el("td", { text: when }), el("td", { class: "muted small-note", text: result || "-" }),
          actionCell(row));
        body.append(tr);
      }
      const running = list.filter((t) => t.status === "running" || t.status === "pending").length;
      info.textContent = "共 " + list.length + " 条，进行中 " + running + " 条"
        + (running ? "（进度每秒自动刷新）" : "");
      // 有在跑的就自动刷新：转码是分钟级动作，盯着看才不焦虑
      if (timer) { clearInterval(timer); timer = 0; }
      if (running) timer = setInterval(refresh, 2000);
    } catch (err) {
      setBanner(note, err && err.message ? err.message : "任务列表加载失败");
    }
  }

  refresh();
  return () => { if (timer) clearInterval(timer); };
}
