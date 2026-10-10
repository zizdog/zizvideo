// 浏览器验收：后台「散片管理 / 短剧管理」两块 + 「未归组」归入流程。
//
// 为什么要有一条**真浏览器**的验收（2026-10-11）：后台这两块是新模型（Jellyfin 式
// 短视频库/短剧库）的入口，而"接口 200"不等于"用户点得动" —— 本脚本第一次跑就抓到
// 建库重名冒 500「服务内部错误」这个真 bug（见提交 5d58a2b 之前的 0cbdfa7 之后那次修复）。
//
// 前置（三选一，就地起一个**临时实例**，别碰用户自己的实例）：
//   1) 造素材：ffmpeg 生成 2 个短视频 + 短剧库（某剧/Season 1/01.mp4、某剧/剧集03.mp4、库根散片.mp4）
//   2) 写一份临时配置（listen 127.0.0.1:7799、data_dir/database_path 都指到 /tmp、
//      media_allow_roots 指到素材目录）
//   3) `make build && ./dist/zizvideo --config <那份配置>`，等 /readyz 回 200
//   然后：bash tools/ui-test.sh tools/ui/admin-split-acceptance.mjs
//
// 脚本自己会用 HTTP 做 setup/login/建库/扫描（这部分 `make smoke` 已覆盖，这里只为 UI 造数据），
// 再用真 DOM 走一遍界面。每次跑前请清掉临时 data 目录（未归组数量断言假设是干净库）。
// 浏览器验收：后台「散片管理 / 短剧管理」两块 + 「未归组」归入流程（走真 DOM，不是静态核对契约）。
//
// 前置：/tmp/zv-ui/config.json 的实例已在 127.0.0.1:7799 跑着（见本文件末尾的用法注释）。
// 跑法：bash tools/ui-test.sh /tmp/zv-ui/check.mjs
import pw from "/tmp/node_modules/playwright/index.js"; // tools/ui-test.sh 的约定：/tmp/node_modules 软链到 zizpanel 的依赖
const { chromium } = pw;

const BASE = process.env.ZV_UI_BASE || "http://127.0.0.1:7799";
const USER = "smokeadmin";
const PASS = "smoke-pass-123";

let failed = 0;
function ok(msg) { console.log("  ✓ " + msg); }
function bad(msg, extra) {
  failed += 1;
  console.log("  ✗ " + msg);
  if (extra) console.log("    " + String(extra).slice(0, 600));
}
function expect(cond, msg, extra) { cond ? ok(msg) : bad(msg, extra); }

