/* 麦门制霸图 · m-king v2
 * 把全城麦当劳门店重绘成一张游戏王国地图：
 * 每家店是一座城邦，按 Voronoi 领地划分疆域，吃下一家 = 点亮整片领土。
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

/* ================= 全局状态 ================= */
const canvas = document.getElementById('map');
const ctx = canvas.getContext('2d');
const tooltip = document.getElementById('tooltip');

const S = {
  mode: 'demo',            // demo | real
  city: '北京',
  stores: [],
  cells: [],               // {poly, site, area}
  roads: [],
  visits: new Map(),       // storeId -> date 'YYYY-MM-DD'
  anims: [],               // 进行中的征服动画
  hover: null,             // {store, cell}
  view: { k: 1, tx: 0, ty: 0 },
  W: 1000, H: 600,         // 世界坐标范围（重算）
  bbox: null,
  kmPerUnit: 1,
  score: 0, scoreShown: 0,
  dragging: false, dragMoved: false, dragStart: null, viewStart: null,
};

const TIER_NAME = { 3: '王都', 2: '城镇', 1: '边哨' };
const TIER_SCORE = { 3: 500, 2: 200, 1: 100 };
const FRONTIER_BONUS = 150;
const REMOTE_MULT = 1.5;
const TITLES = [
  [0, '麦门路人'], [1, '见习麦民'], [5, '麦田巡逻官'], [10, '金拱门骑士'],
  [20, '堡垒男爵'], [30, '边疆侯爵'], [45, '巨无霸公爵'], [60, '麦门亲王'], [80, '制霸者 · 麦门之主'],
];

/* ================= 数据加载 ================= */
async function tryFetchJSON(url) {
  try {
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) return null;
    return await r.json();
  } catch (e) { return null; }
}

async function loadData() {
  let stores = null, visits = null;
  const combined = await tryFetchJSON('data/stores.json');
  if (combined && Array.isArray(combined.stores)) {
    stores = combined.stores;
    visits = combined.visits || (await tryFetchJSON('data/visits.json')) || [];
    S.mode = 'real';
    S.city = combined.city || '北京';
  } else {
    const v2 = await tryFetchJSON('data/visits.json');
    if (v2) visits = v2;
    const demo = window.MC_KINGDOM_DEMO;
    if (!demo) throw new Error('演示数据缺失');
    stores = demo.stores;
    visits = visits || demo.visits || [];
    S.mode = 'demo';
    S.city = demo.city || '北京';
  }
  S.stores = stores;
  S.visits = new Map((visits || []).map(v => [v.storeId, v.date || '']));
  build();
}

/* ================= 投影与几何 ================= */
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
  S.bbox = { x0: 0, y0: 0, x1: W, y1: H };
  const kmX = spanX * 111.32, kmY = spanY * 111.32;
  S.kmPerUnit = (kmX + kmY) / 2 / ((W / pad + H / pad) / 2);

  S.cells = voronoi(S.stores, S.bbox);
  S.roads = buildRoads(S.stores);
  document.getElementById('cityName').textContent = '· ' + S.city;
  fitView();
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

/* 道路：MST + 每点连最近邻，营造道路网 */
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

/* ================= 背景画布（羊皮纸，重绘一次） ================= */
let bgCanvas = null;
function makeBackground(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  const rnd = mulberry32(20261011);
  g.fillStyle = '#e8dabb';
  g.fillRect(0, 0, w, h);
  // 大块深浅斑驳
  for (let i = 0; i < 26; i++) {
    const x = rnd() * w, y = rnd() * h, r = 80 + rnd() * 260;
    const grad = g.createRadialGradient(x, y, 0, x, y, r);
    const dark = rnd() > 0.5;
    grad.addColorStop(0, dark ? 'rgba(160,130,80,0.10)' : 'rgba(255,248,225,0.16)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    g.fillRect(x - r, y - r, r * 2, r * 2);
  }
  // 细噪点
  for (let i = 0; i < w * h / 130; i++) {
    g.fillStyle = rnd() > 0.5 ? 'rgba(120,95,55,0.05)' : 'rgba(255,250,235,0.06)';
    g.fillRect(rnd() * w, rnd() * h, 1.4, 1.4);
  }
  // 暗角
  const vg = g.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.35, w / 2, h / 2, Math.max(w, h) * 0.75);
  vg.addColorStop(0, 'rgba(0,0,0,0)');
  vg.addColorStop(1, 'rgba(60,40,15,0.35)');
  g.fillStyle = vg;
  g.fillRect(0, 0, w, h);
  return c;
}

