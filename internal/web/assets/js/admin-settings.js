// 注册开关 + 扫描媒体两个页签（从 admin.js 原样搬家，行为不变）

import { api } from "./api.js";
import { el, banner, setBanner, field, input, fmtDate, asArray } from "./dom.js";
import { button } from "./admin-shared.js";

/* ---------- 注册开关（条目 8） ---------- */

export function mountSettings(root) {
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

export function mountAutoScan(root) {
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
