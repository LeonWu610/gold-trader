# Trading Model Builder — Agent Prompt

> 将此 prompt 完整粘贴给 agent，然后在「模型输入」一节填入你的核心逻辑和数据需求，agent 将自动搭建完整的前后端交易系统。

---

## 你的任务

你是一名全栈工程师，负责从零搭建一套**量化交易信号系统**。目标是：基于用户提供的「模型输入」，生成一个**可独立运行、可云端部署、低门槛二次开发**的前后端项目。

请严格遵循下方的架构规范和代码风格，不要引入任何额外依赖，不要生成 README 以外的文档文件。

---

## 模型输入（由用户填写）

```
标的名称：___（例：黄金、原油、比特币、沪深300）
标的代码：___（例：GC=F、CL=F、BTC-USD、000300.SS）
系统名称：___（例：Gold Signal Engine）

评分因子（列出所有因子，每条一行）：
- 因子名称 | 数据来源 | 评分区间 | 权重 | 多空逻辑
- ...

交易信号逻辑：
- 做多条件：___
- 做空条件：___
- 观望条件：___

必需的外部 API：
- ___（例：FRED API Key，免费，申请地址：xxx）
- ___（可选）

其他补充说明：___
```

---

## 架构规范

### 目录结构

```
{project-name}/
├── {name}-trader/              # 前端（React 单页应用）
│   ├── src/
│   │   ├── {name}_system.jsx   # ★ 核心文件：全部 UI + 数据获取 + 评分计算
│   │   ├── App.js              # 仅一行：return <SystemComponent />
│   │   └── index.js            # React 入口，无 reportWebVitals
│   ├── public/
│   │   ├── index.html          # 标题、favicon、lang="zh-CN"，无多余标签
│   │   └── favicon.svg         # SVG 格式，与标的主题匹配
│   ├── package.json
│   ├── Dockerfile
│   └── railway.toml
├── data_fetcher.py             # Python 后端：数据抓取 + HTTP API 服务
├── requirements.txt
├── {name}_signal.json          # 后端输出的缓存数据（git ignore 可选）
└── README.md
```

### 核心原则

1. **前端零依赖**：只用 React 18 + react-scripts，不引入任何 UI 库（antd、MUI 等）。所有样式用 inline style + 一个 `<style>` 标签实现。
2. **单文件架构**：前端全部逻辑（数据获取、评分计算、UI 组件）写在一个 `.jsx` 文件里，便于理解和修改。
3. **渐进降级**：后端不可用时前端自动切换到直连 API，始终有数据可展示。
4. **一键部署**：Dockerfile + railway.toml 开箱即用，不需要额外配置。

---

## 前端规范（`{name}_system.jsx`）

### 设计语言

```js
// 固定配色系统（深色，终端风）
const COLORS = {
  bg: "#0a0b0e", surface: "#111318", card: "#161a21",
  border: "#1e2330", borderLight: "#252d3d",
  // 主题色（根据标的调整）：
  //   黄金 → gold: "#c9a84c"
  //   原油 → amber: "#f59e0b"
  //   股指 → blue: "#3b82f6"
  //   加密 → purple: "#a855f7"
  primary: "___", primaryLight: "___", primaryDim: "___",
  green: "#22c55e", red: "#ef4444", amber: "#f59e0b",
  text: "#e8eaf0", textSub: "#7a8299", textDim: "#4a5268",
};

// 字体：Space Mono（数字/代码）+ DM Sans（正文）
// 通过 Google Fonts @import 加载，写在 css 模板字符串中
```

### 必须实现的 UI 模块

**① 顶部状态栏（Header）**
- 左：系统名称（Space Mono，主题色）+ 实时小圆点（pulse 动画）+ 最后更新时间
- 右：加载进度文字 + 刷新按钮
- 样式：`position: sticky; top: 0; backdrop-filter: blur(12px)`

