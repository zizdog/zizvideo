// 浏览器自检：老 WebView 的 flex gap 兜底块**能不能被解析**（语法错会被整块丢掉、静默失效）。
//
// 前置：一个**从磁盘读前端**的临时实例（否则内嵌的是旧 CSS，你会对着一份没有兜底的 CSS 自检）：
//   make build
//   ZV_ASSETS_DIR="$PWD/internal/web/assets" ./dist/zizvideo --config <临时 config>   # 端口随便挑个空闲的
// 然后：ZV_UI_BASE=http://127.0.0.1:7798 bash tools/ui-test.sh tools/ui/css-fallback-check.mjs
//
// 它验三件事：① 浏览器 CSSOM 里真的存在 `@supports not (gap: 1px)` 规则；
// ② 块里至少有 10 条兜底；③ 实测依赖 gap 的 6 个电视端容器都在兜底里。
// 注意：现代浏览器支持 gap ⇒ 兜底块**不会生效**，这里只证明"它被正确解析且内容齐全"。
import pw from "/tmp/node_modules/playwright/index.js";
const { chromium } = pw;
const BASE = process.env.ZV_UI_BASE || "http://127.0.0.1:7798";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
await page.goto(BASE + "/?tv=1#/feed", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(1200);
const info = await page.evaluate(() => {
  const out = { found: false, rules: 0, sels: [], gapSupported: CSS.supports("gap", "1px") };
  for (const sheet of document.styleSheets) {
    let rules;
    try { rules = sheet.cssRules; } catch { continue; }
    for (const r of rules) {
      if (r.conditionText && r.conditionText.indexOf("gap") >= 0) {
        out.found = true;
        out.rules = r.cssRules ? r.cssRules.length : 0;
        out.sels = r.cssRules ? Array.from(r.cssRules).map((x) => x.selectorText) : [];
      }
    }
  }
  return out;
});
console.log(JSON.stringify(info, null, 2));
// 兜底块在当前浏览器里**不会生效**（它支持 gap），但必须被解析出来（语法错会被整块丢掉）
let failed = 0;
if (!info.found) { console.log("✗ 浏览器里找不到 @supports not (gap) 规则（语法错？）"); failed++; }
else console.log("✓ @supports not (gap: 1px) 规则被成功解析，里面有 " + info.rules + " 条兜底");
if (info.rules < 10) { console.log("✗ 兜底条数太少（应 ≥10）"); failed++; }
for (const want of [".overlay > * + *", ".ov-top > * + *", ".ov-rail > * + *", ".set-panel > * + *", ".sheet-row > * + *", ".sheet-seg > * + *"]) {
  if (!info.sels.includes(want)) { console.log("✗ 兜底里缺少 " + want); failed++; }
}
await browser.close();
console.log(failed ? "\n兜底块自检失败" : "\n兜底块自检通过 ✅");
process.exit(failed ? 1 : 0);
