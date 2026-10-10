#!/usr/bin/env node
// ============================================================================
//  check-js-undeclared.mjs —— 抓"赋值了但全文件没有声明"的标识符。
//
//  为什么需要它：acorn 只查语法，不查名字有没有定义。历史上清理"死代码"时
//  删掉过 `let cmCorePromise = null;`，而下面 4 处引用还在 —— 语法完全合法、
//  门禁全绿，浏览器里却是 `Can't find variable: cmCorePromise`，编辑器直接打不开。
//
//  2026-09-24 补第二条判据（同一个坑的另一面）：**调用了作用域里不存在的函数**。
//  起因：upload.js 里 `targetPayload()` 是定义在 mountUpload 里的，却被模块级的 uploadOne 调用 ——
//  文件里"明明有这个名字"，赋值检查也绿，浏览器里点上传就报 `Can't find variable: targetPayload`（用户报障）。
//  所以调用点要看**真实作用域链**（模块 → 函数 → 块），跨函数拿了别人的局部函数一律报出来。
//
//  判据（保守，宁少报不误报）：
//    · 收集文件内所有声明：var/let/const、function/class、函数参数、catch 参数、import；
//    · 收集所有"裸标识符赋值"：`x = …`、`x++`、`for (x of …)`、`for (x in …)`；
//    · 赋值了但文件内没有任何声明、也不在已知全局白名单里 → 报错；
//    · `f(...)` / `new F(...)` 的 f/F 在当前作用域链里找不到、也不是全局 → 报错。
//  仅扫第一方资源；vendor/ 下的第三方库不扫（它们的全局风格不适用这条判据）。
//
//  用法：node tools/check-js-undeclared.mjs <目录或文件> [更多…]
//  退出码 0 通过，1 有发现，2 用法/环境不对。
// ============================================================================
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';

// 见 check-js-syntax.mjs：acorn 不可导入必须直接失败，不许静默跳过（铁律 3）。
let acorn;
try {
  acorn = await import('acorn');
} catch (err) {
  console.error('!! 无法导入 acorn（' + (err && err.message) + '）：先 `npm install`，别跳过检查');
  process.exit(1);
}

// 浏览器/宿主提供的全局名（赋值给它们不算"没声明"）。
const GLOBALS = new Set([
  'window', 'document', 'location', 'navigator', 'history', 'screen', 'console',
  'localStorage', 'sessionStorage', 'indexedDB', 'crypto', 'performance',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask',
  'requestAnimationFrame', 'cancelAnimationFrame', 'fetch', 'URL', 'URLSearchParams',
  'Blob', 'File', 'FileReader', 'FormData', 'Headers', 'Request', 'Response',
  'EventSource', 'WebSocket', 'AbortController', 'TextEncoder', 'TextDecoder',
  'alert', 'confirm', 'prompt', 'structuredClone', 'CustomEvent', 'Event',
  'MutationObserver', 'IntersectionObserver', 'ResizeObserver', 'Notification',
  'matchMedia', 'getComputedStyle', 'scrollTo', 'open', 'close', 'postMessage',
  // vendor 库挂到 window 上的名字（由 assets/vendor 提供）
  'CodeMirror', 'Plyr', 'hljs',
  // 语言内建（不是"变量"）：调用它们永远合法，别误报
  'Object', 'Array', 'String', 'Number', 'Boolean', 'BigInt', 'Symbol', 'Function',
  'Set', 'Map', 'WeakMap', 'WeakSet', 'WeakRef', 'Promise', 'Proxy', 'Reflect',
  'Error', 'TypeError', 'RangeError', 'SyntaxError', 'EvalError', 'ReferenceError',
  'Date', 'RegExp', 'JSON', 'Math', 'Intl', 'console',
  'isNaN', 'isFinite', 'parseInt', 'parseFloat',
  'encodeURIComponent', 'decodeURIComponent', 'encodeURI', 'decodeURI', 'escape', 'unescape',
  'ArrayBuffer', 'SharedArrayBuffer', 'DataView', 'Uint8Array', 'Int8Array',
  'Uint8ClampedArray', 'Uint16Array', 'Int16Array', 'Uint32Array', 'Int32Array',
  'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array', 'Atomics',
  'eval', 'undefined', 'NaN', 'Infinity', 'arguments', 'globalThis',
  'XMLHttpRequest', 'DOMParser', 'Image', 'Audio', 'Option', 'EventTarget', 'Worker',
  'atob', 'btoa', 'self', 'top', 'parent', 'frames', 'requestIdleCallback',
]);

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('用法：node tools/check-js-undeclared.mjs <目录或文件> [更多…]');
  process.exit(2);
}