**② 核心指标行（MetricCard × N 列）**
- 显示最核心的 N 个实时数据（价格、关键宏观指标等）
- `grid-template-columns: repeat(N, minmax(0, 1fr))`
- 每张卡片：标签 + ⓘ 说明图标 + 主值（Space Mono 粗体）+ 副标签（来源/涨跌幅）
- 加载状态：shimmer 骨架屏动画

**③ 主决策卡片**
- 当前交易信号（大字，主题色，带 glow 阴影）
- 综合评分（±N 区间，绿/黄/红色）+ 技术确认（X/N 项满足）
- 高分但不满足入场条件时显示解释性警告

**④ Tab 标签页**（最多 5 个）
- `信号总览`：6 个关键信号条目，左文字 + 右状态 Tag
- `评分明细`：按评分层次分组（宏观结构/宏观节奏/情绪博弈），每项含横向评分条
- `技术指标`：6 项技术确认（勾选列表），下方支撑/阻力/RSI/MA 等数字
- `仓位计算`：入场/止损/目标价 → 自动计算 R:R 比率和建议仓位
- `数据来源`：列出所有数据源（接口地址、延迟、是否免费、质量评级）

**⑤ 说明弹窗系统（InfoModal + InfoIcon）**
```jsx
// INFO_DICT：为每个指标提供三段式说明
const INFO_DICT = {
  "key": {
    title: "指标名称",
    content: [
      "📌 含义：___",
      "📡 来源：___",
      "📐 计算：___",
      "🔑 评分规则：___",   // 可选
      "⚠️ 注意：___",       // 可选
    ]
  }
};

// InfoIcon：行内 ⓘ 圆形图标，hover 变主题色
// InfoModal：固定定位全屏遮罩，点击遮罩关闭
// ★ 关键：必须在 return() 末尾渲染 <InfoModal>，否则弹窗不显示
{infoModal && <InfoModal info={infoModal} onClose={() => setInfoModal(null)} />}
```

**⑥ 动画系统**
```css
@keyframes fadeIn   { from{opacity:0;transform:translateY(6px)} to{opacity:1;transform:translateY(0)} }
@keyframes pulse    { 0%,100%{opacity:1} 50%{opacity:0.3} }
@keyframes spin     { to{transform:rotate(360deg)} }
@keyframes shimmer  { 0%{background-position:-200% 0} 100%{background-position:200% 0} }
```
所有卡片入场用 `fadeIn 0.4s ease both`，按 index 依次延迟 `i*0.05s`。

### 数据获取层（严格按优先级降级）

```js
// 优先级 0：Python 后端（本地或云端，数据最完整）
const BACKEND_BASE = process.env.REACT_APP_BACKEND_URL || "http://localhost:5001";
const fetchFromLocalBackend = async (onProgress) => { ... };

// 优先级 1：Yahoo Finance 非官方 API（前端直连，无 key，15min 延迟）
// URL: https://query1.finance.yahoo.com/v8/finance/chart/{SYMBOL}?interval=1d&range=5d
const fetchYahooPrice = async (symbol) => { ... };

// 优先级 2：FRED API（宏观数据，免费，需 key）
// URL: https://api.stlouisfed.org/fred/series/observations?series_id={ID}&api_key={KEY}
const fetchFredSeries = async (seriesId, limit = 3) => { ... };

// 优先级 3（可选）：Anthropic web_search（兜底，仅当前两项都失败时）
const fetchViaAnthropicSearch = async (query) => { ... };

// 主数据加载函数
const loadData = useCallback(async () => {
  try { return await fetchFromLocalBackend(onProgress); }
  catch { /* 降级到直连 */ }
  // ... fallback 链
}, []);

// 自动刷新：15 分钟
useEffect(() => {
  loadData();
  const t = setInterval(loadData, 15 * 60 * 1000);
  return () => clearInterval(t);
}, [loadData]);
```

### 评分计算层

