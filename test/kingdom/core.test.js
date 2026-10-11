/* 麦门制霸图 · core.js 单元测试（node --test，零依赖）
 * 覆盖：Voronoi 几何性质、投影往返、道路连通性、计分规则、
 *       称号阶梯、成就徽章、下一目标推荐。
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const C = require('../../kingdom/core.js');

/* ---------- 几何 ---------- */
test('clipBisector: 正方形被四邻裁成四分之一', () => {
  const p = { x: 0, y: 0 };
  let poly = [[-10, -10], [10, -10], [10, 10], [-10, 10]];
  for (const q of [{ x: 20, y: 0 }, { x: -20, y: 0 }, { x: 0, y: 20 }, { x: 0, y: -20 }]) {
    poly = C.clipBisector(poly, p, q);
  }
  // 中心点对四个远邻的 cell 仍是整个正方形（半平面都包含 p 侧）
  assert.strictEqual(Math.abs(C.polyArea(poly)) > 0, true);
  // 对紧邻的四点裁剪后面积应为 1/4
  let poly2 = [[-10, -10], [10, -10], [10, 10], [-10, 10]];
  for (const q of [{ x: 10, y: 0 }, { x: -10, y: 0 }, { x: 0, y: 10 }, { x: 0, y: -10 }]) {
    poly2 = C.clipBisector(poly2, p, q);
  }
  const a = Math.abs(C.polyArea(poly2));
  assert.ok(Math.abs(a - 100) < 1e-6, `期望 100，实际 ${a}`);
});

test('voronoi: 面积守恒且每个 cell 包含自己的 site', () => {
  const sites = [];
  const rnd = C.mulberry32(7);
  for (let i = 0; i < 40; i++) {
    sites.push({ id: 'S' + i, x: rnd() * 100, y: rnd() * 100, tier: 1 + (i % 3), remote: false, district: 'D' + (i % 4), districtTitle: 'D' + (i % 4) + '郡', shortName: '店' + i });
  }
  const cells = C.voronoi(sites, { x0: 0, y0: 0, x1: 100, y1: 100 });
  assert.strictEqual(cells.length, 40);
  const total = cells.reduce((a, c) => a + c.area, 0);
  assert.ok(Math.abs(total - 10000) < 1e-6, `面积和 ${total} ≠ 10000`);
  for (const c of cells) {
    assert.ok(C.pointInPoly([c.site.x, c.site.y], c.poly), `site ${c.site.id} 不在自己的 cell 内`);
  }
});

test('pointInPoly: 边界内外判定', () => {
  const sq = [[0, 0], [10, 0], [10, 10], [0, 10]];
  assert.strictEqual(C.pointInPoly([5, 5], sq), true);
  assert.strictEqual(C.pointInPoly([15, 5], sq), false);
  assert.strictEqual(C.pointInPoly([-1, -1], sq), false);
});

test('projectStores: 单调性 + 世界尺寸合理', () => {
  const stores = [
    { lat: 40.0, lng: 116.0 }, { lat: 39.5, lng: 116.5 }, { lat: 39.8, lng: 116.3 },
  ];
  const { W, H, kmPerUnit } = C.projectStores(stores);
  assert.ok(W === 1000 && H > 300 && H < 1400);
  assert.ok(kmPerUnit > 0);
  // 纬度越高 y 越小（北在上）
  const [a, b] = stores;
  assert.ok(a.y < b.y);
});

test('buildRoads: 图连通（MST 保证）', () => {
  const sites = [];
  for (let i = 0; i < 20; i++) {
    sites.push({ x: (i % 5) * 10, y: Math.floor(i / 5) * 10 });
  }
  const edges = C.buildRoads(sites);
  const adj = new Map(sites.map((_, i) => [i, []]));
  for (const [a, b] of edges) { adj.get(a).push(b); adj.get(b).push(a); }
  const seen = new Set([0]);
  const stack = [0];
  while (stack.length) {
    for (const v of adj.get(stack.pop()) || []) {
      if (!seen.has(v)) { seen.add(v); stack.push(v); }
    }
  }
  assert.strictEqual(seen.size, 20);
  // 边数不超过 MST(19) + 每点 2 条 kNN 补边的上限
  assert.ok(edges.length <= 19 + 20 * 2);
});

/* ---------- 计分 ---------- */
function mkStore(id, district, tier, remote) {
  return { id, district, districtTitle: district + '郡', tier, remote, shortName: id, x: 0, y: 0 };
}

test('computeScore: 等级分 + 远郊倍率 + 每郡一次开疆奖', () => {
  const stores = [
    mkStore('a', '海淀', 3, false),   // 王都 500 + 开疆150
    mkStore('b', '海淀', 1, false),   // 边哨 100（开疆只发一次）
    mkStore('c', '密云', 2, true),    // 城镇 200*1.5=300 + 开疆150
  ];
  const visits = new Map([['a', '2026-01-01']]);
  assert.strictEqual(C.computeScore(stores, visits), 650);
  visits.set('b', '2026-01-02');
  assert.strictEqual(C.computeScore(stores, visits), 750);
  visits.set('c', '2026-01-03');
  assert.strictEqual(C.computeScore(stores, visits), 1200);
});

