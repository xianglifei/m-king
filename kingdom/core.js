/* 麦门制霸图 · core.js —— 纯逻辑层（无 DOM，浏览器/Node 通用）
 *
 * 职责：投影、Voronoi 领地、道路网、计分、称号、成就徽章、下一目标推荐。
 * 不碰 canvas、不碰 DOM，全部函数可被 node:test 直接单测。
 * 导出：浏览器挂 window.MCK_CORE；Node 走 module.exports。
 */
'use strict';

/* ================= 基础工具 ================= */
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
function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/* ================= 游戏数值 ================= */
const TIER_NAME = { 3: '王都', 2: '城镇', 1: '甜品站' };
const TIER_SCORE = { 3: 500, 2: 200, 1: 100 };
const FRONTIER_BONUS = 150;
const REMOTE_MULT = 1.5;
const TITLES = [
  [0, '麦门路人'], [1, '见习麦民'], [5, '麦田巡逻官'], [10, '金拱门骑士'],
  [20, '堡垒男爵'], [30, '边疆侯爵'], [45, '巨无霸公爵'], [60, '麦门亲王'], [80, '制霸者 · 麦门之主'],
];

/* ================= 投影 =================
 * 经纬度 → 世界坐标（等距圆柱 + 中纬度 cos 修正）。
 * 返回画布世界尺寸与比例尺信息；坐标写入 store.x / store.y。
 */
function projectStores(stores, opts = {}) {
  if (!stores.length) return { W: 1000, H: 600, kmPerUnit: 1 };
  const lats = stores.map(s => s.lat), lngs = stores.map(s => s.lng);
  const lat0 = Math.min(...lats), lat1 = Math.max(...lats);
  const lng0 = Math.min(...lngs), lng1 = Math.max(...lngs);
  const midLat = (lat0 + lat1) / 2;
  const kx = Math.cos(midLat * Math.PI / 180);
  const spanX = Math.max((lng1 - lng0) * kx, 1e-9), spanY = Math.max(lat1 - lat0, 1e-9);
  const W = opts.W || 1000;
  const H = Math.max(420, Math.min(1400, W * spanY / spanX));
  const mx = (lng0 + lng1) / 2, my = (lat0 + lat1) / 2;
  const pad = opts.pad || 1.06;
  for (const s of stores) {
    s.x = W / 2 + (s.lng - mx) / spanX * W / pad;
    s.y = H / 2 - (s.lat - my) / spanY * H / pad;
  }
  const kmPerUnit = ((spanX + spanY) / 2 * 111.32) / ((W / pad + H / pad) / 2);
  return { W, H, kmPerUnit };
}

/* ================= Voronoi ================= */
function clipBisector(poly, p, q) {
  // 保留距 p 更近的半平面：2(q-p)·x <= |q|²-|p|²
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

/* ================= 道路网（MST + 最近邻补边） ================= */
function buildRoads(sites) {
  const n = sites.length;
  if (n < 2) return [];
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
    const near = sites.map((s, j) => [j, (s.x - sites[i].x) ** 2 + (s.y - sites[i].y) ** 2])
      .filter(([j]) => j !== i).sort((a, b) => a[1] - b[1]).slice(0, 2);
    for (const [j] of near) {
      const key = i < j ? i + '-' + j : j + '-' + i;
      if (!seen.has(key)) { seen.add(key); edges.push([i, j]); }
    }
  }
  return edges;
}

/* ================= 计分 ================= */
const isLit = (visits, id) => visits.has(id);

/** 战功 = Σ(城邦等级分 × 远郊倍率) + 每郡首次点亮奖 */
function computeScore(stores, visits) {
  let score = 0;
  const seen = new Set();
  for (const s of stores) {
    if (!isLit(visits, s.id)) continue;
    let p = TIER_SCORE[s.tier] || 100;
    if (s.remote) p = Math.round(p * REMOTE_MULT);
    if (!seen.has(s.district)) { p += FRONTIER_BONUS; seen.add(s.district); }
    score += p;
  }
  return score;
}

/** 单店打卡可得战功（含远郊倍率与开疆判定） */
function checkinGain(stores, visits, store) {
  let gain = TIER_SCORE[store.tier] || 100;
  const parts = [];
  if (store.remote) { gain = Math.round(gain * REMOTE_MULT); parts.push('远征 ×1.5'); }
  const before = new Set(
    stores.filter(x => isLit(visits, x.id) && x.id !== store.id).map(x => x.district)
  );
  if (!before.has(store.district)) { gain += FRONTIER_BONUS; parts.push('开疆 +' + FRONTIER_BONUS); }
  return { gain, parts };
}

