/* 麦门制霸图 · m-king v2（Q版）
 * 渲染与交互层：纯逻辑在 core.js（可单测），本文件负责 canvas 渲染、
 * 交互（拖拽/缩放/打卡）、持久化与产品功能（目标卡/徽章墙/分享卡）。
 * 点亮只由真实用餐记录驱动（打卡/订单导入），没有随机自动点亮。
 */
(() => {
'use strict';
const C = window.MCK_CORE;
const { clamp, ease, mulberry32, hashStr } = C;
const FONT = '"Yuanti SC","YouYuan","PingFang SC","Microsoft YaHei",sans-serif';
const CONFETTI_COLORS = ['#da291c', '#ffc72c', '#ffffff', '#58b368', '#ff8a3c'];

/* ================= 全局状态 ================= */
const canvas = document.getElementById('map');
const ctx = canvas.getContext('2d');
const tooltip = document.getElementById('tooltip');

const S = {
  mode: 'demo',
  city: '北京',
  stores: [],
  cells: [],
  roads: [],
  visits: new Map(),
  anims: [],
  particles: [],
  hover: null,
  tooltipPinned: false,
  lastCheckIn: null,
  view: { k: 1, tx: 0, ty: 0 },
  W: 1000, H: 600,
  kmPerUnit: 1,
  score: 0, scoreShown: 0,
  dragging: false, dragMoved: false,
};

/* ================= 持久化（手动打卡 + 首访标记） ================= */
const LS_KEY = 'mck-checkins-v1';
let P = { demo: [], real: [], seenHelp: false };
try { P = Object.assign(P, JSON.parse(localStorage.getItem(LS_KEY) || '{}')); } catch (e) { /* 隐私模式等 */ }
function persist() {
  try { localStorage.setItem(LS_KEY, JSON.stringify({ demo: P.demo, real: P.real, seenHelp: P.seenHelp })); } catch (e) { /* 忽略 */ }
}

/* ================= 数据加载 ================= */
async function tryFetchJSON(url) {
  try {
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) return null;
    return await r.json();
  } catch (e) { return null; }
}

async function loadData() {
  let stores, visits;
  const combined = await tryFetchJSON('data/stores.json');
  if (combined && Array.isArray(combined.stores)) {
    stores = combined.stores;
    visits = combined.visits || (await tryFetchJSON('data/visits.json')) || [];
    S.mode = 'real';
    S.city = combined.city || '北京';
  } else {
    const v2 = await tryFetchJSON('data/visits.json');
    const demo = window.MC_KINGDOM_DEMO;
    if (!demo) throw new Error('演示数据缺失');
    stores = demo.stores;
    visits = v2 || demo.visits || [];
    S.mode = 'demo';
    S.city = demo.city || '北京';
  }
  S.stores = stores;
  S.visits = new Map((visits || []).map(v => [v.storeId, v.date || '']));
  // 合并本机手动打卡（订单接口只有最近 ~10 单，手动打卡是长期档案）
  for (const rec of (P[S.mode] || [])) {
    if (S.stores.some(s => s.id === rec.storeId) && !S.visits.has(rec.storeId)) {
      S.visits.set(rec.storeId, rec.date || '');
    }
  }
  // 撤销入口跨刷新可用：指向档案里最近的一条手动打卡
  const manual = P[S.mode] || [];
  if (manual.length) {
    S.lastCheckIn = { storeId: manual[manual.length - 1].storeId };
  }
  build();
}

/* ================= 投影与构建 ================= */
let landRect = null;

function build() {
  const { W, H, kmPerUnit } = C.projectStores(S.stores);
  S.W = W; S.H = H; S.kmPerUnit = kmPerUnit;
  const inset = 7;
  landRect = { x: inset, y: inset, w: W - inset * 2, h: H - inset * 2, r: 30 };
  S.cells = C.voronoi(S.stores, { x0: 0, y0: 0, x1: W, y1: H });
  S.roads = C.buildRoads(S.stores);
  document.getElementById('cityName').textContent = '· ' + S.city;
  fitView();
  ensureLoop();
  render();
  renderSidebar();
}

/* ================= 天空背景（缓存） ================= */
let bgCanvas = null;
function makeSky(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, '#9fdcff');
  grad.addColorStop(0.55, '#c8ecff');
  grad.addColorStop(1, '#e8f8ff');
  g.fillStyle = grad;
  g.fillRect(0, 0, w, h);
  const rnd = mulberry32(2026);
  for (let i = 0; i < 9; i++) drawCloud(g, rnd() * w, h * (0.04 + rnd() * 0.3), 26 + rnd() * 40, 0.8);
  return c;
}
function drawCloud(g, x, y, r, alpha) {
  g.save();
  g.globalAlpha = alpha;
  g.fillStyle = '#ffffff';
  g.beginPath();
  g.arc(x, y, r * 0.5, 0, Math.PI * 2);
  g.arc(x + r * 0.5, y - r * 0.22, r * 0.62, 0, Math.PI * 2);
  g.arc(x + r * 1.05, y, r * 0.46, 0, Math.PI * 2);
  g.rect(x - r * 0.5, y, r * 1.55, r * 0.5);
  g.fill();
  g.restore();
}

/* ================= 视图 ================= */
function resize() {
  const wrap = document.getElementById('mapWrap');
  const dpr = window.devicePixelRatio || 1;
  canvas.width = wrap.clientWidth * dpr;
  canvas.height = wrap.clientHeight * dpr;
  canvas.style.width = wrap.clientWidth + 'px';
  canvas.style.height = wrap.clientHeight + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  S.cssW = wrap.clientWidth; S.cssH = wrap.clientHeight;
  S.dpr = dpr;
  bgCanvas = makeSky(Math.ceil(S.cssW * dpr), Math.ceil(S.cssH * dpr));
  render();
}

function fitView() {
  const kw = S.cssW / S.W, kh = S.cssH / S.H;
  const k = Math.min(kw, kh) * 0.96;
  S.view.k = k;
  S.view.tx = (S.cssW - S.W * k) / 2;
  S.view.ty = (S.cssH - S.H * k) / 2;
}
const worldToScreen = (x, y) => [x * S.view.k + S.view.tx, y * S.view.k + S.view.ty];
const isLit = s => C.isLit(S.visits, s.id);

