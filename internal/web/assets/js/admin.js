// 管理后台：媒体库 / 媒体 / 允许根 / 用户 / 系统 页签

import { api } from "./api.js";
import { el, clear, banner, setBanner, field, input, fmtDuration, fmtBytes, fmtDate, asArray } from "./dom.js";
import { openDirectoryPicker } from "./roots.js";
import { uploadToLibrary } from "./uploads.js";
import { mountSeriesTab } from "./admin-series.js";
import { videoCard } from "./cards.js";

function button(label, onclick, extraClass) {
  return el("button", {
    class: "btn small" + (extraClass ? " " + extraClass : ""),
    type: "button", text: label, onclick,
  });
}

function cell(value) {
  const td = el("td");
  if (value instanceof Node) td.append(value);
  else td.textContent = value === null || value === undefined || value === "" ? "-" : String(value);
  return td;
}

function rowOf(values) {
  const row = el("tr");
  for (const value of values) row.append(cell(value));
  return row;
}

function emptyRow(cols, text) {
  return el("tr", null, el("td", { class: "empty", colspan: String(cols), text }));
}

function gridOf(headers) {
  const table = el("table", { class: "grid" });
  const headRow = el("tr");
  for (const label of headers) headRow.append(el("th", { text: label }));
  const body = el("tbody");
  table.append(el("thead", null, headRow), body);
  return { table: el("div", { class: "table-scroll" }, table), body };
}

function selectFrom(options) {
  const select = el("select", { class: "input" });
  for (const option of options) select.append(el("option", { value: option.value, text: option.label }));
  return select;
}

function kv(label, value) {
  return el("div", { class: "kv" },
    el("span", { class: "k", text: label }),
    el("span", { class: "v", text: value === null || value === undefined || value === "" ? "-" : String(value) }));
}

/* ---------- 允许根共用 ---------- */

function normPath(path) {
  if (!path || path === "/") return "/";
  return String(path).replace(/\/+$/, "");
}

function isUnder(path, roots) {
  const p = normPath(path);
  return (roots || []).some((root) => {
    const r = normPath(root);
    return p === r || p.startsWith(r + "/");
  });
}

/* ---------- 媒体库 ---------- */

