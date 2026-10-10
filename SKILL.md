---
name: m-king
description: 麦当劳"麦门总管"可视化技能。当用户说"打开麦门""m-king""麦门总管""看看我的麦当劳""麦当劳面板/仪表盘/控制台""我的积分/券/年度账单/比价/热量"时使用。会启动本地服务，打开一座金拱门宫门网页，两侧陈列六个技能入口；用户点任意一门即当场执行真实麦当劳 MCP 调用链，结果直接渲染回页面。
---

# m-king · 麦门总管

一扇金拱门宫门，两侧各守三门技能。**点一下，当场执行，结果就地呈现。**

## 定位（关键区别）

与"静态看板"型 Skill 不同，m-king **真的能执行**：

```
用户点击卡片
  → 浏览器 POST /api/run 到本地服务（127.0.0.1）
  → 本地服务直连麦当劳 MCP（https://mcp.mcd.cn，JSON-RPC over HTTP）
  → 跑完真实调用链并计算
  → 结果渲染回网页（关键数字 / 对比表 / 榜单 / 结论 + 每步调用耗时）
```

不复制指令、不跳回对话框、不粘贴。**网页是执行入口，不是说明书。**

## 执行步骤

### 1. 确认能否拿到麦当劳 MCP Token

按优先级检查（`lib/mcp.js` 会自动做这件事）：

1. 环境变量 `MCD_MCP_TOKEN`
2. `~/.workbuddy/mcp.json` → `mcpServers["mcd-mcp"].headers.Authorization`
3. 项目内 `mcp.config.json`

**如果 WorkBuddy 里已接入麦当劳连接器**（`mcd-mcp` 状态为已连接），第 2 项自动可用，**什么都不用配**。

若三者都没有，提示用户去 <https://open.mcd.cn/mcp> 申请 Token 并写入其中一处。

### 2. 启动本地服务

```bash
cd <m-king 项目目录> && node server.js
```

服务默认监听 `127.0.0.1:8799`，端口占用会自动顺延。启动后会打印实际访问地址。

**建议后台运行**（它是常驻服务）：

```bash
cd <m-king 项目目录> && nohup node server.js > /tmp/m-king.log 2>&1 &
# 或前台跑，用 run_in_background
```

推荐用 `run_in_background: true` 启动，避免阻塞会话。

### 3. 确认服务就绪

```bash
curl -s http://127.0.0.1:8799/api/status
```

返回 `ok: true` 且 `toolCount: 35` 即正常。

### 4. 把页面呈现给用户

用 `present_files` 传入本地服务地址，会直接在浏览器预览面板中打开：

```
present_files({ files: ["http://127.0.0.1:8799/"], cwd: "<m-king 项目目录>" })
```

### 5. 回话要点

简述从 `/api/dashboard` 拿到的真实数字（可用积分 / 券包数量 / 已过期积分 / 今日活动），然后说明：**点任意一门卡片，当场执行并出结果**。

## 六个技能（都由页面点击直接触发）

| 位置 | 模式 ID | 技能 | 真实调用链 |
|---|---|---|---|
| 左 1 | `mci-index` | 中国麦价指数 McIndex | `now-time-info` → `query-nearby-stores` → `query-meals` |
| 左 2 | `annual-report` | 麦当劳年度账单 | `order-list` → `list-nutrition-foods` |
| 左 3 | `points-advisor` | 积分理财师 | `query-my-account` → `mall-points-products` → `query-lottery-info` |
| 右 1 | `fulfillment-compare` | 三路比价器 | `query-nearby-stores`×2 → `delivery-query-addresses` → `delivery-query-stores` → `query-meals`×3 → `calculate-price`×3 |
| 右 2 | `coupon-lifecycle` | 券生命周期管家 | `available-coupons` → `query-my-coupons` → `query-meals` |
| 右 3 | `calorie-coach` | 热量预算教练 | `list-nutrition-foods` → `query-nearby-stores` → `query-meals` |

算法与口径细节见 `references/modes.md`。

## 在会话里直接执行单个模式

如果用户不想开网页，也可以在会话中直接调 API 拿结构化结果：

```bash
curl -X POST http://127.0.0.1:8799/api/run \
  -H 'Content-Type: application/json' \
  -d '{"mode":"points-advisor"}'
```

返回体含 `blocks[]`（渲染规格）与 `chain[]`（真实调用记录）。

**降级方案**：如果用户环境起不了本地服务，改用 WorkBuddy 会话里的 `mcp__mcd-mcp__*` 工具直接调 MCP，用文字/表格回答同样的问题。

## 可调参数

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `MCD_MCP_TOKEN` | — | 麦当劳 MCP Token（最高优先级） |
| `MCD_MCP_URL` | `https://mcp.mcd.cn` | MCP 端点 |
| `MCD_PORT` | `8799` | 本地服务端口 |
| `MCD_HOST` | `127.0.0.1` | 监听地址（不要改成 0.0.0.0） |
| `MCD_CITY` | `北京` | 门店搜索的默认城市 |
| `MCD_KEYWORD` | `麦当劳` | 门店搜索关键词 |
| `MCD_TIMEOUT_MS` | `30000` | 单次 MCP 调用超时 |

热量教练还支持在 `/api/run` 的 `options` 里传 `budget`（kcal，默认 600）和 `priceCap`（元，默认 45）。

## 边界（务必遵守）

- **只读**：只调用查询/算价类 Tool，**绝不调用** `create-order`、`cancel-order`、`auto-bind-coupons`、`draw-lottery`、`mall-create-order`、`party-order-create`、`delivery-create-address`。涉及领券/下单/抽奖，只在结论里**建议**用户去做。
- **Token 安全**：不展示、不记录、不复述用户的 MCP Token；不把 Token 写进任何文件、日志或对话输出。
- **服务不对外**：本地服务只监听 `127.0.0.1`，不要改成 `0.0.0.0`。
- **数据时效**：页面显示的是**取数那一刻**的真实快照，不做缓存美化；不编造匹配不上的数据（券未匹配就标"未匹配"，品类缺货就标注剔除）。
- **免责**：项目输出仅供参考，不构成医疗、营养或其他专业建议；餐品信息、价格及供应状态以麦当劳官方渠道实时结果为准。
