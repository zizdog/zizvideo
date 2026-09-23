// 顶部条（用户 2026-09-23："顶部改成类似抖音的左边返回按钮，右侧搜索按钮"）：
// 只放两个动作 —— 左「返回」、右「搜索」，中间什么都不放。
// 账号/退出/设置都不在这里（它们在「我的」里），所以顶栏跟登录状态无关地保持极简。

import { el, clear } from "./dom.js";
import { session } from "./auth.js";

export function renderTopBar(headerEl, options) {
  const opts = options || {};
  clear(headerEl);
  if (!session.user) { headerEl.hidden = true; return; } // 登录/注册/初始化页不要顶栏
  headerEl.hidden = false;
  // 返回键只在"有来路"时出现：直接从外部打开 #/feed 时没有上一页，放个点了没反应的按钮不如不放。
  const nodes = [];
  if (opts.showBack) {
    nodes.push(el("button", {
      class: "top-btn", type: "button", title: "返回", "aria-label": "返回",
      dataset: { role: "top-back" }, text: "←", onclick: opts.onBack,
    }));
  }
  nodes.push(el("div", { class: "spacer" }));
  nodes.push(el("button", {
    class: "top-btn", type: "button", title: "搜索", "aria-label": "搜索",
    dataset: { role: "top-search" }, text: "🔍", onclick: opts.onSearch,
  }));
  for (const node of nodes) headerEl.append(node);
}
