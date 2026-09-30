// 顶部条：左「侧面板」、右「搜索」，**无背景横条**（用户 2026-09-23）；
// 原来左边的返回键已按要求换成侧面板展开按钮。
// 账号/退出/设置都不在这里（它们在「我的」里），所以顶栏跟登录状态无关地保持极简。

import { el, clear } from "./dom.js";
import { session } from "./auth.js";
import { icon } from "./icons.js";
import { tvMode } from "./tv.js";

export function renderTopBar(headerEl, options) {
  const opts = options || {};
  clear(headerEl);
  if (!session.user) { headerEl.hidden = true; return; } // 登录/注册/初始化页不要顶栏
  // 电视端（?tv=1）：**整个顶栏都不要**（用户 2026-09-28："不要全屏、和搜索按钮。是 TV 端不需要，
  // 不要放在任何地方，直接隐藏掉就行！"）—— 右上角也不能有任何按钮（第 5 条）。
  if (tvMode()) { headerEl.hidden = true; return; }
  headerEl.hidden = false;
  // 用户 2026-09-23：左侧"返回"换成**侧面板展开**按钮。
  const nodes = [];
  nodes.push(el("button", {
    class: "top-btn", type: "button", title: "菜单", "aria-label": "菜单",
    dataset: { role: "top-menu" }, onclick: opts.onMenu,
  }, icon("menu")));
  nodes.push(el("div", { class: "spacer" }));
  nodes.push(el("button", {
    class: "top-btn", type: "button", title: "搜索", "aria-label": "搜索",
    dataset: { role: "top-search" }, onclick: opts.onSearch,
  }, icon("search")));
  for (const node of nodes) headerEl.append(node);
}
