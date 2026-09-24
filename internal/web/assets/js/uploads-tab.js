// 后台「待审」页（用户上传 UGC）：预览 + 通过（选库）/ 驳回（填原因）。
// 数据源：GET /api/v1/admin/uploads/pending；预览用 /api/v1/uploads/{id}/stream|cover。

import { api } from "./api.js";
import { el, clear, banner, setBanner, fmtBytes, fmtDate } from "./dom.js";
import { confirmDialog } from "./confirm.js";

export function mountUploadsTab(root) {
  const note = banner();
  const count = el("span", { class: "muted small-note", dataset: { role: "pending-count" } });
  const listBox = el("div", { class: "upload-list", dataset: { role: "pending-rows" } });
  // 转码进度行放面板里：reload() 会清空 listBox，放在里面会被"通过后刷新"顺手清掉。
  const transcodeLine = el("div", { class: "muted small-note", dataset: { role: "transcode-progress" } });
  let libraries = [];

  root.append(el("div", { class: "panel" },
    el("div", { class: "panel-title" }, el("span", { text: "待审上传" }), count),
    el("div", { class: "muted small-note", text: "通过前先看一眼预览：通过后文件移进你选的媒体库并立刻可播。" }),
    note, transcodeLine), listBox);

  async function loadLibraries() {
    try {
      const data = await api.libraries();
      libraries = (data && (data.list || data)) || [];
    } catch (err) { libraries = []; }
  }

  // 转码任务进度（复用任务中心 /admin/tasks/{id} 的 percent）
  let transcodeTimer = 0;
  function pollTranscode(jobId) {
    if (transcodeTimer) clearInterval(transcodeTimer);
    const line = transcodeLine;
    const tick = async () => {
      let task = null;
      try { task = await api.jobTask(jobId); }
      catch (err) {
        clearInterval(transcodeTimer); transcodeTimer = 0;
        line.textContent = "转码进度查询失败：" + (err && err.message ? err.message : "");
        return;
      }
      if (task.status === "pending" || task.status === "running") {
        line.textContent = "转码中 " + (Number(task.processed) || 0) + "/" + (Number(task.total) || 0) +
          " · 当前 " + (Number(task.percent) || 0) + "%";
        return;
      }
      clearInterval(transcodeTimer);
      transcodeTimer = 0;
      const summary = task.summary || {};
      line.textContent = (task.status === "success" ? "转码完成：" : "转码有失败：") +
        "成功 " + (Number(summary.succeeded) || 0) + " / 失败 " + (Number(summary.failed) || 0) +
        (task.error ? "；" + task.error : "");
      await reload();
    };
    transcodeTimer = setInterval(tick, 1200);
    tick();
  }

  async function reload() {
    clear(listBox);
    setBanner(note, "");
    try {
      const data = await api.pendingUploads();
      const list = Array.isArray(data.list) ? data.list : [];
      count.textContent = list.length ? (list.length + " 条待审") : "";
      if (!list.length) {
        listBox.append(el("div", { class: "muted", text: "没有待审的上传" }));
        return;
      }
      for (const item of list) listBox.append(rowFor(item));
    } catch (err) {
      setBanner(note, err && err.message ? err.message : "加载失败");
    }
  }

  function preview(item) {
    const overlay = el("div", { class: "modal-overlay", dataset: { role: "upload-preview" } });
    const video = el("video", {
      class: "preview-video", controls: true, playsinline: true, preload: "metadata",
      src: "/api/v1/uploads/" + encodeURIComponent(item.id) + "/stream",
    });
    const box = el("div", { class: "modal wide" },
      el("div", { class: "picker-head" },
        el("span", { text: item.name }),
        el("button", { class: "btn small", type: "button", text: "关闭", onclick: () => overlay.remove() })),
      video);
    overlay.append(box);
    overlay.addEventListener("click", (event) => { if (event.target === overlay) overlay.remove(); });
    document.body.append(overlay);
  }

  function rowFor(item) {
    const cover = el("img", {
      class: "upload-cover", alt: "",
      src: "/api/v1/uploads/" + encodeURIComponent(item.id) + "/cover",
      onclick: () => preview(item),
    });
    const libSelect = el("select", { class: "input", dataset: { role: "pending-library" } });
    for (const lib of libraries) libSelect.append(el("option", { value: lib.id, text: lib.name }));
    const titleInput = el("input", { class: "input", placeholder: "标题（可改）", value: item.title || "" });
    const approve = el("button", { class: "btn primary small", type: "button", text: "通过并入库",
      dataset: { role: "pending-approve" } });
    approve.addEventListener("click", async () => {
      if (!libSelect.value) { setBanner(note, "先选一个媒体库"); return; }
      approve.disabled = true;
      try {
        await api.approveUpload(item.id, { library_id: libSelect.value, title: titleInput.value.trim() });
        await reload();
      } catch (err) {
        setBanner(note, err && err.message ? err.message : "通过失败");
      } finally {
        approve.disabled = false;
      }
    });
    // 通过并转码（P1）：兼容优先，转码是后台任务，失败也不影响"已经进库"这件事。
    const approveTranscode = el("button", { class: "btn small", type: "button", text: "通过并转码",
      dataset: { role: "pending-approve-transcode" } });
    approveTranscode.addEventListener("click", async () => {
      if (!libSelect.value) { setBanner(note, "先选一个媒体库"); return; }
      approveTranscode.disabled = true;
      try {
        const data = await api.approveUpload(item.id, { library_id: libSelect.value,
          title: titleInput.value.trim(), transcode: true });
        await reload();
        if (data && data.transcode_error) setBanner(note, "已通过，但转码没排上：" + data.transcode_error);
        else if (data && data.transcode_job_id) pollTranscode(data.transcode_job_id);
      } catch (err) {
        setBanner(note, err && err.message ? err.message : "通过失败");
      } finally {
        approveTranscode.disabled = false;
      }
    });
    const reject = el("button", { class: "btn danger small", type: "button", text: "驳回",
      dataset: { role: "pending-reject" } });
    reject.addEventListener("click", async () => {
      const noteText = await confirmDialog({
        title: "驳回这条上传",
        message: "填写驳回原因（会给上传者看）",
        input: { placeholder: "例如：画面不清晰 / 内容不合适", required: true },
        confirmText: "驳回",
      });
      if (noteText === null) return;
      try {
        await api.rejectUpload(item.id, noteText);
        await reload();
      } catch (err) {
        setBanner(note, err && err.message ? err.message : "驳回失败");
      }
    });
    return el("div", { class: "upload-row review", dataset: { role: "pending-row", id: item.id } },
      cover,
      el("div", { class: "review-body" },
        el("div", { class: "upload-name" }, el("span", { text: item.name }),
          el("span", { class: "muted small-note", text: " " + fmtBytes(item.size) })),
        el("div", { class: "muted small-note", text: "上传者 " + (item.uploader || "-") + " · " + fmtDate(item.created_at) }),
        el("div", { class: "row" }, libSelect, titleInput),
        el("div", { class: "actions" }, approve, approveTranscode, reject)));
  }

  loadLibraries().then(reload);
  return null;
}
