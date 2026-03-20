# Gold Signal Engine · 黄金信号引擎

基于宏观结构、宏观节奏、情绪博弈三层框架，对黄金多空信号进行综合评分的交易辅助系统。数据实时拉取，纯前端渲染，无需后端即可独立运行。

---

## 架构

```
fin_mdl/
├── gold-trader/          # 前端 React 应用（主体）
│   ├── src/
│   │   ├── gold_system_v2.jsx   # 核心：数据获取、评分计算、全部 UI
│   │   ├── App.js               # 根组件（仅挂载 GoldSystemV2）
│   │   └── index.js             # React 入口
│   ├── public/
│   │   ├── index.html
│   │   └── favicon.svg
│   └── Dockerfile        # 生产部署镜像（serve 静态构建产物）
│
├── data_fetcher.py       # 可选：本地 Python 后端，生成 gold_signal.json
├── gold_signal.json      # 后端输出的本地数据文件（前端优先读取）
├── production.json       # 生产环境参考数据快照
└── requirements.txt      # Python 依赖
```

## 数据来源（优先级从高到低）

| 优先级 | 来源 | 数据 | 延迟 | 需要 Key |
|--------|------|------|------|----------|
| 1 | 本地 `gold_signal.json` | 全量 | 按需运行 | — |
| 2 | Yahoo Finance API | 金价、DXY、ETF | 15 min | 否 |
| 3 | FRED API | TIPS 利率、CPI | 日/月更新 | 是（免费） |

---

## 快速开始

### 前提

- Node.js ≥ 18
- （可选）Python ≥ 3.10，用于本地后端数据增强

### 1. 安装依赖并启动前端

```bash
cd gold-trader
npm install
npm start
```

浏览器访问 [http://localhost:3000](http://localhost:3000)，前端会自动向 Yahoo Finance 拉取数据。

### 2. （可选）启动 Python 后端，获取更完整的数据

```bash
# 安装 Python 依赖
pip install -r requirements.txt

# 配置 FRED API Key（免费申请：https://fred.stlouisfed.org/docs/api/api_key.html）
export FRED_API_KEY=your_key_here

# 运行后端，自动写入 gold_signal.json
python data_fetcher.py
```

运行后，前端会优先读取本地 `gold_signal.json`，获得 COT、TIPS、CPI 等更精确的宏观数据。

---

## 评分模型

系统按三个层次对当前黄金多空信号进行加权评分，满分区间 **±15**：

| 层次 | 因子 | 权重 |
|------|------|------|
| 宏观结构 | TIPS 实际利率、美元指数、黄金趋势 | 0.13 × 3 |
| 宏观节奏 | 降息预期（CME FedWatch）、CPI 通胀、ETF 资金流 | 0.14 + 0.13 + 0.12 |
| 情绪博弈 | COT 持仓、VIX 避险情绪 | 0.12 + 0.10 |

综合评分 ≥ +3 且价格处于支撑区 → **积极做多**  
综合评分 ≥ +3 但价格偏离支撑 → **持仓观望**  
综合评分 ≤ -3 → **谨慎做空**

---

## 生产部署

项目已配置 Railway 一键部署：

```bash
# 构建静态产物
cd gold-trader
npm run build

# 本地预览构建结果
npx serve -s build
```

Docker 部署：

```bash
cd gold-trader
docker build -t gold-signal .
docker run -p 3000:3000 gold-signal
```

---

## 免责声明

本系统仅供学习与辅助分析，不构成投资建议。所有交易决策请结合自身风险承受能力独立判断。
