// 后台「待审」页（用户上传 UGC）：预览 + 通过（选库）/ 驳回（填原因）。
// 数据源：GET /api/v1/admin/uploads/pending；预览用 /api/v1/uploads/{id}/stream|cover。

import { api } from "./api.js";
import { el, clear, banner, setBanner, fmtBytes, fmtDate } from "./dom.js";
import { confirmDialog } from "./confirm.js";

export function mountUploadsTab(root) {
  const note = banner();
  const count = el("span", { class: "muted small-note", dataset: { role: "pending-count" } });
  const listBox = el("div", { class: "upload-list", dataset: { role: "pending-rows" } });
  // 批量审核（A1）：一次几十集时，别让人点几十次
  const picked = new Set();
  const batchInfo = el("span", { class: "muted small-note", dataset: { role: "batch-count" }, text: "已选 0 条" });
  // 转码进度行放面板里：reload() 会清空 listBox，放在里面会被"通过后刷新"顺手清掉。
  const transcodeLine = el("div", { class: "muted small-note", dataset: { role: "transcode-progress" } });
  let libraries = [];
  let seriesList = [];

  root.append(el("div", { class: "panel" },
    el("div", { class: "panel-title" }, el("span", { text: "待审上传" }), count),
    el("div", { class: "muted small-note", text: "通过前先看一眼预览：通过后文件移进你选的媒体库并立刻可播。" }),
    note, transcodeLine,
    el("div", { class: "row", dataset: { role: "batch-bar" } },
      el("button", { class: "btn small", type: "button", text: "全选待审", dataset: { role: "batch-all" },
        onclick: () => {
          for (const box of listBox.querySelectorAll('[data-role="pending-pick"]')) {
            box.checked = true; picked.add(box.dataset.id);
          }
          paintBatch();
          prefillBatchFromPicks(lastItems);
        } }),
      el("button", { class: "btn small", type: "button", text: "清空选择", dataset: { role: "batch-none" },
        onclick: () => { for (const box of listBox.querySelectorAll('[data-role="pending-pick"]')) box.checked = false; picked.clear(); paintBatch(); } }),
      batchInfo)), listBox);

  async function loadLibraries() {
    try {
      const data = await api.libraries();
      libraries = (data && (data.list || data)) || [];
    } catch (err) { libraries = []; }
    // 剧场草稿（P1）：通过时可以顺手归入一个剧场（已有 / 按标题新建）
    try {
      const data = await api.request("GET", "/api/v1/series");
      seriesList = (data && Array.isArray(data.list)) ? data.list : [];
    } catch (err) { seriesList = []; }
  }

  // 每个上传者能访问的库（缓存）：审核通过后视频要进"上传者自己也能看到"的库，
  // 否则会出现"自己传的、审核过了、自己看不见"。用户 2026-09-24 明确要求这么筛。
  const accessCache = new Map();
  async function uploaderLibraries(item) {
    const uid = item.uploader_id || "";
    if (!uid) return { list: libraries, note: "" };
    if (accessCache.has(uid)) return accessCache.get(uid);
    let result = { list: libraries, note: "" };
    try {
      const data = await api.userLibraries(uid);
      const ids = new Set((data && data.library_ids) || []);
      const mine = libraries.filter((lib) => ids.has(String(lib.id)));
      if (mine.length) {
        result = { list: mine, note: "只列出 " + (item.uploader || "该用户") + " 能访问的库（" + mine.length + " 个）" };
      } else {
        // 没授权（普通用户 0 授权 = 什么都看不到）：如实说明，并把全部库留一个出口给管理员。
        result = { list: libraries, note: (item.uploader || "该用户") + " 还没有可访问的媒体库，先到「用户」页授权（下面列出全部库）" };
      }
    } catch (err) { /* 读不到授权就退回全部库，但不说成"已按权限筛选" */ }
    accessCache.set(uid, result);
    return result;
  }

  function paintBatch() {
    batchInfo.textContent = "已选 " + picked.size + " 条";
  }

  // 勾选后按"第一条勾选项的投递目标"预填批量工具条（A2）：上传者已经说过要进哪，别再让管理员选一遍。
  function prefillBatchFromPicks(items) {
    const first = (items || []).find((x) => picked.has(x.id));
    if (!first) return;
    if (first.target_library_id && Array.from(batchLib.options).some((o) => o.value === first.target_library_id)) {
      batchLib.value = first.target_library_id;
    }
    if (first.target_series_title) {
      const exist = seriesList.find((x) => (x.title || "") === first.target_series_title);
      if (exist) {
        batchSeries.value = "id:" + exist.id;
        batchSeriesName.classList.add("hidden");
      } else {
        batchSeries.value = "new";
        batchSeriesName.value = first.target_series_title;
        batchSeriesName.classList.remove("hidden");
      }
    }
  }
  let lastItems = [];

  // 批量工具条上的控件：目标库 / 剧场 / 尺寸 / 原因，一次选好套用到全部勾选项
  const batchLib = el("select", { class: "input", dataset: { role: "batch-library" } });
  const batchSeries = el("select", { class: "input", dataset: { role: "batch-series" } });
  const batchSeriesName = el("input", { class: "input hidden", placeholder: "新剧场名（集号按文件名识别）",
    dataset: { role: "batch-series-name" } });
  const batchSize = sizeSelect("batch-size");
  const batchBar2 = el("div", { class: "row", dataset: { role: "batch-actions" } });
  batchSeries.addEventListener("change", () => {
    batchSeriesName.classList.toggle("hidden", batchSeries.value !== "new");
  });

  function seriesPayloadOf(pick, nameInput) {
    if (pick.value === "new") {
      const t = nameInput.value.trim();
      return t ? { series_title: t } : null;
    }
    if (pick.value.startsWith("id:")) return { series_id: pick.value.slice(3) };
    return {};
  }

  async function runBatchApprove() {
    const ids = Array.from(picked);
    if (!ids.length) { setBanner(note, "先勾选要通过的条目"); return; }
    if (!batchLib.value) { setBanner(note, "先选目标媒体库"); return; }
    const sp = seriesPayloadOf(batchSeries, batchSeriesName);
    if (sp === null) { setBanner(note, "填一下新剧场名"); return; }
    setBanner(note, "");
    const res = await api.approveUploadBatch(Object.assign({ ids, library_id: batchLib.value,
      transcode_height: Number(batchSize.value) || 0 }, sp));
    await reload();
    const failed = Number(res.failed) || 0;
    const msg = "批量通过 " + (Number(res.approved) || 0) + " 条"
      + (failed ? "，" + failed + " 条失败：" + (res.results || []).filter((r) => !r.ok)
        .map((r) => (r.error || "失败")).slice(0, 3).join("；") : "");
    setBanner(note, msg);
    if (res.results) {
      const tid = (res.results || []).map((r) => r.item && r.item.transcode_job_id).filter(Boolean)[0];
      if (tid) pollTranscode(tid);
    }
  }

  async function runBatchReject() {
    const ids = Array.from(picked);
    if (!ids.length) { setBanner(note, "先勾选要驳回的条目"); return; }
    const noteText = await confirmDialog({
      title: "批量驳回 " + ids.length + " 条",
      message: "填写驳回原因（会给上传者看）",
      input: { placeholder: "例如：内容不合适 / 不是视频", required: true },
      confirmText: "驳回",
    });
    if (noteText === null) return;
    setBanner(note, "");
    const res = await api.rejectUploadBatch(ids, noteText);
    await reload();
    setBanner(note, "批量驳回 " + (Number(res.rejected) || 0) + " 条"
      + (Number(res.failed) ? "，" + res.failed + " 条失败" : ""));
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
    picked.clear();
    paintBatch();
    // 批量工具条的下拉按当前库/剧场列表重建
    clear(batchLib);
    for (const lib of libraries) batchLib.append(el("option", { value: lib.id, text: lib.name }));
    clear(batchSeries);
    batchSeries.append(el("option", { value: "", text: "不归入剧场" }));
    for (const x of seriesList) batchSeries.append(el("option", { value: "id:" + x.id, text: "归入：" + (x.title || x.id) }));
    batchSeries.append(el("option", { value: "new", text: "＋新建剧场草稿…" }));
    setBanner(note, "");
    try {
      const data = await api.pendingUploads();
      const list = Array.isArray(data.list) ? data.list : [];
      lastItems = list;
      count.textContent = list.length ? (list.length + " 条待审") : "";
      if (!list.length) {
        listBox.append(el("div", { class: "muted", text: "没有待审的上传" }));
        return;
      }
      for (const item of list) listBox.append(await rowFor(item));
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

  // 转码尺寸（用户 2026-09-24）：很多源已经压到极限，再压只能缩画面。
  function sizeSelect(role) {
    return el("select", { class: "input", dataset: { role } },
      ...[["", "保持原分辨率"], ["720", "720p"], ["480", "480p"], ["360", "360p"], ["240", "240p"]]
        .map(([value, label]) => el("option", { value, text: label })));
  }

  async function rowFor(item) {
    const cover = el("img", {
      class: "upload-cover", alt: "",
      src: "/api/v1/uploads/" + encodeURIComponent(item.id) + "/cover",
      onclick: () => preview(item),
    });
    const access = await uploaderLibraries(item);
    const libSelect = el("select", { class: "input", dataset: { role: "pending-library" } });
    for (const lib of access.list) libSelect.append(el("option", { value: lib.id, text: lib.name }));
    // A2：上传者填过"投递目标"就预填（管理员仍可改；目标库必须在他的可见列表里才预选）
    if (item.target_library_id && access.list.some((l) => String(l.id) === String(item.target_library_id))) {
      libSelect.value = item.target_library_id;
    }
    const accessNote = access.note
      ? el("div", { class: "muted small-note", dataset: { role: "pending-libs-note" }, text: access.note })
      : null;
    const tSize = sizeSelect("pending-transcode-size");
    // 归入剧场：不归入（默认）/ 现有剧场 / ＋新建剧场草稿（集号按文件名识别）
    const seriesPick = el("select", { class: "input", dataset: { role: "pending-series" } },
      el("option", { value: "", text: "不归入剧场" }),
      ...seriesList.map((x) => el("option", { value: "id:" + x.id, text: "归入：" + (x.title || x.id) })),
      el("option", { value: "new", text: "＋新建剧场草稿…" }));
    const seriesName = el("input", { class: "input hidden", placeholder: "新剧场名（集号按文件名识别）",
      dataset: { role: "pending-series-name" } });
    // A2：上传者指定的剧场草稿名预填；同名剧场已存在就直接选中它
    if (item.target_series_title) {
      const exist = seriesList.find((x) => (x.title || "") === item.target_series_title);
      if (exist) {
        seriesPick.value = "id:" + exist.id;
      } else {
        seriesPick.value = "new";
        seriesName.value = item.target_series_title;
        seriesName.classList.remove("hidden");
      }
    }
    seriesPick.addEventListener("change", () => {
      seriesName.classList.toggle("hidden", seriesPick.value !== "new");
    });
    const titleInput = el("input", { class: "input", placeholder: "标题（可改）", value: item.title || "" });
    const approve = el("button", { class: "btn primary small", type: "button", text: "通过并入库",
      dataset: { role: "pending-approve" } });
    function seriesPayload() {
      if (seriesPick.value === "new") {
        const t = seriesName.value.trim();
        return t ? { series_title: t } : null;
      }
      if (seriesPick.value.startsWith("id:")) return { series_id: seriesPick.value.slice(3) };
      return {};
    }
    approve.addEventListener("click", async () => {
      if (!libSelect.value) { setBanner(note, "先选一个媒体库"); return; }
      if (seriesPick.value === "new" && !seriesName.value.trim()) { setBanner(note, "填一下新剧场名"); return; }
      approve.disabled = true;
      try {
        const payload = Object.assign({ library_id: libSelect.value, title: titleInput.value.trim() },
          seriesPayload());
        await api.approveUpload(item.id, payload);
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
      if (seriesPick.value === "new" && !seriesName.value.trim()) { setBanner(note, "填一下新剧场名"); return; }
      approveTranscode.disabled = true;
      try {
        const data = await api.approveUpload(item.id, Object.assign({
          library_id: libSelect.value, title: titleInput.value.trim(), transcode: true,
          transcode_height: Number(tSize.value) || 0 }, seriesPayload()));
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
    const pick = el("input", { type: "checkbox", title: "勾选后可批量通过/驳回",
      dataset: { role: "pending-pick", id: item.id } });
    pick.addEventListener("change", () => {
      if (pick.checked) picked.add(item.id); else picked.delete(item.id);
      paintBatch();
      // 勾上就按"这条的投递目标"预填批量工具条（A2）
      if (pick.checked) prefillBatchFromPicks(lastItems);
    });
    return el("div", { class: "upload-row review", dataset: { role: "pending-row", id: item.id } },
      el("span", { class: "video-lead" }, pick),
      cover,
      el("div", { class: "review-body" },
        el("div", { class: "upload-name" }, el("span", { text: item.name }),
          el("span", { class: "muted small-note", text: " " + fmtBytes(item.size) })),
        el("div", { class: "muted small-note", text: "上传者 " + (item.uploader || "-") + " · " + fmtDate(item.created_at) }),
        el("div", { class: "row" }, libSelect, titleInput, tSize),
        el("div", { class: "row" }, seriesPick, seriesName),
        accessNote,
        el("div", { class: "actions" }, approve, approveTranscode, reject)));
  }

  batchBar2.append(
    el("span", { class: "muted small-note", text: "批量：" }), batchLib, batchSeries, batchSeriesName, batchSize,
    el("button", { class: "btn primary small", type: "button", text: "批量通过", dataset: { role: "batch-approve" },
      onclick: () => { runBatchApprove().catch((err) => setBanner(note, err && err.message ? err.message : "批量通过失败")); } }),
    el("button", { class: "btn danger small", type: "button", text: "批量驳回", dataset: { role: "batch-reject" },
      onclick: () => { runBatchReject().catch((err) => setBanner(note, err && err.message ? err.message : "批量驳回失败")); } }));
  listBox.after(batchBar2);
  loadLibraries().then(reload);
  return null;
}