/* ================= 渲染 ================= */
function rrPath(g, r) {
  g.beginPath();
  g.moveTo(r.x + r.r, r.y);
  g.arcTo(r.x + r.w, r.y, r.x + r.w, r.y + r.h, r.r);
  g.arcTo(r.x + r.w, r.y + r.h, r.x, r.y + r.h, r.r);
  g.arcTo(r.x, r.y + r.h, r.x, r.y, r.r);
  g.arcTo(r.x, r.y, r.x + r.w, r.y, r.r);
  g.closePath();
}

function render() {
  if (!S.cells.length || !bgCanvas) return;
  const { k } = S.view;
  ctx.save();
  ctx.setTransform(S.dpr, 0, 0, S.dpr, 0, 0);
  ctx.drawImage(bgCanvas, 0, 0, S.cssW, S.cssH);

  ctx.translate(S.view.tx, S.view.ty);
  ctx.scale(k, k);

  ctx.save();
  rrPath(ctx, landRect);
  ctx.clip();

  // 草地底 + 斑块
  ctx.fillStyle = '#8ecf72';
  ctx.fillRect(landRect.x, landRect.y, landRect.w, landRect.h);
  const rndL = mulberry32(99);
  for (let i = 0; i < 26; i++) {
    const x = rndL() * S.W, y = rndL() * S.H, r = 60 + rndL() * 160;
    ctx.fillStyle = rndL() > 0.5 ? 'rgba(255,255,255,0.07)' : 'rgba(50,120,40,0.06)';
    ctx.beginPath();
    ctx.ellipse(x, y, r, r * 0.6, rndL() * Math.PI, 0, Math.PI * 2);
    ctx.fill();
  }

  // 领地
  for (const cell of S.cells) {
    const s = cell.site;
    const poly = cell.poly;
    ctx.beginPath();
    ctx.moveTo(poly[0][0], poly[0][1]);
    for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i][0], poly[i][1]);
    ctx.closePath();
    if (isLit(s)) {
      const grad = ctx.createLinearGradient(0, s.y - 50, 0, s.y + 50);
      grad.addColorStop(0, '#ffd94e');
      grad.addColorStop(1, '#ffc32a');
      ctx.fillStyle = grad;
      ctx.fill();
    } else {
      ctx.fillStyle = '#d9ecca';
      ctx.fill();
      ctx.fillStyle = 'rgba(110,140,100,0.10)';
      ctx.fill();
    }
  }

  // 白色贴纸描边
  ctx.strokeStyle = 'rgba(255,255,255,0.95)';
  ctx.lineWidth = 3;
  ctx.lineJoin = 'round';
  for (const cell of S.cells) {
    const poly = cell.poly;
    ctx.beginPath();
    ctx.moveTo(poly[0][0], poly[0][1]);
    for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i][0], poly[i][1]);
    ctx.closePath();
    ctx.stroke();
  }

  // 迷雾云朵
  for (const cell of S.cells) {
    if (!isLit(cell.site)) drawFogCloud(cell);
  }

  drawRiver();
  drawScenery();

  // 道路
  ctx.setLineDash([9, 7]);
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.lineWidth = 2.4;
  ctx.beginPath();
  for (const [a, b] of S.roads) {
    ctx.moveTo(S.stores[a].x, S.stores[a].y);
    ctx.lineTo(S.stores[b].x, S.stores[b].y);
  }
  ctx.stroke();
  ctx.setLineDash([]);

  // 打卡渐染动画 + 光环
  const now = performance.now();
  for (const a of S.anims) {
    const t = clamp((now - a.t0) / 900, 0, 1);
    const e = ease(t);
    const cell = a.cell;
    ctx.beginPath();
    ctx.moveTo(cell.poly[0][0], cell.poly[0][1]);
    for (let i = 1; i < cell.poly.length; i++) ctx.lineTo(cell.poly[i][0], cell.poly[i][1]);
    ctx.closePath();
    ctx.globalAlpha = e * 0.95;
    const grad = ctx.createLinearGradient(0, cell.site.y - 50, 0, cell.site.y + 50);
    grad.addColorStop(0, '#ffd94e');
    grad.addColorStop(1, '#ffc32a');
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.beginPath();
    ctx.arc(cell.site.x, cell.site.y, 8 + e * 55, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,138,60,' + (0.75 * (1 - e)) + ')';
    ctx.lineWidth = 4 * (1 - e) + 0.6;
    ctx.stroke();
  }
  ctx.restore(); // land clip
  ctx.restore(); // world

  // 屏幕空间层
  ctx.save();
  ctx.setTransform(S.dpr, 0, 0, S.dpr, 0, 0);
  for (const s of S.stores) {
    const [sx, sy] = worldToScreen(s.x, s.y);
    if (sx < -40 || sy < -40 || sx > S.cssW + 40 || sy > S.cssH + 40) continue;
    drawSettlement(s, sx, sy);
  }
  drawDistrictLabels();
  if (S.hover) {
    const [hx, hy] = worldToScreen(S.hover.site.x, S.hover.site.y);
    ctx.beginPath();
    ctx.arc(hx, hy, 16, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,110,40,0.95)';
    ctx.lineWidth = 2.5;
    ctx.stroke();
  }
  drawParticles();
  drawSun();
  drawScaleBar();
  ctx.restore();
}

function drawFogCloud(cell) {
  const rnd = mulberry32(hashStr(cell.site.id + '#c'));
  const xs = cell.poly.map(p => p[0]), ys = cell.poly.map(p => p[1]);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  const x = cx + (rnd() - 0.5) * (Math.max(...xs) - Math.min(...xs)) * 0.3;
  const y = cy + (rnd() - 0.5) * (Math.max(...ys) - Math.min(...ys)) * 0.3;
  const r = 11 + rnd() * 7;
  ctx.save();
  rrPath(ctx, landRect);
  ctx.clip();
  ctx.fillStyle = 'rgba(140,170,140,0.22)';
  ctx.beginPath();
  ctx.arc(x, y + r * 0.28, r * 0.55, 0, Math.PI * 2);
  ctx.arc(x + r * 0.5, y + r * 0.1, r * 0.6, 0, Math.PI * 2);
  ctx.fill();
  drawCloud(ctx, x - r * 0.55, y - r * 0.1, r * 1.15, 0.9);
  ctx.restore();
}

