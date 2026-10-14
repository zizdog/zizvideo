// 剧场播放页「返回」按钮的回归测试（2026-10-14 用户报"点了没反应"后补的）。
// 用法：先起一个跑当前代码的实例（见 AGENTS.md 的 ZV_ASSETS_DIR 调试法），然后：
//   ZV_UI_BASE=http://127.0.0.1:7788 ZV_UI_SERIES=<ser_xxx> \
//   NODE_PATH=<zizpanel>/node_modules bash tools/ui-test.sh tools/ui-tests/player-back.mjs
// 断言：播放页里存在 [data-role=player-back]，点击后 hash 变成 #/series（路由会清理播放器）。
// 诊断剧场播放页的「返回」按钮：是否存在 / 中心点上是谁 / 点击后 hash 是否变化
import { chromium } from "playwright";

const B = process.env.ZV_UI_BASE || "http://127.0.0.1:7788";
const SERIES = process.env.ZV_UI_SERIES || process.argv[2] || "";
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 420, height: 860 } });
const page = await ctx.newPage();
page.on("console", (m) => console.log("[console]", m.type(), m.text().slice(0, 200)));
page.on("pageerror", (e) => console.log("[pageerror]", String(e).slice(0, 300)));

await page.goto(B + "/", { waitUntil: "domcontentloaded" });
const login = await page.evaluate(async () => {
  const r = await fetch("/api/v1/auth/login", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: process.env.ZV_UI_USER || "tester", password: process.env.ZV_UI_PASS || "testtest12" }), credentials: "same-origin",
  });
  return r.status;
});
console.log("[login]", login);
// 关键：登录后必须重载，前端才会带着会话启动（否则路由把页面踢回 #/login）
await page.goto(B + "/", { waitUntil: "networkidle" });
console.log("[after reload] hash:", await page.evaluate(() => location.hash));

// 进剧场详情 → 点第一集进播放页
await page.goto(B + "/#/series/" + SERIES, { waitUntil: "networkidle" });
await page.waitForTimeout(800);
const items = await page.locator(".ep-item, [data-role='episode-item'], a[href*='episode']").count();
console.log("[series] 集元素数:", items);
if (items > 0) {
  await page.locator(".ep-item, [data-role='episode-item'], a[href*='episode']").first().click();
} else {
  // 兜底：直接点第一个可点条目
  const any = page.locator("[data-role='ep-item'], .ep-list a, .ep-list button").first();
  if (await any.count()) await any.click();
}
await page.waitForTimeout(1500);
console.log("[hash] 进播放页后:", await page.evaluate(() => location.hash));

const diag = await page.evaluate(() => {
  const el = document.querySelector('[data-role="player-back"]');
  if (!el) return { exists: false, topHtml: document.querySelector(".fd-item, .layer") ? "有播放层" : "无播放层" };
  const r = el.getBoundingClientRect();
  const cx = Math.round(r.left + r.width / 2), cy = Math.round(r.top + r.height / 2);
  const top = document.elementFromPoint(cx, cy);
  const chain = [];
  for (let n = top; n && chain.length < 6; n = n.parentElement) {
    chain.push(n.tagName + (n.className ? "." + String(n.className).split(" ").join(".") : "") +
      (n.dataset && n.dataset.role ? "[data-role=" + n.dataset.role + "]" : ""));
  }
  const cs = getComputedStyle(el);
  return {
    exists: true, rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
    center: { cx, cy },
    pointerEvents: cs.pointerEvents, zIndex: cs.zIndex, display: cs.display, visibility: cs.visibility,
    isTop: top === el, topChain: chain,
  };
});
console.log("[ov-back 诊断]", JSON.stringify(diag, null, 1));

const before = await page.evaluate(() => location.hash);
try {
  await page.click('[data-role="player-back"]', { timeout: 3000 });
  console.log("[click] 点到了");
} catch (e) {
  console.log("[click] 点不到:", String(e).slice(0, 200));
}
await page.waitForTimeout(1200);
const after = await page.evaluate(() => location.hash);
console.log("[结果] hash:", before, "→", after, after !== before ? "✓ 变了" : "✗ 没变");
const gone = await page.evaluate(() => !document.querySelector('[data-role="player-back"]'));
console.log("[清理] 播放器已关闭:", gone ? "✓" : "✗");
await browser.close();
if (after !== "#/series" || !diag.exists) {
  console.error("!! 返回按钮不可用（这正是 2026-10-14 的回归）");
  process.exit(1);
}
