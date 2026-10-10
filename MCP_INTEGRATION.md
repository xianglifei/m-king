# MCP 集成说明

本文说明 m-king 实际使用的麦当劳 MCP Server、Tool、调用流程，以及每个调用链对应的业务价值。

---

## 1. MCP Server

| 项 | 值 |
|---|---|
| Server 名称 | `mcd-mcp`（麦当劳中国 MCP Server） |
| 传输方式 | Streamable HTTP（JSON-RPC 2.0 over HTTPS） |
| 端点 | `https://mcp.mcd.cn` |
| 鉴权 | `Authorization: Bearer <MCD_MCP_TOKEN>` |
| 申请入口 | <https://open.mcd.cn/mcp> → 手机号验证 → 控制台 → 激活 |
| 工具总数 | **35 个**（`tools/list` 实测） |
| 协议版本 | `2025-03-26`（`initialize` 协商结果） |
| Server 版本 | `mcd-mcp 1.0.0` |

### 客户端实现

m-king 自带一个零依赖的 MCP 客户端（[`lib/mcp.js`](../lib/mcp.js)），只用 Node 18+ 内置的 `fetch`：

```js
POST https://mcp.mcd.cn
Content-Type: application/json
Accept: application/json, text/event-stream
Authorization: Bearer <token>

{"jsonrpc":"2.0","id":1,"method":"tools/call",
 "params":{"name":"query-meals","arguments":{"beType":1,"orderType":1,"storeCode":"1950592"}}}
```

响应兼容两种形态：纯 `application/json` 与 `text/event-stream`（SSE）。业务数据优先从 `result.structuredContent` 取，缺失时回退解析 `result.content[0].text` 中 `## Original Response` 段的 JSON。

**Token 三级回退**（越靠前优先级越高，Token 永不落盘、永不出现在返回体）：

1. 环境变量 `MCD_MCP_TOKEN`
2. WorkBuddy 连接器配置 `~/.workbuddy/mcp.json` → `mcpServers["mcd-mcp"].headers.Authorization`
3. 项目内 `mcp.config.json`（已在 `.gitignore` 中）

---

## 2. 实际调用的 Tool

### 2.1 汇总

| Tool | 调用位置 | 关键入参 | 用途 |
|---|---|---|---|
| `now-time-info` | 麦价指数 / 看板 | — | 取服务器时间，决定供餐时段、活动日期、券的临期天数 |
| `query-nearby-stores` | 麦价指数 / 比价器 / 券管家 / 热量教练 / 看板 | `beType`(1到店/5得来速), `searchType`(1收藏/2城市搜索), `city`, `keyword` | 拿到 `storeCode`（到店）/ `beCode`（得来速） |
| `delivery-query-addresses` | 比价器 | — | 取历史配送地址，拿到 `addressId` |
| `delivery-query-stores` | 比价器 | `addressId`, `beType=2` | 拿到外送门店的 `storeCode` + `beCode` |
| `query-meals` | 麦价指数 / 比价器 / 券管家 / 热量教练 | `storeCode`, `beType`, `orderType`, `beCode`(仅非到店自取) | 取门店在售菜单（商品名、现价、原价） |
| `calculate-price` | 比价器 | `storeCode`, `beType`, `orderType`, `beCode`, `items[]` | 真实试算：商品小计 / 配送费 / 打包费 / 实付 |
| `order-list` | 年度账单 | — | 历史订单（商品、门店、时间、实付金额） |
| `list-nutrition-foods` | 年度账单 / 热量教练 | — | 官方营养表（160 条）：能量、蛋白质、脂肪、碳水、钠、钙 |
| `query-my-account` | 积分理财师 / 看板 | — | 积分账户：可用 / 累计 / 已过期 / 本月下月将过期 |
| `mall-points-products` | 积分理财师 | `catRuleIds="1>4"`（商品券分类） | 积分可兑换的券列表（含所需积分与券名面值） |
| `query-lottery-info` | 积分理财师 | — | 积分抽奖活动：单次消耗积分、奖品池 |
| `available-coupons` | 券管家 / 看板 | — | 当前可领取的券 |
| `query-my-coupons` | 券管家 / 看板 | — | 券包：券名、用券价（`discountInfo`）、可用起止时间 |
| `campaign-calendar` | 首页看板 | — | 当月营销活动日历（含当日活动标题与内容） |

> **只读原则**：m-king 只调用上表中的**查询/算价类** Tool。以下写入类能力**一律不调用**：`create-order`、`cancel-order`、`auto-bind-coupons`、`draw-lottery`、`mall-create-order`、`party-order-create`、`delivery-create-address`。涉及领取或下单，只在结论中给出文字建议。

