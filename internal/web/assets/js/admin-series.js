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

  // ── 剧场集合（用户 2026-10-11 定稿）：剧场自己的容器，一个集合 = 一个目录；
  //    集合里每个一级子目录 = 一部剧。它**不出现在「媒体库」**，只在这个版块里管理。
  const collectionSelect = el("select", { class: "input", dataset: { role: "theater-collection" } });
  const collectionNote = el("div", { class: "muted small-note",
    text: "剧场集合是剧场自己的容器（一个目录）：集合里每个一级子目录 = 一部剧。它不会出现在「媒体库」里，短视频扫描也不会碰它。" });
  const collName = input({ placeholder: "剧场集合名称", required: true });
  const collPath = input({ placeholder: "目录（绝对路径，例如 /Volumes/Data/dramas）", required: true });
  const collSubmit = el("button", { class: "btn primary", type: "submit", text: "建立" });
  const collForm = el("form", { class: "panel", hidden: true, dataset: { role: "theater-create" } },
    field("名称", collName), field("目录", collPath), el("div", { class: "actions" }, collSubmit));
  const collToggle = btn("＋ 新建剧场集合", () => {
    collForm.hidden = !collForm.hidden;
    if (!collForm.hidden) collName.focus();
  }, "primary");
  const collScan = btn("扫描此集合", async () => {
    const cur = currentCollection();
    if (!cur) { setBanner(note, "先在上面选一个剧场集合"); return; }
    setBanner(note, "");
    try {
      await api.request("POST", "/api/v1/libraries/" + encodeURIComponent(cur.id) + "/scan", {});
      setBanner(note, "已开始扫描「" + (cur.name || "") + "」——在「任务中心」看进度");
    } catch (err) {
      setBanner(note, err && err.message ? err.message : "扫描失败");
    }
  });

  const titleInput = input({ placeholder: "剧场标题", required: true });
  const descInput = input({ placeholder: "简介（可选）" });
  const submit = el("button", { class: "btn primary", type: "submit", text: "新建" });
  const form = el("form", { class: "panel", hidden: true, dataset: { role: "series-create" } },
    field("标题", titleInput), field("简介", descInput), el("div", { class: "actions" }, submit));
  const createToggle = btn("＋ 新建剧场", () => {
    form.hidden = !form.hidden;
    if (!form.hidden) titleInput.focus();
  }, "primary");

  root.append(note, detectNote, collForm,
    el("div", { class: "row" }, collectionSelect, collToggle, collScan),
    collectionNote,
    form,
    el("div", { class: "row" },
      createToggle,
      btn("新建剧场并上传", () => uploadNewSeries(load)),
      btn("按子目录批量建剧场", () => batchImportSeries(load)),
      btn("一键识别全部", (event) => runDetectAll(event.currentTarget))),
    table);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    setBanner(note, "");
    submit.disabled = true;
    try {
      const cur = currentCollection();
      const body = { title: titleInput.value.trim(), description: descInput.value.trim() };
      if (cur) body.library_id = cur.id;
      await api.request("POST", "/api/v1/admin/series", body);
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

  collForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    setBanner(note, "");
    collSubmit.disabled = true;
    try {
      const created = await api.request("POST", "/api/v1/admin/theater-collections", {
        name: collName.value.trim(), root_path: collPath.value.trim(),
      });
      collName.value = "";
      collPath.value = "";
      collForm.hidden = true;
      collectionSelect.value = String((created && created.id) || "");
      await load();
    } catch (err) {
      setBanner(note, err && err.message ? err.message : "建立剧场集合失败");
    } finally {
      collSubmit.disabled = false;
    }
  });

  function currentCollection() {
    if (!collectionSelect.value) return null;
    for (const c of collections) {
      if (String(c.id) === String(collectionSelect.value)) return c;
    }
    return null;
  }

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
    const keep = collectionSelect.value;
    try {
      const results = await Promise.all([
        api.request("GET", "/api/v1/series"),
        api.theaterCollections(),
      ]);
      list = asArray(results[0] && results[0].list);
      collections = asArray(results[1] && results[1].list);
      libraries = collections; // 兼容旧引用（来源库名等）
    } catch (err) {
      clear(body);
      setBanner(note, err && err.message ? err.message : "加载失败");
      return;
    }
    // 集合下拉：全部 + 每个集合
    clear(collectionSelect);
    collectionSelect.append(el("option", { value: "", text: "全部剧场集合" }));
    for (const c of collections) {
      collectionSelect.append(el("option", { value: String(c.id), text: (c.name || String(c.id)) }));
    }
    collectionSelect.value = keep && collections.some((c) => String(c.id) === String(keep)) ? keep : "";
    const cur = currentCollection();
    const shown = cur ? list.filter((it) => String(it.library_id || "") === String(cur.id)) : list;
    clear(body);
    if (!shown.length) {
      body.append(el("tr", null, el("td", { class: "empty", colspan: "4",
        text: cur ? "这个集合里还没有剧：用上面的「＋ 新建剧场」或「按子目录批量建剧场」" : "还没有剧场" })));
      return;
    }
    for (const item of shown) body.append(seriesRow(item));
  }

  let libraries = [];   // 兼容旧引用；实际保存的是剧场集合
  let collections = [];
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
      await load();
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
  return () => { if (detectTimer) clearInterval(detectTimer); detectTimer = null; };
}
