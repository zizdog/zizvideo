// 用户管理页签 + 「媒体库权限」抽屉（从 admin.js 原样搬家，行为不变）

import { api } from "./api.js";
import { el, clear, banner, setBanner, field, input, fmtDate, asArray } from "./dom.js";
import { button, rowOf, emptyRow, gridOf, selectFrom } from "./admin-shared.js";

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
  // 管理员默认全见：勾了库/组才收窄（用户 2026-09-23："后台可以为管理员设置访问范围"）
  const adminHint = user.role === "admin"
    ? el("div", { class: "muted small-note", dataset: { role: "admin-scope-hint" },
        text: "管理员默认可见全部库；一旦勾选就只可见勾选的库，全部清空 = 恢复全部。" })
    : null;
  // 逐库列表按分组折叠（用户 2026-09-23："将分组显示在上面。或者，媒体库可以折叠显示"）：
  // 折叠状态与「媒体库」页共用同一个 localStorage 键，在哪折的在哪都折着。
  const COLLAPSE_KEY = "zv_admin_collapsed_groups";
  const collapsed = (() => {
    try { return new Set(JSON.parse(localStorage.getItem(COLLAPSE_KEY) || "[]")); } catch (err) { return new Set(); }
  })();
  function saveCollapsed() {
    try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify(Array.from(collapsed))); } catch (err) { /* 隐私模式忽略 */ }
  }
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
    listBox.append(el("div", { class: "panel-title", text: "逐库授权（与上面的分组授权是并集）" }));
    if (!libraries.length) { listBox.append(el("div", { class: "muted", text: "暂无媒体库" })); }
    const known = new Set(groups.map((g) => g.id));
    const section = (title, key, members) => {
      const rows = members.map((library) => {
        const check = el("input", { type: "checkbox", checked: sources.has(library.id) });
        const tag = sources.has(library.id)
          ? (sources.get(library.id) === "default" ? "（注册时继承）" : "（管理员授权）") : "";
        checks.set(library.id, check);
        return el("label", { class: "check" }, check, el("span", { text: (library.name || library.id) + tag }));
      });
      const caret = el("button", { class: "btn small", type: "button", dataset: { role: "group-toggle" },
        style: { minWidth: "28px" } });
      const head = el("div", { class: "group-head", dataset: { role: "group-row", group: title } },
        el("div", { class: "row" }, caret, el("span", { text: title }),
          el("span", { class: "muted small-note", text: members.length + " 个库" })));
      const apply = () => {
        const on = collapsed.has(key);
        caret.textContent = on ? "▸" : "▾";
        caret.title = on ? "展开这一组" : "折叠这一组";
        for (const row of rows) row.hidden = on;
      };
      caret.addEventListener("click", (event) => {
        event.preventDefault();
        if (collapsed.has(key)) collapsed.delete(key); else collapsed.add(key);
        saveCollapsed();
        apply();
      });
      listBox.append(head);
      for (const row of rows) listBox.append(row);
      apply();
    };
    for (const group of groups) {
      section(group.name || group.id, group.id, libraries.filter((library) => library.group_id === group.id));
    }
    section("未分组", "__ungrouped__",
      libraries.filter((library) => !library.group_id || !known.has(library.group_id)));

    // 组授权：勾一个组 = 该组当下及以后加入的库都可见（与上面的直授是并集）。
    const granted = new Set(asArray(groupGrants).map((g) => g.group_id));
    clear(groupsBox);
    groupChecks.clear();
    groupsBox.append(el("div", { class: "panel-title", text: "按分组授权（勾一个组 = 该组现在及以后加入的库都可见）" }));
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
  // 分组授权放上面、逐库授权放下面（用户 2026-09-23："应该将分组显示在上面"）
  body.append(...(adminHint ? [adminHint] : []), groupsBox, listBox,
    el("div", { class: "actions" }, selectAll, selectNone, save), state);
  load();
}

/* ---------- 用户 ---------- */

export function mountUsers(root) {
  const note = banner();
  const { table, body } = gridOf(["用户名", "显示名", "角色", "状态", "上传", "最后登录", "操作"]);
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
      if (!list.length) body.append(emptyRow(7, "暂无用户"));
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
    // 管理员也能设范围（用户 2026-09-23："后台可以为管理员设置访问范围"）：
    // 管理员默认全见，一旦勾了库就收窄到那些库（清空 = 恢复全见，抽屉里有说明）。
    actions.append(button("媒体库权限", () => openUserLibrariesDrawer(user, refresh)));
    actions.append(
      button("改角色", () => patch({ role: user.role === "admin" ? "user" : "admin" })),
      button(user.status === "active" ? "禁用" : "启用", () => patch({ status: user.status === "active" ? "disabled" : "active" })),
      button("重置口令", () => resetBox.classList.remove("hidden")));
    const holder = el("td", null, actions, resetBox);
    // 上传白名单（用户 2026-09-24）：管理员天然能传，这里只管普通用户。
    const uploadCell = user.role === "admin"
      ? el("span", { class: "muted", text: "管理员" })
      : button(user.can_upload ? "禁止上传" : "允许上传",
        () => patch({ can_upload: !user.can_upload }));
    return rowOf([user.username, user.display_name, user.role, user.status, uploadCell,
      fmtDate(user.last_login_at), holder]);
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