### 2.2 容易踩的参数坑（已在代码中处理）

麦当劳 MCP 的点餐参数在**四种履约方式**下规则不同，这是很多参赛项目会踩的地方：

| 履约方式 | `beType` | `orderType` | `beCode` | 说明 |
|---|:--:|:--:|---|---|
| 到店自取 | 1 | 1 | **不传** | 传了会报错 |
| 得来速 | 5 | 1 | **必传** | 从 `query-nearby-stores(beType=5)` 取 |
| 麦乐送 | 2 | 2 | **必传** | 从 `delivery-query-stores` 取 |
| 企业团餐 | 6 | 2 | **必传** + `gmServiceCode` | 需先查助餐服务 |

其他实测注意点：

- `query-nearby-stores` 的 `searchType=1`（收藏门店）在收藏为空时返回 `600050`，需回退到 `searchType=2` + `city` + `keyword`。
- 外送菜单与到店菜单**商品集合不同、同款标价也可能不同**（实测同款商品 ¥21.50 vs ¥23.50）。比价时必须先求交集。
- `calculate-price` 金额单位是**分**，`query-meals` 的 `currentPrice` 单位是**元**（字符串）。代码中分别用 `cents2yuan()` / `menuYuan()` 处理。
- `list-nutrition-foods` 返回的是伪表格文本（形如 `[160]{productName,energyKj,...}:\n  猪柳麦满分,null,1288,308,...`），需按表头解析，见 `parseNutrition()`。
- `mall-points-products` 默认分类返回的是现金商品；要取积分兑换券需显式传 `catRuleIds="1>4"`。

---

## 3. 调用流程

### 模式 1 · 中国麦价指数 McIndex

```
now-time-info ─────────────► 取服务器时间（判供餐时段）
      │
query-nearby-stores ───────► beType=1, searchType=1（收藏门店）
      │                        └─ 空 → searchType=2 + city + keyword
      ▼
query-meals ───────────────► storeCode + beType=1 + orderType=1
      │
      ▼
本地计算 ──────────────────► 按品类挑代表性单品 → 篮子现价合计
                              + 折扣商品占比 + 价格榜 + 折扣榜
```

**业务价值**：把"麦当劳现在到底多贵"变成一个可复现的读数。口径固定（主食+小食+饮品），可以按期对比。早餐时段缺小食时**明确标注剔除**而非硬凑，保证读数可比。

### 模式 2 · 麦当劳年度账单

```
order-list ─────────────────► 历史订单（含商品明细、金额、门店、时间）
      │
list-nutrition-foods ──────► 官方营养表（160 条）
      │
      ▼
本地计算 ──────────────────► 订单数 / 总消费 / 客单价 / 覆盖门店 / 时间跨度
                              + 月度分布 + 高频单品
                              + 名称模糊匹配 → 热量估算 → 跑步公里数
```

**业务价值**：把冷冰冰的订单流水，翻译成一份**可分享的自我认知**（"这一年我在麦门花了 53 元、摄入约 1345 kcal"）。这是纯传播向的能力——年度账单天然适合截图发朋友圈。

### 模式 3 · 积分理财师

```
query-my-account ──────────► 可用 / 累计 / 已过期 / 本月下月将过期
      │
mall-points-products ──────► catRuleIds="1>4"（积分兑换券）
      │
query-lottery-info ────────► 抽奖单次消耗积分、奖品池
      │
      ▼
本地计算 ──────────────────► 从券名解析面值（"18.8元…" → 18.8）
                              → 每积分价值 = 面值 ÷ 所需积分
                              → 排序 + 过滤「当前积分能兑的」
                              → 过期积分的机会成本折算
```

**业务价值**：这是**痛点最真实**的一个模式。麦当劳积分到期会清零，而绝大多数用户根本不知道自己的积分正在无声蒸发。m-king 把"你已损失 1360.7 分，约合 ¥511.62"直接摆到台面上——**这个数字本身就是一条转发理由**。

### 模式 4 · 三路比价器

```
query-nearby-stores(beType=1) ──┐
query-nearby-stores(beType=5) ──┤
delivery-query-addresses ───────┤   拿到三条履约路径各自的门店与 beCode
delivery-query-stores(beType=2)─┘
      │
query-meals ×3 ────────────► 三条路各自拉菜单
      │
      ▼
本地计算 ──────────────────► 求三条路的商品交集 → 按品类取代表篮子
      │
calculate-price ×3 ────────► 逐路真实算价
      │
      ▼
本地计算 ──────────────────► 对比实付（含配送费/打包费）→ 差额与省幅
```