function mountLibraries(root) {
  const note = banner();
  const timers = [];
  const { table, body } = gridOf(["名称", "根目录", "递归", "启用", "分组", "新用户默认可看", "创建时间", "操作"]);
  // 未设置默认库 = 新用户看不到任何内容（fail-closed），常驻提示（B.8）。
  const defaultHint = el("div", {
    class: "banner", hidden: true, dataset: { role: "default-unset-hint" },
    text: "未设置新用户默认可看库，新用户看不到任何内容",
  });
  const backfillInfo = el("div", { class: "muted", dataset: { role: "backfill-info" } });
  const backfill = el("button", {
    class: "btn", type: "button", text: "把默认可见库补发给未授权用户", dataset: { role: "backfill-defaults" },
  });
  const nameInput = input({ placeholder: "名称", required: true });
  const pathInput = input({ placeholder: "根目录，例如 /Users/me/Videos", required: true });
  const recursive = el("input", { type: "checkbox", checked: true });
  const enabled = el("input", { type: "checkbox", checked: true });
  const ignoreInput = input({ placeholder: "忽略规则，逗号分隔" });
  const rootsHint = el("div", { class: "muted small-note" });
  let allowed = [];
  const pick = button("选择目录", () => {
    openDirectoryPicker({
      start: pathInput.value.trim() || "/",
      roots: () => allowed,
      onPicked: (picked) => { pathInput.value = picked; renderHint(); },
      onRootsChanged: loadRoots,
    });
  });
  const submit = el("button", { class: "btn primary", type: "submit", text: "新建" });
  const cancel = el("button", { class: "btn", type: "button", text: "取消", hidden: true });
  let editing = null;
  // 分组（用户 2026-09-22）：一个库最多一个组；组用于归类显示、整组操作、整组授权。
  let groups = [];
  const groupNameInput = input({ placeholder: "新分组名，例如 短剧 / 电影", required: true });
  const groupAdd = el("button", { class: "btn primary", type: "button", text: "新建分组" });
  const groupFormInner = el("form", null,
    el("div", { class: "row" }, field("媒体库分组", groupNameInput), groupAdd),
    el("div", { class: "muted small-note",
      text: "一个库最多属于一个分组；分组用于归类显示、整组操作与整组授权。删除分组只解绑，不会删库。" }));
  const groupForm = el("details", { class: "panel collapsible", dataset: { role: "group-form" } },
    el("summary", { text: "新建分组" }),
    el("div", { class: "collapsible-body" }, groupFormInner));

  function renderHint() {
    let text = "允许根：" + (allowed.length ? allowed.slice(0, 3).join("、") : "无");
    if (allowed.length > 3) text += " 等 " + allowed.length + " 个";
    const current = pathInput.value.trim();
    if (current && isUnder(current, allowed)) text = "✓ 已在允许根内";
    rootsHint.textContent = text;
  }

  async function loadRoots() {
    try {
      const data = await api.mediaRoots();
      const list = data && Array.isArray(data.roots) ? data.roots : [];
      allowed = list.map((item) => item.path);
    } catch (err) {
      allowed = [];
    }
    renderHint();
  }

  // 默认折叠（用户 2026-09-22：上半部分占满页面，下面的列表没法操作）；
  // 横幅 note 移出折叠区，否则提交结果/报错会被藏起来。
  const form = el("form", null,
    el("div", { class: "row" }, field("名称", nameInput),
      field("根目录", el("div", { class: "row" }, pathInput, pick))),
    rootsHint,
    el("div", { class: "row" },
      el("label", { class: "check" }, recursive, el("span", { text: "递归扫描" })),
      el("label", { class: "check" }, enabled, el("span", { text: "启用" }))),
    field("忽略规则", ignoreInput),
    el("div", { class: "actions" }, submit, cancel));
  // ⚠️ 折叠必须是 <details> 在外、表单在里：<summary> 放进 <form> 里不会折叠（本轮踩到）。
  const formBox = el("details", { class: "panel collapsible", dataset: { role: "library-form" } },
    el("summary", { text: "新建媒体库" }),
    el("div", { class: "collapsible-body" }, form));

  function setEditing(library) {
    editing = library;
    if (library) {
      formBox.open = true; // 编辑时展开表单，否则用户看不到输入框
      nameInput.value = library.name || "";
      pathInput.value = library.root_path || "";
      recursive.checked = !!library.recursive;
      enabled.checked = !!library.enabled;
      ignoreInput.value = Array.isArray(library.ignore_rules) ? library.ignore_rules.join(",") : "";
      submit.textContent = "保存";
      cancel.hidden = false;
    } else {
      nameInput.value = "";
      pathInput.value = "";
      recursive.checked = true;
      enabled.checked = true;
      ignoreInput.value = "";
      submit.textContent = "新建";
      cancel.hidden = true;
    }
    renderHint();
  }

  async function loadBackfill() {
    try {
      const data = await api.defaultLibraries();
      const unset = (Number(data && data.default_count) || 0) === 0;
      const pending = Number(data && data.users_without_libraries) || 0;
      const total = Number(data && data.users_total) || 0;
      defaultHint.hidden = !unset;
      backfillInfo.textContent = unset ? "未设置默认可见库，无法补发"
        : "将影响 " + pending + " 个未授权用户（共 " + total + " 个用户）";
      backfill.disabled = unset || pending === 0;
    } catch (err) {
      backfillInfo.textContent = "";
    }
  }

  async function refresh() {
    setBanner(note, "");
    try {
      const [libResult, groupResult] = await Promise.all([api.libraries(), api.libraryGroups()]);
      const list = libResult && Array.isArray(libResult.list) ? libResult.list : [];
      groups = groupResult && Array.isArray(groupResult.list) ? groupResult.list : [];
      clear(body);
      if (!list.length) body.append(emptyRow(8, "暂无媒体库"));
      // 按组分区显示：每组一个小标题行（带整组操作），最后是"未分组"。
      // 组顺序按后端给的 sort_order；库在组内保持原来的创建顺序。
      const known = new Set(groups.map((g) => g.id));
      for (const group of groups) {
        const members = list.filter((library) => library.group_id === group.id);
        body.append(groupHeaderRow(group, members));
        if (!members.length) {
          body.append(emptyRow(8, "这个分组还没有媒体库 —— 用右侧「分组」下拉把库归进来"));
        }
        for (const library of members) body.append(libraryRow(library));
      }
      const rest = list.filter((library) => !library.group_id || !known.has(library.group_id));
      if (rest.length) {
        body.append(sectionHeaderRow("未分组", rest.length, []));
        for (const library of rest) body.append(libraryRow(library));
      }
      // 库里引用了不存在的分组（理论上不该发生）会被算进"未分组"，不需要额外提示。
    } catch (err) {
      setBanner(note, err && err.message ? err.message : "加载失败");
    }
    await loadBackfill();
  }

  // sectionHeaderRow 是一行跨列的区块标题：组名 + 库数 + 该组的操作按钮。
  function sectionHeaderRow(title, count, actions) {
    return el("tr", null, el("td", {
      colspan: "8",
      style: { background: "var(--panel)", fontWeight: "620" },
      dataset: { role: "group-row", group: title },
    }, el("div", { class: "row" },
      el("span", { text: title }),
      el("span", { class: "muted small-note", text: count + " 个库" }),
      el("div", { class: "spacer" }),
      el("div", { class: "actions" }, actions))));
  }

  function groupHeaderRow(group, members) {
    return sectionHeaderRow(group.name, members.length, [
      button("启用整组", () => groupAction(group, "enable")),
      button("停用整组", () => groupAction(group, "disable")),
      button("扫描整组", () => groupAction(group, "scan")),
      button("改名", () => renameGroup(group)),
      button("删除分组", () => removeGroup(group), "danger"),
    ]);
  }

  // 整组操作的结果一律以后端计数为准。注意：refresh() 开头会清横幅，
  // 所以结果必须**在 refresh 之后**写，否则用户点了操作什么提示都看不到（实测踩过）。
  async function groupAction(group, action) {
    setBanner(note, "");
    try {
      const data = await api.libraryGroupAction(group.id, action);
      let message;
      if (action === "scan") {
        const started = Number(data && data.started) || 0;
        const total = Number(data && data.total) || 0;
        const failed = asArray(data && data.failed);
        message = "「" + group.name + "」整组扫描：已启动 " + started + "/" + total +
          (failed.length
            ? "，未启动 " + failed.length + " 个（" + failed.map((f) => (f.name || f.library_id) + "：" + f.error).join("；") + "）"
            : "");
      } else {
        const changed = Number(data && data.changed) || 0;
        message = "「" + group.name + "」整组" + (action === "enable" ? "启用" : "停用") + "：" + changed + " 个库";
      }
      await refresh();
      setBanner(note, message);
    } catch (err) {
      setBanner(note, err && err.message ? err.message : "操作失败");
    }
  }

  async function renameGroup(group) {
    const next = window.prompt("分组名", group.name || "");
    if (next === null) return;
    const trimmed = next.trim();
    if (!trimmed || trimmed === group.name) return;
    try {
      await api.updateLibraryGroup(group.id, { name: trimmed });
      await refresh();
    } catch (err) {
      setBanner(note, err && err.message ? err.message : "改名失败");
    }
  }

  async function removeGroup(group) {
    if (!window.confirm("删除分组「" + group.name + "」？组内 " + group.library_count +
      " 个库会回到未分组，库和文件都保留。")) return;
    try {
      const data = await api.deleteLibraryGroup(group.id);
      await refresh();
      setBanner(note, "已删除分组，解绑 " + (Number(data && data.unbound_libraries) || 0) + " 个库（库与文件都保留）");
    } catch (err) {
      setBanner(note, err && err.message ? err.message : "删除失败");
    }
  }

  function pollScan(taskId, line) {
    const timer = setInterval(async () => {
      try {
        const task = await api.scanTask(taskId);
        const scanned = Number(task.scanned) || 0;
        const total = Number(task.total) || 0;
        const failed = Number(task.failed) || 0;
        const missing = Number(task.missing) || 0;
        const suspected = Number(task.suspected) || 0;
        const renamed = Number(task.renamed) || 0;
        let text = "已扫描 " + scanned + "/" + total + "，失败 " + failed;
        if (renamed) text += "，识别到改名 " + renamed + " 个";
        if (missing || suspected) text += "，疑似丢失 " + (suspected || missing);
        line.textContent = text;
        if (task.status === "success" || task.status === "failed" || task.status === "interrupted") {
          clearInterval(timer);
          const label = task.status === "success" ? "扫描完成" : task.status === "failed" ? "扫描失败" : "扫描已中断";
          let final = label + "，已扫描 " + scanned + "/" + total + "，失败 " + failed;
          // 改名被识别出来是好事，要说出来（否则用户只看到"疑似丢失"，以为文件丢了）。
          if (renamed > 0) {
            final += "；识别到 " + renamed + " 个改名/移动（已改指新路径，观看进度与收藏保留）";
          }
          // 疑似丢失超阈值时扫描**不会**删记录（防止外接盘没挂载就清库），必须说出来，
          // 否则用户只看到"扫描完成"，以为没生效（用户 2026-09-22 报障）。
          if (suspected > 0) {
            final += "；疑似丢失 " + suspected + " 个（超过自动删除阈值，未删除）——可在「媒体」页选库后点「清理缺失记录」";
          } else if (missing > 0) {
            final += "；已标记缺失 " + missing + " 个（再扫一次确认后会自动删除）";
          }
          if (task.error) final += "：" + task.error;
          line.textContent = final;
        }
      } catch (err) {
        clearInterval(timer);
        line.textContent = err && err.message ? err.message : "查询失败";
      }
    }, 1000);
    timers.push(timer);
  }

  async function startScan(library, line) {
    line.textContent = "提交扫描…";
    try {
      const result = await api.scanLibrary(library.id);
      const taskId = result && (result.task_id || result.id);
      if (!taskId) { line.textContent = "未返回任务号"; return; }
      pollScan(taskId, line);
    } catch (err) {
      line.textContent = err && err.message ? err.message : "扫描失败";
    }
  }

  function libraryRow(library) {
    const line = el("div", { class: "scan-line" });
    const actions = el("div", { class: "actions" },
      button("上传", () => uploadToLibrary(refresh, library.id)),
      button("扫描", () => startScan(library, line)),
      button("编辑", () => { setEditing(library); nameInput.focus(); }),
      button("删除", async () => {
        if (!window.confirm("删除媒体库「" + (library.name || library.id) + "」？")) return;
        try { await api.deleteLibrary(library.id); await refresh(); }
        catch (err) { setBanner(note, err && err.message ? err.message : "删除失败"); }
      }, "danger"));
    const holder = el("td", null, actions, line);
    const isDefault = el("input", {
      type: "checkbox", checked: !!library.default_for_new_users,
      dataset: { role: "default-for-new-users", id: library.id },
    });
    // 归组下拉：未分组 + 全部分组。改动立即提交并回读（失败就提示，不改本地状态装成功）。
    const groupSelect = selectFrom([{ value: "", label: "未分组" }].concat(
      groups.map((g) => ({ value: g.id, label: g.name }))));
    groupSelect.value = library.group_id || "";
    groupSelect.dataset.role = "library-group";
    groupSelect.addEventListener("change", async () => {
      setBanner(note, "");
      groupSelect.disabled = true;
      try {
        await api.setLibraryGroup(library.id, groupSelect.value);
        await refresh();
      } catch (err) {
        setBanner(note, err && err.message ? err.message : "归组失败");
        groupSelect.disabled = false;
      }
    });
    isDefault.addEventListener("change", async () => {
      setBanner(note, "");
      isDefault.disabled = true;
      try {
        await api.updateLibrary(library.id, { default_for_new_users: isDefault.checked });
        await refresh();
      } catch (err) {
        isDefault.checked = !isDefault.checked;
        setBanner(note, err && err.message ? err.message : "保存失败");
      } finally {
        isDefault.disabled = false;
      }
    });
    return rowOf([library.name, library.root_path, library.recursive ? "是" : "否",
      library.enabled ? "是" : "否", groupSelect, el("label", { class: "check" }, isDefault),
      fmtDate(library.created_at), holder]);
  }

  // 新建分组：失败（重名/空名）如实提示，不假装成功。
  groupAdd.addEventListener("click", async () => {
    const name = groupNameInput.value.trim();
    if (!name) { setBanner(note, "请填分组名"); return; }
    setBanner(note, "");
    groupAdd.disabled = true;
    try {
      await api.createLibraryGroup({ name });
      groupNameInput.value = "";
      await refresh();
      setBanner(note, "已创建分组「" + name + "」");
    } catch (err) {
      setBanner(note, err && err.message ? err.message : "建组失败");
    } finally {
      groupAdd.disabled = false;
    }
  });
  groupFormInner.addEventListener("submit", (event) => event.preventDefault());

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    setBanner(note, "");
    submit.disabled = true;
    const payload = {
      name: nameInput.value.trim(),
      root_path: pathInput.value.trim(),
      recursive: recursive.checked,
      enabled: enabled.checked,
      ignore_rules: ignoreInput.value.split(",").map((part) => part.trim()).filter(Boolean),
    };
    try {
      if (editing) await api.updateLibrary(editing.id, payload);
      else await api.createLibrary(payload);
      setEditing(null);
      await refresh();
    } catch (err) {
      setBanner(note, err && err.message ? err.message : "保存失败");
    } finally {
      submit.disabled = false;
    }
  });

  cancel.addEventListener("click", () => setEditing(null));
  pathInput.addEventListener("change", renderHint);
  backfill.addEventListener("click", async () => {
    setBanner(note, "");
    backfill.disabled = true;
    try {
      const data = await api.backfillDefaults();
      await refresh();
      setBanner(note, "已补发 " + (data.users_granted || 0) + " 个用户，跳过 " + (data.users_skipped || 0) + " 个");
    } catch (err) {
      setBanner(note, err && err.message ? err.message : "补发失败");
      await loadBackfill();
    }
  });
  const uploadTop = button("上传视频", () => uploadToLibrary(refresh));
  root.append(note, formBox, groupForm, defaultHint, el("div", { class: "row" }, uploadTop, backfill, backfillInfo), table);
  loadRoots().then(refresh);

  return () => {
    for (const timer of timers) clearInterval(timer);
  };
}

