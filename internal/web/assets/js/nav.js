// 底栏四入口：首页（播放页）/ 剧场 / 收藏 / 我的
// 用户 2026-09-24：**只留文字、不要图标**（图标一竖排太占播放画面），底栏高度也跟着降下来。

import { el } from "./dom.js";

const ITEMS = [
  { key: "feed", label: "首页", hash: "#/feed" },
  { key: "series", label: "剧场", hash: "#/series" },
  { key: "favorites", label: "收藏", hash: "#/favorites" },
  { key: "me", label: "我的", hash: "#/me" },
];

// mountNav 只返回节点：路由切换时整个 view 被清空，无需额外清理。
export function mountNav(active) {
  const nav = el("nav", { class: "bottom-nav", dataset: { role: "bottom-nav" } });
  for (const item of ITEMS) {
    nav.append(el("a", {
      class: "nav-item" + (item.key === active ? " on" : ""),
      href: item.hash, dataset: { key: item.key }, text: item.label,
    }));
  }
  return nav;
}
