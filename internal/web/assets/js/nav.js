// 底栏四入口：首页（播放页）/ 剧场 / 收藏 / 我的
// 用户 2026-09-24：**只留文字、不要图标**（图标一竖排太占播放画面），底栏高度也跟着降下来。

import { el } from "./dom.js";
import { session } from "./auth.js";

const ITEMS = [
  { key: "feed", label: "首页", hash: "#/feed" },
  { key: "series", label: "剧场", hash: "#/series" },
  // 用户 2026-09-24：剧场与收藏之间放一个「+」当上传入口（只有能上传的账号才看到）
  { key: "upload", label: "+", hash: "#/upload", upload: true, class: "upload" },
  { key: "favorites", label: "收藏", hash: "#/favorites" },
  { key: "me", label: "我的", hash: "#/me" },
];

// mountNav 只返回节点：路由切换时整个 view 被清空，无需额外清理。
export function mountNav(active) {
  const nav = el("nav", { class: "bottom-nav", dataset: { role: "bottom-nav" } });
  const user = session.user || {};
  const canUpload = user.role === "admin" || user.can_upload === true;
  for (const item of ITEMS) {
    if (item.upload && !canUpload) continue; // 没权限就不显示入口（别让人点进 403）
    nav.append(el("a", {
      class: "nav-item" + (item.key === active ? " on" : "") + (item.class ? " " + item.class : ""),
      href: item.hash, dataset: { key: item.key }, text: item.label,
    }));
  }
  return nav;
}