```js
const computeScore = (data) => {
  const scoreItems = [
    // 每个因子：
    { layer: "宏观结构|宏观节奏|情绪博弈",
      name: "___",
      value: "___",           // 展示值（字符串）
      score: ___,             // -3 ~ +3 整数
      weight: 0.XX,           // 各项权重之和 = 1.0（即使有数据缺失也不缩减分母）
      infoKey: "___"          // 对应 INFO_DICT 中的 key
    },
    // ...
  ];

  // 加权归一化到 ±15
  const totalWeight = scoreItems.reduce((s, i) => s + i.weight, 0);
  const weighted = scoreItems.reduce((s, i) => s + i.score * i.weight, 0) / totalWeight;
  const normalized = Math.round(weighted * 15);

  // 技术确认（6 项布尔值）
  const techScore = [above_ma200, above_ma50, rsi_healthy, rsi_divergence,
                     macd_positive, volume_surge].filter(Boolean).length;

  // 优先使用后端已计算的评分（后端有完整权重）
  const normalizedFinal = data._signal?.normalized_score ?? normalized;
  const techScoreFinal  = data._signal?.tech_score ?? techScore;

  return { scoreItems, normalized: normalizedFinal, techScore: techScoreFinal, ... };
};
```

---

## 后端规范（`data_fetcher.py`）

### 整体结构

```python
"""
{标的名称}交易信号系统 — 数据抓取后端（HTTP API 服务版）
数据源：Yahoo Finance (yfinance) / FRED API / CFTC / 其他
运行：python data_fetcher.py
接口：GET http://localhost:5001/api/{name}
"""

import os, io, json, time, random, threading, datetime, zipfile
import requests, yfinance as yf, pandas as pd
from http.server import HTTPServer, BaseHTTPRequestHandler
from typing import Optional
from fredapi import Fred

# 配置（从环境变量读取，本地开发可硬编码默认值）
FRED_API_KEY = os.environ.get("FRED_API_KEY", "your_key_here")
PORT = int(os.environ.get("PORT", 5001))
```

### 数据抓取函数规范

每个数据源写一个独立函数，统一的失败处理模式：

```python
def fetch_xxx_data() -> dict:
    """
    函数说明：数据含义、来源、更新频率
    返回字段：{key: value, ...}
    """
    try:
        # 1. 主数据源（yfinance / FRED / CFTC 等）
        result = _fetch_from_primary()
        print(f"  ✅ [{名称}] 数据: {result}")
        return result
    except Exception as e:
        print(f"  ⚠️  [{名称}] 主数据源失败: {e}")
        try:
            # 2. Fallback（Polygon.io / Alpha Vantage / FRED 等）
            result = _fetch_from_fallback()
            return result
        except Exception as e2:
            print(f"  ❌ [{名称}] fallback 也失败: {e2}")
            return {}   # 返回空 dict 而不是 raise，让其他数据源继续运行
```

### yfinance 使用规范

```python
# yfinance 1.2+ 使用 curl_cffi 自动伪装浏览器指纹，不需要手动 Session
def yf_ticker_with_retry(symbol, period="5d", interval="1d", max_retries=1):
    for attempt in range(max_retries):
        try:
            if attempt > 0:
                time.sleep(2)
            else:
                time.sleep(random.uniform(0.5, 1.5))  # 随机延迟防限流
            ticker = yf.Ticker(symbol)
            hist = ticker.history(period=period, interval=interval, auto_adjust=True)
            if hist.empty:
                raise ValueError(f"{symbol} 返回空数据")
            return hist
        except Exception as e:
            if attempt == max_retries - 1:
                raise
```

### 技术指标计算规范

