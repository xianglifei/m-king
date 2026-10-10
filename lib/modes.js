'use strict';
/**
 * m-king · 六大麦门模式的真实调用链
 * ------------------------------------------------------------
 * 每个模式都是一条真实的麦当劳 MCP 调用链：
 *   拉数据 → 计算/对比 → 输出统一的「渲染规格」(blocks)
 * 前端只负责把 blocks 画出来，所有业务判断都发生在这一层。
 *
 * 统一返回：
 *   { id, title, subtitle, chain:[{tool, ok, ms}], costMs, blocks:[...], degraded:[...] }
 *
 * block 类型：
 *   hero  {title, big, unit, sub, tone}
 *   kpi   {items:[{label, value, unit, hint, tone}]}
 *   table {title, cols:[], rows:[[]], align:[]}
 *   bars  {title, items:[{label, value, display, tone}], max}
 *   list  {title, items:[{title, meta, tone}]}
 *   note  {tone, text}
 */

const { callTool, payload, tokenReady } = require('./mcp');

/* ============================================================
 * 通用工具
 * ========================================================== */

const cents2yuan = (c) => Number(c || 0) / 100;            // 算价接口：分 → 元
const menuYuan = (v) => Number(v || 0);                   // 菜单接口：本身就是元
const fmt = (n, d = 2) => Number(n || 0).toFixed(d);
const yuanText = (n) => '¥' + fmt(n);
const sum = (arr, f) => arr.reduce((a, b) => a + (f ? f(b) : b), 0);

/** 记录一次调用的耗时与成败，用于「数据链路」展示 */
function trace(list, res) {
  list.push({ tool: res.tool, ok: res.ok, ms: res.ms, error: res.error || null });
  return res;
}

/* ---------------- 短 TTL 结果缓存 ----------------
 * 连点几个门会反复拉同一批门店/菜单；这里缓存 query-nearby-stores /
 * query-meals 等只读结果 MCD_CACHE_TTL_MS（默认 45 秒），命中时调用链
 * 里会明确标注 (cache)。设 MCD_CACHE_TTL_MS=0 可完全关闭，恢复每次都打真实接口。 */
const CACHE_TTL_MS = Number(process.env.MCD_CACHE_TTL_MS === undefined ? 45000 : process.env.MCD_CACHE_TTL_MS);
const _cache = new Map();

/** 带缓存的 callTool：成功结果缓存一个短 TTL，chain 里如实标注命中情况 */
async function callToolCached(chain, name, args) {
  const key = name + '|' + JSON.stringify(args);
  const hit = _cache.get(key);
  if (CACHE_TTL_MS > 0 && hit && Date.now() - hit.ts < CACHE_TTL_MS) {
    chain.push({ tool: name + ' (cache)', ok: true, ms: 0, error: null });
    return hit.res;
  }
  const res = await callTool(name, args);
  trace(chain, res);
  if (res.ok) _cache.set(key, { ts: Date.now(), res });
  return res;
}

/** 解析营养数据（MCP 返回的是伪表格字符串） */
function parseNutrition(text) {
  if (!text || typeof text !== 'string') return [];
  const lines = text.split('\n');
  let cols = null;
  const out = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const head = line.match(/\{([^}]+)\}:/);
    if (head) { cols = head[1].split(',').map((s) => s.trim()); continue; }
    const parts = line.split(',').map((s) => s.trim());
    if (parts.length < 4) continue;
    const rec = { productName: parts[0] };
    (cols || ['productName', 'nutritionDescription', 'energyKj', 'energyKcal', 'protein', 'fat', 'carbohydrate', 'sodium', 'calcium'])
      .forEach((c, i) => { rec[c] = parts[i]; });
    rec.energyKcal = Number(rec.energyKcal) || 0;
    rec.energyKj = Number(rec.energyKj) || 0;
    if (rec.productName) out.push(rec);
  }
  return out;
}

