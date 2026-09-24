#!/usr/bin/env node
// ============================================================================
//  check-version-rule.mjs —— 版本号必须守「每 10 进一」的规矩。
//
//  用户 2026-09-24 两次明确："每 10 进一，进 0.2.10 后是 0.3.0。app 也是这个原则"。
//  也就是说末段是 **0～10 的计数器**：0.1.10 之后是 **0.2.0**，绝不允许 0.1.11 / 0.1.13；
//  同理 0.2.10 之后是 0.3.0，不允许 0.2.11。
//
//  为什么要有这条门禁：2026-09-24 我连着把服务端发到 0.2.5、安卓发到 0.1.13（早就越界），
//  用户连着纠正两次。原来的版本门禁只比对"Makefile 与 api.go 是否一致"，**不看格式**，
//  所以这种错它一句话都不会说（这就是它能溜过去的原因）。
//
//  用法：node tools/check-version-rule.mjs <仓库根>
// ============================================================================
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.argv[2] || '.';
const read = (p) => readFileSync(join(root, p), 'utf8');

const targets = [];
{
  const mk = read('Makefile');
  const m = mk.match(/^VERSION\s+\?=\s*(\S+)/m);
  targets.push({ name: '服务端（Makefile）', file: 'Makefile', version: m ? m[1] : '' });
}
{
  const go = read('internal/api/api.go');
  const m = go.match(/var Version = "([^"]+)"/);
  targets.push({ name: '服务端（internal/api/api.go）', file: 'internal/api/api.go', version: m ? m[1] : '' });
}
{
  const gradle = read('android/app/build.gradle.kts');
  const m = gradle.match(/versionName\s*=\s*"([^"]+)"/);
  targets.push({ name: '安卓（build.gradle.kts）', file: 'android/app/build.gradle.kts', version: m ? m[1] : '' });
}

let bad = 0;
for (const t of targets) {
  if (!t.version) {
    console.error(`✗ ${t.name}：读不到版本号（文件或写法变了？）`);
    bad++;
    continue;
  }
  // 允许 0.2.5 / 0.1.40-mvp 这种（后缀忽略）；末段必须是 0～10 的十进制整数
  const m = t.version.match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  if (!m) {
    console.error(`✗ ${t.name}：${t.version} 不是 主.次.末 三段式（${t.file}）`);
    bad++;
    continue;
  }
  const patch = Number(m[3]);
  if (String(patch) !== m[3]) {
    console.error(`✗ ${t.name}：${t.version} 末段有前导零（${t.file}）`);
    bad++;
    continue;
  }
  if (patch > 10) {
    console.error(`✗ ${t.name}：${t.version} 的末段 ${patch} 超过 10 —— ` +
      `规矩是"每 10 进一"：${m[1]}.${m[2]}.10 之后必须是 ${m[1]}.${Number(m[2]) + 1}.0（${t.file}）`);
    bad++;
    continue;
  }
  console.log(`   ok：${t.name} = ${t.version}`);
}
if (bad === 0) {
  console.log('✓ 版本号守规矩（末段 0～10，数到 10 就进前一段）');
  process.exit(0);
}
console.error('\n改法：末段超过 10 时把"次"加 1、末段归零（0.1.10 → 0.2.0；0.2.10 → 0.3.0）。');
process.exit(1);