```python
def compute_technical_indicators(df: pd.DataFrame) -> dict:
    """
    输入：包含 Open/High/Low/Close/Volume 列的日线 DataFrame
    输出：标准化技术指标字典
    """
    closes = df["Close"].values
    # MA
    ma20  = float(closes[-20:].mean()) if len(closes) >= 20 else float(closes.mean())
    ma50  = float(closes[-50:].mean()) if len(closes) >= 50 else float(closes.mean())
    ma200 = float(closes[-200:].mean()) if len(closes) >= 200 else float(closes.mean())
    current = float(closes[-1])

    # RSI(14)
    deltas = np.diff(closes)
    gains = np.where(deltas > 0, deltas, 0)[-14:]
    losses = np.where(deltas < 0, -deltas, 0)[-14:]
    avg_gain, avg_loss = gains.mean(), losses.mean()
    rsi = round(100 - 100 / (1 + avg_gain / avg_loss), 1) if avg_loss != 0 else 100

    # MACD(12,26,9)
    ema = lambda arr, n: pd.Series(arr).ewm(span=n, adjust=False).mean().values
    ema12, ema26 = ema(closes, 12), ema(closes, 26)
    macd_line = ema12 - ema26
    signal_line = ema(macd_line, 9)
    macd_positive = bool(macd_line[-1] > 0)
    macd_cross    = bool(macd_line[-1] > signal_line[-1] and macd_line[-2] <= signal_line[-2])

    # ATR(14) + 支撑/阻力
    highs, lows = df["High"].values, df["Low"].values
    atr = float(np.mean(highs[-14:] - lows[-14:]))
    support    = round(float(lows[-60:].min()))
    resistance = round(float(highs[-60:].max()))

    # 量能放大
    vols = df["Volume"].values
    volume_surge = bool(vols[-5:].mean() > vols[-20:].mean() * 1.3)

    # RSI 底背离（简化版）
    rsi_series = compute_rsi_series(closes)
    price_new_low = current < closes[-20:-1].min()
    rsi_new_low   = rsi_series[-1] < rsi_series[-20:-1].min()
    rsi_divergence = bool(price_new_low and not rsi_new_low)

    return {
        "price": round(current, 2),
        "ma20": round(ma20), "ma50": round(ma50), "ma200": round(ma200),
        "above_ma20": current > ma20, "above_ma50": current > ma50, "above_ma200": current > ma200,
        "rsi": round(rsi, 1), "rsi_healthy": 35 <= rsi <= 65, "rsi_oversold": rsi < 30,
        "rsi_divergence": rsi_divergence,
        "macd_positive": macd_positive, "macd_cross": macd_cross,
        "atr": round(atr, 2), "support": support, "resistance": resistance,
        "volume_surge": volume_surge,
        "source": "yfinance历史数据",
    }
```

### 综合评分函数规范

```python
def compute_signal_score(price_data, macro_data, tech_data, ...) -> dict:
    """
    评分结果，与前端 computeScore() 完全对齐。
    后端是权威评分，前端在后端不可用时使用本地降级计算。
    """
    score_items = []

    # 每个因子：
    #   score：-3 ~ +3 整数
    #   weight：权重（所有因子权重之和应 = 1.0）
    #   ⚠️ 无数据时 score=0 但 weight 仍保留，防止分母缩水导致评分虚高
    score_items.append({
        "layer": "宏观结构",   # 或 "宏观节奏" / "情绪博弈"
        "name": "___",
        "value": "___",
        "score": ___,
        "weight": 0.XX,
    })
    # ...

    total_weight = sum(i["weight"] for i in score_items)
    weighted_avg = sum(i["score"] * i["weight"] for i in score_items) / total_weight
    normalized   = round(weighted_avg * 15)   # 映射到 ±15

    # 技术确认（与前端对齐）
    tech_bools = [
        tech_data.get("above_ma200", False),
        tech_data.get("above_ma50",  False),
        tech_data.get("rsi_healthy", False),
        tech_data.get("rsi_divergence", False),
        tech_data.get("macd_positive", False),
        tech_data.get("volume_surge",  False),
    ]
    tech_score = sum(tech_bools)

    # 支撑/阻力区域判断
    support    = tech_data.get("support", 0)
    resistance = tech_data.get("resistance", 0)
    atr        = tech_data.get("atr", 0)
    support_band = atr * 2 if atr > 0 else support * 0.03
    in_support      = support > 0 and support <= gold_price <= support + support_band
    in_deep_support  = support > 0 and support * 0.97 <= gold_price < support
    breakout        = resistance > 0 and gold_price >= resistance * 0.98

    # 交易信号
    if breakout and normalized >= 4 and tech_score >= 3:
        action = "追多突破"
    elif (in_support or in_deep_support) and normalized >= 3 and tech_score >= 3:
        action = "建仓做多"
    elif (in_support or in_deep_support) and normalized >= 2 and tech_score >= 2:
        action = "试探轻仓"
    elif normalized < 0:
        action = "观望空仓"
    else:
        action = "持仓观望"

    return {
        "normalized_score": normalized,
        "tech_score": tech_score,
        "tech_score_raw": tech_bools,
        "action": action,
        "gold_price": gold_price,   # 或 {标的}_price
        "in_support": in_support,
        "in_deep_support": in_deep_support,
        "breakout": breakout,
        "score_items": score_items,
    }
```