let riverPath = null;
function drawRiver() {
  if (!riverPath) {
    const rnd = mulberry32(7);
    riverPath = new Path2D();
    let x = S.W * 0.02, y = S.H * (0.3 + rnd() * 0.15);
    riverPath.moveTo(x, y);
    const pts = [[0.18, 0.55], [0.36, 0.32], [0.55, 0.62], [0.74, 0.42], [0.98, 0.7]];
    for (const [fx, fy] of pts) {
      const nx = S.W * fx, ny = S.H * fy;
      riverPath.quadraticCurveTo((x + nx) / 2 + (rnd() - 0.5) * S.W * 0.12, (y + ny) / 2 + (rnd() - 0.5) * S.H * 0.12, nx, ny);
      x = nx; y = ny;
    }
  }
  ctx.strokeStyle = 'rgba(110,198,242,0.95)';
  ctx.lineWidth = 10;
  ctx.lineCap = 'round';
  ctx.stroke(riverPath);
  ctx.strokeStyle = 'rgba(255,255,255,0.7)';
  ctx.lineWidth = 2.2;
  ctx.setLineDash([10, 12]);
  ctx.stroke(riverPath);
  ctx.setLineDash([]);
}

function drawScenery() {
  for (const cell of S.cells) {
    const s = cell.site;
    if (isLit(s)) continue;
    const rnd = mulberry32(hashStr(s.id + '#sc'));
    if (s.remote && rnd() > 0.3) {
      ctx.fillStyle = '#a5d88a';
      ctx.strokeStyle = 'rgba(90,150,70,0.5)';
      ctx.lineWidth = 1;
      const n = 1 + Math.floor(rnd() * 2);
      for (let m = 0; m < n; m++) {
        const ox = s.x + (rnd() - 0.5) * 50, oy = s.y + (rnd() - 0.5) * 44;
        const w = 9 + rnd() * 7, h = 6 + rnd() * 5;
        ctx.beginPath();
        ctx.ellipse(ox, oy, w, h, 0, Math.PI, 0);
        ctx.closePath();
        ctx.fill(); ctx.stroke();
      }
    }
    if (rnd() > 0.55) {
      const n = 2 + Math.floor(rnd() * 3);
      for (let m = 0; m < n; m++) {
        const ox = s.x + (rnd() - 0.5) * 64, oy = s.y + (rnd() - 0.5) * 54;
        ctx.fillStyle = 'rgba(110,80,50,0.75)';
        ctx.fillRect(ox - 0.9, oy - 1, 1.8, 4.5);
        ctx.fillStyle = rnd() > 0.5 ? '#5cb567' : '#79c96f';
        ctx.beginPath();
        ctx.arc(ox, oy - 4, 3.2 + rnd() * 1.6, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
}

/* ---------- Q版城邦图标（地图/图例/打卡列表共用） ---------- */
function drawIconOn(g, tier, conquered) {
  const line = '#7a4a1e';
  g.lineJoin = 'round';
  g.lineWidth = 1.6;
  g.strokeStyle = line;
  if (tier === 3) {
    g.fillStyle = conquered ? '#fffdf5' : '#e8e4da';
    g.beginPath(); g.roundRect(-10, -3, 20, 11, 2); g.fill(); g.stroke();
    g.beginPath(); g.roundRect(-12.5, -9, 6.5, 17, 2); g.fill(); g.stroke();
    g.beginPath(); g.roundRect(6, -9, 6.5, 17, 2); g.fill(); g.stroke();
    g.beginPath(); g.roundRect(-3.5, -7, 7, 15, 2); g.fill(); g.stroke();
    g.fillStyle = conquered ? '#e84a3f' : '#b9b2a6';
    g.beginPath(); g.moveTo(-13.5, -9); g.lineTo(-9.25, -14.5); g.lineTo(-5, -9); g.closePath(); g.fill(); g.stroke();
    g.beginPath(); g.moveTo(5, -9); g.lineTo(9.25, -14.5); g.lineTo(13.5, -9); g.closePath(); g.fill(); g.stroke();
    g.beginPath(); g.moveTo(-4.5, -7); g.lineTo(0, -12.5); g.lineTo(4.5, -7); g.closePath(); g.fill(); g.stroke();
    g.fillStyle = '#9a6a3a';
    g.beginPath();
    g.moveTo(-2.4, 8); g.lineTo(-2.4, 4.5); g.arc(0, 4.5, 2.4, Math.PI, 0); g.lineTo(2.4, 8);
    g.closePath(); g.fill();
    g.beginPath(); g.moveTo(0, -12.5); g.lineTo(0, -19); g.stroke();
    g.fillStyle = conquered ? '#da291c' : '#c9c2b4';
    g.beginPath();
    g.moveTo(0, -19); g.lineTo(8.5, -16.8); g.lineTo(0, -14.4);
    g.closePath(); g.fill();
    if (conquered) {
      g.fillStyle = '#ffc72c';
      g.font = '900 5.5px ' + FONT;
      g.textAlign = 'center';
      g.fillText('M', 4, -15.4);
    }
  } else if (tier === 2) {
    g.fillStyle = conquered ? '#fffdf5' : '#e8e4da';
    g.beginPath(); g.roundRect(-7.5, -2, 15, 9, 2); g.fill(); g.stroke();
    g.fillStyle = conquered ? '#e84a3f' : '#b9b2a6';
    g.beginPath();
    g.moveTo(-9, -2); g.lineTo(0, -9.5); g.lineTo(9, -2);
    g.closePath(); g.fill(); g.stroke();
    g.fillStyle = '#9a6a3a';
    g.beginPath();
    g.moveTo(-1.9, 7); g.lineTo(-1.9, 3.2); g.arc(0, 3.2, 1.9, Math.PI, 0); g.lineTo(1.9, 7);
    g.closePath(); g.fill();
    g.fillStyle = '#bfe0f5';
    g.beginPath(); g.roundRect(2.8, 0.5, 3, 3, 1); g.fill(); g.stroke();
    g.beginPath(); g.moveTo(0, -9.5); g.lineTo(0, -14); g.stroke();
    g.fillStyle = conquered ? '#da291c' : '#c9c2b4';
    g.beginPath(); g.moveTo(0, -14); g.lineTo(6, -12.4); g.lineTo(0, -10.8); g.closePath(); g.fill();
  } else {
    g.fillStyle = '#fffdf5';
    g.beginPath(); g.roundRect(-6, 1, 12, 6, 2); g.fill(); g.stroke();
    g.beginPath(); g.moveTo(0, 1); g.lineTo(0, -8); g.stroke();
    g.fillStyle = conquered ? '#ffc72c' : '#c9c2b4';
    g.beginPath();
    g.arc(0, -8, 8, Math.PI, 0);
    g.closePath(); g.fill(); g.stroke();
    if (conquered) {
      g.strokeStyle = '#fff';
      g.lineWidth = 2;
      g.beginPath(); g.moveTo(-5.4, -8); g.quadraticCurveTo(0, -4.5, 5.4, -8); g.stroke();
    }
    g.strokeStyle = line;
    g.lineWidth = 1.6;
    g.fillStyle = '#e84a3f';
    g.beginPath(); g.arc(0, -8, 1.3, 0, Math.PI * 2); g.fill();
  }
}

function drawSettlement(s, sx, sy) {
  const conquered = isLit(s);
  const k = S.view.k;
  ctx.save();
  ctx.translate(sx, sy);
  if (s.tier === 1 && !conquered && k < 1.35) {
    ctx.fillStyle = 'rgba(255,255,255,0.95)';
    ctx.beginPath(); ctx.arc(0, 0, 4.6, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#9fb98a';
    ctx.beginPath(); ctx.arc(0, 0, 3, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
    return;
  }
  ctx.fillStyle = 'rgba(60,110,40,0.28)';
  ctx.beginPath();
  ctx.ellipse(0, 10, 12, 3.4, 0, 0, Math.PI * 2);
  ctx.fill();
  drawIconOn(ctx, s.tier, conquered);

  const showLabel =
    s.tier === 3 ||
    (conquered && s.tier === 2 && k >= 1.18) ||
    (!conquered && s.tier === 2 && k >= 1.6) ||
    k >= 2.1;
  if (showLabel) {
    ctx.font = (conquered ? '800 ' : '') + '10.5px ' + FONT;
    ctx.textAlign = 'center';
    ctx.lineWidth = 3.5;
    ctx.strokeStyle = 'rgba(255,255,255,0.92)';
    ctx.strokeText(s.shortName, 0, 22);
    ctx.fillStyle = conquered ? '#8a5a10' : '#5a6b48';
    ctx.fillText(s.shortName, 0, 22);
  }
  ctx.restore();
}

function drawDistrictLabels() {
  const byDistrict = {};
  for (const s of S.stores) {
    (byDistrict[s.districtTitle] = byDistrict[s.districtTitle] || []).push(s);
  }
  ctx.font = '800 15px ' + FONT;
  ctx.textAlign = 'center';
  for (const [title, arr] of Object.entries(byDistrict)) {
    const cx = arr.reduce((a, s) => a + s.x, 0) / arr.length;
    const cy = arr.reduce((a, s) => a + s.y, 0) / arr.length;
    const [sx, sy] = worldToScreen(cx, cy);
    if (sx < 0 || sy < 0 || sx > S.cssW || sy > S.cssH) continue;
    ctx.lineWidth = 4.5;
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineJoin = 'round';
    ctx.strokeText(title, sx, sy - 28);
    ctx.fillStyle = 'rgba(90,110,55,0.85)';
    ctx.fillText(title, sx, sy - 28);
  }
}

function drawSun() {
  const x = S.cssW - 48, y = 48;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(performance.now() / 24000);
  ctx.strokeStyle = '#ffcf4d';
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  for (let i = 0; i < 8; i++) {
    const a = (Math.PI * 2 / 8) * i;
    ctx.beginPath();
    ctx.moveTo(Math.cos(a) * 14, Math.sin(a) * 14);
    ctx.lineTo(Math.cos(a) * 19, Math.sin(a) * 19);
    ctx.stroke();
  }
  ctx.restore();
  ctx.save();
  ctx.translate(x, y);
  ctx.fillStyle = '#ffd93b';
  ctx.strokeStyle = '#f0a828';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(0, 0, 13, 0, Math.PI * 2);
  ctx.fill(); ctx.stroke();
  ctx.fillStyle = '#8a5a10';
  ctx.beginPath(); ctx.arc(-4, -2.5, 1.5, 0, Math.PI * 2); ctx.arc(4, -2.5, 1.5, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = '#8a5a10';
  ctx.lineWidth = 1.4;
  ctx.beginPath(); ctx.arc(0, 1.5, 4.2, 0.15 * Math.PI, 0.85 * Math.PI); ctx.stroke();
  ctx.restore();
}

function drawScaleBar() {
  const targetKm = S.kmPerUnit * (S.W / S.view.k) * 0.12;
  const nice = [1, 2, 5, 10, 20, 50, 100].reduce((a, b) => Math.abs(b - targetKm) < Math.abs(a - targetKm) ? b : a);
  const px = nice / S.kmPerUnit * S.view.k;
  const x = 18, y = S.cssH - 20;
  ctx.save();
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.beginPath();
  ctx.roundRect(x - 8, y - 22, px + 58, 28, 9);
  ctx.fill();
  ctx.strokeStyle = '#4a3313';
  ctx.lineWidth = 2.4;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(x, y - 5); ctx.lineTo(x, y); ctx.lineTo(x + px, y); ctx.lineTo(x + px, y - 5);
  ctx.stroke();
  ctx.fillStyle = '#4a3313';
  ctx.font = '700 11px ' + FONT;
  ctx.textAlign = 'left';
  ctx.fillText(nice + ' km', x + px + 8, y + 1);
  ctx.restore();
}

/* ================= 彩带粒子 ================= */
function spawnConfetti(wx, wy, n = 30) {
  const [sx, sy] = worldToScreen(wx, wy);
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2;
    const sp = 2 + Math.random() * 3.6;
    S.particles.push({
      x: sx, y: sy,
      vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 3.4,
      rot: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.3,
      w: 5 + Math.random() * 4, h: 3 + Math.random() * 3,
      color: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
      life: 1,
    });
  }
}
function drawParticles() {
  for (const p of S.particles) {
    ctx.save();
    ctx.globalAlpha = clamp(p.life, 0, 1);
    ctx.translate(p.x, p.y);
    ctx.rotate(p.rot);
    ctx.fillStyle = p.color;
    ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
    ctx.restore();
  }
}
function stepParticles() {
  for (const p of S.particles) {
    p.x += p.vx; p.y += p.vy;
    p.vy += 0.16;
    p.vx *= 0.985;
    p.rot += p.vr;
    p.life -= 0.014;
  }
  S.particles = S.particles.filter(p => p.life > 0 && p.y < S.cssH + 30);
}

/* 唯一的动画驱动：有动画/粒子时才跑 rAF，闲时停表 */
let loopRunning = false;
function ensureLoop() {
  if (loopRunning) return;
  loopRunning = true;
  requestAnimationFrame(function tick() {
    S.anims = S.anims.filter(a => performance.now() - a.t0 < 950);
    stepParticles();
    render();
    if (S.anims.length || S.particles.length) {
      requestAnimationFrame(tick);
    } else {
      loopRunning = false;
    }
  });
}

/* ================= 打卡（唯一点亮入口） ================= */
function conquer(storeId, opts = {}) {
  const s = S.stores.find(x => x.id === storeId);
  if (!s || isLit(s)) return null;
  const date = opts.date || new Date().toISOString().slice(0, 10);

  const prevPct = C.areaShare(S.cells, S.visits).pct;
  const prevTitle = C.titleFor(prevPct).title;

  S.visits.set(storeId, date);
  S.lastCheckIn = { storeId };
  P[S.mode] = P[S.mode] || [];
  P[S.mode] = P[S.mode].filter(r => r.storeId !== storeId);
  P[S.mode].push({ storeId, date });
  persist();

  const cell = S.cells.find(c => c.site.id === storeId);
  if (cell) S.anims.push({ cell, t0: performance.now() });
  ensureLoop();

  const { gain, parts } = C.checkinGain(S.stores, S.visits, s);
  S.score = C.computeScore(S.stores, S.visits);
  const newPct = C.areaShare(S.cells, S.visits).pct;
  const { title: newTitle, next } = C.titleFor(newPct);
  const leveledUp = newTitle !== prevTitle;
  if (leveledUp) spawnConfetti(s.x, s.y, 26);

  renderSidebar();
  showToast(
    leveledUp
      ? `<div class="big">晋升 · ${newTitle}！</div><div class="gain">点亮 ${s.shortName} +${gain} 战功${parts.length ? ' · ' + parts.join(' · ') : ''}</div>`
      : `<div class="big">点亮 ${s.shortName}${s.tier === 3 ? '王都' : ''}！</div><div class="gain">+${gain} 战功${parts.length ? ' · ' + parts.join(' · ') : ''}${next ? '' : ' · 已至制霸之巅'}</div>`,
    leveledUp ? 'levelup' : ''
  );
  return { store: s, gain };
}

function undoCheckIn() {
  if (!S.lastCheckIn) return;
  const id = S.lastCheckIn.storeId;
  const s = S.stores.find(x => x.id === id);
  S.visits.delete(id);
  S.lastCheckIn = null;
  P[S.mode] = (P[S.mode] || []).filter(r => r.storeId !== id);
  persist();
  S.score = C.computeScore(S.stores, S.visits);
  renderSidebar();
  render();
  showToast(`<div class="big">已撤销「${s ? s.shortName : ''}」的打卡</div><div class="gain">领地重回迷雾</div>`);
}

/* ================= 侧栏 ================= */
function fmtScore(n) { return n.toLocaleString('en-US'); }
function districtOf(s) { return s.districtTitle || (s.district + '郡'); }

function renderSidebar() {
  const total = S.stores.length;
  const got = S.stores.filter(isLit).length;
  const { pct } = C.areaShare(S.cells, S.visits);
  const { title, next } = C.titleFor(pct);
  S.score = C.computeScore(S.stores, S.visits);

  document.getElementById('modeBadge').textContent = S.mode === 'demo' ? '演示数据' : '真实数据';
  document.getElementById('modeBadge').className = 'badge' + (S.mode === 'demo' ? '' : ' real');
  document.getElementById('playerTitle').textContent = title;
  document.getElementById('nextTitle').textContent = next
    ? `距「${next[1]}」还差 ${(next[0] - pct).toFixed(1)}% 版图`
    : '已至制霸之巅';
  const prev = C.TITLES.filter(t => pct >= t[0]).pop()[0];
  document.getElementById('titleBar').style.width =
    (next ? clamp((pct - prev) / (next[0] - prev) * 100, 2, 100) : 100) + '%';
  document.getElementById('stArea').textContent = pct.toFixed(1);
  document.getElementById('areaBar').style.width = clamp(pct, 1, 100) + '%';
  document.getElementById('stStores').textContent = got;
  document.getElementById('stStoresAll').textContent = total;
  document.getElementById('stDistricts').textContent = new Set(S.stores.filter(isLit).map(s => s.district)).size;
  document.getElementById('stDistrictsAll').textContent = new Set(S.stores.map(s => s.district)).size;
  document.getElementById('stCapitals').textContent = S.stores.filter(s => isLit(s) && s.tier === 3).length;
  document.getElementById('stScore').textContent = fmtScore(S.score);
  document.getElementById('undoBtn').classList.toggle('show', !!S.lastCheckIn);

  renderGoal();
  renderBadges();

  const byDistrict = {};
  for (const s of S.stores) {
    const d = byDistrict[s.district] = byDistrict[s.district] || { title: districtOf(s), all: 0, got: 0 };
    d.all++;
    if (isLit(s)) d.got++;
  }
  const rows = Object.values(byDistrict).sort((a, b) => (b.got - a.got) || (b.all - a.all));
  document.getElementById('districtRows').innerHTML = rows.map(d => {
    const p = d.all ? d.got / d.all * 100 : 0;
    return `<div class="drow"><span class="dn">${d.title}</span>` +
      `<span class="dbar"><span class="bar"><i style="width:${p}%"></i></span></span>` +
      `<span class="dv">${d.got}/${d.all}</span></div>`;
  }).join('');

  const chrono = [...S.visits.entries()]
    .map(([id, date]) => ({ date, s: S.stores.find(x => x.id === id) }))
    .filter(v => v.s)
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
    .slice(0, 8);
  document.getElementById('chronicle').innerHTML = chrono.length
    ? chrono.map(v =>
      `<li><span class="cdate">${v.date || '—'}</span><span class="cname">${v.s.shortName}</span><span class="cdist">${districtOf(v.s)}</span></li>`
    ).join('')
    : '<li class="empty">尚无征服记录 —— 点「用餐打卡」记下第一家。</li>';

  animateScore();
}

/* 下一目标卡 */
function renderGoal() {
  const goal = C.nextGoal(S.stores, S.cells, S.visits);
  const el = document.getElementById('goalCard');
  if (goal.type === 'done') {
    el.innerHTML = `<div class="goal done">👑 ${goal.text}</div>`;
    return;
  }
  el.innerHTML =
    `<div class="goal"><div class="g-label">下一个目标</div><div class="g-text">${goal.text}</div></div>` +
    (goal.store ? `<button class="ci-btn goal-btn" data-id="${goal.store.id}">打卡它</button>` : '');
  const btn = el.querySelector('.goal-btn');
  if (btn) btn.addEventListener('click', () => openCheckin(goal.store.id));
}

/* 成就徽章墙 */
function renderBadges() {
  const badges = C.evaluateBadges(S.stores, S.cells, S.visits);
  document.getElementById('badgeWall').innerHTML = badges.map(b =>
    `<div class="bcell ${b.done ? 'done' : ''}" title="${b.name}：${b.desc}">` +
    `<span class="bicon">${b.icon}</span><span class="bname">${b.name}</span></div>`
  ).join('');
}

let scoreAnim = null;
function animateScore() {
  const el = document.getElementById('stScore');
  if (scoreAnim) cancelAnimationFrame(scoreAnim);
  const from = S.scoreShown, to = S.score, t0 = performance.now();
  (function step() {
    const t = clamp((performance.now() - t0) / 600, 0, 1);
    S.scoreShown = Math.round(from + (to - from) * ease(t));
    el.textContent = fmtScore(S.scoreShown);
    if (t < 1) scoreAnim = requestAnimationFrame(step);
    else scoreAnim = null;
  })();
}

/* ================= 交互（Pointer Events，鼠标/触摸统一） ================= */
const pointers = new Map();   // pointerId -> {x, y}
let pinchStart = null;        // {dist, mid:{x,y}, view:{k,tx,ty}}

function eventPos(e) {
  const rect = canvas.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}
function pickHover(px, py) {
  let best = null, bestD = 18 * 18 / S.view.k;
  for (const s of S.stores) {
    const d = (s.x - (px - S.view.tx) / S.view.k) ** 2 + (s.y - (py - S.view.ty) / S.view.k) ** 2;
    if (d < bestD) { bestD = d; best = s; }
  }
  return best;
}

canvas.addEventListener('pointerdown', e => {
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, eventPos(e));
  if (pointers.size === 1) {
    S.dragging = true; S.dragMoved = false;
    S.dragStart = [e.clientX, e.clientY];
    S.viewStart = { ...S.view };
    canvas.classList.add('dragging');
  } else if (pointers.size === 2) {
    const [p1, p2] = [...pointers.values()];
    pinchStart = {
      dist: Math.hypot(p1.x - p2.x, p1.y - p2.y),
      mid: { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 },
      view: { ...S.view },
    };
  }
});

canvas.addEventListener('pointermove', e => {
  const pos = eventPos(e);
  if (!pointers.has(e.pointerId)) {
    // 无按下的悬停（鼠标）
    if (S.tooltipPinned) return;
    hoverAt(pos, e);
    return;
  }
  pointers.set(e.pointerId, pos);
  if (pointers.size === 2 && pinchStart) {
    const [p1, p2] = [...pointers.values()];
    const dist = Math.hypot(p1.x - p2.x, p1.y - p2.y);
    const mid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
    const k2 = clamp(pinchStart.view.k * dist / Math.max(pinchStart.dist, 1), 0.5, 6);
    const [wx, wy] = [
      (pinchStart.mid.x - pinchStart.view.tx) / pinchStart.view.k,
      (pinchStart.mid.y - pinchStart.view.ty) / pinchStart.view.k,
    ];
    S.view.k = k2;
    S.view.tx = mid.x - wx * k2;
    S.view.ty = mid.y - wy * k2;
    S.dragMoved = true;
    hideTooltip();
    render();
    return;
  }
  if (S.dragging) {
    const dx = e.clientX - S.dragStart[0], dy = e.clientY - S.dragStart[1];
    if (Math.abs(dx) + Math.abs(dy) > 3) S.dragMoved = true;
    S.view.tx = S.viewStart.tx + dx;
    S.view.ty = S.viewStart.ty + dy;
    hideTooltip();
    render();
  }
});

function endPointer(e) {
  pointers.delete(e.pointerId);
  if (pointers.size < 2) pinchStart = null;
  if (pointers.size === 0) {
    S.dragging = false;
    canvas.classList.remove('dragging');
  }
}
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener('pointerleave', e => {
  if (!pointers.has(e.pointerId) && !S.tooltipPinned) hideTooltip();
});

function hoverAt(pos, e) {
  const s = pickHover(pos.x, pos.y);
  const prev = S.hover;
  S.hover = s ? { site: s, cell: S.cells.find(c => c.site === s) } : null;
  if (s !== (prev && prev.site)) render();
  if (s) {
    const got = isLit(s);
    tooltip.style.display = 'block';
    tooltip.innerHTML =
      `<div class="t-name">${got ? '📍 ' : ''}${s.name}</div>` +
      `<div class="t-line">${districtOf(s)} · ${C.TIER_NAME[s.tier]}${s.open24h ? ' · 24h' : ''}</div>` +
      (got
        ? `<div class="t-line">已点亮（${S.visits.get(s.id) || '—'}）</div>`
        : `<div class="t-line">尚未点亮 · 打卡可得 ${C.checkinGain(S.stores, S.visits, s).gain} 战功${s.remote ? '（远郊加成）' : ''}</div>` +
          `<button class="tt-btn" data-id="${s.id}">我吃了这家 · 打卡</button>`);
    tooltip.style.left = clamp(pos.x + 16, 6, S.cssW - 260) + 'px';
    tooltip.style.top = clamp(pos.y + 14, 6, S.cssH - 150) + 'px';
    canvas.style.cursor = 'pointer';
  } else {
    hideTooltip();
    canvas.style.cursor = 'grab';
  }
}
function hideTooltip() {
  tooltip.style.display = 'none';
  if (S.hover) { S.hover = null; render(); }
}

tooltip.addEventListener('mouseenter', () => { S.tooltipPinned = true; });
tooltip.addEventListener('mouseleave', () => {
  S.tooltipPinned = false;
  tooltip.style.display = 'none';
  S.hover = null;
  render();
});
tooltip.addEventListener('click', e => {
  const btn = e.target.closest('.tt-btn');
  if (btn) {
    hideTooltip();
    S.tooltipPinned = false;
    conquer(btn.dataset.id);
  }
});

canvas.addEventListener('click', e => {
  if (S.dragMoved) { S.dragMoved = false; return; }
  const pos = eventPos(e);
  const s = pickHover(pos.x, pos.y);
  if (!s) return;
  if (isLit(s)) {
    showToast(`<div class="big">📍 ${s.shortName}</div><div class="gain">已于 ${S.visits.get(s.id) || '—'} 点亮</div>`);
  } else {
    openCheckin(s.id);
  }
});

canvas.addEventListener('wheel', e => {
  e.preventDefault();
  const pos = eventPos(e);
  const [wx, wy] = [(pos.x - S.view.tx) / S.view.k, (pos.y - S.view.ty) / S.view.k];
  const k2 = clamp(S.view.k * Math.exp(-e.deltaY * 0.0012), 0.5, 6);
  S.view.k = k2;
  S.view.tx = pos.x - wx * k2;
  S.view.ty = pos.y - wy * k2;
  render();
}, { passive: false });

canvas.addEventListener('dblclick', () => { fitView(); render(); });
window.addEventListener('resize', resize);

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    document.getElementById('checkin').classList.remove('show');
    document.getElementById('help').classList.remove('show');
  }
});

/* ================= 用餐打卡弹窗 ================= */
function openCheckin(highlightId) {
  document.getElementById('checkin').classList.add('show');
  const input = document.getElementById('ciSearch');
  input.value = '';
  renderCheckinList('', highlightId);
  if (highlightId) {
    const s = S.stores.find(x => x.id === highlightId);
    if (s) input.placeholder = `搜门店名 / 区县…（当前：${s.shortName}）`;
    input.focus();
  }
  input.oninput = () => renderCheckinList(input.value.trim(), highlightId);
}
function closeCheckin() { document.getElementById('checkin').classList.remove('show'); }

function renderCheckinList(filter, highlightId) {
  const list = document.getElementById('ciList');
  const unconq = S.stores.filter(s => !isLit(s));
  const f = (filter || '').toLowerCase();
  const match = s => !f ||
    s.name.toLowerCase().includes(f) ||
    s.shortName.toLowerCase().includes(f) ||
    (s.districtTitle || '').includes(f) ||
    (s.district || '').includes(f);
  const rows = unconq.filter(match)
    .sort((a, b) => (a.district + a.tier).localeCompare(b.district + b.tier) || a.shortName.localeCompare(b.shortName, 'zh'))
    .slice(0, 60);
  if (!rows.length) {
    list.innerHTML = `<div class="ci-none">${unconq.length ? '没有匹配的门店' : '全城已点亮！制霸达成 🎉'}</div>`;
    return;
  }
  list.innerHTML = rows.map(s => `
    <div class="ci-row${s.id === highlightId ? ' hl' : ''}" data-id="${s.id}">
      <canvas class="ci-icon" width="60" height="60" data-tier="${s.tier}"></canvas>
      <div class="ci-main">
        <div class="ci-name">${s.shortName}</div>
        <div class="ci-sub">${districtOf(s)} · ${C.TIER_NAME[s.tier]}${s.remote ? ' · 远郊' : ''} · +${C.checkinGain(S.stores, S.visits, s).gain} 战功</div>
      </div>
      <button class="ci-btn" data-id="${s.id}">打卡</button>
    </div>`).join('');
  for (const c of list.querySelectorAll('canvas.ci-icon')) {
    const g = c.getContext('2d');
    g.scale(2, 2);
    g.translate(15, 18);
    drawIconOn(g, Number(c.dataset.tier), true);
  }
}

document.getElementById('checkin').addEventListener('click', e => {
  if (e.target.id === 'checkin' || e.target.id === 'ciClose') { closeCheckin(); return; }
  const row = e.target.closest('.ci-row');
  if (row) {
    closeCheckin();
    conquer(row.dataset.id);
  }
});

document.getElementById('btnCheckin').addEventListener('click', () => openCheckin());
document.getElementById('undoBtn').addEventListener('click', undoCheckIn);

/* 重置演示：二次确认（按钮文字变化），防误触清空打卡 */
let resetArmed = false, resetTimer = null;
document.getElementById('btnReset').addEventListener('click', e => {
  const btn = e.currentTarget;
  if (!resetArmed) {
    resetArmed = true;
    btn.textContent = '确认重置?';
    resetTimer = setTimeout(() => { resetArmed = false; btn.textContent = '重置演示'; }, 3000);
    return;
  }
  clearTimeout(resetTimer);
  resetArmed = false;
  btn.textContent = '重置演示';
  P.demo = [];
  persist();
  S.mode = 'demo';
  S.stores = window.MC_KINGDOM_DEMO.stores;
  S.city = window.MC_KINGDOM_DEMO.city;
  S.visits = new Map(window.MC_KINGDOM_DEMO.visits.map(v => [v.storeId, v.date]));
  S.lastCheckIn = null;
  build();
  showToast('<div class="big">演示王国已重置</div><div class="gain">迷雾重归全城</div>');
});

document.getElementById('btnImport').addEventListener('click', () => document.getElementById('fileInput').click());
document.getElementById('fileInput').addEventListener('change', async e => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const stores = data.stores || data;
    const visits = data.visits || [];
    if (!Array.isArray(stores) || !stores.length || !stores[0].id) throw new Error('格式不对：需要包含 stores 数组');
    S.mode = 'real';
    S.stores = stores;
    S.city = data.city || '自定义区域';
    S.visits = new Map(visits.map(v => [v.storeId, v.date || '']));
    S.lastCheckIn = null;
    build();
    showToast('<div class="big">真实数据已载入</div><div class="gain">你的王国开始生长</div>');
  } catch (err) {
    showToast(`<div class="big">导入失败</div><div class="gain">${err.message}</div>`);
  }
  e.target.value = '';
});