/** 名称归一化，用于跨接口模糊匹配 */
function normName(s) {
  return String(s || '')
    .replace(/[【】\[\]（）()\s"'“”‘’·、,，。.\-—_/]/g, '')
    .replace(/汉堡|套餐|组合|小杯|中杯|大杯/g, '')
    .toLowerCase();
}

/** 双向包含匹配 */
function fuzzyFind(pool, name, key = 'productName') {
  const n = normName(name);
  if (!n) return null;
  let best = null;
  for (const it of pool) {
    const k = normName(it[key]);
    if (!k) continue;
    if (k === n) return it;
    if (k.includes(n) || n.includes(k)) {
      if (!best || Math.abs(k.length - n.length) < Math.abs(normName(best[key]).length - n.length)) best = it;
    }
  }
  return best;
}

/** 门店城市 / 搜索词（可在 mcp.config.json 或环境变量里覆盖） */
function cityConfig() {
  return {
    city: process.env.MCD_CITY || '北京',
    keyword: process.env.MCD_KEYWORD || '麦当劳',
  };
}

/** 解析门店：页面指定 > 收藏门店 > 按城市+关键词搜索 */
async function resolveStore(chain, opts = {}) {
  if (opts.storeCode) {
    return { storeCode: opts.storeCode, storeName: opts.storeName || '指定门店', _via: '页面指定', _count: 1 };
  }
  const cfg = cityConfig();
  let res = await callToolCached(chain, 'query-nearby-stores', { beType: 1, searchType: 1 });
  let list = payload(res);
  let via = '收藏门店';
  if (!Array.isArray(list) || !list.length) {
    res = await callToolCached(chain, 'query-nearby-stores', {
      beType: 1, searchType: 2, city: cfg.city, keyword: cfg.keyword,
    });
    list = payload(res);
    via = `城市搜索(${cfg.city})`;
  }
  if (!Array.isArray(list) || !list.length) throw new Error('未找到可点餐门店，请检查门店收藏或城市配置');
  return Object.assign({}, list[0], { _via: via, _count: list.length });
}

/** 拉门店菜单 */
async function fetchMenu(chain, storeCode, opts = {}) {
  const args = Object.assign({ beType: 1, orderType: 1, storeCode }, opts);
  const res = await callToolCached(chain, 'query-meals', args);
  const data = payload(res);
  const meals = (data && data.meals) || {};
  const items = Object.entries(meals).map(([code, v]) => ({
    code,
    name: v.name,
    price: menuYuan(v.currentPrice),
    orig: menuYuan(v.originalPrice),
    image: v.image,
  }));
  return { items, categories: (data && data.categories) || [], raw: data };
}

/* ============================================================
 * 模式 1 · 中国麦价指数 McIndex
 * 链路：now-time-info → query-nearby-stores → query-meals
 * ========================================================== */

const BASKET_SPEC = [
  {
    cat: '主食 · 汉堡',
    keys: ['巨无霸', '安格斯', '麦辣鸡腿汉堡', '麦辣鸡腿', '板烧鸡腿', '双层吉士', '麦香鸡', '猪柳蛋', '炒双蛋', '麦满分', '汉堡'],
    exclude: /薯条|可乐|雪碧|豆浆|牛奶|咖啡|橙汁|圆筒|新地|麦旋风|派|鸡块|鸡翅/,
  },
  {
    cat: '小食 · 薯条/鸡块',
    keys: ['中薯条', '大薯条', '小薯条', '薯条', '麦乐鸡', '鸡块', '鸡翅'],
    exclude: /堡|麦满分|汉堡|卷|套餐|可乐|雪碧|豆浆|牛奶|咖啡|橙汁|麦旋风|新地/,
  },
  {
    cat: '饮品 · 汽水/果汁',
    keys: ['中可乐', '中雪碧', '可乐', '雪碧', '橙汁', '柠檬茶', '豆浆', '牛奶'],
    exclude: /堡|麦满分|汉堡|薯条|麦乐鸡|鸡块|鸡翅|套餐/,
  },
];

/** 从菜单里挑「最具代表性」的单品：命中关键词里名字最短、价格最低的那个（避免选中套餐） */
function pickRepresentative(items, keys, exclude) {
  for (const key of keys) {
    let hits = items.filter((i) => i.name.includes(key));
    if (exclude) hits = hits.filter((i) => !exclude.test(i.name));
    const clean = hits.filter((i) => !/套餐|组合|三件套|两件套|四件套|派对|礼盒/.test(i.name));
    const use = clean.length ? clean : [];
    if (use.length) {
      use.sort((a, b) => (a.name.length - b.name.length) || (a.price - b.price));
      return { item: use[0], matchedKey: key, substituted: key !== keys[0], exact: key === keys[0] };
    }
  }
  return null;
}

async function modeMcIndex(opts = {}) {
  const chain = [];
  const t0 = Date.now();

  const timeRes = trace(chain, await callTool('now-time-info', {}));
  const now = payload(timeRes) || {};
  const nowText = now.formatted || String(now.datetime || '').replace('T', ' ').slice(0, 19) || '—';
  const store = await resolveStore(chain, opts);
  const menu = await fetchMenu(chain, store.storeCode);
  if (!menu.items.length) throw new Error('该门店当前未返回在售餐品');

  const basket = [];
  const missing = [];
  for (const spec of BASKET_SPEC) {
    const hit = pickRepresentative(menu.items, spec.keys, spec.exclude);
    if (hit) {
      basket.push({
        cat: spec.cat,
        name: hit.item.name,
        price: hit.item.price,
        orig: hit.item.orig,
        note: hit.exact ? '标准基准' : `替代（命中「${hit.matchedKey}」）`,
      });
    } else {
      missing.push(spec.cat);
    }
  }

  const basketTotal = sum(basket, (b) => b.price);
  const basketOrig = sum(basket, (b) => b.orig);
  const discounted = menu.items.filter((i) => i.orig > i.price);
  const discRate = menu.items.length ? (discounted.length / menu.items.length) * 100 : 0;
  const topPrice = [...menu.items].sort((a, b) => b.price - a.price).slice(0, 10);
  const topDisc = [...discounted].map((i) => ({ ...i, off: i.orig - i.price }))
    .sort((a, b) => b.off - a.off).slice(0, 8);

  const blocks = [
    {
      type: 'hero',
      title: basket.length === 3
        ? '本期麦价篮子（主食 + 小食 + 饮品的经典三件套）'
        : `本期麦价篮子（${basket.length}/3 品类，本时段部分品类停售）`,
      big: yuanText(basketTotal).replace('¥', ''),
      unit: '元 / 篮子',
      sub: basket.length
        ? `${basket.map((b) => b.name).join(' + ')} · ${store.storeName}`
        : '未能构成篮子',
      tone: 'gold',
    },
    {
      type: 'kpi',
      items: [
        { label: '基准门店', value: store.storeName.replace(/^麦当劳/, ''), hint: store.storeCode + ' · ' + store._via, tone: 'plain' },
        { label: '在售商品', value: menu.items.length, unit: '款', hint: now.time || now.datetime || '', tone: 'plain' },
        { label: '篮子原价', value: yuanText(basketOrig), hint: basketOrig > basketTotal ? `已折 ${yuanText(basketOrig - basketTotal)}` : '无折扣', tone: basketOrig > basketTotal ? 'ok' : 'plain' },
        { label: '折扣商品占比', value: fmt(discRate, 1), unit: '%', hint: `${discounted.length} / ${menu.items.length} 款在打折`, tone: discRate > 40 ? 'ok' : 'plain' },
      ],
    },
    {
      type: 'table',
      title: '篮子构成明细',
      cols: ['品类', '实际商品', '现价', '原价', '说明'],
      rows: basket.map((b) => [b.cat, b.name, yuanText(b.price), yuanText(b.orig), b.note]),
    },
    {
      type: 'bars',
      title: '单品价格 TOP 10（元）',
      items: topPrice.map((i) => ({ label: i.name, value: i.price, display: yuanText(i.price) })),
    },
    {
      type: 'bars',
      title: '折扣力度 TOP 8（省得最多，元）',
      items: topDisc.map((i) => ({
        label: i.name, value: i.off, display: `省 ${yuanText(i.off)}`,
        sub: `${yuanText(i.orig)} → ${yuanText(i.price)}`, tone: 'ok',
      })),
    },
    {
      type: 'note',
      tone: missing.length ? 'warn' : 'info',
      text: `取数时刻 ${nowText}（${now.timezone || 'GMT+08:00'}），门店「${store.storeName}」当前处在${guessDaypart(nowText)}时段。`
        + (missing.length ? `${missing.join('、')}在该时段无在售单品，已从篮子中剔除（不臆造价格）。` : '三个品类均有在售单品，篮子完整。')
        + '指数口径 = 主食 + 小食 + 饮品三件套的现价合计；替代项已在明细中逐条标注，便于与历史读数对齐。',
    },
  ];

  return {
    id: 'mci-index',
    title: '中国麦价指数 McIndex',
    subtitle: '用真实门店菜单，算出这一期的"麦价"读数',
    chain, costMs: Date.now() - t0, blocks,
    raw: { store: store.storeName, basketTotal, items: menu.items.length },
  };
}

function guessDaypart(dt) {
  const m = String(dt || '').match(/(\d{2}):(\d{2})/);
  if (!m) return '当前';
  const h = Number(m[1]);
  if (h < 10) return '早餐';
  if (h < 14) return '午餐';
  if (h < 17) return '下午茶';
  return '晚餐/夜市';
}

/* ============================================================
 * 模式 2 · 麦当劳年度账单
 * 链路：order-list → list-nutrition-foods
 * ========================================================== */

async function modeAnnualReport() {
  const chain = [];
  const t0 = Date.now();

  const ordRes = trace(chain, await callTool('order-list', {}));
  const nutRes = trace(chain, await callTool('list-nutrition-foods', {}));
  const orders = (payload(ordRes) || {}).list || [];
  const nutRaw = payload(nutRes);
  const nutText = typeof nutRaw === 'string' ? nutRaw : (nutRaw && (nutRaw._text || '')) || '';
  const nutrition = parseNutrition(nutText);

  const items = [];
  for (const o of orders) {
    for (const p of o.orderProductList || []) {
      items.push({
        name: p.productName, qty: Number(p.quantity) || 1, orderId: o.orderId,
        date: (o.createTime || '').slice(0, 10), amount: Number(o.realTotalAmount) || 0,
      });
      for (const sub of p.comboItemList || []) {
        if (sub.name || sub.productName) {
          items.push({ name: sub.name || sub.productName, qty: Number(sub.quantity) || 1, orderId: o.orderId, date: (o.createTime || '').slice(0, 10), amount: 0 });
        }
      }
    }
  }

  const total = sum(orders, (o) => Number(o.realTotalAmount) || 0);
  const stores = new Set(orders.map((o) => o.storeName));
  const dates = orders.map((o) => (o.createTime || '').slice(0, 10)).filter(Boolean).sort();

  // 月度分布
  const byMonth = {};
  for (const o of orders) {
    const m = (o.createTime || '').slice(0, 7);
    if (!m) continue;
    byMonth[m] = (byMonth[m] || 0) + (Number(o.realTotalAmount) || 0);
  }

  // 高频单品
  const freq = {};
  for (const it of items) freq[it.name] = (freq[it.name] || 0) + it.qty;
  const topItems = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 10);

  // 热量估算
  let kcalTotal = 0, matched = 0;
  const kcalDetail = [];
  for (const it of items) {
    const hit = nutrition.length ? fuzzyFind(nutrition, it.name) : null;
    if (hit && hit.energyKcal) {
      const k = hit.energyKcal * it.qty;
      kcalTotal += k; matched += it.qty;
      kcalDetail.push({ name: it.name, qty: it.qty, kcal: k });
    }
  }

  const avgOrder = orders.length ? total / orders.length : 0;
  const spanDays = dates.length >= 2
    ? Math.round((new Date(dates[dates.length - 1]) - new Date(dates[0])) / 86400000)
    : 0;

  const blocks = [
    {
      type: 'hero',
      title: '这一年，你在麦门的花销',
      big: fmt(total, 0),
      unit: '元',
      sub: `共 ${orders.length} 笔订单 · 覆盖 ${stores.size} 家餐厅 · 单均 ${yuanText(avgOrder)}`,
      tone: 'gold',
    },
    {
      type: 'kpi',
      items: [
        { label: '订单数', value: orders.length, unit: '笔', tone: 'plain' },
        { label: '涉及门店', value: stores.size, unit: '家', tone: 'plain' },
        { label: '客单价', value: yuanText(avgOrder), tone: 'plain' },
        { label: '时间跨度', value: spanDays, unit: '天', hint: dates.length ? `${dates[0]} → ${dates[dates.length - 1]}` : '', tone: 'plain' },
      ],
    },
    {
      type: 'bars',
      title: '月度消费分布（元）',
      items: Object.entries(byMonth).sort().map(([m, v]) => ({ label: m, value: v, display: yuanText(v) })),
    },
    {
      type: 'table',
      title: '订单明细',
      cols: ['日期', '餐厅', '商品', '实付'],
      rows: orders.map((o) => [
        (o.createTime || '').slice(0, 16),
        String(o.storeName || '').replace(/^麦当劳/, '').slice(0, 14),
        (o.orderProductList || []).map((p) => `${p.productName}×${p.quantity}`).join('、').slice(0, 40),
        yuanText(Number(o.realTotalAmount) || 0),
      ]),
    },
    {
      type: 'bars',
      title: '点得最多的单品',
      items: topItems.map(([n, c]) => ({ label: n, value: c, display: c + ' 份' })),
    },
    kcalTotal > 0
      ? {
        type: 'kpi',
        items: [
          { label: '估算摄入热量', value: Math.round(kcalTotal), unit: 'kcal', hint: `已匹配 ${matched} 件商品的营养数据`, tone: 'warn' },
          { label: '折算跑步', value: fmt(kcalTotal / 60, 1), unit: '公里', hint: '按 60 kcal/公里估算', tone: 'warn' },
          { label: '折算饭量', value: fmt(kcalTotal / 230, 1), unit: '碗米饭', hint: '按一碗 230 kcal 估算', tone: 'plain' },
          { label: '日均摄入', value: Math.round(kcalTotal / Math.max(spanDays, 1)), unit: 'kcal/天', tone: 'plain' },
        ],
      }
      : {
        type: 'note', tone: 'warn',
        text: '你的订单商品名没能匹配到营养库（可能是区域限定品或名称差异），所以本期只统计了金额，没有热量估算。',
      },
    {
      type: 'table',
      title: '热量构成（可匹配部分）',
      cols: ['商品', '份数', '热量'],
      rows: kcalDetail.sort((a, b) => b.kcal - a.kcal).slice(0, 12)
        .map((d) => [d.name, d.qty + ' 份', Math.round(d.kcal) + ' kcal']),
    },
    {
      type: 'note',
      tone: 'info',
      text: `账单只统计「到店/外送」订单，不含麦麦商城订单（商城要走 mall-order-list）。营养匹配基于官方餐品营养表共 ${nutrition.length} 条记录，做的是名称模糊匹配，热量为估算值而非精确值。`,
    },
  ];

  return {
    id: 'annual-report',
    title: '麦当劳年度账单',
    subtitle: '这一年你吃了多少麦，花了多少钱',
    chain, costMs: Date.now() - t0, blocks,
    raw: { orders: orders.length, total },
  };
}

/* ============================================================
 * 模式 3 · 积分理财师
 * 链路：query-my-account → mall-points-products → query-lottery-info
 * ========================================================== */

async function modePointsAdvisor() {
  const chain = [];
  const t0 = Date.now();

  const accRes = trace(chain, await callTool('query-my-account', {}));
  const mallRes = trace(chain, await callTool('mall-points-products', { catRuleIds: '1>4' }));
  const lotRes = trace(chain, await callTool('query-lottery-info', {}));

  const acc = payload(accRes) || {};
  const mall = payload(mallRes) || [];
  const lot = payload(lotRes) || {};

  const available = Number(acc.availablePoint) || 0;
  const expired = Number(acc.expiredPoint) || 0;
  const accumulative = Number(acc.accumulativePoint) || 0;
  const thisMonthExp = Number(acc.currentMouthExpirePoint) || 0;
  const nextMonthExp = Number(acc.nextMouthExpirePoint) || 0;

  // 商城券：从名称里抠出面值（如「18.8元2份麦辣鸡翅」）
  const products = (Array.isArray(mall) ? mall : []).map((p) => {
    const point = Number(p.point) || 0;
    const m = String(p.spuName || '').match(/(\d+(?:\.\d+)?)\s*元/);
    const face = m ? Number(m[1]) : 0;
    return {
      name: p.spuName, point, face, cat: p.catName, image: p.spuImage,
      valuePerPoint: point > 0 && face > 0 ? face / point : 0,
      affordable: point > 0 && point <= available,
    };
  }).filter((p) => p.point > 0);

  const ranked = products.filter((p) => p.valuePerPoint > 0)
    .sort((a, b) => b.valuePerPoint - a.valuePerPoint);
  const affordableRanked = ranked.filter((p) => p.affordable);

  const drawPoint = Number(lot.drawPoint) || 0;
  const draws = drawPoint > 0 ? Math.floor(available / drawPoint) : 0;

  const best = affordableRanked[0] || ranked[0] || null;
  const worst = ranked.length ? ranked[ranked.length - 1] : null;
  const spread = best && worst ? best.valuePerPoint / worst.valuePerPoint : 0;

  const blocks = [
    {
      type: 'hero',
      title: '可用积分',
      big: fmt(available, 1),
      unit: '分',
      sub: expired > 0
        ? `⚠ 历史累计 ${fmt(accumulative, 1)} 分，其中 ${fmt(expired, 1)} 分已过期作废（${fmt(accumulative ? expired / accumulative * 100 : 0, 1)}%）`
        : `历史累计 ${fmt(accumulative, 1)} 分，暂无过期损失`,
      tone: expired > 0 ? 'bad' : 'gold',
    },
    {
      type: 'kpi',
      items: [
        { label: '本月将过期', value: fmt(thisMonthExp, 1), unit: '分', tone: thisMonthExp > 0 ? 'bad' : 'ok' },
        { label: '下月将过期', value: fmt(nextMonthExp, 1), unit: '分', tone: nextMonthExp > 0 ? 'warn' : 'ok' },
        { label: '已过期损失', value: fmt(expired, 1), unit: '分', hint: '历史累计的' + fmt(accumulative ? expired / accumulative * 100 : 0, 0) + '%', tone: expired > 0 ? 'bad' : 'ok' },
        { label: '抽奖可抽', value: draws, unit: '次', hint: `${drawPoint} 分/次`, tone: 'plain' },
      ],
    },
    {
      type: 'table',
      title: '积分三种花法的对比',
      cols: ['用途', '单位成本', '可得价值', '换算', '建议'],
      rows: [
        best ? ['麦麦商城兑券', `${best.point} 分`, best.name, `¥${fmt(best.valuePerPoint, 4)}/分`, '✅ 优先'] : null,
        drawPoint > 0 ? ['积分抽奖', `${drawPoint} 分/次`, '奖品随机（券/权益卡/免费餐）', `期望值不固定`, draws > 0 ? '🎲 小赌怡情' : '积分不足'] : null,
        ['攒着不用', '0', '—', '到期自动清零', expired > 0 ? '❌ 已损失 ' + fmt(expired, 1) + ' 分' : '❌ 不推荐'],
      ].filter(Boolean),
    },
    {
      type: 'bars',
      title: '商城兑换性价比排行（每积分换到的现金价值，元/分 ×1000）',
      items: ranked.slice(0, 10).map((p) => ({
        label: `${p.name}（${p.point}分）`,
        value: p.valuePerPoint * 1000,
        display: '¥' + fmt(p.valuePerPoint, 4) + '/分' + (p.affordable ? '' : ' · 积分不足'),
        tone: p.affordable ? 'ok' : 'plain',
      })),
    },
    {
      type: 'list',
      title: `你现在就能兑的（可用 ${fmt(available, 1)} 分内）`,
      items: affordableRanked.slice(0, 8).map((p) => ({
        title: p.name,
        meta: `${p.point} 分 · 面值 ¥${fmt(p.face, 2)} · 性价比 ¥${fmt(p.valuePerPoint, 4)}/分 · ${p.cat || ''}`,
        tone: 'ok',
      })),
    },
    {
      type: 'note',
      tone: expired > 0 ? 'bad' : 'info',
      text: expired > 0
        ? `止损结论：你的积分有 ${fmt(expired, 1)} 分已经作废——相当于丢掉了约 ${yuanText(expired * (best ? best.valuePerPoint : 0.03))}（按当前最优兑换率折算）。以后建议在积分到期月主动兑换成券，券的有效期通常比积分长。`
        : `止损结论：当前没有即将过期的积分，但积分到期会清零，建议在到期月前把积分换成券（券的有效期更长）。`,
    },
    {
      type: 'note',
      tone: 'info',
      text: '性价比口径 = 券面值 ÷ 所需积分。面值从商品名中解析（如「18.8元2份麦辣鸡翅」取 18.8 元），这是估算而非官方定价；无面值信息的商品（如应援活动）不参与排行。抽奖期望值受概率影响无法静态计算，故不给具体数字。',
    },
  ];

  return {
    id: 'points-advisor',
    title: '积分理财师',
    subtitle: '积分到期预警 + 三种花法期望值比较',
    chain, costMs: Date.now() - t0, blocks,
    raw: { available, expired, products: products.length },
  };
}

/* ============================================================
 * 模式 4 · 三路比价器
 * 链路：query-nearby-stores ×2 → delivery-query-addresses
 *       → delivery-query-stores → query-meals ×N → calculate-price ×N
 * ========================================================== */

async function modeFulfillmentCompare() {
  const chain = [];
  const t0 = Date.now();
  const cfg = cityConfig();

  /* --- 三条路径的门店发现互相独立，并行执行；调用链仍按 A→B→C 固定顺序展示 --- */
  async function discoverPickup(log) {
    try {
      let r = await callToolCached(log, 'query-nearby-stores', { beType: 1, searchType: 1 });
      let list = payload(r);
      if (!Array.isArray(list) || !list.length) {
        r = await callToolCached(log, 'query-nearby-stores', { beType: 1, searchType: 2, city: cfg.city, keyword: cfg.keyword });
        list = payload(r);
      }
      if (Array.isArray(list) && list.length) {
        return { key: 'pickup', label: '到店自取', beType: 1, orderType: 1, storeCode: list[0].storeCode, beCode: undefined, storeName: list[0].storeName };
      }
    } catch (e) { /* 该路径不可用 */ }
    return null;
  }

  async function discoverDrivethru(log) {
    try {
      const r = await callToolCached(log, 'query-nearby-stores', { beType: 5, searchType: 2, city: cfg.city, keyword: cfg.keyword });
      const list = payload(r);
      if (Array.isArray(list) && list.length) {
        return { key: 'drivethru', label: '得来速车道', beType: 5, orderType: 1, storeCode: list[0].storeCode, beCode: list[0].beCode, storeName: list[0].storeName };
      }
    } catch (e) { /* 该路径不可用 */ }
    return null;
  }

  async function discoverDelivery(log) {
    try {
      const adr = await callToolCached(log, 'delivery-query-addresses', {});
      const addrs = (payload(adr) || {}).addresses || [];
      if (addrs.length) {
        const st = await callToolCached(log, 'delivery-query-stores', { addressId: addrs[0].addressId, beType: 2 });
        const list = payload(st);
        if (Array.isArray(list) && list.length) {
          return {
            key: 'delivery', label: '麦乐送', beType: 2, orderType: 2,
            storeCode: list[0].storeCode, beCode: list[0].beCode,
            storeName: list[0].storeName, address: addrs[0].fullAddress,
          };
        }
      }
    } catch (e) { /* 该路径不可用 */ }
    return null;
  }

  const discoverLogs = [[], [], []];
  const found = await Promise.all([discoverPickup(discoverLogs[0]), discoverDrivethru(discoverLogs[1]), discoverDelivery(discoverLogs[2])]);
  discoverLogs.forEach((l) => chain.push(...l));
  const paths = found.filter(Boolean);

  if (!paths.length) throw new Error('三条履约路径都没拿到可用门店');

  /* --- 每条路各自拉菜单（并行） --- */
  const menus = {};
  const menuLogs = paths.map(() => []);
  await Promise.all(paths.map(async (p, idx) => {
    const args = { beType: p.beType, orderType: p.orderType, storeCode: p.storeCode };
    if (p.beType !== 1) args.beCode = p.beCode;
    const res = await callToolCached(menuLogs[idx], 'query-meals', args);
    const meals = (payload(res) || {}).meals || {};
    menus[p.key] = Object.entries(meals).map(([code, v]) => ({
      code, name: v.name, price: menuYuan(v.currentPrice), orig: menuYuan(v.originalPrice),
    }));
  }));
  menuLogs.forEach((l) => chain.push(...l));

  /* --- 找各路径都在售的「同款」商品 --- */
  const availPaths = paths.filter((p) => menus[p.key] && menus[p.key].length);
  let commonCodes = null;
  for (const p of availPaths) {
    const set = new Set(menus[p.key].map((i) => i.code));
    commonCodes = commonCodes === null ? set : new Set([...commonCodes].filter((c) => set.has(c)));
  }
  commonCodes = commonCodes || new Set();

  const refPath = availPaths[0];
  let basket = refPath ? menus[refPath.key].filter((i) => commonCodes.has(i.code)) : [];
  // 同款里按「主食/小食/饮品/咖啡」各取一件，避免篮子全是咖啡这种失真
  if (basket.length > 4) {
    const CATS = [
      { re: /堡|卷|麦满分|汉堡/, keys: ['巨无霸', '板烧鸡腿', '麦辣鸡腿', '猪柳蛋', '麦香鸡', '双层吉士'] },
      { re: /薯条|麦乐鸡|鸡块|鸡翅|派/, keys: ['中薯条', '薯条', '麦乐鸡'] },
      { re: /可乐|雪碧|橙汁|豆浆|牛奶|柠檬茶/, keys: ['中可乐', '可乐', '橙汁', '豆浆'] },
      { re: /咖啡|拿铁|美式|卡布|摩卡/, keys: ['美式', '拿铁'] },
    ];
    const picked = [];
    const used = new Set();
    for (const c of CATS) {
      const cand = basket.filter((b) => c.re.test(b.name) && !used.has(b.code));
      if (!cand.length) continue;
      const best = cand.find((b) => c.keys.some((k) => b.name.includes(k))) || cand[0];
      used.add(best.code); picked.push(best);
      if (picked.length >= 4) break;
    }
    for (const b of [...basket].sort((a, b) => b.price - a.price)) {
      if (picked.length >= 4) break;
      if (!used.has(b.code)) { used.add(b.code); picked.push(b); }
    }
    basket = picked;
  }

  /* --- 逐路算价（并行；算价不走缓存，保证每次都是实时价） --- */
  const results = paths.map((p) => ({ ...p, ok: false }));
  const priceLogs = paths.map(() => []);
  await Promise.all(paths.map(async (p, idx) => {
    const items = basket.map((b) => ({ productCode: b.code, quantity: 1 }));
    const args = { beType: p.beType, orderType: p.orderType, storeCode: p.storeCode, items, needTableware: false };
    if (p.beType !== 1) args.beCode = p.beCode;
    const res = await callTool('calculate-price', args);
    trace(priceLogs[idx], res);
    const d = payload(res);
    if (!d) {
      results[idx] = { ...p, ok: false, error: res.data ? res.data.message : (res.error || '算价失败') };
      return;
    }
    results[idx] = {
      ...p, ok: true,
      product: cents2yuan(d.productPrice),
      delivery: cents2yuan(d.deliveryPrice),
      packing: cents2yuan(d.packingPrice),
      discount: cents2yuan(d.discount),
      payable: cents2yuan(d.price),
      original: cents2yuan(d.originalPrice),
    };
  }));
  priceLogs.forEach((l) => chain.push(...l));

  const okRes = results.filter((r) => r.ok).sort((a, b) => a.payable - b.payable);
  const cheapest = okRes[0];
  const dearest = okRes[okRes.length - 1];
  const gap = cheapest && dearest ? dearest.payable - cheapest.payable : 0;
  const basketDesc = basket.map((b) => `${b.name}×1`).join(' + ');

  const blocks = [
    {
      type: 'hero',
      title: '同款一单，哪条路最便宜',
      big: cheapest ? yuanText(cheapest.payable).replace('¥', '') : '—',
      unit: '元 实付',
      sub: cheapest
        ? `${cheapest.label} · 比最贵那条省 ${yuanText(gap)}（${fmt(dearest.payable ? gap / dearest.payable * 100 : 0, 1)}%）· 基准篮子：${basketDesc}`
        : '未能完成比价',
      tone: 'gold',
    },
    {
      type: 'table',
      title: '三路实付对比',
      cols: ['履约方式', '门店', '商品小计', '配送费', '打包费', '实付', '判定'],
      rows: results.map((r) => {
        if (!r.ok) return [r.label, r.storeName || '—', '—', '—', '—', '—', '不可用：' + r.error];
        return [
          r.label,
          String(r.storeName || '').replace(/^麦当劳/, '').slice(0, 16),
          yuanText(r.product),
          r.delivery > 0 ? yuanText(r.delivery) : '—',
          r.packing > 0 ? yuanText(r.packing) : '—',
          yuanText(r.payable),
          cheapest && r.payable === cheapest.payable ? '🏆 最省' : '+ ' + yuanText(r.payable - cheapest.payable),
        ];
      }),
    },
    {
      type: 'bars',
      title: '实付金额对比（元）',
      items: okRes.map((r, i) => ({
        label: r.label, value: r.payable, display: yuanText(r.payable),
        sub: i === 0 ? '最低' : '+ ' + yuanText(r.payable - okRes[0].payable),
        tone: i === 0 ? 'ok' : 'plain',
      })),
    },
    {
      type: 'note',
      tone: 'info',
      text: `对比口径：取各路径「同时有售」的同款商品各 1 份（本次为 ${basket.length} 件），用 calculate-price 逐路算价。到店/得来速不含配送费，麦乐送会加收配送费与打包服务费。注意：同款商品在到店与外送菜单上的标价本身就可能不同，这正是差价的主要来源。`,
    },
  ];

  if (results.some((r) => !r.ok)) {
    blocks.push({
      type: 'note', tone: 'warn',
      text: '不可用的路径：' + results.filter((r) => !r.ok).map((r) => `${r.label}（${r.error}）`).join('；') + '。得来速需要有支持车道取餐的门店，麦乐送需要有配送范围内的门店。',
    });
  }

  return {
    id: 'fulfillment-compare',
    title: '三路比价器',
    subtitle: '到店自取 / 得来速 / 麦乐送，同款一单差多少',
    chain, costMs: Date.now() - t0, blocks,
    raw: { paths: results.map((r) => ({ label: r.label, ok: r.ok, payable: r.payable })) },
  };
}

/* ============================================================
 * 模式 5 · 券生命周期管家
 * 链路：available-coupons → query-my-coupons
 * ========================================================== */

async function modeCouponLifecycle(opts = {}) {
  const chain = [];
  const t0 = Date.now();

  const availRes = trace(chain, await callTool('available-coupons', {}));
  const mineRes = trace(chain, await callTool('query-my-coupons', {}));
  const avail = payload(availRes) || [];
  const mine = (payload(mineRes) || {}).coupons || [];

  // 拉菜单：用来把「用券价」和菜单原价比，算出每张券真实值多少钱
  let menuItems = [];
  let storeName = '';
  try {
    const store = await resolveStore(chain, opts);
    storeName = store.storeName;
    const menu = await fetchMenu(chain, store.storeCode);
    menuItems = menu.items;
  } catch (e) { /* 菜单拿不到时降级：只做临期统计 */ }

  const toClaim = (Array.isArray(avail) ? avail : []).filter((c) => c.couponStatus !== 'HAVING_RECEIVE');
  const claimed = (Array.isArray(avail) ? avail : []).filter((c) => c.couponStatus === 'HAVING_RECEIVE');

  const today = new Date();
  const enriched = mine.map((c) => {
    const end = c.tradeEndDateTime || (c.tradeEndDate ? c.tradeEndDate + ' 23:59:59' : '');
    let days = null;
    if (end) days = Math.ceil((new Date(end.replace(/-/g, '/')) - today) / 86400000);

    // 解析券的优惠
    const di = c.discountInfo || {};
    const dv = Number(di.discountValue) || 0;
    const desc = String(di.discountDesc || '');
    const isPrice = /价/.test(desc);                 // 「用券价格」→ 券后价
    const isCut = /减|省|折/.test(desc) && !isPrice; // 「立减 X 元」

    // 只保留券名核心词，便于匹配菜单
    const coreName = String(c.title || '')
      .replace(/套餐|两件套|三件套|四件套|组合|早餐|超值|单人|双人|指定/g, '')
      .trim();
    const hit = menuItems.length ? (fuzzyFind(menuItems, c.title, 'name') || fuzzyFind(menuItems, coreName, 'name')) : null;

    let saving = null, menuPrice = null, couponPrice = null;
    if (isPrice && dv > 0) {
      couponPrice = dv;
      if (hit) { menuPrice = hit.price; saving = menuPrice - couponPrice; }
    } else if (isCut && dv > 0) {
      saving = dv;
      if (hit) { menuPrice = hit.price; couponPrice = menuPrice - dv; }
    }

    return {
      title: c.title, code: c.code, id: c.id,
      start: c.tradeStartDate, end: c.tradeEndDate, endDateTime: end,
      discountText: desc ? desc + ' ¥' + dv : '',
      menuPrice, couponPrice, saving,
      matchedItem: hit ? hit.name : null,
      days,
      scope: [].concat(c.beTypes || c.beType || []).join('/') || '通用',
      status: days === null ? '未知' : (days < 0 ? '已过期' : (days <= 1 ? '今明到期' : (days <= 7 ? '临期' : '充裕'))),
    };
  }).sort((a, b) => (a.days === null ? 999 : a.days) - (b.days === null ? 999 : b.days));

  const expSoon = enriched.filter((e) => e.days !== null && e.days >= 0 && e.days <= 7);
  const expiredCnt = enriched.filter((e) => e.days !== null && e.days < 0).length;
  const pendingValue = sum(enriched.filter((e) => e.saving > 0), (e) => e.saving);

  // 同名券（不同到期日的独立券）归并成一行，避免表格里重复出现
  const groupMap = new Map();
  for (const e of enriched.filter((x) => x.saving !== null)) {
    const key = [e.title, e.matchedItem || '', e.menuPrice, e.couponPrice, e.saving].join('|');
    if (!groupMap.has(key)) {
      groupMap.set(key, { ...e, count: 0, minDays: e.days });
    }
    const g = groupMap.get(key);
    g.count += 1;
    if (e.days !== null && (g.minDays === null || e.days < g.minDays)) g.minDays = e.days;
  }
  const valued = [...groupMap.values()].sort((a, b) => (b.saving || 0) - (a.saving || 0));
  const matchRate = enriched.length ? (valued.reduce((a, b) => a + b.count, 0) / enriched.length) * 100 : 0;

  const blocks = [
    {
      type: 'hero',
      title: '券包里还没用掉的优惠，折算现金价值',
      big: yuanText(pendingValue).replace('¥', ''),
      unit: '元',
      sub: `${enriched.length} 张券 · ${valued.length} 类券已与菜单价对上（覆盖 ${valued.reduce((a, b) => a + b.count, 0)} 张，匹配率 ${fmt(matchRate, 0)}%）· ${expSoon.length} 张 7 天内到期`,
      tone: expSoon.length ? 'warn' : 'gold',
    },
    {
      type: 'kpi',
      items: [
        { label: '券包券数', value: enriched.length, unit: '张', tone: 'plain' },
        { label: '可领未领', value: toClaim.length, unit: '张', hint: toClaim.length ? '建议一键领取' : '都领完了', tone: toClaim.length ? 'warn' : 'ok' },
        { label: '7 天内到期', value: expSoon.length, unit: '张', tone: expSoon.length ? 'bad' : 'ok' },
        { label: '已过期', value: expiredCnt, unit: '张', tone: expiredCnt ? 'bad' : 'ok' },
      ],
    },
    valued.length
      ? {
        type: 'table',
        title: '这张券值多少钱（用券价 vs 菜单原价）',
        cols: ['券名', '张数', '对应餐品', '菜单价', '用券价', '立省', '最近到期'],
        rows: valued.map((e) => [
          e.title,
          e.count + ' 张',
          e.matchedItem ? e.matchedItem.slice(0, 20) : '未匹配到同款',
          e.menuPrice !== null ? yuanText(e.menuPrice) : '—',
          e.couponPrice !== null ? yuanText(e.couponPrice) : '—',
          e.saving > 0 ? '省 ' + yuanText(e.saving) + '/张'
            : (e.saving === null ? '未匹配到同款' : '券后价 ≥ 菜单价（品类可能不同）'),
          e.minDays === null ? '—' : (e.minDays <= 0 ? '今天最后一天' : e.minDays + ' 天'),
        ]),
      }
      : {
        type: 'note', tone: 'warn',
        text: '你的券里没有可解析的「优惠金额/券后价」字段，所以这次只做了临期统计，没有折算现金价值。',
      },
    {
      type: 'table',
      title: '临期券预警（7 天内到期，按紧急度排序）',
      cols: ['券名', '可用时间', '剩余', '优惠', '状态'],
      rows: (expSoon.length ? expSoon : enriched.slice(0, 8)).map((e) => [
        e.title,
        `${e.start || '—'} ~ ${e.end || '—'}`,
        e.days === null ? '—' : (e.days <= 0 ? '今天最后一天' : e.days + ' 天'),
        e.discountText || '—',
        e.days <= 1 ? '🔴 ' + e.status : (e.days <= 7 ? '🟠 ' + e.status : '🟢 ' + e.status),
      ]),
    },
    {
      type: 'list',
      title: `可领取但还没领的券（${toClaim.length} 张）`,
      items: toClaim.slice(0, 12).map((c) => ({
        title: c.couponName || '(未命名券)',
        meta: [c.label, c.couponStatus].filter(Boolean).join(' · ') || '可领取',
        tone: 'warn',
      })),
    },
    valued.length
      ? {
        type: 'bars',
        title: '最该优先用掉的券（按立省金额，元/张）',
        items: valued.filter((e) => e.saving > 0).slice(0, 10).map((e) => ({
          label: e.title,
          value: e.saving,
          display: '省 ' + yuanText(e.saving) + '/张 × ' + e.count,
          sub: e.minDays <= 0 ? '今天到期' : `最近到期剩 ${e.minDays} 天`,
          tone: 'ok',
        })),
      }
      : null,
    {
      type: 'note',
      tone: toClaim.length ? 'warn' : 'info',
      text: toClaim.length
        ? `你现在有 ${toClaim.length} 张券可以领但还没领。券是有「领取窗口」的，过窗口不领就没了——建议现在就用一键领券（auto-bind-coupons）全领掉。`
        : '当前没有可领未领的券，说明你领得挺勤快。',
    },
    {
      type: 'note',
      tone: 'info',
      text: `券价值口径 = 门店菜单标价 − 券商「用券价」，再用券名与${storeName ? '「' + storeName + '」' : ''}菜单做名称匹配。匹配不上的（如限定品、跨门店券）标为「未匹配」，不做臆测。`
        + '临期天数按券的 tradeEndDateTime 与当前时间计算；部分券限定时段（如早餐 05:00–10:29），不在时段内无法使用。',
    },
  ].filter(Boolean);

  return {
    id: 'coupon-lifecycle',
    title: '券生命周期管家',
    subtitle: '临期预警 + 券值多少钱 + 待领清点',
    chain, costMs: Date.now() - t0, blocks,
    raw: { mine: enriched.length, toClaim: toClaim.length, expSoon: expSoon.length, pendingValue },
  };
}

/* ============================================================
 * 模式 6 · 热量预算教练
 * 链路：list-nutrition-foods → query-meals
 * ========================================================== */

async function modeCalorieCoach(opts = {}) {
  const chain = [];
  const t0 = Date.now();
  const budget = Number(opts.budget) > 0 ? Number(opts.budget) : 600;
  const priceCap = Number(opts.priceCap) > 0 ? Number(opts.priceCap) : 45;

  // 供餐时段以麦当劳服务器时间为准（北京时间），不用本机时区判断
  const timeRes = trace(chain, await callTool('now-time-info', {}));
  const now = payload(timeRes) || {};
  const nowText = now.formatted || String(now.datetime || '').replace('T', ' ').slice(0, 19) || '—';

  const nutRes = trace(chain, await callTool('list-nutrition-foods', {}));
  const nutRaw = payload(nutRes);
  const nutrition = parseNutrition(typeof nutRaw === 'string' ? nutRaw : (nutRaw && nutRaw._text) || '');

  const store = await resolveStore(chain, opts);
  const menu = await fetchMenu(chain, store.storeCode);

  // 把菜单商品与营养库对上
  const pool = [];
  for (const it of menu.items) {
    const hit = fuzzyFind(nutrition, it.name);
    if (hit && hit.energyKcal > 0) {
      pool.push({ code: it.code, name: it.name, price: it.price, kcal: hit.energyKcal, protein: Number(hit.protein) || 0 });
    }
  }
  if (!pool.length) throw new Error('当前门店在售餐品没有匹配到营养数据，稍后再试（不同供餐时段菜单不同）');

  // 组合搜索：穷举 1~3 件互不相同的餐品（同一餐品不会重复出现在一个组合里）
  const MAIN_RE = /堡|卷|麦满分|汉堡|鸡块|薯条|饭|鸡翅|鸡腿|派|豆浆|粥/;
  const combos = [];
  const n = pool.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      for (let k = j + 1; k < n; k++) {
        pushCombo([pool[i], pool[j], pool[k]]);
      }
      pushCombo([pool[i], pool[j]]);
    }
    pushCombo([pool[i]]);
  }
  function pushCombo(list) {
    if (!list.some((x) => MAIN_RE.test(x.name))) return; // 排除「一杯咖啡」这种凑数解
    const kcal = sum(list, (x) => x.kcal);
    const price = sum(list, (x) => x.price);
    if (kcal <= budget && price <= priceCap && kcal >= 50) {
      combos.push({
        items: list.map((x) => x.name), kcal, price,
        protein: sum(list, (x) => x.protein),
        utilization: kcal / budget,
      });
    }
  }

  const byKcalDesc = [...combos].sort((a, b) => b.kcal - a.kcal);
  const fullest = byKcalDesc[0];
  const lightest = [...combos].sort((a, b) => a.kcal - b.kcal)[0];
  const cheapest = [...combos].sort((a, b) => (a.price / Math.max(a.kcal, 1)) - (b.price / Math.max(b.kcal, 1)))[0];

  const uniq = (arr) => {
    const seen = new Set();
    return arr.filter((x) => x && !seen.has(x.kcal + '|' + x.price) && seen.add(x.kcal + '|' + x.price));
  };
  const options = uniq([fullest, lightest, cheapest]).filter(Boolean);

  const blocks = [
    {
      type: 'hero',
      title: '在 ' + budget + ' kcal 预算内，本店能怎么吃',
      big: fullest ? String(Math.round(fullest.kcal)) : '—',
      unit: 'kcal 推荐组合',
      sub: fullest ? `${fullest.items.join(' + ')} · ${yuanText(fullest.price)} · 预算利用 ${fmt(fullest.utilization * 100, 0)}%` : '没找到可行组合',
      tone: 'ok',
    },
    {
      type: 'kpi',
      items: [
        { label: '热量预算', value: budget, unit: 'kcal', tone: 'plain' },
        { label: '匹配餐品', value: pool.length, unit: '款', hint: '来自本店在售菜单', tone: 'plain' },
        { label: '可行组合', value: combos.length, unit: '种', hint: `价格上限 ¥${priceCap}`, tone: 'plain' },
        { label: '推荐组合价格', value: fullest ? yuanText(fullest.price) : '—', tone: 'ok' },
      ],
    },
    {
      type: 'table',
      title: '三套方案：用满预算 / 最轻负担 / 最划算',
      cols: ['方案', '组合', '热量', '蛋白质', '价格', '折算跑步'],
      rows: [
        fullest && ['🏆 用满预算', fullest.items.join(' + '), Math.round(fullest.kcal) + ' kcal', fmt(fullest.protein, 1) + ' g', yuanText(fullest.price), fmt(fullest.kcal / 60, 1) + ' km'],
        lightest && ['🪶 最轻负担', lightest.items.join(' + '), Math.round(lightest.kcal) + ' kcal', fmt(lightest.protein, 1) + ' g', yuanText(lightest.price), fmt(lightest.kcal / 60, 1) + ' km'],
        cheapest && ['💰 每卡最省', cheapest.items.join(' + '), Math.round(cheapest.kcal) + ' kcal', fmt(cheapest.protein, 1) + ' g', yuanText(cheapest.price), fmt(cheapest.kcal / 60, 1) + ' km'],
      ].filter(Boolean),
    },
    {
      type: 'bars',
      title: '本店餐品热量排行（kcal，只列已匹配营养数据的）',
      items: [...pool].sort((a, b) => b.kcal - a.kcal).slice(0, 12)
        .map((p) => ({ label: p.name, value: p.kcal, display: Math.round(p.kcal) + ' kcal', sub: yuanText(p.price) })),
    },
    {
      type: 'table',
      title: '该躲开的（热量最猛的几款）',
      cols: ['餐品', '热量', '价格', '折合跑步'],
      rows: [...pool].sort((a, b) => b.kcal - a.kcal).slice(0, 5)
        .map((p) => [p.name, Math.round(p.kcal) + ' kcal', yuanText(p.price), fmt(p.kcal / 60, 1) + ' km']),
    },
    {
      type: 'note',
      tone: 'info',
      text: `热量取自官方营养表，跑步换算按 60 kcal/公里（约 60kg 体重慢跑）估算，个体差异较大仅供参考。组合是从本店在售餐品里穷举 1~3 件的全部可行解得出，非推荐算法拟合。当前时段为${guessDaypart(nowText)}，菜单随供餐时段变化。`,
    },
  ];

  return {
    id: 'calorie-coach',
    title: '热量预算教练',
    subtitle: `预算 ${budget} kcal 内，本店能怎么点`,
    chain, costMs: Date.now() - t0, blocks,
    raw: { budget, pool: pool.length, combos: combos.length },
  };
}

