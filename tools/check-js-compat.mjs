#!/usr/bin/env node
// 前端兼容门禁：禁止使用"老 WebView 上没有"的 DOM/JS API。
//
// 为什么必须有这一条（规则 8 的"抓会伤到使用者"那条例外）：
//   · `tools/check-js-syntax.mjs`（acorn）只查**语法**，`node.replaceChildren(...)` 语法完全合法；
//   · 电视/盒子上的 WebView 常年不更新（小米电视 HyperOS 实测没有 `replaceChildren`），
//     一调就抛异常，**整页崩** —— 用户 2026-09-27 看到的就是"加载失败 + 遥控器没焦点"。
//   所以这里按"最低 Chrome 版本"设一道黑名单：宁可写老写法，也不许让整页白给。
//
// 2026-10-11 起这条门禁还管两件事（**没有新增门禁条目**，是把它本来该管的事补齐）：
//   · **CSS 兼容**：`:has()` 一律禁止；`flex gap` / `aspect-ratio` 这类老 WebView 没有的写法
//     走**棘轮**（ratchet）—— 现存数量记在 tools/css-compat-baseline.json 里，**只许减少**，
//     新增一处就红。为什么不一次性全改：app.css 现有 58 处 gap，一次性改布局风险大（电视上
//     塌过一次，见 app.css 的注释），先用棘轮把债锁住、以后随手还。
//   · **禁用原生弹窗**：`window.confirm/prompt` 在 App/电视的 WebView 里恒假
//     （WebChromeClient 没 override onJs*），危险操作会静默失效；项目有自己的 js/confirm.js。
//
// 用法：node tools/check-js-compat.mjs internal/web/assets
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const root = process.argv[2] || "internal/web/assets";
// [正则, 最低 Chrome 版本, 说明]；命中就报错（宁可误报也不许在老电视上崩）
const BANNED = [
  [/\.replaceChildren\s*\(/, 86, "Element.replaceChildren"],
  [/\.toggleAttribute\s*\(/, 69, "Element.toggleAttribute"],
  [/Object\.fromEntries\s*\(/, 73, "Object.fromEntries"],
  [/Object\.hasOwn\s*\(/, 93, "Object.hasOwn"],
  [/\.replaceAll\s*\(/, 85, "String.replaceAll"],
  [/structuredClone\s*\(/, 98, "structuredClone"],
  [/\.toSorted\s*\(|\.toReversed\s*\(|\.with\s*\(/, 110, "Array 复制式变更方法"],
  [/queueMicrotask\s*\(/, 71, "queueMicrotask（老电视上退化写法就行）"],
  [/\bglobalThis\b/, 71, "globalThis"],
  [/\.flatMap\s*\(|\.flat\s*\(/, 69, "Array.prototype.flat/flatMap"],
  [/Promise\.allSettled\s*\(/, 76, "Promise.allSettled"],
  [/ResizeObserver/, 64, "ResizeObserver"],
  [/IntersectionObserver/, 51, "IntersectionObserver"],
  [/\?\./, 80, "可选链 ?."],
  [/\?\?/, 80, "空值合并 ??"],
];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith(".js") || name.endsWith(".mjs")) out.push(p);
  }
  return out;
}

// CSS 棘轮基线：{ "相对路径": { "gap:": n, "aspect-ratio:": n } }
// 数量只许**减少**（还债），新增一处即红。基线文件不存在时按 0 处理（等于全禁）。
const BASELINE_PATH = "tools/css-compat-baseline.json";
let baseline = {};
try {
  baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
} catch (err) {
  if (err && err.code !== "ENOENT") {
    console.log("  ✗ 读不了 " + BASELINE_PATH + "：" + err.message);
    process.exit(1);
  }
}

// 老 WebView 缺的 CSS 写法：key 就是基线 JSON 里的字段名（别用正则字符串当 key，看不懂）
const CSS_BANNED = [
  { key: "has", re: /:has\s*\(/, what: "CSS :has()（Chrome 105+）", ratchet: false },
  { key: "gap", re: /\bgap\s*:/, what: "flex/grid gap（Chrome 84+；老电视上间距会全塌，用 margin）", ratchet: true },
  { key: "aspect-ratio", re: /\baspect-ratio\s*:/, what: "aspect-ratio（Chrome 88+；老写法用 padding-top 百分比）", ratchet: true },
  { key: "inset", re: /\binset\s*:/, what: "inset 简写（Chrome 87+；写 top/right/bottom/left）", ratchet: true },
];
const CSS_FILES = [];
(function walkCSS(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walkCSS(p);
    else if (name.endsWith(".css")) CSS_FILES.push(p);
  }
})(root);

let bad = 0;
let files = 0;
for (const file of walk(root)) {
  files += 1;
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, i) => {
    // 注释行不算（这些说明里就写着 replaceChildren 三个字）
    const code = line.replace(/\/\/.*$/, "").replace(/^\s*\*.*$/, "");
    if (!code.trim()) return;
    for (const [re, ver, what] of BANNED) {
      if (re.test(code)) {
        bad += 1;
        console.log(`  ✗ ${file}:${i + 1}  用了 ${what}（Chrome ${ver}+ 才有；老电视 WebView 会整页崩）`);
      }
    }
  });
}
// 原生弹窗禁令（App/电视上恒假 —— 见头注释）
for (const file of walk(root)) {
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, i) => {
    const code = line.replace(/([^:]|^)\/\/.*$/, "$1");
    if (/\bwindow\.(confirm|prompt)\s*\(/.test(code)) {
      bad += 1;
      console.log(`  ✗ ${file}:${i + 1}  用了 window.confirm/prompt（App/电视的 WebView 里恒假，` +
        `危险操作会静默失效）；改用 js/confirm.js 的 confirmDialog/choiceDialog`);
    }
  });
}

// CSS 兼容（棘轮）：统计每个文件的命中的"可棘轮"写法，与基线比只许多减少
let cssFiles = 0;
const counts = {};
for (const file of CSS_FILES) {
  cssFiles += 1;
  const text = readFileSync(file, "utf8");
  for (const rule of CSS_BANNED) {
    const { re, what, ratchet, key } = rule;
    const hits = text.split("\n").reduce((n, line) => (re.test(line) ? n + 1 : n), 0);
    if (!hits) continue;
    if (!ratchet) {
      bad += 1;
      console.log(`  ✗ ${file}  用了 ${what}；老电视 WebView 不支持，必须改掉`);
      continue;
    }
    const allow = (baseline[file] && baseline[file][key]) || 0;
    if (hits > allow) {
      bad += 1;
      console.log(`  ✗ ${file}  ${what}：现在 ${hits} 处，基线只允许 ${allow} 处` +
        `（棘轮只许减少；要还债就改完再更新 ${BASELINE_PATH} 里的 "${key}"）`);
    } else if (hits < allow) {
      console.log(`  ⚠ ${file}  ${what}：已降到 ${hits} 处（基线 ${allow}）——` +
        ` 记得把 ${BASELINE_PATH} 里这个数字改小，锁住成果`);
    }
  }
}

if (bad) {
  console.log(`\n共 ${bad} 处。改用老写法（removeChild/appendChild、for 循环、字符串拼接、margin 撑间距…），别让电视白屏。`);
  process.exit(1);
}
console.log(`  ✓ 前端兼容检查通过（${files} 个 JS + ${cssFiles} 个 CSS；未使用老 WebView 上没有的 API，` +
  `原生弹窗零命中，CSS 棘轮未超标）`);
