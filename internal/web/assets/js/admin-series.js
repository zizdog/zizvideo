// 后台「剧场」页签：新建 / 批量建 / 一键识别 / 上传 / 逐剧场管理都收在这里。
// 观看面（#/series）只负责看与播，不放任何管理入口（用户 2026-09-22 要求）。

import { api } from "./api.js";
import { el, clear, banner, setBanner, field, input, asArray, fmtDuration } from "./dom.js";
import { confirmDialog } from "./confirm.js";
import { batchImportSeries, importDirIntoSeries } from "./series-import.js";
import { uploadNewSeries, uploadToSeries } from "./uploads.js";
import { mountSeriesAdmin } from "./series-admin.js";

function btn(label, onclick, extra) {
  return el("button", {
    class: "btn small" + (extra ? " " + extra : ""), type: "button", text: label, onclick,
  });
}

function gridOf(headers) {
  const headRow = el("tr");
  for (const label of headers) headRow.append(el("th", { text: label }));
  const body = el("tbody");
  const table = el("table", { class: "grid" }, el("thead", null, headRow), body);
  return { table: el("div", { class: "table-scroll" }, table), body };
}

function textCell(value) {
  return el("td", { text: value === null || value === undefined || value === "" ? "-" : String(value) });
}

export function mountSeriesTab(root) {
  const note = banner();
  const detectNote = el("div", { class: "banner", hidden: true, dataset: { role: "series-detect-note" } });
  const { table, body } = gridOf(["标题", "集数", "简介", "操作"]);

  // ── 未归组（设计第 5 步收尾）：短剧库**库根直接放的散片** = 还没归进任何剧的。
  //    扫描只把它们留在库里、不建剧，归组是人工动作（用户 2026-10-10 拍板的 Jellyfin 式模型：
  //    库根一级目录 = 一部剧）。散片可能属于**任意**短剧库，所以列全库并标出来源库。
  const ungroupNote = banner(); // 横幅放在折叠区**外面**，收起时结果/报错也看得见（同 admin.js 新建媒体库）
  const ungroupSummary = el("summary", { text: "未归组" });
  const ungroupGrid = gridOf(["文件", "时长", "来源库", "操作"]);
  const ungroupBox = el("details", { class: "panel collapsible", dataset: { role: "ungrouped-box" } },
    ungroupSummary,
    el("div", { class: "collapsible-body" },
      el("div", { class: "muted small-note",
        text: "库根直接放的散片不会自动建剧；选一部剧归入即可（已归入的会自动跳过）。" }),
      ungroupGrid.table));

  const titleInput = input({ placeholder: "剧场标题", required: true });
  const descInput = input({ placeholder: "简介（可选）" });
  const submit = el("button", { class: "btn primary", type: "submit", text: "新建" });
  const form = el("form", { class: "panel", hidden: true, dataset: { role: "series-create" } },
    field("标题", titleInput), field("简介", descInput), el("div", { class: "actions" }, submit));
  const createToggle = btn("＋ 新建剧场", () => {
    form.hidden = !form.hidden;
    if (!form.hidden) titleInput.focus();
  }, "primary");

  root.append(note, detectNote, form,
    el("div", { class: "row" },
      createToggle,
      btn("新建剧场并上传", () => uploadNewSeries(load)),
      btn("按子目录批量建剧场", () => batchImportSeries(load)),
      btn("一键识别全部", (event) => runDetectAll(event.currentTarget))),
    ungroupNote,
    ungroupBox,
    table);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    setBanner(note, "");
    submit.disabled = true;
    try {
      await api.request("POST", "/api/v1/admin/series", {
        title: titleInput.value.trim(), description: descInput.value.trim(),
      });
      titleInput.value = "";
      descInput.value = "";
      form.hidden = true;
      await load();
    } catch (err) {
      setBanner(note, err && err.message ? err.message : "新建失败");
    } finally {
      submit.disabled = false;
    }
  });

  function seriesRow(item) {
    const actions = el("div", { class: "actions" },
      btn("管理", () => openDrawer(item), "primary"),
      btn("上传", () => uploadToSeries(item, load)),
      btn("从目录导入", () => importDirIntoSeries(item, load)));
    return el("tr", { dataset: { role: "series-row", id: String(item.id) } },
      textCell(item.title), textCell((item.episode_count || 0) + " 集"), textCell(item.description),
      el("td", null, actions));
  }

  function openDrawer(item) {
    const overlay = el("div", { class: "modal-overlay", dataset: { role: "series-admin-drawer" } });
    const panelBody = el("div", { class: "panel series-admin-body" });
    const box = el("div", { class: "modal wide" },
      el("div", { class: "picker-head" },
        el("span", { text: "管理剧场：" + (item.title || "") }),
        el("button", {
          class: "btn small", type: "button", text: "关闭", dataset: { role: "drawer-close" },
          onclick: () => overlay.remove(),
        })),
      panelBody);
    overlay.append(box);
    overlay.addEventListener("click", (event) => { if (event.target === overlay) overlay.remove(); });
    document.body.append(overlay);
    mountSeriesAdmin(panelBody, item, {
      onChanged: load,
      onDeleted: () => { overlay.remove(); load(); },
    });
  }

  async function load() {
    clear(body);
    body.append(el("tr", null, el("td", { class: "empty", colspan: "4", text: "加载中…" })));
    let list = [];
    try {
      const data = await api.request("GET", "/api/v1/series");
      list = asArray(data && data.list);
    } catch (err) {
      clear(body);
      setBanner(note, err && err.message ? err.message : "加载失败");
      return;
    }
    clear(body);
    if (!list.length) {
      body.append(el("tr", null, el("td", { class: "empty", colspan: "4", text: "还没有剧场" })));
      return;
    }
    for (const item of list) body.append(seriesRow(item));
  }

  // ── 未归组区块：列出来源库名要库表、内联下拉要剧表，一次并发拿齐。
  let libraries = [];
  let allSeries = [];

  function findLibrary(id) {
    for (const lib of libraries) {
      if (String(lib.id) === String(id)) return lib;
    }
    return null;
  }

  function libraryName(id) {
    const lib = findLibrary(id);
    return lib ? (lib.name || String(lib.id)) : (id ? String(id) : "-");
  }

  function baseName(p) {
    const slash = String(p || "").replace(/\\/g, "/");
    const at = slash.lastIndexOf("/");
    return at >= 0 ? slash.slice(at + 1) : slash;
  }

  function withoutExt(name) {
    const text = String(name || "");
    const at = text.lastIndexOf(".");
    return at > 0 ? text.slice(0, at) : text;
  }

  // 剧名 = **库根一级目录名**（模型就是"库根一级目录=一部剧"）；文件直接放在库根时退回文件名。
  // 取一级目录而不是最近一层父目录：剧里面常还有季子目录，拿"Season 1"当剧名就错了。
  function seriesTitleFrom(filePath, rootPath) {
    const file = String(filePath || "").replace(/\\/g, "/");
    const root = String(rootPath || "").replace(/\\/g, "/").replace(/\/+$/, "");
    if (root && file.indexOf(root + "/") === 0) {
      const rest = file.slice(root.length + 1);
      const at = rest.indexOf("/");
      if (at > 0) return rest.slice(0, at);
    }
    return withoutExt(baseName(file));
  }

  // 文件名优先用接口给的 file_name（列表接口不外发宿主机路径，只给文件名）；
  // title 在前面：短剧散片常常已经按文件名/剧名给过 title。
  function mediaLabel(item) {
    if (item.title) return String(item.title);
    if (item.file_name) return String(item.file_name);
    return baseName(item.path);
  }

  async function loadUngrouped() {
    clear(ungroupGrid.body);
    ungroupGrid.body.append(el("tr", null, el("td", { class: "empty", colspan: "4", text: "加载中…" })));
    let media = null;
    let libResult = null;
    let seriesResult = null;
    try {
      const results = await Promise.all([
        api.mediaList({ kind: "drama", ungrouped: 1, per_page: 50 }),
        api.libraries(),
        api.request("GET", "/api/v1/series"),
      ]);
      media = results[0];
      libResult = results[1];
      seriesResult = results[2];
    } catch (err) {
      ungroupSummary.textContent = "未归组";
      clear(ungroupGrid.body);
      ungroupGrid.body.append(el("tr", null, el("td", { class: "empty", colspan: "4", text: "加载失败" })));
      setBanner(ungroupNote, err && err.message ? err.message : "未归组加载失败");
      return;
    }
    libraries = asArray(libResult && libResult.list);
    allSeries = asArray(seriesResult && seriesResult.list);
    const list = asArray(media && media.data && media.data.list);
    const total = media && media.meta && media.meta.total !== undefined ? Number(media.meta.total) : list.length;
    ungroupSummary.textContent = "未归组（" + total + " 条）";
    clear(ungroupGrid.body);
    if (!list.length) {
      ungroupGrid.body.append(el("tr", null, el("td", { class: "empty", colspan: "4", text: "没有未归组的散片" })));
      return;
    }
    for (const item of list) ungroupGrid.body.append(ungroupRow(item));
    if (total > list.length) {
      ungroupGrid.body.append(el("tr", null, el("td", { class: "empty", colspan: "4",
        text: "共 " + total + " 条，这里只列最新的 " + list.length + " 条" })));
    }
  }

  function ungroupRow(item) {
    const pick = el("select", { class: "input", dataset: { role: "ungrouped-series" } },
      el("option", { value: "", text: "选择要归入的剧…" }));
    for (const series of allSeries) {
      // 只列**同一个库**的剧（跨库归入等于归到自己没在看的地方）；没挂库的老剧场仍然列出来。
      if (item.library_id && series.library_id && String(series.library_id) !== String(item.library_id)) continue;
      pick.append(el("option", { value: String(series.id), text: series.title || String(series.id) }));
    }
    pick.append(el("option", { value: "new", text: "＋新建一部剧（按所在目录名）" }));
    const go = btn("归入", () => assignToSeries(item, pick, go));
    return el("tr", { dataset: { role: "ungrouped-row", id: String(item.id) } },
      textCell(mediaLabel(item)),
      textCell(item.duration_ms ? fmtDuration(item.duration_ms) : ""),
      textCell(item.library_id ? libraryName(item.library_id) : "-"),
      el("td", null, el("div", { class: "actions" }, pick, go)));
  }

  function seriesTitleOf(id) {
    for (const series of allSeries) {
      if (String(series.id) === String(id)) return series.title || String(id);
    }
    return String(id);
  }

  // 「新建一部剧」：列表接口不给 path（只有管理员详情接口给），所以按需读一次详情拿目录名。
  async function createSeriesFor(item) {
    let path = "";
    try {
      const detail = await api.media(item.id);
      if (detail && detail.path) path = String(detail.path);
    } catch (err) {
      path = ""; // 读不到就退回文件名，下面的兜底会用；不谎报，名字会显示在横幅里
    }
    const lib = findLibrary(item.library_id);
    let title = seriesTitleFrom(path, lib ? lib.root_path : "");
    if (!title) title = withoutExt(mediaLabel(item));
    if (!title) throw new Error("读不到目录名：请先在下面「新建一部剧」再归入");
    const body = { title: title };
    if (item.library_id) body.library_id = item.library_id;
    const created = await api.request("POST", "/api/v1/admin/series", body);
    if (!created || !created.id) throw new Error("新建剧场没返回 id，请重试");
    return { id: created.id, title: created.title || title };
  }

  async function assignToSeries(item, pick, button) {
    setBanner(ungroupNote, "");
    const value = pick.value;
    if (!value) {
      setBanner(ungroupNote, "请先选一部剧再点归入");
      pick.focus();
      return;
    }
    button.disabled = true;
    pick.disabled = true;
    try {
      let seriesId = value;
      let seriesTitle = "";
      if (value === "new") {
        const created = await createSeriesFor(item);
        seriesId = created.id;
        seriesTitle = created.title;
      } else {
        seriesTitle = seriesTitleOf(seriesId);
      }
      const result = await api.request("POST",
        "/api/v1/admin/series/" + encodeURIComponent(seriesId) + "/media", { media_ids: [item.id] });
      // 口是幂等的：已在剧里的会被跳过。added=0 就说"没归入"，别报成成功。
      const added = Number(result && result.added) || 0;
      setBanner(ungroupNote, added > 0
        ? ("已归入《" + seriesTitle + "》")
        : ("已在《" + seriesTitle + "》里，未重复归入"));
      await loadUngrouped();
      await load();
    } catch (err) {
      // 行还在：按钮恢复可点，报错照抄后端 message（400 的"剧场标题不能为空"这类要看得见）。
      setBanner(ungroupNote, err && err.message ? err.message : "归入失败");
      button.disabled = false;
      pick.disabled = false;
    }
  }

  // 一键识别：先预览变化（不落库）→ 确认 → 任务进度 → 结果（文案 ≤40 字）。
  let detectTimer = null;

  async function runDetectAll(button) {
    setBanner(detectNote, "正在统计变化…");
    button.disabled = true;
    let preview;
    try {
      preview = await api.detectAll({ confirm: false });
    } catch (err) {
      setBanner(detectNote, err && err.message ? err.message : "预览失败");
      button.disabled = false;
      return;
    }
    button.disabled = false;
    const failed = Number(preview && preview.failed_total) || 0;
    if (failed > 0) {
      setBanner(detectNote, "预览失败 " + failed + " 个剧场：" + firstDetectError(preview));
      return;
    }
    const changes = Number(preview && preview.changes_total) || 0;
    const manual = Number(preview && preview.manual_skipped_total) || 0;
    if (changes === 0) {
      setBanner(detectNote, "没有需要识别的新集");
      return;
    }
    const ok = await confirmDialog({
      title: "一键识别全部", danger: false, confirmText: "开始识别",
      message: "将更新 " + changes + " 集，跳过 " + manual + " 集手动",
    });
    if (!ok) { setBanner(detectNote, ""); return; }
    let task;
    try {
      task = await api.detectAll({ confirm: true });
    } catch (err) {
      setBanner(detectNote, err && err.message ? err.message : "提交失败");
      return;
    }
    const taskId = task && task.task_id;
    if (!taskId) {
      setBanner(detectNote, (task && task.note) || "没有需要识别的剧场");
      return;
    }
    pollDetect(taskId);
  }

  function pollDetect(taskId) {
    if (detectTimer) clearInterval(detectTimer);
    setBanner(detectNote, "识别中…");
    detectTimer = setInterval(async () => {
      let task;
      try {
        task = await api.jobTask(taskId);
      } catch (err) {
        clearInterval(detectTimer);
        detectTimer = null;
        setBanner(detectNote, err && err.message ? err.message : "查询失败");
        return;
      }
      if (task.status === "pending" || task.status === "running") {
        setBanner(detectNote, "识别中 " + (Number(task.processed) || 0) + "/" + (Number(task.total) || 0) + "…");
        return;
      }
      clearInterval(detectTimer);
      detectTimer = null;
      const updated = Number(task.updated) || 0;
      const skipped = Number(task.manual_skipped) || 0;
      const label = task.status === "success" ? "已更新 " : task.status === "failed" ? "识别失败：" : "识别已中断：";
      let text = label + updated + " 集，跳过 " + skipped + " 集手动";
      if (task.error) text += "；" + task.error;
      if (task.degraded && task.degrade_reason) text += "；" + task.degrade_reason;
      setBanner(detectNote, text);
      load();
    }, 1000);
  }

  function firstDetectError(preview) {
    for (const row of asArray(preview && preview.per_series)) {
      if (row && row.error) return row.error;
    }
    return "请重试";
  }

  load();
  loadUngrouped();
  return () => { if (detectTimer) clearInterval(detectTimer); detectTimer = null; };
}
