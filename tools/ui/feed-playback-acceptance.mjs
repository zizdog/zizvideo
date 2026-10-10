// 浏览器验收：首页播放流 + 设置面板 + 剧场页（`feed.js` / `series.js` 拆分前的安全网）。
//
// 为什么要先有它（2026-10-11）：`feed.js` 2601 行、要按"散片/短剧"边界拆模块；而这条路径是
// **播放核心**，光靠 JS 静态门禁（语法/未声明/兼容）证明不了"点得动、放得出、设置生效"。
// 本脚本跑在**临时实例**上（见 tools/ui/admin-split-acceptance.mjs 头部的同一套前置），
// 用真 DOM 走：登录 → 首页刷出散片 → 点开一条开始播 → 画面元素存在 → 打开设置面板并改一项
// → 回读接口确认落库 → 剧场页能打开（短剧库那一侧没被混进首页）。
//
// 跑法：bash tools/ui-test.sh tools/ui/feed-playback-acceptance.mjs
import pw from "/tmp/node_modules/playwright/index.js";
const { chromium } = pw;

const BASE = process.env.ZV_UI_BASE || "http://127.0.0.1:7799";
const USER = process.env.ZV_UI_USER || "smokeadmin";
const PASS = process.env.ZV_UI_PASS || "smoke-pass-123";