document.getElementById('btnHelp').addEventListener('click', () => document.getElementById('help').classList.add('show'));
document.getElementById('help').addEventListener('click', e => {
  if (e.target.id === 'help' || e.target.id === 'helpClose') {
    e.target.closest('.overlay').classList.remove('show');
    P.seenHelp = true;
    persist();
  }
});

/* ================= 战绩分享卡 ================= */
function makeShareCard() {
  const saved = { ...S.view };
  fitView(); render();
  const snap = document.createElement('canvas');
  snap.width = canvas.width; snap.height = canvas.height;
  snap.getContext('2d').drawImage(canvas, 0, 0);
  Object.assign(S.view, saved);
  render();

  const W = 900, H = 1280, SC = 2;
  const card = document.createElement('canvas');
  card.width = W * SC; card.height = H * SC;
  const g = card.getContext('2d');
  g.scale(SC, SC);
  const rnd = mulberry32(hashStr(S.city + S.visits.size));

  // 底色 + 彩点
  g.fillStyle = '#fff8ec';
  g.fillRect(0, 0, W, H);
  for (let i = 0; i < 40; i++) {
    g.fillStyle = CONFETTI_COLORS[i % CONFETTI_COLORS.length];
    g.globalAlpha = 0.14;
    g.save();
    g.translate(rnd() * W, rnd() * H);
    g.rotate(rnd() * Math.PI);
    g.fillRect(-5, -2, 10, 4);
    g.restore();
  }
  g.globalAlpha = 1;

  // 顶栏
  g.fillStyle = '#da291c';
  g.beginPath(); g.roundRect(36, 40, 56, 56, 14); g.fill();
  g.fillStyle = '#ffc72c';
  g.font = '900 40px ' + FONT;
  g.textAlign = 'center';
  g.fillText('M', 64, 84);
  g.fillStyle = '#da291c';
  g.font = '900 40px ' + FONT;
  g.textAlign = 'left';
  g.fillText('麦门制霸图', 110, 84);
  g.fillStyle = '#8a6a2e';
  g.font = '600 18px ' + FONT;
  g.fillText(`${S.city} · ${new Date().toISOString().slice(0, 10)}`, 110, 110);

  // 地图快照（圆角裁剪，裁上下居中 820x540）
  const mw = 820, mh = 540, mx = 40, my = 140;
  g.save();
  g.beginPath(); g.roundRect(mx, my, mw, mh, 24); g.clip();
  g.fillStyle = '#bfe6fb';
  g.fillRect(mx, my, mw, mh);
  const sw = snap.width, sh = snap.height;
  const drawH = mw / sw * sh;
  g.drawImage(snap, mx, my + (mh - drawH) / 2, mw, drawH);
  g.restore();
  g.strokeStyle = '#ffc72c';
  g.lineWidth = 6;
  g.beginPath(); g.roundRect(mx, my, mw, mh, 24); g.stroke();

  // 数据
  const { pct } = C.areaShare(S.cells, S.visits);
  const { title } = C.titleFor(pct);
  const got = S.stores.filter(isLit).length;
  const districts = new Set(S.stores.filter(isLit).map(s => s.district)).size;
  const badges = C.evaluateBadges(S.stores, S.cells, S.visits);

  g.textAlign = 'center';
  g.fillStyle = '#4a3313';
  g.font = '700 20px ' + FONT;
  const stats = [
    ['版图', pct.toFixed(1) + '%'],
    ['城邦', `${got}/${S.stores.length}`],
    ['战功', fmtScore(S.score)],
    ['郡', `${districts}/${new Set(S.stores.map(s => s.district)).size}`],
  ];
  const cw = (W - 80) / 4;
  stats.forEach(([k, v], i) => {
    const x = 40 + cw * i + cw / 2;
    g.fillStyle = '#a8823c';
    g.font = '700 16px ' + FONT;
    g.fillText(k, x, 736);
    g.fillStyle = i === 0 ? '#da291c' : '#4a3313';
    g.font = '900 34px ' + FONT;
    g.fillText(v, x, 774);
  });

  // 称号横幅
  g.fillStyle = '#da291c';
  g.beginPath(); g.roundRect(W / 2 - 240, 810, 480, 64, 32); g.fill();
  g.fillStyle = '#fff';
  g.font = '900 30px ' + FONT;
  g.fillText(title, W / 2, 852);

  // 徽章行
  g.font = '900 26px ' + FONT;
  badges.forEach((b, i) => {
    const x = W / 2 + (i - (badges.length - 1) / 2) * 64;
    g.beginPath();
    g.arc(x, 940, 24, 0, Math.PI * 2);
    g.fillStyle = b.done ? '#ffc72c' : '#eadfbe';
    g.fill();
    g.fillStyle = b.done ? '#da291c' : '#c4b88f';
    g.fillText(b.icon, x, 950);
  });

  // 底部 slogan
  g.fillStyle = '#8a6a2e';
  g.font = '800 30px ' + FONT;
  g.fillText('全城制霸 · 吃遍麦门', W / 2, 1058);
  g.font = '600 16px ' + FONT;
  g.fillStyle = '#b09256';
  g.fillText('麦门制霸图 m-king · 打卡你的每一次麦门朝圣', W / 2, 1092);
  // 金拱门剪影
  g.strokeStyle = '#ffc72c';
  g.lineWidth = 10;
  g.lineCap = 'round';
  g.beginPath();
  g.arc(W / 2 - 20, 1160, 34, Math.PI, 0);
  g.arc(W / 2 + 20, 1160, 34, Math.PI, 0);
  g.stroke();

  const a = document.createElement('a');
  a.download = `麦门制霸图-${S.city}-${new Date().toISOString().slice(0, 10)}.png`;
  a.href = card.toDataURL('image/png');
  a.click();
  showToast('<div class="big">战绩卡已生成</div><div class="gain">已开始下载，晒出去吧</div>');
}
document.getElementById('btnShare').addEventListener('click', makeShareCard);

