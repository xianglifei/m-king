'use strict';
/* 纯函数单测：解析、归一化、模糊匹配、代表品挑选、时段判断 */

const test = require('node:test');
const assert = require('node:assert');
const { _internal } = require('../lib/modes');

test('parseNutrition 解析表头与数据行', () => {
  const text =
    '{productName,nutritionDescription,energyKj,energyKcal,protein,fat,carbohydrate,sodium,calcium}:\n' +
    '巨无霸,含小麦,2130,510,26,27,43,1000,150\n' +
    '中薯条,炸制,1330,320,4,16,41,310,20\n';
  const rows = _internal.parseNutrition(text);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].productName, '巨无霸');
  assert.equal(rows[0].energyKcal, 510);
  assert.equal(rows[1].energyKcal, 320);
});

test('parseNutrition 无表头时按默认列兜底，空输入返回空数组', () => {
  const rows = _internal.parseNutrition('巨无霸,含小麦,2130,510,26,27,43,1000,150\n');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].productName, '巨无霸');
  assert.deepEqual(_internal.parseNutrition(''), []);
  assert.deepEqual(_internal.parseNutrition(null), []);
});

test('normName 去除修饰词、括号与空白后小写', () => {
  assert.equal(_internal.normName('麦辣鸡腿汉堡（中杯）'), '麦辣鸡腿');
  assert.equal(_internal.normName('Big Mac'), 'bigmac');
});

test('fuzzyFind 归一化后完全相等者优先于仅包含者', () => {
  // 「超值麦辣鸡腿汉堡双人套餐」归一后只是"包含"目标名，「麦辣鸡腿汉堡」归一后与之完全相等
  const pool = [
    { productName: '超值麦辣鸡腿汉堡双人套餐' },
    { productName: '麦辣鸡腿汉堡' },
  ];
  assert.equal(_internal.fuzzyFind(pool, '麦辣鸡腿汉堡').productName, '麦辣鸡腿汉堡');
});

test('fuzzyFind 双向包含时取长度最接近者', () => {
  const pool = [
    { productName: '板烧鸡腿 Forte 鸡腿堡' },
    { productName: '板烧鸡腿' },
  ];
  assert.equal(_internal.fuzzyFind(pool, '板烧鸡腿').productName, '板烧鸡腿');
  assert.equal(_internal.fuzzyFind(pool, '不存在的品'), null);
});

test('pickRepresentative 跳过套餐、按关键词顺序降级替代', () => {
  const items = [
    { name: '巨无霸中套餐', price: 39 },
    { name: '巨无霸', price: 25.5 },
  ];
  let hit = _internal.pickRepresentative(items, ['巨无霸']);
  assert.equal(hit.item.name, '巨无霸');
  assert.equal(hit.exact, true);

  // 首选关键词缺货时，用次选关键词顶上并标注替代
  hit = _internal.pickRepresentative(items, ['安格斯', '巨无霸']);
  assert.equal(hit.substituted, true);
  assert.equal(hit.matchedKey, '巨无霸');
});

test('pickRepresentative 命中词被 exclude 排除时继续找下一个', () => {
  const items = [{ name: '中薯条', price: 11.5 }];
  const hit = _internal.pickRepresentative(items, ['巨无霸', '薯条'], /可乐/);
  assert.equal(hit.item.name, '中薯条');
});

test('guessDaypart 按小时划分供餐时段', () => {
  assert.equal(_internal.guessDaypart('2026-10-10 08:30'), '早餐');
  assert.equal(_internal.guessDaypart('2026-10-10 12:00'), '午餐');
  assert.equal(_internal.guessDaypart('2026-10-10 16:00'), '下午茶');
  assert.equal(_internal.guessDaypart('2026-10-10 21:00'), '晚餐/夜市');
  assert.equal(_internal.guessDaypart(''), '当前');
});