**业务价值**：现有同类作品几乎都在比"套餐组合怎么凑最省"，**没有人比"履约方式"**。但履约方式恰恰是差价最大、用户最不透明的一环——实测同款一单，到店自取 ¥72.90 vs 麦乐送 ¥84.50，**差 ¥11.60（13.7%）**，而且差价主要来自"同款商品在到店菜单和外送菜单上标价不同"这个几乎没人知道的事实。

### 模式 5 · 券生命周期管家

```
available-coupons ─────────► 可领取的券（含已领/未领状态）
      │
query-my-coupons ──────────► 券包：券名、discountInfo（用券价）、起止时间
      │
query-nearby-stores ───────┐
query-meals ───────────────┘  拿门店菜单用于比价
      │
      ▼
本地计算 ──────────────────► 券名 ↔ 菜单名模糊匹配
                              → 立省 = 菜单价 − 用券价
                              → 按 tradeEndDateTime 算临期天数
                              → 紧急度排序 + 未领清点
```

**业务价值**：券的痛点不在"有多少张"，而在**"这张券到底帮我省了多少钱"**和**"哪张马上要过期"**。实测把券商「用券价 ¥9.90」和菜单「芝芝火腿扒堡 ¥13.00」对上，得出「省 ¥3.10」——这是用户可以立刻做决策的信息。匹配不上的券会**明确标注未匹配**，不编造差价。

### 模式 6 · 热量预算教练

```
list-nutrition-foods ──────► 官方营养表
      │
query-nearby-stores ───────┐
query-meals ───────────────┘  拿本店实际在售餐品与价格
      │
      ▼
本地计算 ──────────────────► 菜单 × 营养表 名称匹配 → 可用商品池
                              → 穷举 1~3 件全部组合
                              → 双重约束：热量 ≤ 预算 且 价格 ≤ 上限
                              → 必须含至少一件主食（排除"一杯咖啡"凑数解）
                              → 三套方案：用满预算 / 最轻负担 / 每卡最省
```

**业务价值**：不是"推荐算法猜你想吃什么"，而是**可验证的穷举**——本次实测在 57 款可匹配餐品中枚举出 4858 种可行组合。用户拿到的是"在 600 kcal 内，这家店现在能怎么吃"的完整解空间摘要。

---

## 4. 端到端链路（一次点击的完整生命周期）

```
浏览器 (index.html)
   │  fetch POST /api/run  { mode: "fulfillment-compare" }
   ▼
本地服务 (server.js, 127.0.0.1:8799)
   │  MODES[mode].run(options)
   ▼
模式编排 (lib/modes.js)
   │  callTool() × N  →  lib/mcp.js  →  POST https://mcp.mcd.cn
   ▼
麦当劳 MCP Server (35 tools)
   │  structuredContent
   ▼
模式编排 计算/对比/排序 → 输出统一「渲染规格」blocks
   │  { hero, kpi, table, bars, list, note } + chain[{tool, ok, ms}]
   ▼
浏览器渲染：推门动效 → 真实调用链 chips（含每步耗时）→ 结果块
```

`chain` 字段是**真实调用的记录**（Tool 名 + 成败 + 每步耗时），前端把它渲染成页面上那一排小标签——所以用户看到的不只是结论，**还能看到结论是怎么一步步算出来的**。

---

## 5. 容错设计

MCP 调用天然会失败（门店收藏为空、某个履约方式无可用门店、菜单品类缺货）。m-king 的取数是**分级降级**而非直接报错：

- `resolveStore()`：收藏门店 → 城市+关键词搜索，两级回退
- 比价器：三条路各自 `try/catch`，某条路不可用就在结果表里标「不可用：原因」，其余照常对比
- 券管家：菜单拿不到时降级为纯临期统计，并说明原因
- 热量教练：营养匹配数为 0 时给出明确提示而不是空结果
- 全部工具调用统一返回 `{ ok, ms, tool, error }`，**永不抛异常中断整条链**

---

## 6. 合规与安全

- **只读**：不调用任何写入类 Tool（下单/领券/抽奖/预约一律不碰）
- **Token**：仅存于本地进程内存，不落盘、不进日志、不出现在任何 API 返回体或页面源码中
- **仓库**：只提供 `mcp-config.example.json` 纯占位符示例；真实配置 `mcp.config.json` 已被 `.gitignore` 忽略
- **网络**：本地服务仅监听 `127.0.0.1`
- **静态文件**：做了目录穿越防护，访问范围限制在项目目录内
- **调试接口**：`/api/tool` 带工具名白名单正则校验
