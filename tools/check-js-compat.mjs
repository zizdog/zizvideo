#!/usr/bin/env node
// 前端兼容门禁：禁止使用"老 WebView 上没有"的 DOM/JS API。
//
// 为什么必须有这一条（规则 8 的"抓会伤到使用者"那条例外）：
//   · `tools/check-js-syntax.mjs`（acorn）只查**语法**，`node.replaceChildren(...)` 语法完全合法；
//   · 电视/盒子上的 WebView 常年不更新（小米电视 HyperOS 实测没有 `replaceChildren`），
//     一调就抛异常，**整页崩** —— 用户 2026-09-27 看到的就是"加载失败 + 遥控器没焦点"。
//   所以这里按"最低 Chrome 版本"设一道黑名单：宁可写老写法，也不许让整页白给。
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
if (bad) {
  console.log(`\n共 ${bad} 处。改用老写法（removeChild/appendChild、for 循环、字符串拼接…），别让电视白屏。`);
  process.exit(1);
}
console.log(`  ✓ 前端兼容检查通过（${files} 个文件，未使用老 WebView 上没有的 API）`);
