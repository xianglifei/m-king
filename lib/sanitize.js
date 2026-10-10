'use strict';
/**
 * m-king · 演示快照脱敏
 * ------------------------------------------------------------
 * 静态 Demo（demo/index.html）会把一次真实调用链的结果烘焙进页面并公开，
 * 这里在烘焙前抹掉可定位到个人的信息：
 *   1. 门店名称 → 「北京·示例门店A/B/C…」
 *      （常去门店≈常驻位置，是快照里最强的定位信号）
 *   2. 年度账单里的「年-月-日 时:分」→ 「年-月-**」
 *      （打码到月份，保留消费故事的形状，抹掉行为时间线）
 *
 * 积分、金额、餐品价格等数字保留——它们是演示的故事线，不构成定位。
 *
 * 用法：sanitizeSnapshot(snap) 返回脱敏后的深拷贝，不修改原对象。
 */

/* 门店名特征：CJK 开头 + 至少 3 个字符 + 「餐厅」结尾。
 * 「全国餐厅」「X家餐厅」这类短语不足 3 字，不会被误伤。 */
const STORE_RE = /[\u4e00-\u9fa5][\u4e00-\u9fa5A-Za-z0-9()（）·/-]{2,26}餐厅/g;

/* 订单时间戳：2026-05-03 或 2026-05-03 18:38（含全角/半角冒号场景均按半角处理） */
const DATE_RE = /\b(20\d{2})-(\d{2})-\d{2}( \d{2}:\d{2})?\b/g;

/** 深度遍历对象里所有字符串（只读） */
function walk(obj, fn) {
  if (obj == null) return;
  if (typeof obj === 'string') return fn(obj);
  if (Array.isArray(obj)) { for (const v of obj) walk(v, fn); return; }
  if (typeof obj === 'object') { for (const v of Object.values(obj)) walk(v, fn); }
}

/** 深度遍历并原地替换所有字符串 */
function walkReplace(obj, fn) {
  if (obj == null || typeof obj === 'string') return;
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      if (typeof obj[i] === 'string') obj[i] = fn(obj[i]); else walkReplace(obj[i], fn);
    }
    return;
  }
  if (typeof obj === 'object') {
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      if (typeof v === 'string') obj[k] = fn(v); else walkReplace(v, fn);
    }
  }
}

/** 先收集快照里出现过的全部真实门店名（归一到去掉「麦当劳」前缀），再按「长的先替换」避免子串误替换 */
function sanitizeSnapshot(snap) {
  const found = new Set();
  walk(snap, (s) => {
    let m;
    STORE_RE.lastIndex = 0;
    while ((m = STORE_RE.exec(s))) found.add(m[0].replace(/^麦当劳/, ''));
  });
  const names = [...found].sort((a, b) => b.length - a.length);
  const map = new Map(names.map((n, i) => [n, '北京·示例门店' + String.fromCharCode(65 + i)]));

  const clone = JSON.parse(JSON.stringify(snap));
  const swapStores = (s) => {
    let out = s;
    for (const [n, code] of map) {
      // 「麦当劳+店名」与「店名」两种写法指向同一个代号，避免同一门店被拆成两家
      out = out.split('麦当劳' + n).join(code).split(n).join(code);
    }
    return out;
  };
  const maskDates = (s) => s.replace(DATE_RE, '$1-$2-**');

  walkReplace(clone, swapStores);
  // 订单时间只存在于年度账单子树里；取数时刻/券有效期不属于个人行为，保留原样
  if (clone.modes && clone.modes['annual-report']) {
    walkReplace(clone.modes['annual-report'], maskDates);
  }
  return clone;
}

module.exports = { sanitizeSnapshot, _internal: { STORE_RE, DATE_RE } };