function walk(p, out) {
  // 目录不存在就跳过：调用方会把"可能没有这个模块"的路径一起传进来
  // （模块下线后 Makefile 没同步，整个 make check 会死在这里）。
  if (!existsSync(p)) return;
  const st = statSync(p);
  if (st.isDirectory()) {
    if (basename(p) === 'vendor' || basename(p) === 'node_modules') return;
    for (const e of readdirSync(p)) walk(join(p, e), out);
  } else if (p.endsWith('.js') || p.endsWith('.mjs')) {
    out.push(p);
  }
}

// 只取模式里的标识符名（解构、默认值都要覆盖到）。
function patternNames(node, into) {
  if (!node) return;
  switch (node.type) {
    case 'Identifier': into.add(node.name); break;
    case 'ObjectPattern':
      for (const p of node.properties) {
        if (p.type === 'RestElement') patternNames(p.argument, into);
        else patternNames(p.value, into);
      }
      break;
    case 'ArrayPattern':
      for (const el of node.elements) patternNames(el, into);
      break;
    case 'AssignmentPattern': patternNames(node.left, into); break;
    case 'RestElement': patternNames(node.argument, into); break;
  }
}

function collect(ast) {
  const declared = new Set();
  const assigned = new Map(); // name -> 行号

  const visit = (node, parent) => {
    if (!node || typeof node.type !== 'string') return;
    switch (node.type) {
      case 'VariableDeclarator': patternNames(node.id, declared); break;
      case 'FunctionDeclaration':
      case 'FunctionExpression':
      case 'ArrowFunctionExpression':
        if (node.id) declared.add(node.id.name);
        for (const p of node.params) patternNames(p, declared);
        break;
      case 'ClassDeclaration':
      case 'ClassExpression':
        if (node.id) declared.add(node.id.name);
        break;
      case 'CatchClause': patternNames(node.param, declared); break;
      case 'ImportDeclaration':
        for (const s of node.specifiers) declared.add(s.local.name);
        break;
      case 'AssignmentExpression':
        if (node.left.type === 'Identifier') {
          if (!assigned.has(node.left.name)) assigned.set(node.left.name, node.loc.start.line);
        }
        break;
      case 'UpdateExpression':
        if (node.argument.type === 'Identifier') {
          if (!assigned.has(node.argument.name)) assigned.set(node.argument.name, node.loc.start.line);
        }
        break;
      case 'ForOfStatement':
      case 'ForInStatement':
        if (node.left.type === 'Identifier') {
          if (!assigned.has(node.left.name)) assigned.set(node.left.name, node.loc.start.line);
        }
        break;
    }
    for (const k of Object.keys(node)) {
      if (k === 'loc' || k === 'start' || k === 'end') continue;
      const v = node[k];
      if (Array.isArray(v)) for (const c of v) visit(c, node);
      else if (v && typeof v.type === 'string') visit(v, node);
    }
  };
  visit(ast, null);
  return { declared, assigned };
}

// ---------------------------------------------------------------------------
// 作用域分析：给"调用"用的。只关心名字能不能查到，不追求完整的 TDZ/提升语义
// （保守取向：宁可漏报块级 TDZ，也不要把合法的调用误报成错 —— 误报会让人关掉门禁）。
// ---------------------------------------------------------------------------

// 收集一个作用域"自己"的声明：递归下降，但**不进入嵌套函数/类体**（它们各有各的作用域）。
function collectScopeDecls(nodes, into) {
  for (const node of nodes) collectScopeDecl(node, into);
}