/* ================= toast ================= */
let toastTimer = null;
function showToast(html, cls = '') {
  const t = document.getElementById('toast');
  t.innerHTML = html;
  t.className = 'show ' + cls;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = ''; }, 3000);
}

/* ================= 图例 ================= */
function drawLegend() {
  const box = document.getElementById('legend');
  const mk = (label, tier) => {
    const c = document.createElement('canvas');
    c.width = 88; c.height = 60;
    const g = c.getContext('2d');
    g.scale(2, 2);
    g.translate(22, 20);
    drawIconOn(g, tier, true);
    const div = document.createElement('div');
    div.className = 'li';
    div.appendChild(c);
    div.insertAdjacentHTML('beforeend', `<span>${label}</span>`);
    box.appendChild(div);
  };
  mk('王都 · 旗舰', 3);
  mk('城镇 · 商场店', 2);
  mk('甜品站 · 街角店', 1);
  const swatch = (fill, stroke, label) => {
    const c = document.createElement('canvas');
    c.width = 88; c.height = 60;
    const g = c.getContext('2d');
    g.scale(2, 2);
    g.fillStyle = fill;
    g.beginPath(); g.roundRect(6, 8, 32, 20, 6); g.fill();
    if (stroke) { g.strokeStyle = stroke; g.lineWidth = 2.4; g.stroke(); }
    else drawCloud(g, 14, 12, 9, 0.95);
    const div = document.createElement('div');
    div.className = 'li';
    div.appendChild(c);
    div.insertAdjacentHTML('beforeend', `<span>${label}</span>`);
    box.appendChild(div);
  };
  swatch('#ffd23f', '#fff', '已点亮领地');
  swatch('#d9ecca', null, '迷雾未征');
}

/* ================= 启动 ================= */
(async function main() {
  resize();
  await loadData();
  drawLegend();
  if (!P.seenHelp) document.getElementById('help').classList.add('show');
  window.__MCK = { S, conquer, undoCheckIn, openCheckin, core: C, persist: P };  // 调试/测试句柄
})();
})();
