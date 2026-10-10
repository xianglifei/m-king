'use strict';
/* server 集成测试：Host 校验、工具白名单、目录穿越、模式路由（不需要真实 Token） */

const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');

const PORT = 18923;
const BASE = `http://127.0.0.1:${PORT}`;

function rawReq(pathname, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: pathname, headers }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end();
  });
}

test('server 安全基线', async (t) => {
  const proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: Object.assign({}, process.env, { MCD_PORT: String(PORT), MCD_MCP_TOKEN: 'dummy-token-for-test' }),
    stdio: 'ignore',
  });
  t.after(() => proc.kill());

  // 等服务就绪
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    try { const r = await fetch(BASE + '/api/status'); if (r.ok) up = true; } catch (e) { /* retry */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(up, 'server 应在 6 秒内启动');

  // 正常 Host：首页可访问
  assert.equal(await rawReq('/', { Host: `127.0.0.1:${PORT}` }), 200);

  // DNS rebinding 防护：非回环 Host 一律 403
  assert.equal(await rawReq('/', { Host: 'evil.example.com' }), 403);
  assert.equal(await rawReq('/api/run', { Host: 'evil.example.com:443' }), 403);

  // 写入类工具被白名单拒绝（README 承诺：绝不调用写入类能力）
  const toolRes = await fetch(BASE + '/api/tool', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'create-order' }),
  });
  assert.equal(toolRes.status, 400);
  const toolBody = await toolRes.json();
  assert.equal(toolBody.ok, false);

  // 目录穿越拿不到项目外文件
  assert.equal(await rawReq('/..%2f..%2f..%2fetc%2fpasswd'), 404);
  assert.equal(await rawReq('/%2e%2e/%2e%2e/etc/passwd'), 404);

  // 未知模式返回 404
  const runRes = await fetch(BASE + '/api/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'no-such-mode' }),
  });
  assert.equal(runRes.status, 404);
});
