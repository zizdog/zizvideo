// 用户上传（UGC）：多选 → 分片 PUT（可断线续传）→ 定稿待审。
// 后端：POST /api/v1/uploads 开会话、PUT /api/v1/uploads/{id} 传字节、POST .../finish 定稿。
// PUT 必须走 XHR：只有它能给 upload.onprogress（fetch 拿不到上传进度）。
// 断线续传：服务端以磁盘上的 .zvpart 为准，重连后 GET 一次续传位置接着传；
// 页面刷新过就按"同名同大小"匹配回未完成的那一条，用户不用从头再来。

import { api, csrfToken } from "./api.js";
import { el, clear, banner, setBanner, fmtBytes, fmtDate } from "./dom.js";

const CHUNK = 8 * 1024 * 1024; // 8MB 一片：进度够细，断点也够省
const STATE_LABEL = { uploading: "上传中", pending: "待审核", approved: "已通过", rejected: "已驳回" };

// putChunk 传一片：Content-Range 说明这一片的起点；服务端对不上会 409（据此重读断点）。
// slot.xhr 暴露给调用方，取消时才能真正 abort 掉这次请求。
function putChunk(id, file, offset, end, onProgress, slot) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    if (slot) slot.xhr = xhr;
    xhr.open("PUT", "/api/v1/uploads/" + encodeURIComponent(id), true);
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.setRequestHeader("Content-Range", "bytes " + offset + "-" + (end - 1) + "/" + file.size);
    const token = csrfToken();
    if (token) xhr.setRequestHeader("X-CSRF-Token", token);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && onProgress) onProgress(offset + event.loaded);
    };
    xhr.onload = () => {
      let payload = null;
      try { payload = JSON.parse(xhr.responseText || "null"); } catch (err) { payload = null; }
      const data = payload && payload.data ? payload.data : null;
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve({ received: data ? !!data.received : false,
          receivedBytes: data && data.received_bytes ? Number(data.received_bytes) : end });
        return;
      }
      const message = payload && payload.error && payload.error.message
        ? String(payload.error.message) : ("上传失败（HTTP " + xhr.status + "）");
      const err = new Error(message);
      err.code = payload && payload.error ? payload.error.code : "";
      err.status = xhr.status;
      reject(err);
    };
    xhr.onerror = () => reject(new Error("网络中断，进度已保留，点「继续」可续传"));
    xhr.onabort = () => reject(new Error("已取消"));
    xhr.send(file.slice(offset, end));
  });
}

// uploadOne 把一个文件传完（内部按 8MB 分片；失败后再次调用会从服务端断点续传）。
async function uploadOne(row, file, onTick) {
  if (!row.id) {
    const started = await api.ugcStart(file.name, file.size, targetPayload());
    row.id = started.item.id;
    row.quota = started.quota;
    row.sent = 0;
  } else {
    const fresh = await api.ugcGet(row.id);
    row.sent = Number(fresh.item.received_bytes) || 0;
  }
  row.state = "uploading";
  let offset = row.sent;
  while (offset < file.size) {
    const end = Math.min(file.size, offset + CHUNK);
    const result = await putChunk(row.id, file, offset, end, (loaded) => onTick(loaded, file.size), row);
    offset = result.receivedBytes || end;
    onTick(offset, file.size);
    if (result.received) break;
  }
  const finished = await api.ugcFinish(row.id);
  row.state = finished.item.state;
  row.reviewNote = finished.item.review_note || "";
  return row;
}

// C7：剧场页「补传缺的集」跳过来时，把投递目标（库 + 剧场草稿名）预选好。
// 名字别用 seed：剧场/连播相关代码里 "seed" 是随机播放标识符，有门禁盯着（见 series_test.go）。
// 用同一个剧场标题 ⇒ 审核通过时按标题挂回**同一个**剧场（服务端 SeriesByTitle），不会新建重复剧场。
let uploadPreset = null;
export function presetUploadTarget(preset) { uploadPreset = preset || null; }