function collectScopeDecl(node, into) {
  if (!node || typeof node.type !== 'string') return;
  switch (node.type) {
    case 'FunctionDeclaration':
      if (node.id) into.add(node.id.name);
      return; // 函数体是另一个作用域
    case 'FunctionExpression':
    case 'ArrowFunctionExpression':
      if (node.id) into.add(node.id.name);
      return;
    case 'ClassDeclaration':
    case 'ClassExpression':
      if (node.id) into.add(node.id.name);
      return;
    case 'VariableDeclarator':
      patternNames(node.id, into);
      collectScopeDecl(node.init, into);
      return;
    case 'VariableDeclaration':
      for (const d of node.declarations) collectScopeDecl(d, into);
      return;
    case 'ImportDeclaration':
      for (const sp of node.specifiers) into.add(sp.local.name);
      return;
    case 'CatchClause':
      patternNames(node.param, into);
      collectScopeDecl(node.body, into);
      return;
  }
  for (const k of Object.keys(node)) {
    if (k === 'loc' || k === 'start' || k === 'end') continue;
    const v = node[k];
    if (Array.isArray(v)) collectScopeDecls(v, into);
    else if (v && typeof v.type === 'string') collectScopeDecl(v, into);
  }
}

function resolves(name, scopes) {
  if (GLOBALS.has(name)) return true;
  for (let i = scopes.length - 1; i >= 0; i--) if (scopes[i].has(name)) return true;
  return false;
}

// 第二遍：沿作用域链检查所有调用/构造的裸标识符。
function collectBadCalls(ast, problems) {
  const moduleScope = new Set();
  collectScopeDecls(ast.body, moduleScope);

  const walk = (node, scopes) => {
    if (!node || typeof node.type !== 'string') return;
    let next = scopes;
    switch (node.type) {
      case 'FunctionDeclaration':
      case 'FunctionExpression':
      case 'ArrowFunctionExpression': {
        const own = new Set();
        if (node.type !== 'FunctionDeclaration' && node.id) own.add(node.id.name);
        for (const p of node.params) patternNames(p, own);
        const body = Array.isArray(node.body) ? node.body : [node.body];
        collectScopeDecls(body, own);
        next = scopes.concat([own]);
        break;
      }
      case 'ClassDeclaration':
      case 'ClassExpression': {
        const own = new Set();
        if (node.id) own.add(node.id.name);
        next = scopes.concat([own]);
        break;
      }
      case 'BlockStatement': {
        const own = new Set();
        collectScopeDecls(node.body, own);
        next = scopes.concat([own]);
        break;
      }
      case 'CatchClause': {
        const own = new Set();
        patternNames(node.param, own);
        next = scopes.concat([own]);
        break;
      }
    }
    if (node.type === 'CallExpression' || node.type === 'NewExpression') {
      const callee = node.callee;
      if (callee && callee.type === 'Identifier' && !resolves(callee.name, next)) {
        problems.push({ name: callee.name, line: callee.loc.start.line });
      }
    }
    for (const k of Object.keys(node)) {
      if (k === 'loc' || k === 'start' || k === 'end') continue;
      const v = node[k];
      if (Array.isArray(v)) for (const c of v) walk(c, next);
      else if (v && typeof v.type === 'string') walk(v, next);
    }
  };
  walk(ast, [moduleScope]);
}

const files = [];
for (const a of args) walk(a, files);

let bad = 0;
for (const f of files) {
  let ast;
  try {
    ast = acorn.parse(readFileSync(f, 'utf8'), { ecmaVersion: 'latest', sourceType: 'module', locations: true });
  } catch (e) {
    console.error(`✗ ${f}: 语法错误（先跑 check-js-syntax.mjs）: ${e.message}`);
    bad++;
    continue;
  }
  const { declared, assigned } = collect(ast);
  for (const [name, line] of assigned) {
    if (declared.has(name) || GLOBALS.has(name)) continue;
    console.error(`✗ ${f}:${line}  ${name} 被赋值但全文件没有声明（浏览器会报 Can't find variable）`);
    bad++;
  }
  const calls = [];
  collectBadCalls(ast, calls);
  const seenCall = new Set();
  for (const c of calls) {
    const key = c.name + '@' + c.line;
    if (seenCall.has(key)) continue;
    seenCall.add(key);
    console.error(`✗ ${f}:${c.line}  调用了 ${c.name}()，但当前作用域里没有它` +
      `（定义在别的函数里？浏览器会报 Can't find variable）`);
    bad++;
  }
}
if (bad === 0) {
  console.log(`✓ JS 未声明/未定义调用检查通过（${files.length} 个文件）`);
  process.exit(0);
}
console.error(`\n共 ${bad} 处。补声明/把函数提到同作用域，或把该名字加进 GLOBALS 白名单（注释里写清它从哪来）。`);
process.exit(1);