// 直接走 HTTP 把库与扫描准备好（这部分 make smoke 已经覆盖，这里只为 UI 造数据）
async function api(path, opts = {}, cookie = "") {
  const headers = { ...(opts.headers || {}) };
  if (opts.body) headers["Content-Type"] = "application/json";
  if (cookie) headers["Cookie"] = cookie;
  const res = await fetch(BASE + path, { ...opts, headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON 就留着原文 */ }
  return { status: res.status, json, text, setCookie: res.headers.getSetCookie ? res.headers.getSetCookie() : [] };
}

async function seed() {
  let r = await api("/api/v1/setup", { method: "POST", body: { username: USER, password: PASS, display_name: "验收" } });
  if (r.status !== 200 && r.status !== 201 && r.status !== 409) throw new Error("setup 失败 " + r.status + " " + r.text);
  r = await api("/api/v1/auth/login", { method: "POST", body: { username: USER, password: PASS } });
  if (r.status !== 200) throw new Error("login 失败 " + r.status + " " + r.text);
  const cookies = {};
  for (const c of r.setCookie || []) {
    const head = c.split(";", 1)[0];
    const i = head.indexOf("=");
    if (i > 0) cookies[head.slice(0, i).trim()] = head.slice(i + 1).trim();
  }
  const cookieHeader = Object.entries(cookies).map(([k, v]) => k + "=" + v).join("; ");
  const csrf = cookies["zv_csrf"] || "";
  async function authed(path, opts = {}) {
    return api(path, { ...opts, headers: { ...(opts.headers || {}), "X-CSRF-Token": csrf } }, cookieHeader);
  }
  const mk = async (name, root, kind) => {
    const res = await authed("/api/v1/libraries", { method: "POST", body: { name, root_path: root, kind } });
    if (res.status === 201) return res.json.data;
    if (res.status === 409 || res.status === 400) {
      const all = await authed("/api/v1/libraries");
      const list = (all.json && all.json.data && all.json.data.list) || (all.json && all.json.list) || [];
      const found = list.find((l) => l.name === name);
      if (found) return found;
    }
    throw new Error("建库 " + name + " 失败 " + res.status + " " + res.text);
  };
  const shortLib = await mk("散片库", "/tmp/zv-ui/media/shorts", "short");
  const dramaLib = await mk("短剧库", "/tmp/zv-ui/media/drama", "drama");
  for (const lib of [shortLib, dramaLib]) {
    const started = await authed("/api/v1/libraries/" + lib.id + "/scan", { method: "POST" });
    if (started.status !== 202 && started.status !== 200) throw new Error("扫描失败 " + started.status + " " + started.text);
    const taskId = started.json.data.task_id;
    for (let i = 0; i < 200; i += 1) {
      const t = await authed("/api/v1/scan-tasks/" + taskId);
      const st = t.json && t.json.data && t.json.data.status;
      if (st === "success" || st === "failed" || st === "interrupted") {
        if (st !== "success") throw new Error("扫描未成功：" + t.text);
        break;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  // 等"扫描后自动识别"落地（它会重算季/集号）
  await new Promise((r) => setTimeout(r, 2500));
  return { shortLib, dramaLib };
}

const browser = await chromium.launch();
try {
  await seed();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const t = m.text();
    // 登录前 /auth/me 的 401 在 Chromium 控制台也会留一行"Failed to load resource"，
    // 那一条是预期的（见下面 response 钩子的说明）。真正的判据是 response 钩子
    // ——它按 URL 精确排除，比按文案过滤可靠。
    if (/Failed to load resource/.test(t) && t.indexOf("401") >= 0) return;
    errors.push("console: " + t);
  });
  page.on("response", (r) => {
    // 登录前 `/auth/me` 回 401 是**预期**的（auth.js 的 loadMe 就是靠它判断"没登录"），
    // 只有其它非 2xx 才算问题。
    const u = r.url();
    if (r.status() >= 400 && !(r.status() === 401 && u.indexOf("/api/v1/auth/me") >= 0)) {
      errors.push("HTTP " + r.status() + " " + u);
    }
  });

  // ── 用界面登录（真表单，不是塞 cookie）
  await page.goto(BASE + "/#/login", { waitUntil: "domcontentloaded" });
  await page.waitForSelector('input[name="username"], input[type="text"]', { timeout: 15000 });
  await page.fill('input[name="username"], input[type="text"]', USER);
  await page.fill('input[type="password"]', PASS);
  await page.click('button[type="submit"]');
  await page.waitForFunction(() => !location.hash.includes("login"), null, { timeout: 15000 });
  ok("界面登录成功");

  // ── 进后台
  await page.goto(BASE + "/#/admin", { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".admin-side, .side-panel, nav", { timeout: 15000 });
  await page.waitForTimeout(800);

  const tabs = await page.$$eval("a, button, .side-item, .admin-nav-item", (els) =>
    els.map((e) => (e.textContent || "").trim()).filter(Boolean));
  const has = (label) => tabs.some((t) => t === label);
  expect(has("散片管理"), "侧栏有「散片管理」", tabs.slice(0, 30).join(" | "));
  expect(has("短剧管理"), "侧栏有「短剧管理」", tabs.slice(0, 30).join(" | "));
  expect(!has("媒体列表") && !has("剧场管理"), "旧名字（媒体列表/剧场管理）已不存在", tabs.slice(0, 30).join(" | "));

  // ── 短剧管理：未归组块
  await page.getByText("短剧管理", { exact: true }).first().click();
  await page.waitForTimeout(1500);
  const summary = await page.$$eval("summary", (els) => els.map((e) => (e.textContent || "").trim()));
  const ungroupSummary = summary.find((s) => s.indexOf("未归组") === 0);
  expect(!!ungroupSummary, "短剧管理里有「未归组」折叠块", summary.join(" | "));
  if (ungroupSummary) {
    // 「库根散片.mp4」+ 剧目下没进剧的？扫描会把某剧/Season 1/01.mp4 与 剧集03.mp4 归进剧，
    // 只剩库根那条散片是未归组 ⇒ N 应该是 1
    expect(/（1 条）/.test(ungroupSummary), "未归组数量 = 1（只有库根那条散片）", ungroupSummary);
    // 展开
    await page.getByText(ungroupSummary, { exact: true }).first().click();
    await page.waitForTimeout(800);
    const bodyText = await page.textContent("body");
    expect(bodyText.includes("库根散片"), "未归组列表里显示了那条散片", bodyText.slice(0, 300));

    // 选「新建一部剧（按所在目录名）」→ 归入。文件在库根 ⇒ 剧名应回退成文件名（去扩展名）
    const selects = await page.$$('select');
    let picked = null;
    for (const sel of selects) {
      const opts = await sel.$$eval("option", (os) => os.map((o) => ({ v: o.value, t: (o.textContent || "").trim() })));
      if (opts.some((o) => o.v === "new" || o.t.indexOf("新建") === 0)) { picked = sel; break; }
    }
    expect(!!picked, "未归组行里有「新建一部剧」选项");
    if (picked) {
      const newVal = await picked.$$eval("option", (os) => (os.find((o) => o.value === "new") || os[os.length - 1]).value);
      await picked.selectOption(newVal);
      const assignBtn = await page.$('button:has-text("归入")');
      expect(!!assignBtn, "行尾有「归入」按钮");
      if (assignBtn) {
        await assignBtn.click();
        await page.waitForTimeout(2000);
        const after = await page.textContent("body");
        expect(/已归入《/.test(after), "归入成功后有明确提示（已归入《…》）", after.slice(0, 400));
        expect(/未归组（0 条）/.test(after), "归入后未归组变 0 条", after.slice(0, 400));
      }
    }
  }

  // ── 散片管理：只出短视频库的内容
  await page.getByText("散片管理", { exact: true }).first().click();
  await page.waitForTimeout(1500);
  const mediaText = await page.textContent("body");
  expect(mediaText.includes("散片一") || mediaText.includes("散片二"), "散片管理列出了短视频库的内容", mediaText.slice(0, 300));
  expect(!mediaText.includes("库根散片") && !mediaText.includes("01.mp4"), "散片管理里没有短剧库的内容", mediaText.slice(0, 300));

  // 库选择下拉里不该出现短剧库（库里只列 short 库）
  const libSelectText = await page.$$eval("select", (els) =>
    els.map((e) => Array.from(e.options).map((o) => o.textContent.trim()).join(",")).join(" || "));
  expect(!libSelectText.includes("短剧库"), "散片管理的媒体库下拉里没有短剧库", libSelectText.slice(0, 200));

  expect(errors.length === 0, "控制台没有 JS 报错", errors.slice(0, 5).join("\n"));
} catch (err) {
  bad("脚本异常：" + (err && err.message), err && err.stack);
} finally {
  await browser.close();
}
if (failed) { console.log(`\n浏览器验收失败：${failed} 条`); process.exit(1); }
console.log("\n浏览器验收通过 ✅");