/* ---------- 媒体允许根 ---------- */

function mountRoots(root) {
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
    if (!window.confirm("删除允许根「" + item.path + "」？")) return;
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

/* ---------- 媒体 ---------- */

function mountMedia(root) {
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
  const { table, body } = gridOf(["标题", "媒体库", "时长", "分辨率", "视频编码", "状态", "大小"]);
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
      });
      const list = result && result.data && Array.isArray(result.data.list) ? result.data.list : [];
      const meta = (result && result.meta) || {};
      clear(body);
      if (!list.length) body.append(emptyRow(7, "没有数据"));
      for (const item of list) {
        const resolution = item.width && item.height ? item.width + "×" + item.height : "-";
        // missing 要如实显示：status 列在这里仍是 ready（扫描只写 missing_since），
        // 直接显示 ready 会让人以为"能放"——用户就是这么被误导的。
        const stateText = item.missing ? "missing（文件不在了）" : item.status;
        body.append(rowOf([item.title, names.get(String(item.library_id)) || item.library_id,
          fmtDuration(item.duration_ms), resolution, item.codecs ? item.codecs.video : "-",
          stateText, fmtBytes(item.size)]));
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

  const filters = el("div", { class: "row" }, librarySelect, query, statusSelect);
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
    if (!window.confirm("清理「" + libName + "」里所有「文件已不在磁盘上」的记录？\n" +
      "只删数据库记录，不删除任何文件；已被清理的视频会从首页消失（下次扫描若文件回来了会重新入库）。")) return;
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
  root.append(note, el("div", { class: "panel" }, filters, el("div", { class: "row" }, purgeBtn, purgeInfo)),
    el("div", { class: "actions" }, prev, next, info), table);
  loadLibraries().then(refresh);
}

