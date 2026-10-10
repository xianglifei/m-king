#!/usr/bin/env node
'use strict';
/* build-demo.js — 生成静态快照 Demo（demo/index.html）
 *
 * 作用：从本地 m-king 服务抓一轮真实数据（看板 + 六个模式的结果），
 *       经 lib/sanitize.js 脱敏（门店名称、订单时间）后烘焙进 index.html
 *       的副本，并注入一个 fetch 拦截器，产出一个自包含、零网络请求的演示页。
 *
 * 用法：
 *   1) 先在本目录运行  node server.js（或 npm start）
 *   2) 另开一个终端运行  node scripts/build-demo.js（或 npm run demo）
 *
 * 可选环境变量：
 *   MCD_BASE   本地服务地址，默认 http://127.0.0.1:8799
 */
if (parseInt(process.versions.node, 10) < 18) {
  console.error('build-demo 需要 Node.js 18+（用到内置 fetch），当前为 ' + process.version);
  process.exit(1);
}

const fs = require('fs');
const path = require('path');
const { sanitizeSnapshot } = require('../lib/sanitize');

const ROOT = path.resolve(__dirname, '..');
const BASE = process.env.MCD_BASE || 'http://127.0.0.1:8799';
const MODES = ['mci-index', 'annual-report', 'points-advisor', 'fulfillment-compare', 'coupon-lifecycle', 'calorie-coach'];

async function jget(p) {
  const r = await fetch(BASE + p, { signal: AbortSignal.timeout(60000) });
  return r.json();
}
async function jpost(p, body) {
  const r = await fetch(BASE + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });
  return r.json();
}
function bjNow() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  return d.toISOString().slice(0, 16).replace('T', ' ');
}

(async () => {
  const status = await jget('/api/status');
  const dashboard = await jget('/api/dashboard');
  const modes = {};
  for (const m of MODES) {
    const r = await jpost('/api/run', { mode: m });
    modes[m] = r;
    process.stderr.write(`  ${r.ok ? '✓' : '✗'} ${m}  ${r.costMs || 0}ms  ${(r.blocks || []).length} blocks\n`);
  }

  const snap = sanitizeSnapshot({
    takenAt: bjNow(),
    status: { ok: true, toolCount: status.toolCount, endpoint: status.endpoint },
    dashboard,
    modes,
  });

  let html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

  // ---- 1) 演示横幅（自带样式，不依赖页面里的 CSS 锚点） ----
  const banner =
    '<style>#snapbar{position:sticky;top:0;z-index:60;margin:0 0 18px;padding:9px 18px;\n' +
    '  background:linear-gradient(90deg,#FFF6DC,#FFEBB8);border-bottom:1px solid #F0DCA0;\n' +
    '  font-size:12px;color:#7A5A11;display:flex;align-items:center;gap:8px;flex-wrap:wrap}\n' +
    '#snapbar b{color:#8E1A10;font-weight:600}\n' +
    '#snapbar .sep{color:#C9A94E}</style>\n' +
    '<div id="snapbar">' +
    '<b>演示快照</b><span class="sep">·</span>' +
    '<span>真实麦当劳 MCP 调用结果的静态烘焙，取数时间 <b id="snapAt"></b></span>' +
    '<span class="sep">·</span><span>门店名称与订单时间已脱敏</span>' +
    '<span class="sep">·</span>' +
    '<span>页面本身为静态，<b>不发起任何网络请求</b>；完整可执行版见 ' +
    '<a href="https://github.com/xianglifei/m-king" target="_blank" rel="noopener">GitHub 仓库</a></span>' +
    '</div>\n';

  // ---- 2) 快照资源 + fetch 拦截器：插到 <body> 之后（先于页面主脚本执行） ----
  const interceptor =
    '<!-- ===== 演示快照（静态，已脱敏） ===== -->\n' +
    '<script id="__MKING_SNAPSHOT__" type="application/json">' +
    JSON.stringify(snap).replace(/<\//g, '<\\/') +
    '</script>\n' +
    '<script>\n' +
    '(function(){\n' +
    '  var S = JSON.parse(document.getElementById("__MKING_SNAPSHOT__").textContent);\n' +
    '  window.__MKING_SNAPSHOT__ = S;\n' +
    '  var real = window.fetch ? window.fetch.bind(window) : null;\n' +
    '  function reply(obj){ return Promise.resolve({ ok:true, json:function(){ return Promise.resolve(obj); } }); }\n' +
    '  window.fetch = function(url, opts){\n' +
    '    var u = String(url);\n' +
    '    if (u.indexOf("/api/status") >= 0) return reply(S.status);\n' +
    '    if (u.indexOf("/api/dashboard") >= 0) return reply(S.dashboard);\n' +
    '    if (u.indexOf("/api/run") >= 0) {\n' +
    '      var mode = "";\n' +
    '      try { mode = JSON.parse((opts && opts.body) || "{}").mode || ""; } catch(e){}\n' +
    '      if (S.modes[mode]) return reply(S.modes[mode]);\n' +
    '      return reply({ ok:false, mode:mode, title:"演示快照缺失", subtitle:"", error:"该模式未包含在快照中", blocks:[{type:"note",tone:"bad",text:"该模式未包含在本次演示快照中。"}] });\n' +
    '    }\n' +
    '    return real ? real(url, opts) : Promise.reject(new Error("no fetch"));\n' +
    '  };\n' +
    '})();\n' +
    '</script>\n';

  const bodyTag = html.match(/<body[^>]*>/);
  if (!bodyTag) throw new Error('index.html 里找不到 <body>（页面结构是否被改动？）');
  html = html.replace(bodyTag[0], bodyTag[0] + '\n' + banner + interceptor);

  // ---- 3) 收尾脚本：填时间 + 改写状态栏（挂在 </body> 前） ----
  const tail =
    '\n<script>\n' +
    '(function(){\n' +
    '  var S = window.__MKING_SNAPSHOT__; if (!S) return;\n' +
    '  var at = document.getElementById("snapAt"); if (at) at.textContent = S.takenAt;\n' +
    '  var n = 0, t = setInterval(function(){\n' +
    '    var s = document.getElementById("statusText");\n' +
    '    if (s) { document.getElementById("dot").className = "dot"; s.textContent = "演示快照模式 · 数据取自 " + S.takenAt; }\n' +
    '    if (++n > 25) clearInterval(t);\n' +
    '  }, 120);\n' +
    '})();\n' +
    '</script>\n';

  // 快照模式下把"实时"措辞改掉，避免误导
  html = html.split('今日活动速览 · 实时').join('今日活动速览 · 快照回放');
  html = html.split('推门即执行 · 六个麦门技能跑在真实麦当劳 MCP 上')
    .join('推门即执行 · 六个麦门技能跑在真实麦当劳 MCP 上（演示快照）');

  html = html.replace('</body>', tail + '</body>');
  html = html.replace('<title>m-king · 麦门总管</title>', '<title>m-king · 麦门总管（演示快照）</title>');

  const outDir = path.join(ROOT, 'demo');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, 'index.html');
  fs.writeFileSync(outFile, html, 'utf8');

  process.stderr.write('\n生成: ' + outFile + '  (' + (Buffer.byteLength(html) / 1024).toFixed(1) + ' KB)\n');
  process.stderr.write('取数时间: ' + snap.takenAt + '\n');
  process.stderr.write('脱敏: 门店名称与订单时间已替换（详见 lib/sanitize.js）\n');
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
