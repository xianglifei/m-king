#!/usr/bin/env node
'use strict';
/**
 * m-king · 本地服务
 * ------------------------------------------------------------
 * 为什么需要它：
 *   纯静态网页的 JS 够不到 MCP（MCP 是服务端能力），所以「点了没反应」。
 *   这个小服务把两件事接起来：
 *     1. 托管 index.html（同源，无 CORS 问题）
 *     2. 暴露 /api/run，把网页的点击转发成真实的麦当劳 MCP 调用链
 *   于是：点击 → 服务端执行 → 结果回网页渲染，全程不离开页面。
 *
 * 只监听 127.0.0.1，不对局域网/公网开放。
 * 零第三方依赖，Node 18+ 直接跑。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { MODES, dashboard } = require('./lib/modes');
const mcp = require('./lib/mcp');

if (parseInt(process.versions.node, 10) < 18) {
  console.error('m-king 需要 Node.js 18+（用到内置 fetch），当前为 ' + process.version);
  process.exit(1);
}

const ROOT = __dirname;
const HOST = process.env.MCD_HOST || '127.0.0.1';
const PREFERRED_PORT = Number(process.env.MCD_PORT || 8799);

/* 调试裸调用的精确白名单：改动这里必须同步 README 的安全承诺 */
const TOOL_ALLOWLIST = new Set([
  'now-time-info', 'campaign-calendar',
  'query-nearby-stores', 'query-meals', 'query-my-account', 'query-my-coupons', 'query-lottery-info',
  'order-list', 'list-nutrition-foods', 'mall-points-products', 'mall-order-list',
  'available-coupons', 'delivery-query-addresses', 'delivery-query-stores',
  'calculate-price',
]);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.md': 'text/plain; charset=utf-8',
};

function send(res, code, body, type) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
  res.writeHead(code, {
    'Content-Type': type || 'text/plain; charset=utf-8',
    'Content-Length': buf.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(buf);
}

function sendJson(res, code, obj) {
  send(res, code, JSON.stringify(obj), 'application/json; charset=utf-8');
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    let settled = false;
    const finish = (val) => { if (!settled) { settled = true; resolve(val); } };
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) { req.destroy(); finish({}); } // 防超大请求体
    });
    req.on('end', () => {
      try { finish(data ? JSON.parse(data) : {}); } catch (e) { finish({}); }
    });
    // 连接被中断/销毁时 end 不会触发，兜底 resolve，避免请求悬挂
    req.on('error', () => finish({}));
    req.on('close', () => finish({}));
  });
}

/** 只接受回环来源的 Host 头，防 DNS rebinding 把本服务变成攻击者页面的「同源」后端 */
function hostAllowed(req) {
  const hostname = String(req.headers.host || '')
    .toLowerCase().replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  if (hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1') return true;
  // 用户主动改 MCD_HOST 暴露到非回环时（自行承担风险），放行同名 Host
  return HOST !== '127.0.0.1' && hostname === String(HOST).toLowerCase();
}

/** 静态文件，限制在项目目录内，防目录穿越 */
function serveStatic(req, res, urlPath) {
  const rel = decodeURIComponent(urlPath === '/' ? '/index.html' : urlPath);
  const full = path.join(ROOT, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!full.startsWith(ROOT)) return send(res, 403, 'Forbidden');
  fs.readFile(full, (err, buf) => {
    if (err) return send(res, 404, 'Not Found');
    send(res, 200, buf, MIME[path.extname(full).toLowerCase()] || 'application/octet-stream');
  });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    try { send(res, 500, 'Internal Error: ' + e.message); } catch (e2) { /* 响应已发出 */ }
  });
});

async function handle(req, res) {
  if (!hostAllowed(req)) return send(res, 403, 'Forbidden');

  const url = new URL(req.url, 'http://' + HOST);
  const p = url.pathname;

  /* ---------- 状态：Token 是否就绪、服务是否可用 ---------- */
  if (p === '/api/status' && req.method === 'GET') {
    const ready = mcp.tokenReady();
    let tools = [];
    if (ready) {
      try { tools = (await mcp.listTools()).map((t) => ({ name: t.name, desc: (t.description || '').split('\n')[0].slice(0, 80) })); }
      catch (e) { tools = []; }
    }
    return sendJson(res, 200, {
      ok: ready,
      endpoint: mcp.MCP_URL,
      tokenSource: mcp.tokenSource(),
      tokenReady: ready,
      toolCount: tools.length,
      tools,
      modes: Object.entries(MODES).map(([id, m]) => ({ id, ...m.meta })),
      hint: ready ? null : '未找到麦当劳 MCP Token：请先按 README 配置（或设置环境变量 MCD_MCP_TOKEN）',
    });
  }

  /* ---------- 首页看板真实数据 ---------- */
  if (p === '/api/dashboard' && req.method === 'GET') {
    try { return sendJson(res, 200, await dashboard()); }
    catch (e) { return sendJson(res, 500, { ok: false, error: e.message }); }
  }

  /* ---------- 执行某个模式 ---------- */
  if (p === '/api/run' && req.method === 'POST') {
    const body = await readBody(req);
    const id = body.mode;
    const entry = MODES[id];
    if (!entry) return sendJson(res, 404, { ok: false, error: '未知模式：' + id });
    const t0 = Date.now();
    try {
      const result = await entry.run(body.options || {});
      return sendJson(res, 200, { ok: true, ...result });
    } catch (e) {
      return sendJson(res, 200, {
        ok: false, mode: id,
        title: entry.meta.name,
        error: e.message,
        costMs: Date.now() - t0,
        blocks: [{ type: 'note', tone: 'bad', text: '执行失败：' + e.message }],
      });
    }
  }

  /* ---------- 单次裸调用（调试用，白名单：只放行查询/算价类，与 README「绝不调用写入类能力」的承诺一致） ---------- */
  if (p === '/api/tool' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body.name || !TOOL_ALLOWLIST.has(body.name)) {
      return sendJson(res, 400, { ok: false, error: '不允许的工具名（白名单仅含查询/算价类工具）' });
    }
    const r = await mcp.callTool(body.name, body.args || {});
    return sendJson(res, 200, { ok: r.ok, ms: r.ms, tool: r.tool, data: r.data, error: r.error });
  }

  if (p.startsWith('/api/')) return sendJson(res, 404, { ok: false, error: 'no such api' });

  return serveStatic(req, res, p);
}

/** 端口占用时顺延，直到找到可用端口 */
function listen(port, attempts = 12) {
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && attempts > 0) {
      listen(port + 1, attempts - 1);
    } else {
      console.error('启动失败：', err.message);
      process.exit(1);
    }
  });
  server.listen(port, HOST, () => {
    const url = `http://${HOST}:${port}/`;
    console.log('');
    console.log('  🍟  m-king · 麦门总管');
    console.log('  ────────────────────────────────────────');
    console.log('  服务地址   ' + url);
    console.log('  MCP 端点   ' + mcp.MCP_URL);
    console.log('  Token      ' + (mcp.tokenReady() ? '已就绪（来源：' + mcp.tokenSource() + '）' : '❌ 未配置 —— 请见 README'));
    console.log('  已加载模式 ' + Object.keys(MODES).length + ' 个');
    console.log('');
    console.log('  打开上面地址，点房子两侧任意一门即可执行。Ctrl+C 停止。');
    console.log('');
  });
}

listen(PREFERRED_PORT);