export function mountUpload(view) {
  const note = banner();
  // A2：上传时可选"投递目标"（审核页会预填）。库列表只来自 /me/libraries（自己的可见库），
  // 选了没权限的库后端也会拒（scope 是唯一判据）。
  const targetLib = el("select", { class: "input", dataset: { role: "upload-target-lib" } },
    el("option", { value: "", text: "（不指定）" }));
  const targetSeries = el("input", { class: "input", placeholder: "剧场草稿名（可选，如：穿越水浒）",
    dataset: { role: "upload-target-series" } });
  const targetNote = el("div", { class: "muted small-note", dataset: { role: "upload-target-note" },
    text: "投递目标只是建议：审核通过时管理员可改，指定后审核页会预填。" });
  const quotaLine = el("div", { class: "muted small-note", dataset: { role: "upload-quota" }, text: "配额读取中…" });
  const picker = el("input", {
    type: "file", multiple: true, accept: "video/*", dataset: { role: "upload-picker" },
  });
  const startBtn = el("button", { class: "btn primary", type: "button", text: "开始上传",
    dataset: { role: "upload-start" }, disabled: true });
  const rowBox = el("div", { class: "upload-list", dataset: { role: "upload-rows" } });
  const rows = [];
  let busy = false;
  let unfinished = [];   // 服务端还留着的"上传中"条目：按同名同大小续传

  // 安卓 App 里多给一个入口：走系统选择器（SAF）交给前台服务后台传，息屏/切后台都不停。
  const nativeBtn = (window.ZvAndroid && typeof window.ZvAndroid.pickUploads === "function")
    ? el("button", { class: "btn", type: "button", text: "用系统选择器后台传",
        dataset: { role: "upload-native" },
        onclick: () => { try { window.ZvAndroid.pickUploads(); } catch (err) { /* 老版本 App 没有这个方法 */ } } })
    : null;
  // A3：页面一进来就把"没传完的"摆出来，并给一个直接续传的按钮 ——
  // 断线/刷新后不用自己去"我的上传"里翻，也不用回忆传到哪了。
  const resumeBox = el("div", { class: "panel hidden", dataset: { role: "upload-resume" } });
  const page = el("div", { class: "page" },
    el("div", { class: "page-head" },
      el("h2", { class: "page-title", text: "上传视频" }),
      el("a", { class: "link small-note", href: "#/me/uploads", text: "我的上传 ›" })),
    resumeBox,
    note,
    el("div", { class: "panel" },
      el("div", { class: "muted small-note", text: "选中视频后点「开始上传」；上传完进待审，管理员通过后才进媒体库。" }),
      quotaLine,
      el("div", { class: "row" }, picker, startBtn, nativeBtn),
      el("div", { class: "row" }, el("span", { class: "muted small-note", text: "投递目标：" }), targetLib, targetSeries),
      targetNote),
    rowBox);

  function paintQuota(quota) {
    if (!quota) return;
    quotaLine.textContent = "已用 " + quota.items + "/" + quota.max_items + " 条 · " +
      fmtBytes(quota.bytes) + "/" + fmtBytes(quota.max_bytes) +
      "（服务器剩余 " + fmtBytes(quota.free_bytes) + "）";
  }

  function paintRow(row) {
    const pct = row.size > 0 ? Math.min(100, Math.round((row.sent / row.size) * 100)) : 0;
    row.fill.style.width = pct + "%";
    row.pct.textContent = row.status === "上传中" ? (pct + "%") : "";
    row.stateNode.textContent = row.status;
    row.stateNode.className = "upload-state " + (row.state || "");
    row.cancel.hidden = !(row.status === "上传中" || row.status === "待上传");
    row.retry.hidden = !(row.status === "失败" || row.status === "已取消");
  }

  function addRow(file) {
    const fill = el("span", { class: "bar-fill" });
    const pct = el("span", { class: "upload-pct", text: "" });
    const stateNode = el("span", { class: "upload-state", text: "待上传" });
    const cancel = el("button", { class: "btn small", type: "button", text: "取消", dataset: { role: "upload-cancel" } });
    const retry = el("button", { class: "btn small", type: "button", text: "继续", hidden: true, dataset: { role: "upload-retry" } });
    const row = {
      file, name: file.name, size: file.size, sent: 0, id: "", state: "", status: "待上传", xhr: null,
      node: el("div", { class: "upload-row", dataset: { role: "upload-row", name: file.name } },
        el("div", { class: "upload-name" }, el("span", { text: file.name }),
          el("span", { class: "muted small-note", text: " " + fmtBytes(file.size) })),
        el("div", { class: "bar" }, fill),
        el("div", { class: "upload-meta" }, stateNode, pct, retry, cancel)),
      fill, pct, stateNode, cancel, retry,
    };
    cancel.addEventListener("click", async () => {
      if (row.xhr) { try { row.xhr.abort(); } catch (err) { /* 已经结束 */ } }
      if (row.id && row.state === "uploading") {
        try { await api.ugcCancel(row.id); row.id = ""; row.sent = 0; }
        catch (err) { setBanner(note, err && err.message ? err.message : "取消失败"); }
      }
      row.status = "已取消";
      row.state = "";
      paintRow(row);
    });
    retry.addEventListener("click", () => { runOne(row); });
    rows.push(row);
    rowBox.append(row.node);
    paintRow(row);
  }

  async function runOne(row) {
    if (busy) return;
    busy = true;
    startBtn.disabled = true;
    try {
      setBanner(note, "");
      row.status = "上传中";
      paintRow(row);
      await uploadOne(row, row.file, (sent) => { row.sent = sent; paintRow(row); });
      row.sent = row.size;
      row.status = STATE_LABEL[row.state] || row.state;
      paintRow(row);
      if (row.quota) paintQuota(row.quota);
    } catch (err) {
      row.status = row.status === "已取消" ? "已取消" : "失败";
      if (row.status === "失败") setBanner(note, row.name + "：" + (err && err.message ? err.message : "上传失败"));
      paintRow(row);
    } finally {
      busy = false;
      startBtn.disabled = rows.length === 0;
    }
  }

  let autoResume = false; // 这次选择是不是"点续传来的"：是就自动开传，不用再点一次开始上传

  picker.addEventListener("change", async () => {
    const picked = Array.from(picker.files || []);
    if (!picked.length) return;
    clear(rowBox);
    rows.length = 0;
    const resumed = [];
    for (const file of picked) {
      addRow(file);
      // 服务端有同名同大小的未完成条目 ⇒ 复用它的 id，续传而不是重传
      const match = unfinished.filter((it) => it.name === file.name && Number(it.size) === file.size)[0];
      if (match) {
        const row = rows[rows.length - 1];
        row.id = match.id;
        row.sent = Number(match.received_bytes) || 0;
        row.status = "可续传";
        paintRow(row);
        resumed.push(row);
      }
    }
    startBtn.disabled = false;
    picker.value = "";
    if (autoResume && resumed.length) {
      autoResume = false;
      for (const row of resumed) await runOne(row);
      refreshQuota();
    } else if (resumed.length) {
      setBanner(note, "有 " + resumed.length + " 个文件可以续传：点「开始上传」接着传（已传部分不会重传）");
    }
  });

  startBtn.addEventListener("click", async () => {
    if (busy) return;
    for (const row of rows) {
      if (row.status === "待上传" || row.status === "失败" || row.status === "已取消") await runOne(row);
    }
    // 成功不用红字横幅（那是错误样式）：结果都写在每一行的状态里，这里只清掉旧错误
    setBanner(note, "");
    refreshQuota();
  });

  // 上传目标只在"开会话"时带上；一个文件一批，所以整批用同一个目标。
  function targetPayload() {
    const out = {};
    if (targetLib.value) out.target_library_id = targetLib.value;
    const t = targetSeries.value.trim();
    if (t) out.target_series_title = t;
    return out;
  }

  async function loadTargets() {
    try {
      const libs = await api.myLibraries();
      const list = Array.isArray(libs) ? libs : ((libs && libs.list) || []);
      for (const lib of list) targetLib.append(el("option", { value: lib.id, text: lib.name || lib.id }));
      if (!list.length) targetNote.textContent = "你还没有可访问的媒体库：投递目标不可选，先让管理员授权。";
      applySeed();
    } catch (err) { /* 读不到就不显示，不编 */ }
  }

  // 把 C7 带来的预选落进控件（库要真在可选项里才选，选不了就只预填剧场名）
  function applySeed() {
    const preset = uploadPreset;
    if (!preset) return;
    uploadPreset = null;
    if (preset.libraryId) {
      const has = Array.from(targetLib.options).some((o) => o.value === preset.libraryId);
      if (has) targetLib.value = preset.libraryId;
    }
    if (preset.seriesTitle) targetSeries.value = preset.seriesTitle;
    targetNote.textContent = "已预选：《" + (preset.seriesTitle || "剧场") + "》—— 审核通过后按这个名字挂回同一个剧场，不会新建。";
  }

  async function refreshQuota() {
    try {
      const data = await api.myUploads();
      paintQuota(data.quota);
      unfinished = (data.list || []).filter((it) => it.state === "uploading");
      paintResume();
    } catch (err) { /* 配额读不到就不显示，不编造 */ }
  }

  // paintResume 把"没传完的"列出来：每条显示进度，一个按钮直接去选文件续传。
  function paintResume() {
    clear(resumeBox);
    if (!unfinished.length) { resumeBox.classList.add("hidden"); return; }
    resumeBox.classList.remove("hidden");
    const go = el("button", { class: "btn primary small", type: "button", text: "选同一个文件继续传",
      dataset: { role: "upload-resume-pick" } });
    go.addEventListener("click", () => { autoResume = true; picker.click(); });
    resumeBox.append(
      el("div", { class: "panel-title", text: "未完成的上传（" + unfinished.length + "）" }),
      el("div", { class: "muted small-note", text: "断线或刷新后：点下面按钮选**同一个文件**，会从断点接着传，已传部分不重传。" }),
      ...unfinished.map((it) => el("div", { class: "upload-row", dataset: { role: "upload-unfinished" } },
        el("div", { class: "upload-name" }, el("span", { text: it.name }),
          el("span", { class: "muted small-note", text: " 已传 " + fmtBytes(it.received_bytes || 0) +
            " / " + fmtBytes(it.size) })),
        el("div", { class: "bar" }, el("span", { class: "bar-fill",
          style: { width: (it.size > 0 ? Math.round((Number(it.received_bytes) || 0) / it.size * 100) : 0) + "%" } })))),
      el("div", { class: "actions" }, go));
  }

  refreshQuota();
  loadTargets();
  view.append(page);
  return null;
}

