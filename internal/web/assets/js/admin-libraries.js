// 媒体管理页签：媒体库 / 分组 / 新用户默认可看库（从 admin.js 原样搬家，行为不变）

import { api } from "./api.js";
import { el, clear, banner, setBanner, field, input, fmtDate, asArray } from "./dom.js";
import { openDirectoryPicker } from "./roots.js";
import { uploadToLibrary } from "./uploads.js";
import { confirmDialog } from "./confirm.js";
import { button, rowOf, emptyRow, gridOf, selectFrom } from "./admin-shared.js";

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

export function mountLibraries(root) {
  const note = banner();
  const timers = [];
  const { table, body } = gridOf(["名称", "类型", "根目录", "递归", "启用", "分组", "新用户默认可看", "创建时间", "操作"]);
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
  // 库类型（用户 2026-10-10 的 Jellyfin 式模型）：创建时选定，决定扫描规则、归组方式与
  // 后台归属 —— 短视频库（散片，一条视频一个条目）/ 短剧库（库根一级目录=一部剧）。
  const kindSelect = el("select", { class: "input", dataset: { role: "library-kind" } },
    el("option", { value: "short", text: "短视频库（散片）" }),
    el("option", { value: "drama", text: "短剧库（目录=一部剧）" }));
  const kindNote = el("div", { class: "muted small-note",
    text: "短视频库：一条视频就是一个条目，首页刷它；短剧库：库根下每个目录算一部剧，只进「剧场」，首页永不出现。" });
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
    el("div", { class: "row" }, field("库类型", kindSelect)),
    kindNote,
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
      kindSelect.value = library.kind === "drama" ? "drama" : "short";
      submit.textContent = "保存";
      cancel.hidden = false;
    } else {
      nameInput.value = "";
      pathInput.value = "";
      recursive.checked = true;
      enabled.checked = true;
      ignoreInput.value = "";
      kindSelect.value = "short";
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
      if (!list.length) body.append(emptyRow(9, "暂无媒体库"));
      // 按组分区显示：每组一个小标题行（带整组操作），最后是"未分组"。
      // 组顺序按后端给的 sort_order；库在组内保持原来的创建顺序。
      const known = new Set(groups.map((g) => g.id));
      for (const group of groups) {
        const members = list.filter((library) => library.group_id === group.id);
        const rows = [];
        if (!members.length) {
          rows.push(emptyRow(9, "这个分组还没有媒体库 —— 用右侧「分组」下拉把库归进来"));
        }
        for (const library of members) rows.push(libraryRow(library));
        const head = groupHeaderRow(group, members);
        body.append(head);
        for (const row of rows) body.append(row);
        wireGroupToggle(head, rows, group.id);
      }
      const rest = list.filter((library) => !library.group_id || !known.has(library.group_id));
      if (rest.length) {
        const rows = rest.map((library) => libraryRow(library));
        const head = sectionHeaderRow("未分组", rest.length, []);
        body.append(head);
        for (const row of rows) body.append(row);
        wireGroupToggle(head, rows, "__ungrouped__");
      }
      // 库里引用了不存在的分组（理论上不该发生）会被算进"未分组"，不需要额外提示。
    } catch (err) {
      setBanner(note, err && err.message ? err.message : "加载失败");
    }
    await loadBackfill();
  }

  // sectionHeaderRow 是一行跨列的区块标题：折叠箭头 + 组名 + 库数 + 该组的操作按钮。
  // 折叠状态记在 localStorage（用户 2026-09-22：分组要能折叠显示），刷新后保持。
  const COLLAPSE_KEY = "zv_admin_collapsed_groups";
  function loadCollapsed() {
    try { return new Set(JSON.parse(localStorage.getItem(COLLAPSE_KEY) || "[]")); } catch (err) { return new Set(); }
  }
  function saveCollapsed(set) {
    try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify(Array.from(set))); } catch (err) { /* 隐私模式忽略 */ }
  }
  const collapsedGroups = loadCollapsed();

  function wireGroupToggle(headerRow, rows, key) {
    const caret = headerRow.querySelector('[data-role="group-toggle"]');
    if (!caret) return;
    const apply = () => {
      const on = collapsedGroups.has(key);
      caret.textContent = on ? "▸" : "▾";
      caret.title = on ? "展开这一组" : "折叠这一组";
      for (const row of rows) row.hidden = on;
    };
    caret.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (collapsedGroups.has(key)) collapsedGroups.delete(key); else collapsedGroups.add(key);
      saveCollapsed(collapsedGroups);
      apply();
    });
    apply();
  }

  function sectionHeaderRow(title, count, actions) {
    return el("tr", null, el("td", {
      colspan: "8",
      style: { background: "var(--panel)", fontWeight: "620" },
      dataset: { role: "group-row", group: title },
    }, el("div", { class: "row" },
      el("button", { class: "btn small", type: "button", text: "▾",
        dataset: { role: "group-toggle" }, style: { minWidth: "28px" } }),
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
    // ⚠️ 不能用浏览器原生的 prompt/confirm：App/电视的 WebChromeClient 没 override
    //    onJsPrompt/onJsConfirm，返回值恒假 ⇒ 危险操作在这两种端上静默失效（点删除没反应）。
    const next = await confirmDialog({
      title: "重命名分组",
      message: "只改分组名，组内的库和文件都不动。",
      input: { value: group.name || "", placeholder: "分组名" },
      confirmText: "保存", danger: false,
    });
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
    // 见 renameGroup 的说明：确认框一律用项目自己的（App/电视上原生 confirm 恒假）
    const okDel = await confirmDialog({
      title: "删除分组「" + group.name + "」",
      message: "组内 " + group.library_count + " 个库会回到未分组，库和文件都保留。",
      confirmText: "删除分组",
    });
    if (!okDel) return;
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
        // 见 renameGroup 的说明：确认框一律用项目自己的（App/电视上原生 confirm 恒假）
        const okDel = await confirmDialog({
          title: "删除媒体库「" + (library.name || library.id) + "」",
          message: "库和库里的媒体记录会一起删掉（磁盘上的文件保留）。",
          confirmText: "删除媒体库",
        });
        if (!okDel) return;
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
    const kindCell = el("div", { class: "row" },
      el("span", { class: "muted", text: library.kind === "drama" ? "短剧库" : "短视频库" }),
      button("改类型", async () => {
        const to = library.kind === "drama" ? "short" : "drama";
        const toLabel = to === "drama" ? "短剧库" : "短视频库";
        // 改类型会改变内容的可见性（短剧库的内容会从首页消失、只进剧场），必须说清后果
        const ok = await confirmDialog({
          title: "把「" + (library.name || library.id) + "」改成" + toLabel + "？",
          message: to === "drama"
            ? "库里的文件与记录都不动；这个库的内容会从首页消失，改由「短剧管理」按目录归剧。"
            : "库里的文件与记录都不动；这个库的内容会重新出现在首页，剧场归组不再生效。",
          confirmText: "改成" + toLabel, danger: to === "drama",
        });
        if (!ok) return;
        try { await api.updateLibrary(library.id, { kind: to }); await refresh(); }
        catch (err) { setBanner(note, err && err.message ? err.message : "改类型失败"); }
      }));
    return rowOf([library.name, kindCell, library.root_path, library.recursive ? "是" : "否",
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
      kind: kindSelect.value,
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