/* ---------- 用户可访问库（P3，整体替换 + 回读） ---------- */

function openUserLibrariesDrawer(user, onSaved) {
  const overlay = el("div", { class: "modal-overlay", dataset: { role: "user-libraries-drawer" } });
  const note = banner();
  const body = el("div", { class: "panel", dataset: { role: "user-libraries-body" } });
  const box = el("div", { class: "modal wide" },
    el("div", { class: "picker-head" },
      el("span", { text: "媒体库权限：" + (user.username || user.id) }),
      el("button", { class: "btn small", type: "button", text: "关闭", dataset: { role: "drawer-close" },
        onclick: () => overlay.remove() })),
    note, body);
  overlay.append(box);
  overlay.addEventListener("click", (event) => { if (event.target === overlay) overlay.remove(); });
  document.body.append(overlay);

  const checks = new Map();
  const groupChecks = new Map();
  const listBox = el("div", { class: "panel" });
  const groupsBox = el("div", { class: "panel" });
  const state = el("div", { class: "muted small-note", dataset: { role: "user-libraries-state" } });
  const save = el("button", { class: "btn primary", type: "button", text: "保存", dataset: { role: "save-user-libraries" } });
  const selectAll = el("button", { class: "btn small", type: "button", text: "全选" });
  const selectNone = el("button", { class: "btn small", type: "button", text: "全不选" });
  let libraries = [];
  let groups = [];

  function paint(grants, groupGrants) {
    const sources = new Map();
    for (const grant of asArray(grants)) sources.set(grant.library_id, grant.source);
    clear(listBox);
    checks.clear();
    if (!libraries.length) { listBox.append(el("div", { class: "muted", text: "暂无媒体库" })); }
    for (const library of libraries) {
      const check = el("input", { type: "checkbox", checked: sources.has(library.id) });
      const tag = sources.has(library.id)
        ? (sources.get(library.id) === "default" ? "（注册时继承）" : "（管理员授权）") : "";
      checks.set(library.id, check);
      listBox.append(el("label", { class: "check" }, check,
        el("span", { text: (library.name || library.id) + tag })));
    }

    // 组授权：勾一个组 = 该组当下及以后加入的库都可见（与上面的直授是并集）。
    const granted = new Set(asArray(groupGrants).map((g) => g.group_id));
    clear(groupsBox);
    groupChecks.clear();
    groupsBox.append(el("div", { class: "panel-title", text: "按分组授权（与上面的逐库授权是并集）" }));
    if (!groups.length) {
      groupsBox.append(el("div", { class: "muted", text: "还没有分组，可在「媒体库」页新建" }));
      return;
    }
    for (const group of groups) {
      const check = el("input", { type: "checkbox", checked: granted.has(group.id) });
      groupChecks.set(group.id, check);
      groupsBox.append(el("label", { class: "check" }, check,
        el("span", { text: (group.name || group.id) + "（" + (Number(group.library_count) || 0) + " 个库）" })));
    }
  }

  async function load() {
    setBanner(note, "");
    save.disabled = true;
    state.textContent = "读取中…";
    try {
      const result = await api.libraries();
      libraries = asArray(result && result.list);
      const groupResult = await api.libraryGroups();
      groups = asArray(groupResult && groupResult.list);
      const [view, groupView] = await Promise.all([
        api.userLibraries(user.id), api.userLibraryGroups(user.id),
      ]);
      paint(view && view.grants, groupView && groupView.grants);
      state.textContent = "已回读 " + asArray(view && view.library_ids).length + " 个直授库、" +
        asArray(groupView && groupView.group_ids).length + " 个授权组";
    } catch (err) {
      state.textContent = "";
      setBanner(note, err && err.message ? err.message : "读取失败");
    } finally { save.disabled = false; }
  }

  save.addEventListener("click", async () => {
    setBanner(note, "");
    save.disabled = true;
    state.textContent = "保存中…";
    const ids = [];
    for (const [id, check] of checks) if (check.checked) ids.push(id);
    const groupIds = [];
    for (const [id, check] of groupChecks) if (check.checked) groupIds.push(id);
    try {
      const view = await api.setUserLibraries(user.id, ids);
      const groupView = await api.setUserLibraryGroups(user.id, groupIds);
      paint(view && view.grants, groupView && groupView.grants);
      state.textContent = "已保存，回读 " + asArray(view && view.library_ids).length + " 个直授库、" +
        asArray(groupView && groupView.group_ids).length + " 个授权组";
      if (onSaved) onSaved();
    } catch (err) {
      setBanner(note, err && err.message ? err.message : "保存失败");
    } finally { save.disabled = false; }
  });

  selectAll.addEventListener("click", () => {
    for (const check of checks.values()) check.checked = true;
    for (const check of groupChecks.values()) check.checked = true;
  });
  selectNone.addEventListener("click", () => {
    for (const check of checks.values()) check.checked = false;
    for (const check of groupChecks.values()) check.checked = false;
  });
  body.append(listBox, groupsBox, el("div", { class: "actions" }, selectAll, selectNone, save), state);
  load();
}