/* ============================================================
 * 模式注册表
 * ========================================================== */

const MODES = {
  'mci-index': { meta: { name: '中国麦价指数', desc: '巨无霸篮子价格读数' }, run: (o) => modeMcIndex(o) },
  'annual-report': { meta: { name: '麦当劳年度账单', desc: '这一年吃了多少麦' }, run: () => modeAnnualReport() },
  'points-advisor': { meta: { name: '积分理财师', desc: '积分怎么花最值' }, run: () => modePointsAdvisor() },
  'fulfillment-compare': { meta: { name: '三路比价器', desc: '到店/得来速/麦乐送比价' }, run: () => modeFulfillmentCompare() },
  'coupon-lifecycle': { meta: { name: '券生命周期管家', desc: '临期券预警与待领清点' }, run: (o) => modeCouponLifecycle(o) },
  'calorie-coach': { meta: { name: '热量预算教练', desc: '预算内最优组合' }, run: (o) => modeCalorieCoach(o) },
};

/* ============================================================
 * 首页看板聚合
 * ========================================================== */

async function dashboard() {
  const t0 = Date.now();
  const [accRes, couponRes, campRes, storeRes, timeRes] = await Promise.all([
    callTool('query-my-account', {}),
    callTool('query-my-coupons', {}),
    callTool('campaign-calendar', {}),
    callTool('query-nearby-stores', { beType: 1, searchType: 1 }),
    callTool('now-time-info', {}),
  ]);

  const acc = payload(accRes) || {};
  const coupons = ((payload(couponRes) || {}).coupons) || [];
  const camp = payload(campRes) || {};
  let stores = payload(storeRes);
  if (!Array.isArray(stores) || !stores.length) {
    const r2 = await callTool('query-nearby-stores', { beType: 1, searchType: 2, ...cityConfig() });
    stores = payload(r2) || [];
  }
  const now = payload(timeRes) || {};

  // 今日活动
  const todayKey = String(now.datetime || now.time || '').slice(0, 10);
  const day = (camp.dailyList || []).find((d) => d.date === todayKey);
  const events = ((day && day.events) || []).map((e) => {
    const a = e.articleDto || {};
    return {
      title: a.title || e.activityTitle || '(未命名活动)',
      highlight: a.highlights || '',
      action: a.buttonText || (e.button && e.button.text) || '',
      price: Number(e.price) > 0 ? '¥' + e.price + (e.priceSuffix || '') : '',
    };
  }).filter((e) => e.title !== '(未命名活动)' || e.highlight);

  // 券的临期统计
  const today = new Date();
  const soon = coupons.filter((c) => {
    const end = c.tradeEndDateTime || (c.tradeEndDate ? c.tradeEndDate + ' 23:59:59' : '');
    if (!end) return false;
    const d = Math.ceil((new Date(end.replace(/-/g, '/')) - today) / 86400000);
    return d >= 0 && d <= 3;
  }).length;

  return {
    ok: true,
    ms: Date.now() - t0,
    time: now.datetime || now.time || new Date().toISOString(),
    account: {
      available: Number(acc.availablePoint) || 0,
      accumulative: Number(acc.accumulativePoint) || 0,
      expired: Number(acc.expiredPoint) || 0,
      thisMonth: Number(acc.currentMouthExpirePoint) || 0,
      nextMonth: Number(acc.nextMouthExpirePoint) || 0,
    },
    coupons: { total: coupons.length, soon },
    store: stores && stores[0] ? { name: stores[0].storeName, code: stores[0].storeCode, count: stores.length } : null,
    stores: Array.isArray(stores) ? stores.slice(0, 10).map((s) => ({ name: s.storeName, code: s.storeCode })) : [],
    events,
    tokenSource: require('./mcp').tokenSource(),
  };
}

module.exports = {
  MODES, dashboard,
  // 供测试
  _internal: { parseNutrition, normName, fuzzyFind, pickRepresentative, guessDaypart, BASKET_SPEC },
};
