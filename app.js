/* 麦门制霸图 · m-king v2（Q版）
 * 把全城麦当劳门店画成一张Q版游戏地图：
 * 每家店是一座小城，按 Voronoi 领地划分地盘；
 * 用户真实打卡吃过哪家，哪片领地就被点亮——没有随机自动点亮。
 * 零依赖，可 file:// 直接打开；真实数据见 tools/fetch_mcd_data.py。
 */
(() => {
'use strict';

/* ================= 小工具 ================= */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const ease = t => 1 - Math.pow(1 - t, 3);
function hashStr(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
const FONT = '"Yuanti SC","YouYuan","PingFang SC","Microsoft YaHei",sans-serif';

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
  anims: [],            // 领土渐染动画
  particles: [],        // 彩带
  hover: null,
  tooltipPinned: false,
  lastCheckIn: null,    // 撤销用
  view: { k: 1, tx: 0, ty: 0 },
  W: 1000, H: 600,
  kmPerUnit: 1,
  score: 0, scoreShown: 0,
  dragging: false, dragMoved: false, dragStart: null, viewStart: null,
};

const TIER_NAME = { 3: '王都', 2: '城镇', 1: '甜品站' };
const TIER_SCORE = { 3: 500, 2: 200, 1: 100 };
const FRONTIER_BONUS = 150;
const REMOTE_MULT = 1.5;
const TITLES = [
  [0, '麦门路人'], [1, '见习麦民'], [5, '麦田巡逻官'], [10, '金拱门骑士'],
  [20, '堡垒男爵'], [30, '边疆侯爵'], [45, '巨无霸公爵'], [60, '麦门亲王'], [80, '制霸者 · 麦门之主'],
];
const CONFETTI_COLORS = ['#da291c', '#ffc72c', '#ffffff', '#58b368', '#ff8a3c'];

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
  build();
}

/* ================= 投影与几何 ================= */
let landRect = null;

function build() {
  const lats = S.stores.map(s => s.lat), lngs = S.stores.map(s => s.lng);
  const lat0 = Math.min(...lats), lat1 = Math.max(...lats);
  const lng0 = Math.min(...lngs), lng1 = Math.max(...lngs);
  const midLat = (lat0 + lat1) / 2;
  const kx = Math.cos(midLat * Math.PI / 180);
  const spanX = (lng1 - lng0) * kx, spanY = (lat1 - lat0);
  const W = 1000;
  const H = Math.max(420, Math.min(1400, W * spanY / Math.max(spanX, 1e-9)));
  const mx = (lng0 + lng1) / 2, my = (lat0 + lat1) / 2;
  const pad = 1.06;
  for (const s of S.stores) {
    s.x = W / 2 + (s.lng - mx) * kx / spanX * W / pad;
    s.y = H / 2 - (s.lat - my) / spanY * H / pad;
  }
  S.W = W; S.H = H;
  const inset = 7;
  landRect = { x: inset, y: inset, w: W - inset * 2, h: H - inset * 2, r: 30 };
  S.kmPerUnit = ((spanX * 111.32 + spanY * 111.32) / 2) / ((W / pad + H / pad) / 2);

  S.cells = voronoi(S.stores, { x0: 0, y0: 0, x1: W, y1: H });
  S.roads = buildRoads(S.stores);
  document.getElementById('cityName').textContent = '· ' + S.city;
  fitView();
  ensureLoop();
  render();
  renderSidebar();
}

function voronoi(sites, bbox) {
  const poly0 = [[bbox.x0, bbox.y0], [bbox.x1, bbox.y0], [bbox.x1, bbox.y1], [bbox.x0, bbox.y1]];
  const cells = [];
  for (let i = 0; i < sites.length; i++) {
    let poly = poly0.map(p => p.slice());
    const p = sites[i];
    for (let j = 0; j < sites.length && poly.length >= 3; j++) {
      if (i === j) continue;
      poly = clipBisector(poly, p, sites[j]);
    }
    cells.push({ poly, site: p, area: Math.abs(polyArea(poly)) });
  }
  return cells;
}

/* 保留距 p 更近的一半平面：2(q-p)·x <= |q|²-|p|² */
function clipBisector(poly, p, q) {
  const dx = q.x - p.x, dy = q.y - p.y;
  const c = (q.x * q.x + q.y * q.y - p.x * p.x - p.y * p.y) / 2;
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const fa = dx * a[0] + dy * a[1] - c;
    const fb = dx * b[0] + dy * b[1] - c;
    if (fa <= 1e-9) out.push(a);
    if ((fa < -1e-9 && fb > 1e-9) || (fa > 1e-9 && fb < -1e-9)) {
      const t = fa / (fa - fb);
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return out;
}

function polyArea(poly) {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}
function pointInPoly(pt, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
    if (((yi > pt[1]) !== (yj > pt[1])) && (pt[0] < (xj - xi) * (pt[1] - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}

/* 道路：MST + 每点连最近邻 */
function buildRoads(sites) {
  const n = sites.length;
  const edges = [];
  const inTree = new Array(n).fill(false);
  const best = new Array(n).fill(Infinity);
  const bestFrom = new Array(n).fill(-1);
  best[0] = 0;
  for (let it = 0; it < n; it++) {
    let u = -1;
    for (let i = 0; i < n; i++) if (!inTree[i] && (u === -1 || best[i] < best[u])) u = i;
    inTree[u] = true;
    if (bestFrom[u] >= 0) edges.push([bestFrom[u], u]);
    for (let v = 0; v < n; v++) {
      if (inTree[v]) continue;
      const d = (sites[u].x - sites[v].x) ** 2 + (sites[u].y - sites[v].y) ** 2;
      if (d < best[v]) { best[v] = d; bestFrom[v] = u; }
    }
  }
  const seen = new Set(edges.map(([a, b]) => a < b ? a + '-' + b : b + '-' + a));
  for (let i = 0; i < n; i++) {
    const ds = sites.map((s, j) => [j, (s.x - sites[i].x) ** 2 + (s.y - sites[i].y) ** 2])
      .filter(([j]) => j !== i).sort((a, b) => a[1] - b[1]).slice(0, 2);
    for (const [j] of ds) {
      const key = i < j ? i + '-' + j : j + '-' + i;
      if (!seen.has(key)) { seen.add(key); edges.push([i, j]); }
    }
  }
  return edges;
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
  // 远处云带
  const rnd = mulberry32(2026);
  for (let i = 0; i < 9; i++) {
    drawCloud(g, rnd() * w, h * (0.04 + rnd() * 0.3), 26 + rnd() * 40, 0.8);
  }
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
const screenToWorld = (sx, sy) => [(sx - S.view.tx) / S.view.k, (sy - S.view.ty) / S.view.k];
const isConquered = s => S.visits.has(s.id);

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

  /* --- 王国岛（世界坐标） --- */
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

  /* --- 领地 --- */
  for (const cell of S.cells) {
    const s = cell.site;
    const poly = cell.poly;
    ctx.beginPath();
    ctx.moveTo(poly[0][0], poly[0][1]);
    for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i][0], poly[i][1]);
    ctx.closePath();
    if (isConquered(s)) {
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

  /* --- 白色贴纸描边 --- */
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

  /* --- 迷雾云朵（未征服领地） --- */
  for (const cell of S.cells) {
    if (isConquered(cell.site)) continue;
    drawFogClouds(cell);
  }

  /* --- 河流 --- */
  drawRiver();

  /* --- 树与山丘 --- */
  drawScenery();

  /* --- 道路 --- */
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

  /* --- 征服动画的领土渐染 + 光环 --- */
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
  ctx.restore(); // 解除 land clip

  /* --- 城邦、标签、彩带（屏幕空间，尺寸恒定） --- */
  ctx.restore(); // 解除世界变换
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

  if (S.anims.length || S.particles.length) requestAnimationFrame(loopTick);
}

function drawFogClouds(cell) {
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
    if (isConquered(s)) continue;
    const rnd = mulberry32(hashStr(s.id + '#sc'));
    if (s.remote && rnd() > 0.3) {
      // 软萌山丘
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
      // 棒棒糖树
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

/* ---------- Q版城邦图标（地图与图例共用） ---------- */
function drawIconOn(g, tier, conquered) {
  const line = '#7a4a1e';
  g.lineJoin = 'round';
  g.lineWidth = 1.6;
  g.strokeStyle = line;
  if (tier === 3) {
    // 王都：白墙红顶双塔城堡 + M 旗
    g.fillStyle = conquered ? '#fffdf5' : '#e8e4da';
    g.beginPath(); g.roundRect(-10, -3, 20, 11, 2); g.fill(); g.stroke();
    g.beginPath(); g.roundRect(-12.5, -9, 6.5, 17, 2); g.fill(); g.stroke();
    g.beginPath(); g.roundRect(6, -9, 6.5, 17, 2); g.fill(); g.stroke();
    g.beginPath(); g.roundRect(-3.5, -7, 7, 15, 2); g.fill(); g.stroke();
    const roof = conquered ? '#e84a3f' : '#b9b2a6';
    g.fillStyle = roof;
    g.beginPath(); g.moveTo(-13.5, -9); g.lineTo(-9.25, -14.5); g.lineTo(-5, -9); g.closePath(); g.fill(); g.stroke();
    g.beginPath(); g.moveTo(5, -9); g.lineTo(9.25, -14.5); g.lineTo(13.5, -9); g.closePath(); g.fill(); g.stroke();
    g.beginPath(); g.moveTo(-4.5, -7); g.lineTo(0, -12.5); g.lineTo(4.5, -7); g.closePath(); g.fill(); g.stroke();
    // 门
    g.fillStyle = '#9a6a3a';
    g.beginPath();
    g.moveTo(-2.4, 8); g.lineTo(-2.4, 4.5); g.arc(0, 4.5, 2.4, Math.PI, 0); g.lineTo(2.4, 8);
    g.closePath(); g.fill();
    // 旗
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
    // 城镇：红顶小屋
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
    // 甜品站：黄色遮阳伞小摊
    g.fillStyle = '#fffdf5';
    g.beginPath(); g.roundRect(-6, 1, 12, 6, 2); g.fill(); g.stroke();
    g.strokeStyle = line;
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
  const conquered = isConquered(s);
  const k = S.view.k;
  ctx.save();
  ctx.translate(sx, sy);
  // 低倍缩放时：未点亮的小甜品站缩为圆点，避免密集区图标堆叠
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
    ctx.lineJoin = 'round';
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
  for (let i = 0; 0.5 + i * 8 <= 13; i++) {
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
function spawnConfetti(wx, wy) {
  const [sx, sy] = worldToScreen(wx, wy);
  for (let i = 0; i < 30; i++) {
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

let loopRunning = false;
function loopTick() {
  stepParticles();
  render();
}
function ensureLoop() {
  if (!loopRunning) {
    loopRunning = true;
    requestAnimationFrame(function tick() {
      if (S.anims.length || S.particles.length) {
        // 清理已完成的领土动画
        S.anims = S.anims.filter(a => performance.now() - a.t0 < 950);
        requestAnimationFrame(tick);
      } else {
        loopRunning = false;
      }
    });
  }
}

/* ================= 游戏逻辑 ================= */
function districtOf(s) { return s.districtTitle || (s.district + '郡'); }

function computeScore() {
  let score = 0;
  const seen = new Set();
  for (const s of S.stores) {
    if (!isConquered(s)) continue;
    let p = TIER_SCORE[s.tier] || 100;
    if (s.remote) p = Math.round(p * REMOTE_MULT);
    if (!seen.has(s.district)) { p += FRONTIER_BONUS; seen.add(s.district); }
    score += p;
  }
  return score;
}

function areaStats() {
  let all = 0, got = 0;
  for (const c of S.cells) {
    all += c.area;
    if (isConquered(c.site)) got += c.area;
  }
  return { pct: all ? got / all * 100 : 0 };
}

function currentTitle(pct) {
  let t = TITLES[0][1], next = null;
  for (let i = 0; i < TITLES.length; i++) {
    if (pct >= TITLES[i][0]) t = TITLES[i][1];
    else { next = TITLES[i]; break; }
  }
  return { title: t, next };
}

function conquer(storeId, opts = {}) {
  const s = S.stores.find(x => x.id === storeId);
  if (!s || isConquered(s)) return null;
  const date = opts.date || new Date().toISOString().slice(0, 10);
  S.visits.set(storeId, date);
  S.lastCheckIn = { storeId };

  const cell = S.cells.find(c => c.site.id === storeId);
  if (cell) S.anims.push({ cell, t0: performance.now() });
  spawnConfetti(s.x, s.y);
  ensureLoop();

  let gain = TIER_SCORE[s.tier] || 100;
  const parts = [];
  if (s.remote) { gain = Math.round(gain * REMOTE_MULT); parts.push('远征 ×1.5'); }
  const before = new Set(S.stores.filter(x => S.visits.has(x.id) && x.id !== s.id).map(x => x.district));
  if (!before.has(s.district)) { gain += FRONTIER_BONUS; parts.push('开疆 +' + FRONTIER_BONUS); }
  S.score = computeScore();
  renderSidebar();
  showToast(
    `<div class="big">点亮 ${s.shortName}${s.tier === 3 ? '王都' : ''}！</div>` +
    `<div class="gain">+${gain} 战功${parts.length ? ' · ' + parts.join(' · ') : ''}</div>`
  );
  return { store: s, gain };
}

function undoCheckIn() {
  if (!S.lastCheckIn) return;
  const s = S.stores.find(x => x.id === S.lastCheckIn.storeId);
  S.visits.delete(S.lastCheckIn.storeId);
  S.lastCheckIn = null;
  S.score = computeScore();
  renderSidebar();
  render();
  showToast(`<div class="big">已撤销「${s ? s.shortName : ''}」的打卡</div><div class="gain">领地重回迷雾</div>`);
}

/* ================= 侧栏 ================= */
function fmtScore(n) { return n.toLocaleString('en-US'); }

function renderSidebar() {
  const total = S.stores.length;
  const got = S.stores.filter(isConquered).length;
  const { pct } = areaStats();
  const { title, next } = currentTitle(pct);
  S.score = computeScore();

  document.getElementById('modeBadge').textContent = S.mode === 'demo' ? '演示数据' : '真实数据';
  document.getElementById('modeBadge').className = 'badge' + (S.mode === 'demo' ? '' : ' real');
  document.getElementById('playerTitle').textContent = title;
  document.getElementById('nextTitle').textContent = next
    ? `距「${next[1]}」还差 ${(next[0] - pct).toFixed(1)}% 版图`
    : '已至制霸之巅';
  const prev = TITLES.filter(t => pct >= t[0]).pop()[0];
  document.getElementById('titleBar').style.width =
    (next ? clamp((pct - prev) / (next[0] - prev) * 100, 2, 100) : 100) + '%';
  document.getElementById('stArea').textContent = pct.toFixed(1);
  document.getElementById('areaBar').style.width = clamp(pct, 1, 100) + '%';
  document.getElementById('stStores').textContent = got;
  document.getElementById('stStoresAll').textContent = total;
  document.getElementById('stDistricts').textContent = new Set(S.stores.filter(isConquered).map(s => s.district)).size;
  document.getElementById('stDistrictsAll').textContent = new Set(S.stores.map(s => s.district)).size;
  document.getElementById('stCapitals').textContent = S.stores.filter(s => isConquered(s) && s.tier === 3).length;
  document.getElementById('stScore').textContent = fmtScore(S.score);
  document.getElementById('undoBtn').classList.toggle('show', !!S.lastCheckIn);

  const byDistrict = {};
  for (const s of S.stores) {
    const d = byDistrict[s.district] = byDistrict[s.district] || { title: districtOf(s), all: 0, got: 0 };
    d.all++;
    if (isConquered(s)) d.got++;
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

/* ================= 交互 ================= */
function pickHover(sx, sy) {
  let best = null, bestD = 18 * 18 / S.view.k;
  for (const s of S.stores) {
    const d = (s.x - (sx - S.view.tx) / S.view.k) ** 2 + (s.y - (sy - S.view.ty) / S.view.k) ** 2;
    if (d < bestD) { bestD = d; best = s; }
  }
  return best;
}

canvas.addEventListener('mousemove', e => {
  if (S.tooltipPinned) return;
  if (S.dragging) {
    const dx = e.clientX - S.dragStart[0], dy = e.clientY - S.dragStart[1];
    if (Math.abs(dx) + Math.abs(dy) > 3) S.dragMoved = true;
    S.view.tx = S.viewStart.tx + dx;
    S.view.ty = S.viewStart.ty + dy;
    render();
    return;
  }
  const rect = canvas.getBoundingClientRect();
  const s = pickHover(e.clientX - rect.left, e.clientY - rect.top);
  const prev = S.hover;
  S.hover = s ? { site: s, cell: S.cells.find(c => c.site === s) } : null;
  if (s !== (prev && prev.site)) render();
  if (s) {
    const got = isConquered(s);
    tooltip.style.display = 'block';
    tooltip.innerHTML =
      `<div class="t-name">${got ? '📍 ' : ''}${s.name}</div>` +
      `<div class="t-line">${districtOf(s)} · ${TIER_NAME[s.tier]}${s.open24h ? ' · 24h' : ''}</div>` +
      (got
        ? `<div class="t-line">已点亮（${S.visits.get(s.id) || '—'}）</div>`
        : `<div class="t-line">尚未点亮 · 打卡可得 ${TIER_SCORE[s.tier] * (s.remote ? REMOTE_MULT : 1) | 0} 战功${s.remote ? '（远郊 ×1.5）' : ''}</div>` +
          `<button class="tt-btn" data-id="${s.id}">我吃了这家 · 打卡</button>`);
    tooltip.style.left = Math.min(e.clientX - rect.left + 16, S.cssW - 260) + 'px';
    tooltip.style.top = (e.clientY - rect.top + 14) + 'px';
    canvas.style.cursor = 'pointer';
  } else {
    tooltip.style.display = 'none';
    canvas.style.cursor = 'grab';
  }
});

canvas.addEventListener('mouseleave', () => {
  if (S.tooltipPinned) return;
  tooltip.style.display = 'none';
  S.hover = null;
  render();
});

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
    tooltip.style.display = 'none';
    S.tooltipPinned = false;
    conquer(btn.dataset.id);
  }
});

canvas.addEventListener('mousedown', e => {
  S.dragging = true; S.dragMoved = false;
  S.dragStart = [e.clientX, e.clientY];
  S.viewStart = { ...S.view };
  canvas.classList.add('dragging');
});
window.addEventListener('mouseup', () => {
  S.dragging = false;
  canvas.classList.remove('dragging');
});

canvas.addEventListener('click', e => {
  if (S.dragMoved) return;
  const rect = canvas.getBoundingClientRect();
  const s = pickHover(e.clientX - rect.left, e.clientY - rect.top);
  if (!s) return;
  if (isConquered(s)) {
    showToast(`<div class="big">📍 ${s.shortName}</div><div class="gain">已于 ${S.visits.get(s.id) || '—'} 点亮</div>`);
  } else {
    openCheckin(s.id);   // 明确的"我吃了这家"确认，不搞一键秒点
  }
});

canvas.addEventListener('wheel', e => {
  e.preventDefault();
  const rect = canvas.getBoundingClientRect();
  const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
  const [wx, wy] = screenToWorld(sx, sy);
  const k2 = clamp(S.view.k * Math.exp(-e.deltaY * 0.0012), 0.5, 6);
  S.view.k = k2;
  S.view.tx = sx - wx * k2;
  S.view.ty = sy - wy * k2;
  render();
}, { passive: false });

canvas.addEventListener('dblclick', () => { fitView(); render(); });
window.addEventListener('resize', resize);

/* ================= 用餐打卡 ================= */
function openCheckin(highlightId) {
  const overlay = document.getElementById('checkin');
  overlay.classList.add('show');
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
  const unconq = S.stores.filter(s => !isConquered(s));
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
        <div class="ci-sub">${districtOf(s)} · ${TIER_NAME[s.tier]}${s.remote ? ' · 远郊' : ''} · +${TIER_SCORE[s.tier] * (s.remote ? REMOTE_MULT : 1) | 0} 战功</div>
      </div>
      <button class="ci-btn" data-id="${s.id}">打卡</button>
    </div>`).join('');
  // 小图标
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
document.getElementById('btnReset').addEventListener('click', () => {
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
  if (e.target.id === 'help' || e.target.id === 'helpClose') e.target.closest('.overlay').classList.remove('show');
});

/* ================= toast ================= */
let toastTimer = null;
function showToast(html) {
  const t = document.getElementById('toast');
  t.innerHTML = html;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2800);
}

/* ================= 图例 ================= */
function drawLegend() {
  const box = document.getElementById('legend');
  const mk = (label, tier, conquered) => {
    const c = document.createElement('canvas');
    c.width = 88; c.height = 60;
    const g = c.getContext('2d');
    g.scale(2, 2);
    g.translate(22, 20);
    drawIconOn(g, tier, conquered);
    const div = document.createElement('div');
    div.className = 'li';
    div.appendChild(c);
    div.insertAdjacentHTML('beforeend', `<span>${label}</span>`);
    box.appendChild(div);
  };
  mk('王都 · 旗舰', 3, true);
  mk('城镇 · 商场店', 2, true);
  mk('甜品站 · 街角店', 1, true);
  const swatch = (fill, stroke, label) => {
    const c = document.createElement('canvas');
    c.width = 88; c.height = 60;
    const g = c.getContext('2d');
    g.scale(2, 2);
    g.fillStyle = fill;
    g.beginPath(); g.roundRect(6, 8, 32, 20, 6); g.fill();
    if (stroke) { g.strokeStyle = stroke; g.lineWidth = 2.4; g.stroke(); }
    else {
      drawCloud(g, 14, 12, 9, 0.95);
    }
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
  window.__MCK = { S, conquer, undoCheckIn, openCheckin };  // 调试/测试句柄
})();
})();
