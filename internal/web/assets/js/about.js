// 关于页：当前版本（用户 2026-09-22 要求）。
// 版本号取自公开的 setup/status，读不到就如实标「未复核」，不编。

import { api } from "./api.js";
import { el } from "./dom.js";

export function mountAbout(view) {
  const version = el("span", { class: "v", text: "读取中…", dataset: { role: "app-version" } });
  view.append(el("div", { class: "page" },
    el("div", { class: "page-head" }, el("h2", { class: "page-title", text: "关于" })),
    el("div", { class: "panel", dataset: { role: "about-panel" } },
      el("div", { class: "panel-title", text: "版本" }),
      el("div", { class: "kv" }, el("span", { class: "k", text: "zizvideo" }), version)),
    el("div", { class: "muted small-note", text: "自托管短视频/短剧：一个二进制 + 内嵌前端 + SQLite。" })));

  api.setupStatus().then((status) => {
    version.textContent = (status && status.version) ? ("v" + status.version) : "未复核";
  }).catch(() => { version.textContent = "未复核"; });
  return null;
}
