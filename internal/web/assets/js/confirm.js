// 二次确认弹窗：危险操作（清除记录/删除剧场/驳回上传）必须先确认再执行。
//
// 返回值约定：不带 opts.input 时 resolve(true/false)；带 input 时 resolve(输入的字符串) 或 null（取消）。
// 老调用方都不传 input，行为完全不变。

import { el } from "./dom.js";
import { tvMode } from "./tv.js";

// 路由切换时 app.js 的 closeOverlays() 会广播它：浮层节点被统一摘掉，等结果的 Promise 要收尾。
const TEARDOWN_EVENT = "zv:overlay-teardown";

export function confirmDialog(options) {
  const opts = options || {};
  const inputOpt = opts.input || null;
  return new Promise((resolve) => {
    const overlay = el("div", { class: "modal-overlay", dataset: { role: "confirm-modal" } });
    const field = inputOpt
      ? el("input", { class: "input", type: "text", placeholder: inputOpt.placeholder || "",
          value: inputOpt.value || "", dataset: { role: "confirm-input" } })
      : null;
    let done = false;

    function close(ok) {
      if (done) return;
      if (ok && field && inputOpt.required && !field.value.trim()) {
        field.classList.add("invalid");
        field.focus();
        return;
      }
      done = true;
      document.removeEventListener("keydown", onKey);
      document.removeEventListener(TEARDOWN_EVENT, onTeardown);
      overlay.remove();
      resolve(field ? (ok ? field.value.trim() : null) : !!ok);
    }

    function onKey(event) {
      if (event.key === "Escape") { event.preventDefault(); close(false); }
    }

    // 路由切换会把 body 上残留的浮层统一摘掉（见 app.js 的 closeOverlays）：节点都没了，
    // 这个 await 必须有个结果 —— 按"用户取消"收尾，调用方就什么都不做。
    function onTeardown() {
      if (done) return;
      done = true;
      document.removeEventListener("keydown", onKey);
      document.removeEventListener(TEARDOWN_EVENT, onTeardown);
      resolve(field ? null : false);
    }

    const cancel = el("button", {
      class: "btn", type: "button", text: opts.cancelText || "取消",
      dataset: { role: "cancel" }, onclick: () => close(false),
    });
    const ok = el("button", {
      class: "btn " + (opts.danger === false ? "primary" : "danger"), type: "button",
      text: opts.confirmText || "确认", dataset: { role: "confirm" }, onclick: () => close(true),
    });
    overlay.append(el("div", { class: "modal", role: "dialog", "aria-modal": "true" },
      el("div", { class: "modal-title", text: opts.title || "确认操作" }),
      el("div", { class: "modal-text", text: opts.message || "" }),
      field,
      el("div", { class: "actions modal-actions" }, cancel, ok)));
    overlay.addEventListener("click", (event) => { if (event.target === overlay) close(false); });
    document.addEventListener("keydown", onKey);
    document.addEventListener(TEARDOWN_EVENT, onTeardown);
    document.body.append(overlay);
    // 打开就落焦：电视端没有鼠标，不落焦的话遥控器的"确定"会先被底下那层面板吃掉。
    // ⚠️ 电视端+危险确认（删除一类）默认落到**「取消」**上：遥控器上"多按一下确定"就是真删，
    //    危险按钮不该是默认落点（同 focusFirst 里"别落在 .danger 上"那条，见 docs/坑清单 44）。
    if (field) field.focus();
    else if (tvMode() && opts.danger !== false) cancel.focus();
    else ok.focus();
  });
}

// choiceDialog 给"两个都算确认"的危险操作（前台删除：只删记录 / 连文件一起删）。
// 返回所选 choice.value；取消或 Esc 返回 null。
export function choiceDialog(options) {
  const opts = options || {};
  return new Promise((resolve) => {
    const overlay = el("div", { class: "modal-overlay", dataset: { role: opts.role || "choice-modal" } });
    let done = false;

    function close(value) {
      if (done) return;
      done = true;
      document.removeEventListener("keydown", onKey);
      document.removeEventListener(TEARDOWN_EVENT, onTeardown);
      overlay.remove();
      resolve(value === undefined ? null : value);
    }

    function onKey(event) {
      if (event.key === "Escape") { event.preventDefault(); close(null); }
    }

    // 同 confirmDialog：路由切换把浮层摘掉时按"取消"（null）收尾，别让 await 永远挂着。
    function onTeardown() {
      if (done) return;
      done = true;
      document.removeEventListener("keydown", onKey);
      document.removeEventListener(TEARDOWN_EVENT, onTeardown);
      resolve(null);
    }

    const actions = el("div", { class: "actions modal-actions" },
      el("button", {
        class: "btn", type: "button", text: opts.cancelText || "取消",
        dataset: { role: "cancel" }, onclick: () => close(null),
      }));
    for (const choice of opts.choices || []) {
      actions.append(el("button", {
        class: "btn " + (choice.danger ? "danger" : "primary"), type: "button", text: choice.label,
        dataset: { role: choice.value }, onclick: () => close(choice.value),
      }));
    }
    overlay.append(el("div", { class: "modal", role: "dialog", "aria-modal": "true" },
      el("div", { class: "modal-title", text: opts.title || "确认操作" }),
      el("div", { class: "modal-text", text: opts.message || "" }),
      actions));
    overlay.addEventListener("click", (event) => { if (event.target === overlay) close(null); });
    document.addEventListener("keydown", onKey);
    document.addEventListener(TEARDOWN_EVENT, onTeardown);
    document.body.append(overlay);
    // 打开就落焦：电视端没有鼠标，不落焦的话遥控器的"确定"会先被底下那层面板吃掉
    const firstBtn = actions.querySelector("button");
    if (firstBtn) firstBtn.focus();
  });
}
