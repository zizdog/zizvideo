// 回归：手机宽度下「用户管理」表格里的操作按钮必须是"一行文字"，不能被挤成竖排。
// 用法（先起一个跑当前代码的实例，见 AGENTS.md 的 ZV_ASSETS_DIR 调试法）：
//   ZV_UI_BASE=http://127.0.0.1:7789 NODE_PATH=<zizpanel>/node_modules \
//   bash tools/ui-test.sh tools/ui-tests/admin-users-actions.mjs
import { chromium } from "playwright";

const B = process.env.ZV_UI_BASE || "http://127.0.0.1:7789";
const USER = process.env.ZV_UI_USER || "tester";
const PASS = process.env.ZV_UI_PASS || "testtest12";

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true });
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("[pageerror]", String(e).slice(0, 200)));

await page.goto(B + "/", { waitUntil: "domcontentloaded" });
const setup = await page.evaluate(async (c) => {
  const r = await fetch("/api/v1/setup", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(c), credentials: "same-origin",
  });
  return r.status;
}, { username: USER, password: PASS });
const login = await page.evaluate(async (c) => {
  const r = await fetch("/api/v1/auth/login", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(c), credentials: "same-origin",
  });
  return r.status;
}, { username: USER, password: PASS });
console.log("[setup]", setup, "[login]", login);
await page.goto(B + "/", { waitUntil: "networkidle" });

await page.goto(B + "/#/admin", { waitUntil: "networkidle" });
await page.waitForTimeout(600);
// 点「用户管理」页签
const tab = page.locator('button.admin-tab[title="用户管理"]').first();
await tab.waitFor({ state: "visible", timeout: 5000 });
await tab.click();
await page.waitForTimeout(800);
console.log("[hash]", await page.evaluate(() => location.hash));

const rows = await page.evaluate(() => {
  const out = [];
  document.querySelectorAll("tr").forEach((tr) => {
    const btns = tr.querySelectorAll(".actions .btn, .actions button, .actions a.btn");
    if (!btns.length) return;
    btns.forEach((b) => {
      const r = b.getBoundingClientRect();
      out.push({
        text: (b.textContent || "").trim().slice(0, 10),
        w: Math.round(r.width), h: Math.round(r.height),
        lh: parseFloat(getComputedStyle(b).lineHeight) || 0,
        nowrap: getComputedStyle(b).whiteSpace,
        lines: Math.max(1, Math.round(r.height / (parseFloat(getComputedStyle(b).lineHeight) || 16))),
      });
    });
  });
  return out;
});
console.log("[按钮]", JSON.stringify(rows.slice(0, 8)));
// 隐藏的按钮（如重置口令的确认框）宽高为 0，不算布局问题
const bad = rows.filter((x) => x.w > 0 && x.h > 0 && (x.lines > 2 || x.w < 40));
console.log("[结论]", rows.length ? (bad.length ? "✗ 仍有竖排/过窄按钮: " + JSON.stringify(bad.slice(0, 4)) : "✓ 都是一行、宽度正常") : "✗ 没找到操作按钮");
await browser.close();
const visible = rows.filter((x) => x.w > 0 && x.h > 0);
if (!visible.length || bad.length) process.exit(1);