/* ---------- 用户 ---------- */

function mountUsers(root) {
  const note = banner();
  const { table, body } = gridOf(["用户名", "显示名", "角色", "状态", "最后登录", "操作"]);
  const username = input({ placeholder: "用户名", required: true });
  const password = input({ type: "password", placeholder: "口令（至少 6 位）", required: true });
  const display = input({ placeholder: "显示名" });
  const role = selectFrom([{ value: "user", label: "user" }, { value: "admin", label: "admin" }]);
  const submit = el("button", { class: "btn primary", type: "submit", text: "新建用户" });

  const form = el("form", { class: "panel" },
    el("div", { class: "row" }, field("用户名", username), field("口令", password),
      field("显示名", display), field("角色", role)),
    el("div", { class: "actions" }, submit),
    note);

  async function refresh() {
    setBanner(note, "");
    try {
      const result = await api.users();
      const list = result && Array.isArray(result.list) ? result.list : [];
      clear(body);
      if (!list.length) body.append(emptyRow(6, "暂无用户"));
      for (const user of list) body.append(userRow(user));
      await loadNoLibraryHint();
    } catch (err) {
      setBanner(note, err && err.message ? err.message : "加载失败");
    }
  }

  // 有 0 授权的普通用户时常驻提示（提示失败不覆盖列表内容）。
  async function loadNoLibraryHint() {
    try {
      const data = await api.defaultLibraries();
      const n = Number(data && data.users_without_libraries) || 0;
      if (n > 0) setBanner(note, n + " 个用户还没有任何库，可在媒体库页补发默认可见库");
    } catch (err) { /* ignore */ }
  }

  function userRow(user) {
    async function patch(payload) {
      setBanner(note, "");
      try { await api.updateUser(user.id, payload); await refresh(); }
      catch (err) { setBanner(note, err && err.message ? err.message : "操作失败"); }
    }
    const newPassword = el("input", { class: "input tiny", type: "password", placeholder: "新口令（至少 6 位）" });
    const confirm = button("确定", async () => {
      if (!newPassword.value) return;
      await patch({ password: newPassword.value });
      newPassword.value = "";
      resetBox.classList.add("hidden");
    });
    const resetBox = el("div", { class: "actions hidden" }, newPassword, confirm);
    const actions = el("div", { class: "actions" });
    if (user.role !== "admin") {
      actions.append(button("媒体库权限", () => openUserLibrariesDrawer(user, refresh)));
    }
    actions.append(
      button("改角色", () => patch({ role: user.role === "admin" ? "user" : "admin" })),
      button(user.status === "active" ? "禁用" : "启用", () => patch({ status: user.status === "active" ? "disabled" : "active" })),
      button("重置口令", () => resetBox.classList.remove("hidden")));
    const holder = el("td", null, actions, resetBox);
    return rowOf([user.username, user.display_name, user.role, user.status, fmtDate(user.last_login_at), holder]);
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    setBanner(note, "");
    submit.disabled = true;
    try {
      await api.createUser({
        username: username.value.trim(),
        password: password.value,
        display_name: display.value.trim() || username.value.trim(),
        role: role.value,
      });
      username.value = "";
      password.value = "";
      display.value = "";
      await refresh();
    } catch (err) {
      setBanner(note, err && err.message ? err.message : "创建失败");
    } finally {
      submit.disabled = false;
    }
  });

  root.append(form, table);
  refresh();
}