test('checkinGain: 开疆奖只按"首次进郡"判定', () => {
  const stores = [mkStore('a', '海淀', 1, false), mkStore('b', '海淀', 1, false), mkStore('c', '密云', 2, true)];
  const visits = new Map([['a', 'x']]);
  const g1 = C.checkinGain(stores, visits, stores[1]); // 同郡第二家：无开疆
  assert.deepStrictEqual(g1, { gain: 100, parts: [] });
  const g2 = C.checkinGain(stores, visits, stores[2]); // 新郡 + 远郊
  assert.strictEqual(g2.gain, Math.round(200 * 1.5) + 150);
  assert.ok(g2.parts.includes('远征 ×1.5'));
  assert.ok(g2.parts.some(p => p.startsWith('开疆')));
});

test('areaShare: 占比 = 已点亮面积 / 总面积', () => {
  const sites = [
    { id: 'a', x: 25, y: 50 }, { id: 'b', x: 75, y: 50 },
  ];
  const cells = C.voronoi(sites, { x0: 0, y0: 0, x1: 100, y1: 100 });
  const share = C.areaShare(cells, new Map([['a', 'x']]));
  assert.ok(Math.abs(share.pct - 50) < 1e-6, `期望 50%，实际 ${share.pct}`);
});

/* ---------- 称号 ---------- */
test('titleFor: 九级阶梯边界', () => {
  const cases = [
    [0, '麦门路人'], [0.9, '麦门路人'], [1, '见习麦民'], [4.9, '见习麦民'],
    [5, '麦田巡逻官'], [10, '金拱门骑士'], [20, '堡垒男爵'], [30, '边疆侯爵'],
    [45, '巨无霸公爵'], [60, '麦门亲王'], [80, '制霸者 · 麦门之主'], [99, '制霸者 · 麦门之主'],
  ];
  for (const [pct, expect] of cases) {
    assert.strictEqual(C.titleFor(pct).title, expect, `pct=${pct}`);
  }
  assert.strictEqual(C.titleFor(4).next[1], '麦田巡逻官');
  assert.strictEqual(C.titleFor(99).next, null);
});

/* ---------- 徽章 ---------- */
test('evaluateBadges: 统计口径与达成判定', () => {
  const stores = [
    mkStore('a', '海淀', 3, false),
    mkStore('b', '密云', 2, true),
    mkStore('c', '延庆', 1, true),
    mkStore('d', '怀柔', 1, true),
  ];
  const visits = new Map(stores.map(s => [s.id, 'x']));
  const badges = C.evaluateBadges(stores, [], visits);
  const byId = Object.fromEntries(badges.map(b => [b.id, b]));
  assert.strictEqual(byId.first.done, true);
  assert.strictEqual(byId.ten.done, false);   // 只点亮 4 家
  assert.strictEqual(byId.expedition.done, true); // 3 家远郊
  assert.strictEqual(byId.capital.done, false);   // 1 座王都 < 3
  assert.strictEqual(byId.pioneer.done, false);   // 3 郡 < 5
});

/* ---------- 下一目标 ---------- */
test('nextGoal: 优先"差一家全亮"的郡，其次高战功目标', () => {
  const stores = [
    mkStore('a1', '东城', 1, false), mkStore('a2', '东城', 1, false),
    mkStore('a3', '东城', 1, false), mkStore('a4', '东城', 1, false),
    mkStore('b1', '朝阳', 3, false), mkStore('b2', '朝阳', 3, false),
  ];
  const visits = new Map([['a1', 'x'], ['a2', 'x'], ['a3', 'x'], ['b1', 'x']]);
  const goal = C.nextGoal(stores, [], visits);
  assert.strictEqual(goal.type, 'district-almost');
  assert.strictEqual(goal.store.id, 'a4');
  assert.ok(goal.text.includes('东城郡'));

  // 东城补齐后：只剩朝阳 b2（王都 500 > 开疆后的远征），应指向高价值
  visits.set('a4', 'x');
  const goal2 = C.nextGoal(stores, [], visits);
  assert.strictEqual(goal2.type, 'high-value');
  assert.strictEqual(goal2.store.id, 'b2');

  // 全点亮 → done
  visits.set('b2', 'x');
  assert.strictEqual(C.nextGoal(stores, [], visits).type, 'done');
});

/* ---------- 工具 ---------- */
test('mulberry32: 同种子序列一致、ease 单调', () => {
  const r1 = C.mulberry32(42), r2 = C.mulberry32(42);
  const seq1 = [r1(), r1(), r1()];
  const seq2 = [r2(), r2(), r2()];
  assert.deepStrictEqual(seq1, seq2);
  for (let i = 1; i < 10; i++) {
    assert.ok(C.ease(i / 10) >= C.ease((i - 1) / 10));
  }
});