// 我的上传：状态 / 驳回原因 / 配额；上传中的可以取消。
export function mountMyUploads(view) {
  const note = banner();
  const quotaLine = el("div", { class: "muted small-note", dataset: { role: "uploads-quota" } });
  const listBox = el("div", { class: "upload-list", dataset: { role: "my-upload-rows" } });
  view.append(el("div", { class: "page" },
    el("div", { class: "page-head" },
      el("h2", { class: "page-title", text: "我的上传" }),
      el("a", { class: "link small-note", href: "#/upload", text: "上传新视频 ›" })),
    note, quotaLine, listBox));

  async function load() {
    clear(listBox);
    setBanner(note, "");
    try {
      const data = await api.myUploads();
      const list = Array.isArray(data.list) ? data.list : [];
      if (data.quota) {
        quotaLine.textContent = "已用 " + data.quota.items + "/" + data.quota.max_items + " 条 · " +
          fmtBytes(data.quota.bytes) + "/" + fmtBytes(data.quota.max_bytes);
      }
      if (!list.length) {
        listBox.append(el("div", { class: "muted", text: "还没有上传过视频" }));
        return;
      }
      for (const item of list) listBox.append(itemRow(item));
    } catch (err) {
      setBanner(note, err && err.message ? err.message : "加载失败");
    }
  }

  function itemRow(item) {
    const pct = item.size > 0 ? Math.min(100, Math.round((Number(item.received_bytes) || 0) / item.size * 100)) : 0;
    const state = el("span", { class: "upload-state " + item.state, text: STATE_LABEL[item.state] || item.state });
    const meta = [fmtBytes(item.size), fmtDate(item.created_at)].filter(Boolean).join(" · ");
    const actions = el("div", { class: "upload-meta" }, state,
      el("span", { class: "muted small-note", text: meta }));
    if (item.state === "uploading") {
      const cancel = el("button", { class: "btn small", type: "button", text: "取消上传", dataset: { role: "my-upload-cancel" } });
      cancel.addEventListener("click", async () => {
        try { await api.ugcCancel(item.id); await load(); }
        catch (err) { setBanner(note, err && err.message ? err.message : "取消失败"); }
      });
      actions.append(cancel);
    }
    const row = el("div", { class: "upload-row", dataset: { role: "my-upload-row", state: item.state } },
      el("div", { class: "upload-name" }, el("span", { text: item.name })),
      item.state === "uploading" ? el("div", { class: "bar" }, el("span", { class: "bar-fill", style: { width: pct + "%" } })) : null,
      actions);
    if (item.state === "rejected" && item.review_note) {
      row.append(el("div", { class: "upload-note", text: "驳回原因：" + item.review_note }));
    }
    if (item.state === "uploading") {
      row.append(el("div", { class: "upload-note", text: "已传 " + fmtBytes(item.received_bytes || 0) +
        "；到「上传视频」页点「选同一个文件继续传」即可从断点接着传（已传部分不重传）" }));
    }
    return row;
  }

  load();
  return null;
}
