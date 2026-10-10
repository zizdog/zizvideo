// 管理后台：页签容器（左侧栏 / 折叠 / 返回）+ 媒体去重页签
//
// 各页签实现按职责拆到 admin-*.js（纯搬家，零行为变化）：
//   admin-shared.js     共用小件（按钮 / 单元格 / 表格 / 下拉）
//   admin-libraries.js  媒体管理（媒体库 / 分组）
//   admin-roots.js      媒体目录（允许根）
//   admin-media.js      散片管理（列表 / 清理 / 转码）
//   admin-users.js      用户管理（含媒体库权限抽屉）
//   admin-settings.js   注册开关 + 扫描媒体
//   admin-tasks.js      任务中心
//   admin-system.js     系统信息（磁盘 / 备份 / 恢复）
// 媒体去重留在本文件：Go 门禁 frontend_assets_test.go 把三条 asArray 收敛断言钉在 admin.js 上，
// 搬走会让 make check 变红，而本轮不许改 Go；待后续与门禁一起搬。

import { api } from "./api.js";
import { el, clear, banner, setBanner, input, fmtDuration, fmtBytes, fmtDate, asArray } from "./dom.js";
import { videoCard, stopInlinePlayers } from "./cards.js";
import { icon } from "./icons.js";
import { confirmDialog } from "./confirm.js";
import { mountSeriesTab } from "./admin-series.js";
import { mountUploadsTab } from "./uploads-tab.js";
import { button } from "./admin-shared.js";
import { mountLibraries } from "./admin-libraries.js";
import { mountRoots } from "./admin-roots.js";
import { mountMedia } from "./admin-media.js";
import { mountUsers } from "./admin-users.js";
import { mountSettings, mountAutoScan } from "./admin-settings.js";
import { mountTasks } from "./admin-tasks.js";
import { mountSystem } from "./admin-system.js";

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
      // 用户 2026-09-24："去重不应该有全选，而是每组重复保留一个" ——
      // 默认就是"每组留一条"（后端按 created_at ASC 给，所以留最早入库的那条），用户可再单独改。
      const grid = el("div", { class: "video-grid large", dataset: { role: "dup-grid" } });
      members.forEach((member, mi) => {
        const keeper = mi === 0;
        const check = el("input", {
          type: "checkbox", title: keeper ? "默认保留这条（想删它就先勾上别的）" : "勾选后可用下方按钮删记录/删文件",
          dataset: { role: "dup-pick", id: String(member.id), keeper: keeper ? "1" : "" },
        });
        check.checked = !keeper;
        if (!keeper) selected.add(member.id);
        check.addEventListener("change", () => {
          if (check.checked) selected.add(member.id); else selected.delete(member.id);
        });
        grid.append(videoCard(member, {
          playInline: true, // 点封面在**这张卡里**播（用户 2026-09-23：不要放大播放，原位置播放）
          badge: fmtBytes(member.size_bytes),
          leading: check,
          meta: [
            keeper ? el("div", { class: "dup-keeper", dataset: { role: "dup-keeper" }, text: "默认保留这条" }) : null,
            (member.library_name || member.library_id || "") + " · " + (member.file_exists ? "文件在" : "文件不在"),
            fmtDuration(member.duration_ms) + " · " + fmtDate(member.created_at),
            el("div", { class: "path", text: member.path || "" }),
          ].filter(Boolean),
        }));
      });
      groupsBox.append(el("div", {
        class: "panel", dataset: { role: "dup-group", index: String(index) },
      },
        el("div", { class: "panel-title",
          text: "疑似重复 " + members.length + " 个 · " + fmtBytes(group.size_bytes) + " · " + fmtDuration(group.duration_ms) }),
        el("div", { class: "muted small-note", text: "大小+时长相同只是疑似，不代表内容相同 —— 点封面就地播放，再点收起；默认每组保留一条，其余已勾好。" }),
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

  const delRecords = button("删除勾选的重复记录", async () => {
    const ids = Array.from(selected);
    if (!ids.length) { setBanner(note, "请先勾选要删的（每组默认保留一条）"); return; }
    if (groupWouldEmpty()) { setBanner(note, "每组至少要留一条，别把整组都删了"); return; }
    // 见 renameGroup 的说明：确认框一律用项目自己的（App/电视上原生 confirm 恒假）
    const okRecords = await confirmDialog({
      title: "删除 " + ids.length + " 条重复记录",
      message: "只删面板记录，磁盘文件保留。",
      confirmText: "删除记录",
    });
    if (!okRecords) return;
    setBanner(note, "");
    try {
      const data = await api.request("POST", "/api/v1/admin/duplicates/delete-records", { ids });
      await load();
      setBanner(note, "已删除 " + (data.deleted || 0) + " 条记录，文件未动");
    } catch (err) {
      setBanner(note, err && err.message ? err.message : "删除失败");
    }
  });

  const delFiles = button("删除勾选的文件（危险）", async () => {
    const ids = Array.from(selected);
    if (!ids.length) { setBanner(note, "请先勾选要删的文件（每组默认保留一条）"); return; }
    if (groupWouldEmpty()) { setBanner(note, "每组至少要留一条，别把整组都删了"); return; }
    const typed = confirmInput.value.trim();
    if (typed !== "删除文件") { setBanner(note, "请手动输入「删除文件」确认"); return; }
    // 见 renameGroup 的说明：确认框一律用项目自己的（App/电视上原生 confirm 恒假）
    const okFiles = await confirmDialog({
      title: "永久删除 " + ids.length + " 个文件",
      message: "永久删除磁盘上的 " + ids.length + " 个文件，不可恢复。",
      confirmText: "永久删除",
    });
    if (!okFiles) return;
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

  // 默认选中 = 每组除保留项之外全部；这两个按钮只做"恢复默认 / 都不选"。
  function selectDefaults() {
    selected.clear();
    for (const box of picks()) {
      const keeper = box.dataset.keeper === "1";
      box.checked = !keeper;
      if (!keeper) selected.add(box.dataset.id);
    }
  }
  const pickDefaults = button("恢复默认（每组留一个）", selectDefaults);
  const pickNone = button("都不选", () => {
    for (const box of picks()) box.checked = false;
    selected.clear();
  });
  // 每组至少留一条：整组都被勾上就拒绝（用户 2026-09-24 明确"每组重复保留一个"）
  function groupWouldEmpty() {
    for (const grid of groupsBox.querySelectorAll('[data-role="dup-grid"]')) {
      const boxes = Array.from(grid.querySelectorAll('[data-role="dup-pick"]'));
      if (boxes.length && boxes.every((box) => box.checked)) return true;
    }
    return false;
  }
  root.append(note, el("div", { class: "panel" },
    el("div", { class: "row" }, detect, summary),
    el("div", { class: "muted small-note", text: "判据：大小 + 时长相同 ⇒ 疑似重复，不代表内容相同；点封面就地播放。" }),
    el("div", { class: "row" }, pickDefaults, pickNone, delRecords, confirmInput, delFiles), progress), groupsBox);
  load();

  return () => {
    for (const timer of timers) clearInterval(timer);
    stopInlinePlayers(); // 换页/重新检测时别把声音留在后台
  };
}

/* ---------- 容器 ---------- */

// 左边栏折叠状态（用户 2026-10-01："左边栏菜单 + 可折叠成图标"）：记在本机，下次进来还是那个样子。
const ADMIN_NAV_KEY = "zv_admin_nav";

function loadNavCollapsed() {
  try {
    const saved = localStorage.getItem(ADMIN_NAV_KEY);
    if (saved === "collapsed") return true;
    if (saved === "expanded") return false;
  } catch (err) { /* 隐私模式：直接按屏宽判断 */ }
  // 没存过：窄屏（手机）默认折成图标栏 —— 展开的 190px 会把内容挤没
  return window.innerWidth < 760;
}

function saveNavCollapsed(collapsed) {
  try { localStorage.setItem(ADMIN_NAV_KEY, collapsed ? "collapsed" : "expanded"); } catch (err) { /* ignore */ }
}

export function mountAdmin(view, initialTab) {
  const note = banner();
  const panel = el("div", { class: "admin-body" });
  const nav = el("nav", { class: "admin-nav", dataset: { role: "admin-nav" } });
  const side = el("aside", { class: "admin-side", dataset: { role: "admin-side" } });
  // 条目 12：顶部固定的「返回播放」，Esc 也能回播放页
  // 「返回播放」不再放这里：顶栏已经有返回键（用户 2026-09-23 要抖音式顶栏）。Esc 快捷方式保留。
  function onBackKey(event) {
    if (event.key !== "Escape") return;
    if (document.querySelector(".modal-overlay, .picker-overlay")) return;
    event.preventDefault();
    location.hash = "#/feed";
  }
  document.addEventListener("keydown", onBackKey);
  // ⚠️ 版块名一律**四个字**（用户 2026-10-01："所有版块改为 4 个字"：媒体根目录→媒体目录、
  // 扫描→扫描媒体）。改名字时字数要对得上，不然左边栏一行长一行短。
  const definitions = [
    { key: "libraries", label: "媒体管理", icon: "grid", mount: mountLibraries },
    { key: "media", label: "散片管理", icon: "play", mount: mountMedia },
    { key: "series", label: "短剧管理", icon: "theater", mount: mountSeriesTab },
    { key: "roots", label: "媒体目录", icon: "home", mount: mountRoots },
    { key: "uploads", label: "上传审核", icon: "up", mount: mountUploadsTab },
    { key: "users", label: "用户管理", icon: "person", mount: mountUsers },
    { key: "settings", label: "注册开关", icon: "gear", mount: mountSettings },
    { key: "autoscan", label: "扫描媒体", icon: "scan", mount: mountAutoScan },
    { key: "tasks", label: "任务中心", icon: "clock", mount: mountTasks },
    { key: "duplicates", label: "重复检测", icon: "clean", mount: mountDuplicates },
    { key: "system", label: "系统信息", icon: "speed", mount: mountSystem },
  ];
  const tabButtons = new Map();
  let cleanup = null;
  let activeKey = "";

  function select(key) {
    if (key === activeKey) return;
    activeKey = key;
    if (cleanup) { try { cleanup(); } catch (err) { /* ignore */ } cleanup = null; }
    clear(panel);
    for (const [tabKey, node] of tabButtons) {
      node.classList.toggle("on", tabKey === key);
      node.setAttribute("aria-current", tabKey === key ? "true" : "false");
    }
    const definition = definitions.filter((item) => item.key === key)[0];
    if (definition) cleanup = definition.mount(panel) || null;
  }

  for (const definition of definitions) {
    // title 就是版块名：折成图标栏时全靠它认（鼠标悬停/读屏都读得到）
    const tabButton = el("button", {
      class: "admin-tab", type: "button", title: definition.label,
      dataset: { role: "admin-tab", tab: definition.key },
      onclick: () => select(definition.key),
    }, icon(definition.icon), el("span", { class: "admin-label", text: definition.label }));
    tabButtons.set(definition.key, tabButton);
    nav.append(tabButton);
  }

  // 折叠 = 只剩图标（用户 2026-10-01）。
  let collapsed = loadNavCollapsed();
  const toggle = el("button", {
    class: "admin-toggle", type: "button", dataset: { role: "admin-toggle" },
    onclick: () => {
      collapsed = !collapsed;
      saveNavCollapsed(collapsed);
      paintCollapsed();
    },
  });
  function paintCollapsed() {
    clear(toggle);
    toggle.append(icon(collapsed ? "expand" : "collapse"));
    const text = collapsed ? "展开菜单" : "折叠菜单";
    toggle.setAttribute("title", text);
    toggle.setAttribute("aria-label", text);
    side.classList.toggle("collapsed", collapsed);
  }
  side.append(toggle, nav);
  paintCollapsed();

  // 用户 2026-09-24："管理后台页面没有返回入口" —— 顶栏只在播放页显示，后台自己带一个返回。
  const back = el("a", { class: "btn small", href: "#/me", dataset: { role: "admin-back" }, text: "← 返回「我的」" });
  view.append(el("div", { class: "admin" },
    side,
    el("div", { class: "admin-main" },
      el("div", { class: "row" }, back),
      note,
      el("div", { class: "muted", text: "短剧的新建/导入/识别/上传/管理都在「短剧管理」版块；散片在「散片管理」。" }),
      el("div", { class: "muted", text: "请确保添加了正确的【媒体目录】，默认为【用户/视频】文件夹。" }),
      el("div", { class: "muted", text: "新建库时选类型：短视频库=散片（首页刷），短剧库=目录即一部剧（只进剧场）。" }),
      panel)));
  select(tabButtons.has(initialTab) ? initialTab : "libraries");

  return () => {
    document.removeEventListener("keydown", onBackKey);
    if (cleanup) cleanup();
  };
}