let failed = 0;
const ok = (m) => console.log("  ✓ " + m);
const bad = (m, extra) => {
  failed += 1;
  console.log("  ✗ " + m);
  if (extra) console.log("    " + String(extra).slice(0, 500));
};
const expect = (c, m, extra) => (c ? ok(m) : bad(m, extra));

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const problems = [];
  page.on("pageerror", (e) => problems.push("pageerror: " + e.message));
  page.on("response", (r) => {
    const u = r.url();
    if (r.status() >= 400 && !(r.status() === 401 && u.indexOf("/api/v1/auth/me") >= 0)) {
      problems.push("HTTP " + r.status() + " " + u);
    }
  });

  // 登录
  await page.goto(BASE + "/#/login", { waitUntil: "domcontentloaded" });
  await page.waitForSelector('input[type="password"]', { timeout: 15000 });
  await page.fill('input[name="username"], input[type="text"]', USER);
  await page.fill('input[type="password"]', PASS);
  await page.click('button[type="submit"]');
  await page.waitForFunction(() => !location.hash.includes("login"), null, { timeout: 15000 });

  // 回首页：等第一条 <video> 出现（feed 是真 DOM 渲染出来的）
  await page.goto(BASE + "/#/feed", { waitUntil: "domcontentloaded" });
  await page.waitForSelector("video", { timeout: 20000 });
  await page.waitForTimeout(1500);
  const videos = await page.$$("video");
  expect(videos.length >= 1, "首页渲染出了视频元素（" + videos.length + " 个）");

  // 播放：断言 readyState/muted 这些**不依赖声音**的事实，再断言 currentTime 在推进
  const state = await page.evaluate(async () => {
    const v = document.querySelector("video");
    if (!v) return null;
    try { await v.play(); } catch (err) { /* 自动播放策略可能拒绝，下面用 currentTime 判 */ }
    const t0 = v.currentTime;
    await new Promise((r) => setTimeout(r, 1200));
    return {
      readyState: v.readyState, muted: v.muted, paused: v.paused,
      t0, t1: v.currentTime, src: (v.currentSrc || v.src || "").slice(0, 60),
      duration: v.duration,
    };
  });
  expect(!!state, "取到了 <video> 的状态");
  if (state) {
    expect(state.readyState >= 2, "视频元数据/数据已就绪（readyState=" + state.readyState + "）", JSON.stringify(state));
    expect(state.t1 > state.t0 || state.muted === true, "画面在推进或按静音预览策略播放（" + state.t0.toFixed(2) + "→" + state.t1.toFixed(2) + "）", JSON.stringify(state));
  }

  // 设置面板：网页端靠**右键**开（用户 2026-09-24 定稿），TV 端才有屏幕上那个齿轮
  await page.mouse.click(640, 400, { button: "right" });
  await page.waitForTimeout(800);
  let panel = await page.$('[data-role="settings-sheet"], .set-panel');
  if (!panel) {
    // 兜底：有的端是长按画面
    await page.mouse.move(640, 400);
    await page.mouse.down();
    await page.waitForTimeout(700);
    await page.mouse.up();
    await page.waitForTimeout(500);
    panel = await page.$('[data-role="settings-sheet"], .set-panel');
  }
  expect(!!panel, "右键（或长按）能调出设置面板");

  if (panel) {
    const visible = await panel.evaluate((el) => !el.classList.contains("hidden"));
    expect(visible, "设置面板是可见的（没有 hidden）");
    // 改「自动播放下一个」并回读接口，证明真的落库（不是只改了 DOM）。
    // ⚠️ 开关的 <input> 是**故意不可见**的（`.sheet-switch-input`，tabIndex=-1，焦点落在整行上，
    // 免得遥控器停在一个看不见的复选框上）。所以要点**整行**（行上挂了 toggleOf 的点击处理），
    // 别去点 input —— 第一版脚本就是点了 input，Playwright 报 "element is not visible" 挂了 30 秒。
    const row = page.locator('.sheet-row, label.set-row').filter({ hasText: '自动播放下一个' }).first();
    expect((await row.count()) > 0, "找得到「自动播放下一个」这一行");
    const inputState = async () => row.locator('input[type="checkbox"]').first().isChecked();
    const before = await inputState();
    await row.click();
    await page.waitForTimeout(1200);
    const res = await page.evaluate(async () => {
      const r = await fetch("/api/v1/feed/settings", { credentials: "same-origin" });
      return { status: r.status, body: await r.text() };
    });
    let parsed = null;
    try { parsed = JSON.parse(res.body).data; } catch { /* 保持 null */ }
    expect(res.status === 200 && parsed, "回读 /feed/settings 成功", res.body);
    if (parsed) {
      expect(parsed.autoplay_next === !before,
        "改过的开关真的落库了（autoplay_next=" + parsed.autoplay_next + "，原值 " + before + "）",
        JSON.stringify(parsed));
    }
    // 改回去，少打扰
    await row.click();
    await page.waitForTimeout(600);
    // 关掉面板
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
  }

  // TV 模式：同一份前端加 ?tv=1 要有三栏骨架（电视端布局的门面）
  await page.goto(BASE + "/?tv=1#/feed", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  const tv = await page.evaluate(() => ({
    hasTvClass: !!document.querySelector(".tv") || document.documentElement.className.indexOf("tv") >= 0,
    hasList: !!document.querySelector('[data-role="tv-list"]'),
    hasStage: !!document.querySelector('[data-role="tv-stage"]'),
    hasNav: !!document.querySelector('[data-role="tv-nav"]'),
    video: !!document.querySelector("video"),
  }));
  expect(tv.hasTvClass, "?tv=1 时 html/body 带 .tv", JSON.stringify(tv));
  expect(tv.hasList && tv.hasStage && tv.hasNav, "TV 三栏骨架（列表/舞台/底栏）都在", JSON.stringify(tv));

  // 剧场页能打开且不报错（短剧那一侧）
  await page.goto(BASE + "/#/series", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1200);
  const seriesText = await page.textContent("body");
  expect(seriesText.length > 0 && !/加载失败/.test(seriesText), "剧场页打开了（没有「加载失败」）", seriesText.slice(0, 200));

  expect(problems.length === 0, "没有 JS 报错 / 意外非 2xx", problems.slice(0, 5).join("\n"));
} catch (err) {
  bad("脚本异常：" + (err && err.message), err && err.stack);
} finally {
  await browser.close();
}
if (failed) { console.log("\n播放路径浏览器验收失败：" + failed + " 条"); process.exit(1); }
console.log("\n播放路径浏览器验收通过 ✅");