/* ---------- 注册开关（条目 8） ---------- */

function mountSettings(root) {
  const note = banner();
  const box = el("div", { class: "panel" });
  const state = el("div", { class: "muted small-note" });
  const toggle = el("input", { type: "checkbox" });
  const label = el("label", { class: "check" }, toggle, el("span", { text: "允许任何人自助注册" }));
  const refresh = button("重新回读", () => load());
  box.append(el("div", { class: "row" }, label, refresh), state,
    el("div", { class: "muted small-note", text: "默认关；开关写回 config.json，回读一致才算生效。" }));
  root.append(note, box);

  function render(data) {
    toggle.checked = !!data.allow_register;
    const parts = ["生效值：" + (data.allow_register ? "开" : "关")];
    if (data.verified) parts.push("已回读复核");
    else parts.push("未复核" + (data.note ? "（" + data.note + "）" : ""));
    if (data.env_override) parts.push("ZV_ALLOW_REGISTER 已覆盖");
    state.textContent = parts.join("；");
  }

  async function load() {
    setBanner(note, "");
    try {
      render(await api.request("GET", "/api/v1/admin/settings"));
    } catch (err) {
      setBanner(note, err && err.message ? err.message : "加载失败");
    }
  }

  toggle.addEventListener("change", async () => {
    setBanner(note, "");
    toggle.disabled = true;
    try {
      render(await api.request("PATCH", "/api/v1/admin/settings", { allow_register: toggle.checked }));
    } catch (err) {
      setBanner(note, err && err.message ? err.message : "保存失败");
      await load();
    } finally {
      toggle.disabled = false;
    }
  });

  load();
}

/* ---------- 自动扫描（定时增量 + 文件事件） ---------- */

function autoScanRunText(run) {
  const labels = { success: "成功", partial: "部分成功", skipped: "跳过", failed: "失败" };
  const bits = [labels[run.status] || run.status || "未知"];
  bits.push("新增 " + (run.new_media || 0));
  bits.push("更新 " + (run.updated || 0));
  if (run.skipped) bits.push("跳过 " + run.skipped);
  if (run.failed) bits.push("失败 " + run.failed);
  return bits.join("，");
}

function clip(text, max) {
  const value = String(text || "");
  return value.length > max ? value.slice(0, max) + "…" : value;
}

function mountAutoScan(root) {
  const note = banner();
  const box = el("div", { class: "panel" });
  const state = el("div", { class: "muted" });
  const detail = el("div", { class: "muted small-note" });
  const toggle = el("input", { type: "checkbox" });
  const events = el("input", { type: "checkbox" });
  const interval = input({ type: "number", min: "1", max: "1440", class: "input" });
  const debounce = input({ type: "number", min: "5", max: "10", class: "input" });
  const save = button("保存", () => saveAll(), "primary");
  const runNow = button("立即扫描", () => runNowScan());
  const refresh = button("刷新", () => load());
  box.append(
    el("div", { class: "row" },
      el("label", { class: "check" }, toggle, el("span", { text: "启用自动扫描" })),
      el("label", { class: "check" }, events, el("span", { text: "文件变动即时触发" }))),
    el("div", { class: "row" },
      field("间隔（分钟 1-1440）", interval),
      field("去抖（秒 5-10）", debounce),
      save, runNow, refresh),
    state, detail,
    el("div", { class: "muted small-note", text: "事件监听不可用时自动退回定时扫描。" }));
  root.append(note, box);

  function render(data) {
    const s = data.settings || {};
    toggle.checked = !!s.enabled;
    events.checked = !!s.events_enabled;
    interval.value = String(s.interval_minutes || 5);
    debounce.value = String(s.debounce_seconds || 8);
    const last = data.last_run;
    state.textContent = (data.summary || "") + (last
      ? "；上次 " + fmtDate(last.started_at) + "：" + autoScanRunText(last)
      : "；尚无运行记录");
    const notes = [];
    if (!data.events_ok && data.events_note) notes.push(clip(data.events_note, 40));
    if (last && last.note) notes.push(clip(last.note, 40));
    detail.textContent = notes.join("；");
  }

  async function load() {
    setBanner(note, "");
    try {
      render(await api.autoScan());
    } catch (err) {
      setBanner(note, err && err.message ? err.message : "加载失败");
    }
  }

  async function saveAll() {
    setBanner(note, "");
    save.disabled = true;
    try {
      await api.saveAutoScan({
        enabled: toggle.checked,
        events_enabled: events.checked,
        interval_minutes: Number(interval.value),
        debounce_seconds: Number(debounce.value),
      });
      await load();
    } catch (err) {
      setBanner(note, err && err.message ? err.message : "保存失败");
    } finally {
      save.disabled = false;
    }
  }

  async function runNowScan() {
    setBanner(note, "");
    runNow.disabled = true;
    try {
      const data = await api.runAutoScan();
      const ids = asArray(data && data.task_ids);
      setBanner(note, ids.length ? "已排队 " + ids.length + " 个扫描任务" : (data.note || "本轮未启动扫描"));
      await load();
    } catch (err) {
      setBanner(note, err && err.message ? err.message : "触发失败");
    } finally {
      runNow.disabled = false;
    }
  }

  load();
}