### HTTP 服务规范

```python
# 缓存层
_cache = {"data": None, "ts": 0}
_cache_lock = threading.Lock()
CACHE_TTL = 15 * 60   # 15 分钟

# 主入口：先启动 HTTP 服务，再后台异步预热数据
# 这样前端首次请求不会超时
if __name__ == "__main__":
    server = HTTPServer(("0.0.0.0", PORT), APIHandler)
    warm_thread = threading.Thread(target=refresh_data_bg, daemon=True)
    warm_thread.start()
    server.serve_forever()

# 路由
# GET /api/{name}        → 返回完整数据（优先缓存，过期则后台刷新）
# GET /api/refresh       → 强制刷新缓存
# OPTIONS *              → CORS 预检

# CORS 必须设置
self.send_header("Access-Control-Allow-Origin", "*")
self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
```

### 输出 JSON 格式规范

```json
{
  "timestamp": "2025-03-20T10:30:00.000000",
  "data_sources": {
    "price": {
      "GC=F": {
        "price": 3020.5,
        "change_pct": 0.42,
        "market_state": "REGULAR",
        "source": "Yahoo Finance"
      }
    },
    "macro": {
      "tips": 1.85,
      "tips_date": "2025-03-18",
      "cpi": 3.1,
      "cpi_date": "2025-03-12",
      "fed_cut_prob": 72,
      "fed_cut_source": "ZQ=F期货",
      "etf_flow": "流入",
      "vix_value": 18.5,
      "vix_risk_level": "中高"
    },
    "technical": {
      "price": 3020.5,
      "ma20": 2980, "ma50": 2950, "ma200": 2750,
      "above_ma20": true, "above_ma50": true, "above_ma200": true,
      "rsi": 58.2, "rsi_healthy": true, "rsi_oversold": false,
      "rsi_divergence": false,
      "macd_positive": true, "macd_cross": false,
      "atr": 28.5,
      "support": 2940, "resistance": 3050,
      "volume_surge": false,
      "source": "yfinance历史数据"
    }
  },
  "signal": {
    "normalized_score": 7,
    "tech_score": 4,
    "tech_score_raw": [true, true, true, false, true, false],
    "action": "建仓做多",
    "gold_price": 3020.5,
    "in_support": true,
    "in_deep_support": false,
    "breakout": false
  }
}
```

---

## 部署规范

### Dockerfile（前端）

```dockerfile
FROM node:18-alpine AS builder
WORKDIR /app
COPY package*.json .npmrc ./
RUN npm ci --prefer-offline
COPY public/ ./public/
COPY src/ ./src/
RUN npm run build

FROM node:18-alpine
RUN npm install -g serve
WORKDIR /app
COPY --from=builder /app/build ./build
EXPOSE 3000
CMD ["serve", "-s", "build", "--listen", "tcp://0.0.0.0:$PORT"]
```