/* ================= 渲染 ================= */
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
  bgCanvas = makeBackground(Math.ceil(S.cssW * dpr), Math.ceil(S.cssH * dpr));
  render();
}

function fitView() {
  // 初始：整图适配窗口
  const kw = S.cssW / S.W, kh = S.cssH / S.H;
  const k = Math.min(kw, kh) * 0.96;
  S.view.k = k;
  S.view.tx = (S.cssW - S.W * k) / 2;
  S.view.ty = (S.cssH - S.H * k) / 2;
}

function worldToScreen(x, y) {
  return [x * S.view.k + S.view.tx, y * S.view.k + S.view.ty];
}
function screenToWorld(sx, sy) {
  return [(sx - S.view.tx) / S.view.k, (sy - S.view.ty) / S.view.k];
}

const isConquered = s => S.visits.has(s.id);

function render() {
  if (!S.cells.length || !bgCanvas) return;
  const { k, tx, ty } = S.view;
  ctx.save();
  ctx.setTransform(S.dpr, 0, 0, S.dpr, 0, 0);
  ctx.clearRect(0, 0, S.cssW, S.cssH);
  ctx.drawImage(bgCanvas, 0, 0, S.cssW, S.cssH);
  ctx.translate(tx, ty);
  ctx.scale(k, k);

  /* --- 领地 --- */
  for (const cell of S.cells) {
    const s = cell.site;
    const poly = cell.poly;
    ctx.beginPath();
    ctx.moveTo(poly[0][0], poly[0][1]);
    for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i][0], poly[i][1]);
    ctx.closePath();
    if (isConquered(s)) {
      const grad = ctx.createLinearGradient(0, s.y - 60, 0, s.y + 60);
      grad.addColorStop(0, '#ecc259');
      grad.addColorStop(1, '#d39a30');
      ctx.fillStyle = grad;
      ctx.fill();
      ctx.strokeStyle = 'rgba(156,58,18,0.85)';
      ctx.lineWidth = 1.8;
      ctx.stroke();
    } else {
      ctx.fillStyle = 'rgba(196,182,148,0.55)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(110,92,60,0.35)';
      ctx.lineWidth = 0.8;
      ctx.stroke();
      drawFog(cell);
    }
  }

  /* --- 征服动画的领土渐染 --- */
  const now = performance.now();
  for (const a of S.anims) {
    const t = clamp((now - a.t0) / 900, 0, 1);
    const e = ease(t);
    const cell = a.cell;
    ctx.beginPath();
    ctx.moveTo(cell.poly[0][0], cell.poly[0][1]);
    for (let i = 1; i < cell.poly.length; i++) ctx.lineTo(cell.poly[i][0], cell.poly[i][1]);
    ctx.closePath();
    ctx.globalAlpha = e * 0.92;
    const grad = ctx.createLinearGradient(0, cell.site.y - 60, 0, cell.site.y + 60);
    grad.addColorStop(0, '#f2ca62');
    grad.addColorStop(1, '#d69b33');
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.globalAlpha = 1;
    // 扩散光环
    const ring = 6 + e * 55;
    ctx.beginPath();
    ctx.arc(cell.site.x, cell.site.y, ring, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(216,98,61,' + (0.7 * (1 - e)) + ')';
    ctx.lineWidth = 3 * (1 - e) + 0.5;
    ctx.stroke();
  }
  if (S.anims.length) requestAnimationFrame(render);

  /* --- 河流 --- */
  drawRiver();

  /* --- 山脉与树林（远郊点缀） --- */
  drawScenery();

  /* --- 道路 --- */
  ctx.setLineDash([7, 6]);
  ctx.strokeStyle = 'rgba(133,108,66,0.55)';
  ctx.lineWidth = 1.3;
  ctx.beginPath();
  for (const [a, b] of S.roads) {
    ctx.moveTo(S.stores[a].x, S.stores[a].y);
    ctx.lineTo(S.stores[b].x, S.stores[b].y);
  }
  ctx.stroke();
  ctx.setLineDash([]);

  /* --- 城邦与标签（屏幕空间，尺寸恒定） --- */
  ctx.save();
  ctx.setTransform(S.dpr, 0, 0, S.dpr, 0, 0);
  const kEff = k;
  for (const s of S.stores) {
    const [sx, sy] = worldToScreen(s.x, s.y);
    if (sx < -40 || sy < -40 || sx > S.cssW + 40 || sy > S.cssH + 40) continue;
    drawSettlement(s, sx, sy, kEff);
  }
  // 郡名
  drawDistrictLabels();
  // 悬停高亮
  if (S.hover) {
    const [hx, hy] = worldToScreen(S.hover.site.x, S.hover.site.y);
    ctx.beginPath();
    ctx.arc(hx, hy, 15, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(216,98,61,0.9)';
    ctx.lineWidth = 2;
    ctx.stroke();
  }
  ctx.restore();

  /* --- 指南针与比例尺 --- */
  drawCompass();
  drawScaleBar();
  ctx.restore();
}

function drawFog(cell) {
  const rnd = mulberry32(hashStr(cell.site.id));
  const xs = cell.poly.map(p => p[0]), ys = cell.poly.map(p => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  ctx.fillStyle = 'rgba(72,62,42,0.10)';
  const step = 46;
  for (let x = x0; x < x1; x += step) {
    for (let y = y0; y < y1; y += step) {
      const jx = x + (rnd() - 0.5) * step * 0.9, jy = y + (rnd() - 0.5) * step * 0.9;
      if (!pointInPoly([jx, jy], cell.poly)) continue;
      const r = 1 + rnd() * 2.6;
      ctx.beginPath();
      ctx.arc(jx, jy, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }
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
  ctx.strokeStyle = 'rgba(120,150,155,0.55)';
  ctx.lineWidth = 9;
  ctx.lineCap = 'round';
  ctx.stroke(riverPath);
  ctx.strokeStyle = 'rgba(180,205,208,0.5)';
  ctx.lineWidth = 3.5;
  ctx.stroke(riverPath);
}

function drawScenery() {
  for (const cell of S.cells) {
    const s = cell.site;
    if (isConquered(s)) continue;
    const rnd = mulberry32(hashStr(s.id + '#sc'));
    if (s.remote && rnd() > 0.25) {
      // 山
      ctx.strokeStyle = 'rgba(120,100,70,0.5)';
      ctx.lineWidth = 1.1;
      const n = 2 + Math.floor(rnd() * 3);
      for (let m = 0; m < n; m++) {
        const ox = s.x + (rnd() - 0.5) * 46, oy = s.y + (rnd() - 0.5) * 40;
        const w = 5 + rnd() * 4, h = 4 + rnd() * 5;
        ctx.beginPath();
        ctx.moveTo(ox - w, oy + h * 0.6);
        ctx.lineTo(ox, oy - h);
        ctx.lineTo(ox + w, oy + h * 0.6);
        ctx.stroke();
      }
    }
    if (['昌平', '延庆', '怀柔', '密云'].includes(s.district) && rnd() > 0.5) {
      // 树
      ctx.fillStyle = 'rgba(96,118,70,0.5)';
      const n = 3 + Math.floor(rnd() * 4);
      for (let m = 0; m < n; m++) {
        const ox = s.x + (rnd() - 0.5) * 60, oy = s.y + (rnd() - 0.5) * 50;
        ctx.beginPath();
        ctx.arc(ox, oy, 2.6 + rnd() * 1.6, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
}

/* 城邦图标（屏幕空间恒定大小） */
function drawSettlement(s, sx, sy, k) {
  const conquered = isConquered(s);
  const bodyC = conquered ? '#caa23c' : '#8f8570';
  const bodyD = conquered ? '#8f6a14' : '#5f584a';
  const flagC = conquered ? '#b8321f' : '#6d675c';
  ctx.save();
  ctx.translate(sx, sy);
  // 影子
  ctx.fillStyle = 'rgba(50,35,15,0.3)';
  ctx.beginPath();
  ctx.ellipse(0, 9, 11, 3.2, 0, 0, Math.PI * 2);
  ctx.fill();

  if (s.tier === 3) {
    // 王都：双塔城堡
    ctx.fillStyle = bodyC;
    ctx.strokeStyle = bodyD;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.rect(-10, -4, 20, 12);
    ctx.fill(); ctx.stroke();
    ctx.beginPath();
    ctx.rect(-12, -10, 6, 18); ctx.fill(); ctx.stroke();
    ctx.beginPath();
    ctx.rect(6, -10, 6, 18); ctx.fill(); ctx.stroke();
    ctx.beginPath();
    ctx.rect(-3.5, -8, 7, 16); ctx.fill(); ctx.stroke();
    // 城门
    ctx.fillStyle = bodyD;
    ctx.beginPath();
    ctx.arc(0, 8, 2.6, Math.PI, 0);
    ctx.fill();
    // 旗帜
    ctx.strokeStyle = '#4a3313';
    ctx.beginPath(); ctx.moveTo(0, -8); ctx.lineTo(0, -17); ctx.stroke();
    ctx.fillStyle = flagC;
    ctx.beginPath();
    ctx.moveTo(0, -17); ctx.lineTo(9, -14.5); ctx.lineTo(0, -12);
    ctx.closePath(); ctx.fill();
    if (conquered) {
      ctx.fillStyle = '#f5d788';
      ctx.font = 'bold 6px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('M', 4.2, -13);
    }
  } else if (s.tier === 2) {
    // 城镇：城墙 + 双屋顶
    ctx.fillStyle = bodyC;
    ctx.strokeStyle = bodyD;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.rect(-8, -2, 16, 9);
    ctx.fill(); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(-9, -2); ctx.lineTo(-4.5, -8); ctx.lineTo(0, -2);
    ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, -2); ctx.lineTo(4.5, -8); ctx.lineTo(9, -2);
    ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.fillStyle = flagC;
    ctx.beginPath();
    ctx.moveTo(-4.5, -8); ctx.lineTo(-4.5, -13); ctx.lineTo(0.5, -11.5); ctx.lineTo(-4.5, -10);
    ctx.closePath(); ctx.fill();
  } else {
    // 边哨：帐篷 + 旗
    ctx.fillStyle = bodyC;
    ctx.strokeStyle = bodyD;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(-6, 6); ctx.lineTo(0, -6); ctx.lineTo(6, 6);
    ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.strokeStyle = '#4a3313';
    ctx.beginPath(); ctx.moveTo(0, -6); ctx.lineTo(0, -12); ctx.stroke();
    ctx.fillStyle = flagC;
    ctx.beginPath();
    ctx.moveTo(0, -12); ctx.lineTo(5.5, -10.5); ctx.lineTo(0, -9);
    ctx.closePath(); ctx.fill();
  }

  // 名牌
  const showLabel =
    s.tier === 3 ||
    (conquered && s.tier === 2 && k >= 1.18) ||
    (!conquered && s.tier === 2 && k >= 1.6) ||
    k >= 2.1;
  if (showLabel) {
    ctx.font = (conquered ? 'bold ' : '') + '10px -apple-system, "PingFang SC", sans-serif';
    ctx.textAlign = 'center';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(238,226,196,0.85)';
    ctx.strokeText(s.shortName, 0, 21);
    ctx.fillStyle = conquered ? '#6e4a08' : '#4f4128';
    ctx.fillText(s.shortName, 0, 21);
  }
  ctx.restore();
}

function drawDistrictLabels() {
  const byDistrict = {};
  for (const s of S.stores) {
    (byDistrict[s.districtTitle] = byDistrict[s.districtTitle] || []).push(s);
  }
  ctx.font = '600 15px "Songti SC","STSong",serif';
  ctx.textAlign = 'center';
  for (const [title, arr] of Object.entries(byDistrict)) {
    const cx = arr.reduce((a, s) => a + s.x, 0) / arr.length;
    const cy = arr.reduce((a, s) => a + s.y, 0) / arr.length;
    const [sx, sy] = worldToScreen(cx, cy);
    if (sx < 0 || sy < 0 || sx > S.cssW || sy > S.cssH) continue;
    ctx.lineWidth = 4;
    ctx.strokeStyle = 'rgba(238,226,196,0.7)';
    ctx.strokeText(title, sx, sy - 26);
    ctx.fillStyle = 'rgba(96,66,26,0.62)';
    ctx.fillText(title, sx, sy - 26);
  }
}

function drawCompass() {
  const x = S.cssW - 44, y = 46;
  ctx.save();
  ctx.globalAlpha = 0.75;
  ctx.beginPath(); ctx.arc(x, y, 16, 0, Math.PI * 2);
  ctx.strokeStyle = '#7a5f2f'; ctx.lineWidth = 1.2; ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x, y - 12); ctx.lineTo(x + 4.5, y + 6); ctx.lineTo(x, y + 2.5); ctx.lineTo(x - 4.5, y + 6);
  ctx.closePath();
  ctx.fillStyle = '#a5281a'; ctx.fill();
  ctx.fillStyle = '#6b5233';
  ctx.font = 'bold 9px serif';
  ctx.textAlign = 'center';
  ctx.fillText('N', x, y - 19);
  ctx.restore();
}

function drawScaleBar() {
  const targetKm = S.kmPerUnit * (S.W / S.view.k) * 0.12;
  const nice = [1, 2, 5, 10, 20, 50, 100].reduce((a, b) => Math.abs(b - targetKm) < Math.abs(a - targetKm) ? b : a);
  const px = nice / S.kmPerUnit * S.view.k;
  const x = 18, y = S.cssH - 18;
  ctx.save();
  ctx.strokeStyle = 'rgba(60,42,16,0.8)';
  ctx.fillStyle = 'rgba(238,226,196,0.85)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x, y - 5); ctx.lineTo(x, y); ctx.lineTo(x + px, y); ctx.lineTo(x + px, y - 5);
  ctx.stroke();
  ctx.fillRect(x, y - 1.2, px, 2.4);
  ctx.fillStyle = '#4a3313';
  ctx.font = '10.5px -apple-system, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('约 ' + nice + ' 公里', x, y - 9);
  ctx.restore();
}

/* ================= 游戏逻辑 ================= */
function districtOf(s) { return s.districtTitle || (s.district + '郡'); }

function computeScore() {
  let score = 0;
  const seenDistricts = new Set();
  for (const s of S.stores) {
    if (!isConquered(s)) continue;
    let p = TIER_SCORE[s.tier] || 100;
    if (s.remote) p = Math.round(p * REMOTE_MULT);
    if (!seenDistricts.has(s.district)) { p += FRONTIER_BONUS; seenDistricts.add(s.district); }
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
  return { pct: all ? got / all * 100 : 0, got, all };
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

  const cell = S.cells.find(c => c.site.id === storeId);
  if (cell && !opts.silent) S.anims.push({ cell, t0: performance.now() });

  // 战功结算
  let gain = TIER_SCORE[s.tier] || 100;
  const gainParts = [];
  if (s.remote) { gain = Math.round(gain * REMOTE_MULT); gainParts.push('远征 ×1.5'); }
  const districtsBefore = new Set(S.stores.filter(x => S.visits.has(x.id) && x.id !== s.id).map(x => x.district));
  if (!districtsBefore.has(s.district)) { gain += FRONTIER_BONUS; gainParts.push('开疆 +' + FRONTIER_BONUS); }
  S.score = computeScore();
  renderSidebar();
  if (!opts.silent) {
    const firstDistrict = gainParts.some(p => p.startsWith('开疆'));
    showToast(
      `<div class="big">⚔ 征服 ${s.shortName}${s.tier === 3 ? '王都' : ''}！</div>` +
      `<div class="gain">+${gain} 战功${gainParts.length ? ' · ' + gainParts.join(' · ') : ''}</div>`
    );
  }
  if (!S.anims.length) render();
  return { store: s, gain };
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
  document.getElementById('modeBadge').className = 'badge ' + (S.mode === 'demo' ? 'demo' : 'real');
  document.getElementById('playerTitle').textContent = title;
  document.getElementById('nextTitle').textContent = next
    ? `距「${next[1]}」还差 ${(next[0] - pct).toFixed(1)}% 版图`
    : '已至制霸之巅';
  const titlePrev = TITLES.filter(t => pct >= t[0]).pop()[0];
  document.getElementById('titleBar').style.width =
    (next ? clamp((pct - titlePrev) / (next[0] - titlePrev) * 100, 2, 100) : 100) + '%';
  document.getElementById('stArea').textContent = pct.toFixed(1);
  document.getElementById('areaBar').style.width = clamp(pct, 1, 100) + '%';
  document.getElementById('stStores').textContent = got;
  document.getElementById('stStoresAll').textContent = total;
  document.getElementById('stDistricts').textContent = new Set(S.stores.filter(isConquered).map(s => s.district)).size;
  document.getElementById('stDistrictsAll').textContent = new Set(S.stores.map(s => s.district)).size;
  document.getElementById('stCapitals').textContent = S.stores.filter(s => isConquered(s) && s.tier === 3).length;
  document.getElementById('stScore').textContent = fmtScore(S.score);

  // 区县战况
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

  // 编年史
  const chrono = [...S.visits.entries()]
    .map(([id, date]) => ({ date, s: S.stores.find(x => x.id === id) }))
    .filter(v => v.s)
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
    .slice(0, 8);
  document.getElementById('chronicle').innerHTML = chrono.length
    ? chrono.map(v =>
      `<li><span class="cdate">${v.date || '—'}</span><span class="cname">${v.s.shortName}</span><span class="cdist">${districtOf(v.s)}</span></li>`
    ).join('')
    : '<li class="empty">尚无征服记录 —— 吃下第一家，开始书写你的麦门疆史。</li>';

  // 战功数字滚动
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
      `<div class="t-name">${got ? '⚑ ' : ''}${s.name}</div>` +
      `<div class="t-line">${districtOf(s)} · ${TIER_NAME[s.tier]}${s.open24h ? ' · 24h' : ''}</div>` +
      `<div class="t-line">状态：${got ? '已征服（' + (S.visits.get(s.id) || '—') + '）' : '迷雾未征'}</div>` +
      `<div class="t-line">征服战功：${TIER_SCORE[s.tier] * (s.remote ? REMOTE_MULT : 1) | 0}${s.remote ? '（远郊 ×1.5）' : ''}</div>` +
      (S.mode === 'demo' && !got ? `<div class="t-hint">点击城邦，即刻攻占</div>` : '');
    tooltip.style.left = Math.min(e.clientX - rect.left + 16, S.cssW - 250) + 'px';
    tooltip.style.top = (e.clientY - rect.top + 14) + 'px';
    canvas.style.cursor = 'pointer';
  } else {
    tooltip.style.display = 'none';
    canvas.style.cursor = 'grab';
  }
});

canvas.addEventListener('mouseleave', () => {
  tooltip.style.display = 'none';
  S.hover = null;
  render();
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
    showToast(`<div class="big">⚑ ${s.shortName}</div><div class="gain">已于 ${S.visits.get(s.id) || '—'} 归入王土</div>`);
    return;
  }
  if (S.mode !== 'demo') {
    showToast(`<div class="big">${s.shortName} 尚未征服</div><div class="gain">真实模式下由你的订单数据点亮疆土</div>`);
    return;
  }
  conquer(s.id);
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

/* ================= 按钮与横幅 ================= */
let toastTimer = null;
function showToast(html) {
  const t = document.getElementById('toast');
  t.innerHTML = html;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2800);
}

document.getElementById('btnConquer').addEventListener('click', () => {
  const unconq = S.stores.filter(s => !isConquered(s));
  if (!unconq.length) {
    showToast('<div class="big">👑 全城制霸达成！</div><div class="gain">这座城市的每一家麦当劳，都插上了你的旗。</div>');
    return;
  }
  let pick;
  const conquered = S.stores.filter(isConquered);
  if (conquered.length) {
    // 在已征服城邦附近挑选目标（前 6 近随机）
    const scored = unconq.map(s => {
      const dmin = Math.min(...conquered.map(c => (s.x - c.x) ** 2 + (s.y - c.y) ** 2));
      return [s, dmin];
    }).sort((a, b) => a[1] - b[1]).slice(0, 6);
    pick = scored[Math.floor(Math.random() * scored.length)][0];
  } else {
    pick = unconq[Math.floor(Math.random() * unconq.length)];
  }
  conquer(pick.id);
});

document.getElementById('btnReset').addEventListener('click', () => {
  S.mode = 'demo';
  S.stores = window.MC_KINGDOM_DEMO.stores;
  S.city = window.MC_KINGDOM_DEMO.city;
  S.visits = new Map(window.MC_KINGDOM_DEMO.visits.map(v => [v.storeId, v.date]));
  build();
  showToast('<div class="big">演示王国已重置</div><div class="gain">17 座城邦重归迷雾</div>');
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
    build();
    showToast('<div class="big">真实数据已载入</div><div class="gain">你的王国开始生长</div>');
  } catch (err) {
    showToast(`<div class="big">导入失败</div><div class="gain">${err.message}</div>`);
  }
  e.target.value = '';
});

document.getElementById('btnHelp').addEventListener('click', () => document.getElementById('help').classList.add('show'));
document.getElementById('help').addEventListener('click', e => {
  if (e.target.id === 'help') e.target.classList.remove('show');
});

/* ================= 图例 ================= */
function drawLegend() {
  const box = document.getElementById('legend');
  const mk = (label, tier, conquered) => {
    const c = document.createElement('canvas');
    c.width = 44; c.height = 30;
    const g = c.getContext('2d');
    g.translate(22, 17);
    drawIconOn(g, tier, conquered);
    const div = document.createElement('div');
    div.className = 'li';
    div.appendChild(c);
    div.insertAdjacentHTML('beforeend', `<span>${label}</span>`);
    box.appendChild(div);
  };
  mk('王都（旗舰）', 3, true);
  mk('城镇（商场店）', 2, false);
  mk('边哨（社区/DT）', 1, false);
  // 已征服/迷雾 色块
  const swatch = (color, stroke, label) => {
    const c = document.createElement('canvas');
    c.width = 44; c.height = 30;
    const g = c.getContext('2d');
    g.fillStyle = color;
    g.fillRect(8, 6, 28, 18);
    if (stroke) { g.strokeStyle = stroke; g.lineWidth = 1.5; g.strokeRect(8, 6, 28, 18); }
    else {
      g.fillStyle = 'rgba(66,56,38,0.35)';
      for (let i = 0; i < 12; i++) { g.beginPath(); g.arc(12 + (i * 7) % 22, 10 + (i * 5) % 12, 2.4, 0, 7); g.fill(); }
    }
    const div = document.createElement('div');
    div.className = 'li';
    div.appendChild(c);
    div.insertAdjacentHTML('beforeend', `<span>${label}</span>`);
    box.appendChild(div);
  };
  swatch('#e2b445', '#9c3a12', '已征服领地');
  swatch('rgba(196,182,148,0.55)', null, '迷雾未征');
}

function drawIconOn(g, tier, conquered) {
  const bodyC = conquered ? '#caa23c' : '#8f8570';
  const bodyD = conquered ? '#8f6a14' : '#5f584a';
  const flagC = conquered ? '#b8321f' : '#6d675c';
  g.strokeStyle = '#4a3313';
  if (tier === 3) {
    g.fillStyle = bodyC; g.lineWidth = 1;
    g.beginPath(); g.rect(-10, -4, 20, 12); g.fill(); g.stroke();
    g.beginPath(); g.rect(-12, -10, 6, 18); g.fill(); g.stroke();
    g.beginPath(); g.rect(6, -10, 6, 18); g.fill(); g.stroke();
    g.beginPath(); g.rect(-3.5, -8, 7, 16); g.fill(); g.stroke();
    g.beginPath(); g.moveTo(0, -8); g.lineTo(0, -17); g.stroke();
    g.fillStyle = flagC;
    g.beginPath(); g.moveTo(0, -17); g.lineTo(9, -14.5); g.lineTo(0, -12); g.closePath(); g.fill();
  } else if (tier === 2) {
    g.fillStyle = bodyC; g.lineWidth = 1;
    g.beginPath(); g.rect(-8, -2, 16, 9); g.fill(); g.stroke();
    g.beginPath(); g.moveTo(-9, -2); g.lineTo(-4.5, -8); g.lineTo(0, -2); g.closePath(); g.fill(); g.stroke();
    g.beginPath(); g.moveTo(0, -2); g.lineTo(4.5, -8); g.lineTo(9, -2); g.closePath(); g.fill(); g.stroke();
    g.fillStyle = flagC;
    g.beginPath(); g.moveTo(-4.5, -8); g.lineTo(-4.5, -13); g.lineTo(0.5, -11.5); g.lineTo(-4.5, -10); g.closePath(); g.fill();
  } else {
    g.fillStyle = bodyC; g.lineWidth = 1;
    g.beginPath(); g.moveTo(-6, 6); g.lineTo(0, -6); g.lineTo(6, 6); g.closePath(); g.fill(); g.stroke();
    g.beginPath(); g.moveTo(0, -6); g.lineTo(0, -12); g.stroke();
    g.fillStyle = flagC;
    g.beginPath(); g.moveTo(0, -12); g.lineTo(5.5, -10.5); g.lineTo(0, -9); g.closePath(); g.fill();
  }
}

/* ================= 启动 ================= */
(async function main() {
  resize();
  await loadData();
  drawLegend();
})();
})();