/* ---------- 媒体去重（条目 11） ---------- */

function mountDuplicates(root) {
  const note = banner();
  const timers = [];
  const detect = el("button", { class: "btn primary", type: "button", text: "检测疑似重复" });
  const summary = el("div", { class: "muted" });
  const progress = el("div", { class: "muted" });
  const confirmInput = input({ placeholder: "输入「删除文件」才可删文件" });
  const groupsBox = el("div", { dataset: { role: "dup-groups" } });
  const selected = new Set();
  const picks = () => Array.from(groupsBox.querySelectorAll('[data-role="dup-pick"]'));

  // 每组一张面板 + 一组**可预览**的卡片：封面点开就是播放（用户 2026-09-22：
  // "去重要有疑似重复视频的预览，没有预览怎么操作"）。卡片组件与观看面同一份（cards.js）。
  function render(list) {
    clear(groupsBox);
    selected.clear();
    const groups = asArray(list);
    if (!groups.length) { groupsBox.append(el("div", { class: "muted", text: "没有疑似重复" })); return; }
    groups.forEach((group, index) => {
      const members = asArray(group && group.members);
      const grid = el("div", { class: "video-grid", dataset: { role: "dup-grid" } });
      for (const member of members) {
        const check = el("input", {
          type: "checkbox", title: "勾选后可用下方按钮删记录/删文件",
          dataset: { role: "dup-pick", id: String(member.id) },
        });
        check.addEventListener("change", () => {
          if (check.checked) selected.add(member.id); else selected.delete(member.id);
        });
        grid.append(videoCard(member, {
          href: "#/one/" + encodeURIComponent(member.id), // 点封面 = 预览播放这条
          badge: fmtBytes(member.size_bytes),
          leading: check,
          meta: [
            (member.library_name || member.library_id || "") + " · " + (member.file_exists ? "文件在" : "文件不在"),
            fmtDuration(member.duration_ms) + " · " + fmtDate(member.created_at),
            el("div", { class: "path", text: member.path || "" }),
          ],
        }));
      }
      groupsBox.append(el("div", {
        class: "panel", dataset: { role: "dup-group", index: String(index) },
      },
        el("div", { class: "panel-title",
          text: "疑似重复 " + members.length + " 个 · " + fmtBytes(group.size_bytes) + " · " + fmtDuration(group.duration_ms) }),
        el("div", { class: "muted small-note", text: "大小+时长相同只是疑似，不代表内容相同 —— 点封面即可预览播放再决定。" }),
        grid));
    });
  }

  async function load() {
    setBanner(note, "");
    detect.disabled = true;
    summary.textContent = "检测中…";
    try {
      const data = await api.request("GET", "/api/v1/admin/duplicates");
      render(asArray(data && data.groups));
      summary.textContent = (data.judgement || "") + " 共 " + (data.group_count || 0) +
        " 组 / " + (data.member_count || 0) + " 个";
    } catch (err) {
      summary.textContent = "";
      setBanner(note, err && err.message ? err.message : "检测失败");
    } finally {
      detect.disabled = false;
    }
  }

  function pollTask(taskId) {
    const timer = setInterval(async () => {
      try {
        const task = await api.request("GET", "/api/v1/scan-tasks/" + encodeURIComponent(taskId));
        progress.textContent = "删文件：" + (task.scanned || 0) + "/" + (task.total || 0) +
          "，成功 " + (task.updated || 0) + "，失败 " + (task.failed || 0);
        if (task.status === "success" || task.status === "failed" || task.status === "interrupted") {
          clearInterval(timer);
          progress.textContent += "（" + task.status + "）" + (task.error ? "：" + task.error : "");
          load();
        }
      } catch (err) {
        clearInterval(timer);
        setBanner(note, err && err.message ? err.message : "查询任务失败");
      }
    }, 1000);
    timers.push(timer);
  }

  const delRecords = button("删除所选面板记录", async () => {
    const ids = Array.from(selected);
    if (!ids.length) { setBanner(note, "请先勾选记录"); return; }
    if (!window.confirm("只删面板记录，磁盘文件保留。继续？")) return;
    setBanner(note, "");
    try {
      const data = await api.request("POST", "/api/v1/admin/duplicates/delete-records", { ids });
      await load();
      setBanner(note, "已删除 " + (data.deleted || 0) + " 条记录，文件未动");
    } catch (err) {
      setBanner(note, err && err.message ? err.message : "删除失败");
    }
  });

  const delFiles = button("删除所选文件（危险）", async () => {
    const ids = Array.from(selected);
    if (!ids.length) { setBanner(note, "请先勾选文件"); return; }
    const typed = confirmInput.value.trim();
    if (typed !== "删除文件") { setBanner(note, "请手动输入「删除文件」确认"); return; }
    if (!window.confirm("永久删除磁盘上的 " + ids.length + " 个文件，不可恢复。继续？")) return;
    setBanner(note, "");
    try {
      const data = await api.request("POST", "/api/v1/admin/duplicates/delete-files",
        { ids, confirm: typed });
      confirmInput.value = "";
      setBanner(note, "任务 " + data.task_id + " 已提交，共 " + (data.total || 0) + " 个");
      pollTask(data.task_id);
    } catch (err) {
      setBanner(note, err && err.message ? err.message : "提交失败");
    }
  }, "danger");

  const pickAll = button("全选", () => {
    for (const box of picks()) { box.checked = true; selected.add(box.dataset.id); }
  });
  const pickNone = button("清空选择", () => {
    for (const box of picks()) { box.checked = false; }
    selected.clear();
  });
  root.append(note, el("div", { class: "panel" },
    el("div", { class: "row" }, detect, summary),
    el("div", { class: "muted small-note", text: "判据：大小 + 时长相同 ⇒ 疑似重复，不代表内容相同；点封面可预览。" }),
    el("div", { class: "row" }, pickAll, pickNone, delRecords, confirmInput, delFiles), progress), groupsBox);
  load();

  return () => { for (const timer of timers) clearInterval(timer); };
}