### railway.toml（前端）

```toml
[build]
builder = "dockerfile"
dockerfilePath = "Dockerfile"

[deploy]
startCommand = "serve -s build --listen tcp://0.0.0.0:$PORT"
```

### railway.toml（后端，项目根目录）

```toml
[build]
builder = "nixpacks"

[deploy]
startCommand = "python data_fetcher.py"
healthcheckPath = "/api/{name}"
healthcheckTimeout = 120
```

### 环境变量

| 变量名 | 位置 | 说明 |
|--------|------|------|
| `FRED_API_KEY` | 后端 | FRED 宏观数据（免费申请）|
| `REACT_APP_BACKEND_URL` | 前端构建时 | 后端 API 地址（如 `https://xxx.railway.app`）|
| `PORT` | 两端 | Railway 自动注入，无需手动设置 |

---

## 开发工作流

### 本地开发

```bash
# 1. 启动后端（可选，不启动则前端自动降级到 Yahoo Finance 直连）
pip install -r requirements.txt
export FRED_API_KEY=your_key
python data_fetcher.py          # 启动在 http://localhost:5001

# 2. 启动前端（新终端）
cd {name}-trader
npm install
npm start                       # 启动在 http://localhost:3000
```

### 修改评分逻辑

所有评分逻辑在两处：
- **前端**：`src/{name}_system.jsx` 中的 `computeScore()` 函数
- **后端**：`data_fetcher.py` 中的 `compute_signal_score()` 函数

两处必须保持一致（因子名称、权重、评分区间、技术确认项顺序）。

前端是降级路径，后端是权威路径。后端评分会通过 `data._signal.normalized_score` 覆盖前端本地计算值。

### 添加新数据源

1. 在 `data_fetcher.py` 中新增 `fetch_xxx()` 函数
2. 在 `run_full_analysis()` 中调用并将结果塞入 output
3. 在前端 `fetchFromLocalBackend()` 中读取新字段
4. 在 `computeScore()` 中加入新因子
5. 在 `INFO_DICT` 中为新因子添加说明

---

## 质量检查清单

agent 完成代码生成后，需确认以下所有项：

- [ ] `<InfoModal>` 在 JSX return 末尾有渲染（`{infoModal && <InfoModal .../>}`），否则弹窗永远不显示
- [ ] `INFO_DICT` 中每个 `infoKey` 都有对应条目
- [ ] 评分权重之和 = 1.0（前后端分别验证）
- [ ] 后端 CORS 头已设置（`Access-Control-Allow-Origin: *`）
- [ ] `fetchFromLocalBackend` 有 35s 超时（`AbortSignal.timeout(35000)`）
- [ ] 15 分钟自动刷新 `setInterval(loadData, 15 * 60 * 1000)`
- [ ] 无数据时展示 `"—"` 而非报错
- [ ] 缓存过期时后台异步刷新，本次返回旧数据（不阻塞）
- [ ] Dockerfile 使用多阶段构建（builder + runner 两阶段）
- [ ] `favicon.svg` 为 SVG 格式（不是 .ico），在 `index.html` 用 `type="image/svg+xml"` 引用

---

## 禁止事项

- ❌ 不引入 styled-components、emotion 等 CSS-in-JS 库
- ❌ 不引入 antd、MUI、chakra 等组件库
- ❌ 不使用 Redux、Zustand 等状态管理库（只用 useState + useCallback + useEffect）
- ❌ 不生成测试文件（App.test.js、setupTests.js）
- ❌ 不保留 reportWebVitals.js
- ❌ 不在 public/ 放 logo192.png、logo512.png、manifest.json、robots.txt
- ❌ 不硬编码支撑/阻力价位（必须从数据动态计算）
- ❌ 不在无数据时 throw Error（return 空对象或默认值，让其他数据源继续）