/** 版图占比（按 Voronoi 领地面积） */
function areaShare(cells, visits) {
  let all = 0, got = 0;
  for (const c of cells) {
    all += c.area;
    if (isLit(visits, c.site.id)) got += c.area;
  }
  return { pct: all ? got / all * 100 : 0, got, all };
}

/** 面积 % → 称号；next 为下一称号 [阈值, 名] 或 null */
function titleFor(pct) {
  let title = TITLES[0][1], current = TITLES[0], next = null;
  for (const t of TITLES) {
    if (pct >= t[0]) { title = t[1]; current = t; }
    else { next = t; break; }
  }
  return { title, current, next };
}

/* ================= 成就徽章 ================= */
const BADGES = [
  { id: 'first', icon: '始', name: '初来麦到', desc: '点亮第一家城邦', test: st => st.lit >= 1 },
  { id: 'ten', icon: '十', name: '小有所成', desc: '累计点亮 10 家', test: st => st.lit >= 10 },
  { id: 'crusade', icon: '猛', name: '攻城拔寨', desc: '累计点亮 25 家', test: st => st.lit >= 25 },
  { id: 'half', icon: '半', name: '半壁江山', desc: '版图面积达 30%', test: st => st.pct >= 30 },
  { id: 'capital', icon: '王', name: '王都克星', desc: '攻克 3 座王都', test: st => st.capitals >= 3 },
  { id: 'pioneer', icon: '疆', name: '开疆拓土', desc: '点亮 5 个郡', test: st => st.districts >= 5 },
  { id: 'expedition', icon: '征', name: '远征军', desc: '点亮 3 家远郊城邦', test: st => st.remotes >= 3 },
  { id: 'almost', icon: '望', name: '制霸在望', desc: '版图面积过半', test: st => st.pct >= 50 },
];

function evaluateBadges(stores, cells, visits) {
  const stats = {
    lit: stores.filter(s => isLit(visits, s.id)).length,
    pct: areaShare(cells, visits).pct,
    capitals: stores.filter(s => isLit(visits, s.id) && s.tier === 3).length,
    districts: new Set(stores.filter(s => isLit(visits, s.id)).map(s => s.district)).size,
    remotes: stores.filter(s => isLit(visits, s.id) && s.remote).length,
  };
  return BADGES.map(b => ({ ...b, done: !!b.test(stats) }));
}

/* ================= 下一目标推荐 =================
 * 优先级：只差 1 家全亮的郡 > 战功最高的未点亮城邦 > 制霸达成。
 * 返回 { type, store, goalDistrict, gain, text }。
 */
function nextGoal(stores, cells, visits) {
  const lit = new Set([...visits.keys()]);
  const unconq = stores.filter(s => !lit.has(s.id));
  if (!unconq.length) {
    return { type: 'done', text: '全城制霸达成！这座城市的每一家麦当劳都插上了你的旗。' };
  }
  // 差一家的郡
  const byDistrict = {};
  for (const s of stores) {
    const d = byDistrict[s.district] = byDistrict[s.district] || { all: 0, got: 0, missing: [] };
    d.all++;
    if (lit.has(s.id)) d.got++;
    else d.missing.push(s);
  }
  for (const [dist, d] of Object.entries(byDistrict)) {
    if (d.all >= 3 && d.missing.length === 1) {
      const s = d.missing[0];
      const { gain } = checkinGain(stores, visits, s);
      return {
        type: 'district-almost', store: s, gain,
        goalDistrict: dist,
        text: `再点亮「${s.shortName}」，${s.districtTitle || dist + '郡'}就全境点亮了！`,
      };
    }
  }
  // 战功最高的未点亮（远征优先）
  let best = unconq[0], bestGain = -1, bestParts = [];
  for (const s of unconq) {
    const { gain, parts } = checkinGain(stores, visits, s);
    if (gain > bestGain) { bestGain = gain; best = s; bestParts = parts; }
  }
  return {
    type: 'high-value', store: best, gain: bestGain,
    text: `下一个高价值目标：「${best.shortName}」 ${bestParts.length ? '(' + bestParts.join(' · ') + ')' : ''} · +${bestGain} 战功`,
  };
}

/* ================= 导出 ================= */
const MCK_CORE = {
  mulberry32, clamp, ease, hashStr,
  TIER_NAME, TIER_SCORE, FRONTIER_BONUS, REMOTE_MULT, TITLES, BADGES,
  projectStores, voronoi, clipBisector, polyArea, pointInPoly, buildRoads,
  computeScore, checkinGain, areaShare, titleFor, evaluateBadges, nextGoal,
  isLit,
};

if (typeof module !== 'undefined' && module.exports) module.exports = MCK_CORE;
if (typeof window !== 'undefined') window.MCK_CORE = MCK_CORE;