/* ---------- 系统 ---------- */

function mountSystem(root) {
  const note = banner();
  const box = el("div", { class: "panel" });
  root.append(note, box);

  api.systemInfo().then((info) => {
    const ffmpeg = info.ffmpeg || {};
    const ffprobe = info.ffprobe || {};
    const disk = info.disk || {};
    const counts = info.counts || {};
    clear(box);
    box.append(
      kv("版本", info.version),
      kv("Go 版本", info.go_version),
      kv("监听", info.listen),
      kv("数据目录", info.data_dir || disk.data_dir),
      kv("ffmpeg", ffmpeg.version),
      kv("ffmpeg 路径", ffmpeg.path),
      kv("VideoToolbox H.264", ffmpeg.videotoolbox_h264 ? "支持" : "不支持"),
      kv("ffprobe", ffprobe.version),
      kv("ffprobe 路径", ffprobe.path),
      kv("磁盘可用", fmtBytes(disk.free_bytes)),
      kv("磁盘总量", fmtBytes(disk.total_bytes)),
      kv("媒体库 / 媒体 / 失败", (counts.libraries || 0) + " / " + (counts.media || 0) + " / " + (counts.failed || 0)));
  }).catch((err) => {
    setBanner(note, err && err.message ? err.message : "加载失败");
  });
}

/* ---------- 容器 ---------- */

export function mountAdmin(view, initialTab) {
  const note = banner();
  const tabs = el("nav", { class: "tabs" });
  const panel = el("div", { class: "admin-body" });
  // 条目 12：顶部固定的「返回播放」，Esc 也能回播放页
  const back = el("a", {
    class: "btn small admin-back", href: "#/feed", text: "← 返回播放",
    dataset: { role: "back-to-feed" },
  });
  function onBackKey(event) {
    if (event.key !== "Escape") return;
    if (document.querySelector(".modal-overlay, .picker-overlay")) return;
    event.preventDefault();
    location.hash = "#/feed";
  }
  document.addEventListener("keydown", onBackKey);
  const definitions = [
    { key: "libraries", label: "媒体库", mount: mountLibraries },
    { key: "media", label: "媒体", mount: mountMedia },
    { key: "series", label: "剧场", mount: mountSeriesTab },
    { key: "roots", label: "媒体允许根", mount: mountRoots },
    { key: "users", label: "用户", mount: mountUsers },
    { key: "settings", label: "注册开关", mount: mountSettings },
    { key: "autoscan", label: "自动扫描", mount: mountAutoScan },
    { key: "duplicates", label: "媒体去重", mount: mountDuplicates },
    { key: "system", label: "系统", mount: mountSystem },
  ];
  const tabButtons = new Map();
  let cleanup = null;
  let activeKey = "";

  function select(key) {
    if (key === activeKey) return;
    activeKey = key;
    if (cleanup) { try { cleanup(); } catch (err) { /* ignore */ } cleanup = null; }
    clear(panel);
    for (const [tabKey, node] of tabButtons) node.classList.toggle("on", tabKey === key);
    const definition = definitions.filter((item) => item.key === key)[0];
    if (definition) cleanup = definition.mount(panel) || null;
  }

  for (const definition of definitions) {
    const tabButton = el("button", { class: "tab", type: "button", text: definition.label, onclick: () => select(definition.key) });
    tabButtons.set(definition.key, tabButton);
    tabs.append(tabButton);
  }

  view.append(el("div", { class: "admin" }, back, note,
    el("div", { class: "muted small-note", text: "剧场的新建/导入/识别/上传/管理都在「剧场」页签" }),
    tabs, panel));
  select(tabButtons.has(initialTab) ? initialTab : "libraries");

  return () => {
    document.removeEventListener("keydown", onBackKey);
    if (cleanup) cleanup();
  };
}
