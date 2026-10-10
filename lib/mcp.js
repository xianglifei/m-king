'use strict';
/**
 * m-king · MCP 客户端
 * ------------------------------------------------------------
 * 直接用 JSON-RPC over HTTP 访问麦当劳中国 MCP 服务（https://mcp.mcd.cn）。
 * 零依赖（只用 Node 内置 fetch），因此 can run standalone without WorkBuddy。
 *
 * Token 解析顺序（越靠前优先级越高）：
 *   1. 环境变量 MCD_MCP_TOKEN
 *   2. WorkBuddy 连接器配置 ~/.workbuddy/mcp.json 里的 mcpServers.mcd-mcp
 *   3. 项目内本地配置 ./mcp.config.json（已 gitignore，不要提交）
 *
 * 安全：Token 只在本地进程内使用，永远不会出现在任何输出、日志或返回体里。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const MCP_URL = process.env.MCD_MCP_URL || 'https://mcp.mcd.cn';
const TIMEOUT_MS = Number(process.env.MCD_TIMEOUT_MS || 30000);

/** 从 WorkBuddy 的 MCP 配置里抠出 Bearer Token */
function tokenFromWorkBuddyConfig() {
  const p = path.join(os.homedir(), '.workbuddy', 'mcp.json');
  try {
    const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
    const srv = (cfg.mcpServers || {})['mcd-mcp'];
    const auth = srv && srv.headers && srv.headers.Authorization;
    if (auth && /^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim();
    if (srv && srv.headers && srv.headers.authorization) {
      return String(srv.headers.authorization).replace(/^Bearer\s+/i, '').trim();
    }
  } catch (e) { /* 配置文件不存在或格式不对，交给下一级回退 */ }
  return null;
}

/** 从项目内本地配置读 Token */
function tokenFromLocalConfig() {
  const p = path.join(__dirname, '..', 'mcp.config.json');
  try {
    const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (cfg.token) return String(cfg.token).trim();
    if (cfg.mcpServers && cfg.mcpServers['mcd-mcp']) {
      const a = cfg.mcpServers['mcd-mcp'].headers &&
                (cfg.mcpServers['mcd-mcp'].headers.Authorization ||
                 cfg.mcpServers['mcd-mcp'].headers.authorization);
      if (a) return String(a).replace(/^Bearer\s+/i, '').trim();
    }
  } catch (e) { /* 无本地配置 */ }
  return null;
}

let _cachedToken = null;
function resolveToken() {
  if (_cachedToken) return _cachedToken;
  _cachedToken =
    (process.env.MCD_MCP_TOKEN && process.env.MCD_MCP_TOKEN.trim()) ||
    tokenFromWorkBuddyConfig() ||
    tokenFromLocalConfig() ||
    null;
  return _cachedToken;
}

/** Token 是否就绪（不返回 Token 本身） */
function tokenReady() { return Boolean(resolveToken()); }

/** Token 来源（用于状态页展示，不含敏感内容） */
function tokenSource() {
  if (process.env.MCD_MCP_TOKEN && process.env.MCD_MCP_TOKEN.trim()) return 'env:MCD_MCP_TOKEN';
  if (tokenFromWorkBuddyConfig()) return '~/.workbuddy/mcp.json';
  if (tokenFromLocalConfig()) return 'mcp.config.json';
  return null;
}

/** 把 SSE 或纯 JSON 两种响应体统一解析成对象 */
function parseBody(text) {
  const t = text.trim();
  if (!t) return null;
  if (t.startsWith('{') || t.startsWith('[')) return JSON.parse(t);
  // text/event-stream：逐行找 data:
  const lines = t.split(/\r?\n/);
  for (const line of lines) {
    if (line.startsWith('data:')) {
      const payload = line.slice(5).trim();
      if (payload && payload !== '[DONE]') {
        try { return JSON.parse(payload); } catch (e) { /* 继续找 */ }
      }
    }
  }
  throw new Error('无法解析 MCP 响应：' + t.slice(0, 200));
}

/** 从 tools/call 结果里抽出业务数据（优先 structuredContent） */
function extractData(result) {
  if (!result) return null;
  if (result.structuredContent) return result.structuredContent;
  const content = result.content || [];
  for (const c of content) {
    if (c && c.type === 'text' && typeof c.text === 'string') {
      const m = c.text.match(/## Original Response\s*\n+([\s\S]*)$/);
      const body = m ? m[1] : c.text;
      try { return JSON.parse(body); } catch (e) { return { _text: body }; }
    }
  }
  return null;
}

/** 底层 JSON-RPC 调用 */
async function rpc(method, params) {
  const token = resolveToken();
  if (!token) throw new Error('未找到麦当劳 MCP Token，请先配置（见 README）');

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(MCP_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'Authorization': 'Bearer ' + token,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: Date.now() % 100000, method, params }),
      signal: ctrl.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error('MCP HTTP ' + res.status + ' · ' + text.slice(0, 180));
    const json = parseBody(text);
    if (!json) throw new Error('MCP 返回空响应');
    if (json.error) throw new Error('MCP 错误 ' + (json.error.code || '') + ' ' + (json.error.message || ''));
    return json.result;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 调用一个 MCP 工具。
 * 永不抛异常，统一返回 { ok, data, ms, error }，方便上层编排容错。
 */
async function callTool(name, args = {}) {
  const t0 = Date.now();
  try {
    const result = await rpc('tools/call', { name, arguments: args });
    const data = extractData(result);
    const ms = Date.now() - t0;
    if (data && data.success === false) {
      return { ok: false, ms, tool: name, args, error: (data.message || '调用失败') + ' (' + data.code + ')', data };
    }
    return { ok: true, ms, tool: name, args, data };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, tool: name, args, error: e.message };
  }
}

/** 取工具返回的 data 字段（麦当劳统一包在 data 里） */
function payload(res) { return res && res.data ? res.data.data : undefined; }

/** 服务器时间 */
async function nowTime() {
  const r = await callTool('now-time-info', {});
  return payload(r) || null;
}

/** 列出全部工具（用于状态页展示能力清单） */
async function listTools() {
  const r = await rpc('tools/list', {});
  return (r && r.tools) || [];
}

module.exports = {
  MCP_URL, TIMEOUT_MS,
  callTool, payload, nowTime, listTools,
  resolveToken, tokenReady, tokenSource,
};
