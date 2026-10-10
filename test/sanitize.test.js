'use strict';
/* 脱敏层单测：门店名称替换、订单时间打码、非个人数据保留 */

const test = require('node:test');
const assert = require('node:assert');
const { sanitizeSnapshot } = require('../lib/sanitize');

function fakeSnap() {
  return {
    takenAt: '2026-10-10 21:00',
    status: { ok: true, toolCount: 35, endpoint: 'https://mcp.mcd.cn' },
    dashboard: {
      ok: true,
      time: '2026-10-10T21:00:00.000',
      store: { name: '麦当劳北京某某路(原某某公园)餐厅', code: '1000001', count: 2 },
      stores: [
        { name: '麦当劳北京某某路(原某某公园)餐厅', code: '1000001' },
        { name: '麦当劳北京另一条大街得来速餐厅', code: '1000002' },
      ],
    },
    modes: {
      'annual-report': {
        ok: true,
        blocks: [
          { type: 'table', title: '订单明细', rows: [
            ['2026-05-03 18:38', '北京某某路(原某某公园)餐厅', '巨无霸×1', '¥24.00'],
            ['2026-05-01 15:42', '北京某某路(原某某公园)餐厅', '麦旋风×1', '¥14.50'],
          ] },
          { type: 'kpi', items: [
            { label: '时间跨度', value: 125, unit: '天', hint: '2026-05-01 → 2026-09-30' },
          ] },
        ],
      },
      'mci-index': {
        ok: true,
        blocks: [
          { type: 'hero', title: '本期麦价篮子', big: '46.5', unit: '元 / 篮子',
            sub: '巨无霸 + 中薯条 + 中可乐 · 麦当劳北京某某路(原某某公园)餐厅' },
        ],
      },
    },
  };
}

test('门店名称被替换为示例门店，且同一门店映射一致', () => {
  const out = sanitizeSnapshot(fakeSnap());
  const sub = out.modes['mci-index'].blocks[0].sub;
  assert.ok(!sub.includes('某某路'), 'hero sub 里不应再出现真实门店名: ' + sub);
  assert.ok(/示例门店[A-Z]/.test(sub));
  // 看板与订单表里的同一门店应替换成同一个代号
  const dashName = out.dashboard.store.name;
  const orderCell = out.modes['annual-report'].blocks[0].rows[0][1];
  assert.equal(dashName, orderCell);
});

test('订单日期打码到月份，取数时间保留', () => {
  const out = sanitizeSnapshot(fakeSnap());
  const row = out.modes['annual-report'].blocks[0].rows[0];
  assert.equal(row[0], '2026-05-**');
  const hint = out.modes['annual-report'].blocks[1].items[0].hint;
  assert.ok(!/\d{2}:\d{2}/.test(hint));
  assert.equal(out.takenAt, '2026-10-10 21:00'); // 快照时刻不是个人行为，保留
});

test('脱敏不改原对象', () => {
  const snap = fakeSnap();
  sanitizeSnapshot(snap);
  assert.equal(snap.dashboard.store.name, '麦当劳北京某某路(原某某公园)餐厅');
});

test('泛化短语「X 家餐厅」不被误替换', () => {
  const out = sanitizeSnapshot({
    dashboard: { store: null },
    modes: { 'mci-index': { blocks: [
      { type: 'note', text: '覆盖 3 家餐厅 · 该门店当前未返回在售餐品' },
    ] } },
  });
  assert.equal(out.modes['mci-index'].blocks[0].text, '覆盖 3 家餐厅 · 该门店当前未返回在售餐品');
});
