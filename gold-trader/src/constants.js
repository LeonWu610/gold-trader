/**
 * constants.js — 全局静态常量层
 * ================================
 * 包含：颜色系统、CSS 动画、指标说明字典（INFO_DICT）
 * 这里不应引入任何 React/业务逻辑，保持纯数据。
 */

// ─── 颜色系统 ─────────────────────────────────────────────────────────────────
export const COLORS = {
  bg: "#0a0b0e", surface: "#111318", card: "#161a21",
  border: "#1e2330", borderLight: "#252d3d",
  gold: "#c9a84c", goldLight: "#e8c96e", goldDim: "#8a6e2e",
  green: "#22c55e", greenDim: "#166534",
  red: "#ef4444", redDim: "#7f1d1d",
  amber: "#f59e0b", amberDim: "#78350f",
  blue: "#3b82f6", blueDim: "#1e3a5f",
  text: "#e8eaf0", textSub: "#7a8299", textDim: "#4a5268",
};

// ─── 全局 CSS（字体 + 动画 + 滚动条）─────────────────────────────────────────
export const GLOBAL_CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&family=DM+Sans:wght@300;400;500&display=swap');
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: ${COLORS.bg}; color: ${COLORS.text}; font-family: 'DM Sans', sans-serif; }
  ::-webkit-scrollbar { width: 4px; }
  ::-webkit-scrollbar-thumb { background: ${COLORS.border}; border-radius: 2px; }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.3} }
  @keyframes fadeIn { from{opacity:0;transform:translateY(6px)} to{opacity:1;transform:translateY(0)} }
  @keyframes spin { to{transform:rotate(360deg)} }
  @keyframes shimmer { 0%{background-position:-200% 0} 100%{background-position:200% 0} }
  .shimmer {
    background: linear-gradient(90deg, ${COLORS.card} 25%, ${COLORS.border} 50%, ${COLORS.card} 75%);
    background-size: 200% 100%; animation: shimmer 1.5s infinite; border-radius: 4px;
  }
  input[type=number]::-webkit-inner-spin-button { opacity: 0.3; }
`;

// ─── 各指标说明字典（含数据含义、来源、计算方法）────────────────────────────
// 用于 InfoIcon 点击后弹出的说明弹窗，key 与 JSX 中的 infoKey 对应。
export const INFO_DICT = {
  // 顶部价格行
  gold_price: {
    title: "黄金期货价格 GC=F",
    content: [
      "📌 含义：COMEX（纽约商品交易所）黄金期货主力合约的最新成交价，单位为美元/盎司。",
      "📡 来源：Yahoo Finance 非官方 JSON API（query1.finance.yahoo.com），与 Yahoo Finance 网页显示一致，延迟约 15 分钟。优先从本地 Python 后端（yfinance 库）获取。",
      "📐 计算：直接使用交易所实时报价，无需额外换算。涨跌幅 = (当前价 - 昨收价) / 昨收价 × 100%。",
      "⚠️ 注意：期货价格包含展期成本（contango/backwardation），与现货金价略有差异（通常差几美元）。",
    ],
  },
  dxy: {
    title: "美元指数 DXY",
    content: [
      "📌 含义：衡量美元相对于一篮子主要货币（欧元、日元、英镑、加拿大元、瑞典克朗、瑞士法郎）的综合强弱。指数越高表示美元越强。",
      "📡 来源：Yahoo Finance，代码 DX-Y.NYB（ICE 美元指数期货）。若后端通过 FRED 获取则使用广义美元指数（DTWEXBGS），阈值会相应调整。",
      "📐 计算：以 1973 年 3 月为基期 100，欧元权重最大（57.6%）。与黄金呈显著负相关：美元升值通常压制金价。",
      "🔑 关键位：100 以下为弱美元利好黄金；100–106 中性；106 以上对黄金明显压制。",
    ],
  },
  tips: {
    title: "TIPS 实际利率（DFII10）",
    content: [
      "📌 含义：10 年期通胀保值国债（TIPS）的收益率，代表剔除通胀预期后的真实资金成本。是黄金最重要的基本面指标之一。",
      "📡 来源：美联储经济数据库 FRED，序列代码 DFII10（10-Year Treasury Inflation-Indexed Security, Constant Maturity），每个交易日更新。",
      "📐 计算：TIPS 实际利率 = 名义国债收益率 - 通胀盈亏平衡率。当实际利率为负或极低时，持有黄金的机会成本接近零，对金价利好。",
      "🔑 评分规则：< 1.5% → +3（利好）；1.5%–2.0% → -1（中性偏负）；≥ 2.0% → -2（利空）。",
    ],
  },
  cpi: {
    title: "美国 CPI 通胀率（CPIAUCSL）",
    content: [
      "📌 含义：美国城市消费者价格指数的同比涨幅（YoY%），反映整体通胀水平。",
      "📡 来源：FRED，序列代码 CPIAUCSL（Consumer Price Index for All Urban Consumers: All Items），美国劳工统计局每月发布，约滞后 5 周。",
      "📐 计算：YoY% = (最新月指数 / 12个月前指数 - 1) × 100。系统获取最近 14 条月度数据，用最新值与第 13 条（约 12 个月前）计算同比。",
      "🔑 评分规则：< 2.5% → +3（低通胀，美联储无压力降息）；2.5%–3.0% → +1；3.0%–3.5% → -1；≥ 3.5% → -2（高通胀，加息压力上升，压制金价）。",
    ],
  },
  // 信号总览
  price_zone: {
    title: "黄金价格区间",
    content: [
      "📌 含义：当前金价相对于技术支撑位和阻力位的位置状态。",
      "📐 计算方式：",
      "  · 支撑位（Support）= 过去 60 个交易日最低价。",
      "  · 阻力位（Resistance）= 过去 60 个交易日最高价。",
      "  · ATR（平均真实波幅）= 过去 14 日高低差均值，用于定义支撑带宽度（支撑位 ± 2×ATR）。",
      "  · 【支撑区】= 价格在 支撑位 ~ 支撑位+2×ATR 之间。",
      "  · 【深度支撑】= 价格跌破支撑位但不低于 支撑位×97%（-3%缓冲）。",
      "  · 【突破阻力】= 价格达到 阻力位×98% 以上。",
      "🎯 意义：入场信号要求价格位于支撑区或深度支撑内，配合宏观评分 ≥ 3 且技术确认 ≥ 3 项。",
    ],
  },
  fed_cut: {
    title: "联储降息预期概率",
    content: [
      "📌 含义：市场隐含的美联储降息概率，反映宽松预期。概率越高，市场预期越多降息，对黄金利好。",
      "📡 来源（优先级）：",
      "  1. ZQ=F 联邦基金期货（Yahoo Finance）：用 (100 - 期货价格) 推算隐含利率，与 FRED DFEDTARU（当前目标利率上限）对比，计算降息概率。",
      "  2. 降级路径：用 TIPS 实际利率线性插值估算（TIPS 越低 → 降息预期越高）。",
      "📐 计算公式：",
      "  · 隐含利率 = 100 - ZQ=F 价格（如价格 94.72 → 隐含利率 5.28%）",
      "  · 利差 = 当前目标利率上限（DFEDTARU）- 隐含利率",
      "  · 概率 = max(0, min(100, 50 + 利差 × 25))",
      "🔑 评分规则：> 70% → +3（强降息预期）；> 50% → +2；> 30% → 0（中性）；≤ 30% → -2（加息/维持预期）。",
    ],
  },
  etf_flow: {
    title: "黄金 ETF 资金流向（GLD）",
    content: [
      "📌 含义：SPDR 黄金 ETF（GLD）的资金流向，反映机构资金对黄金的态度。GLD 是全球最大黄金 ETF，其流入/流出是黄金需求的重要风向标。",
      "📡 来源：Yahoo Finance，代码 GLD。通过比较 GLD 当日涨跌幅（change_pct）判断资金方向。",
      "📐 计算：",
      "  · 流入：GLD 当日涨幅 > +0.5%",
      "  · 流出：GLD 当日跌幅 < -0.5%",
      "  · 持平：涨跌幅在 ±0.5% 内",
      "⚠️ 数据校验：系统会对比 GLD 与 GC=F（黄金期货）的涨跌方向，若背离超 3% 则标记「数据疑问」（可能是 GLD 除权或数据异常）。",
      "🔑 评分规则：流入 → +2；持平 → 0；流出 → -2；数据疑问 → 0（不计入评分）。",
    ],
  },
  vix: {
    title: "VIX 恐慌指数与地缘风险",
    content: [
      "📌 含义：VIX（CBOE Volatility Index）是标普 500 期权隐含波动率的衡量，俗称「恐慌指数」。VIX 上升通常反映市场风险厌恶上升，可能触发黄金避险买入。",
      "📡 来源：Yahoo Finance，代码 ^VIX，由 CBOE 实时计算并发布。",
      "📐 计算方法：",
      "  · VIX ≥ 25：高风险/恐慌，通常利好黄金避险需求 → +3（但见下注意）",
      "  · 20 ≤ VIX < 25：中高风险 → +2",
      "  · 15 ≤ VIX < 20：中性 → 0",
      "  · VIX < 15：低风险/平静市场 → -1",
      "⚠️ Risk-off 修正：当 VIX 快速飙升往往伴随系统性抛售（股票、商品同跌）。若当日黄金跌幅 > 2%，则判定为「避险失效」（risk-off 模式），VIX 加分归零，并在界面显示警示。",
    ],
  },
  tech_summary: {
    title: "技术面综合评分",
    content: [
      "📌 含义：6 项技术指标满足情况的汇总计数（0–6 项），每项 pass/fail 二选一。",
      "📐 6 项指标：",
      "  1. 站上 MA200（长期趋势方向正确）",
      "  2. 站上 MA50（中期趋势确认）",
      "  3. RSI 健康区间（35–65，避免极端超买超卖）",
      "  4. RSI 底背离（价格创新低但 RSI 未创新低，反转信号）",
      "  5. MACD 多头（DIF 在 Signal 线上方）",
      "  6. 量能放大（近 5 日均量超 20 日均量 130%）",
      "🎯 入场要求：技术确认 ≥ 3 项（建仓做多门槛），≥ 4 项为强信号。",
    ],
  },
  key_levels: {
    title: "关键支撑位 / 阻力位",
    content: [
      "📌 含义：基于近 60 个交易日价格数据自动计算的动态价格区间。",
      "📐 计算方法：",
      "  · 支撑位 = 过去 60 个交易日的最低价（近三个月价格底部）",
      "  · 阻力位 = 过去 60 个交易日的最高价（近三个月价格顶部）",
      "  · ATR = 14 日平均真实波幅，用于定义支撑带宽度",
      "📡 来源：Yahoo Finance 历史日 K 线数据（yfinance 库），由后端 Python 计算。",
      "⚠️ 注意：这是纯价格统计区间，不代表强弱支撑。实际交易时应结合成交量、关键整数关口（如 3000、3100）综合判断。",
    ],
  },
  // 评分明细
  score_tips: {
    title: "TIPS 实际利率（评分维度）",
    content: [
      "📌 含义：10 年期 TIPS 收益率。黄金无息资产，实际利率越低则持有黄金的机会成本越低，利好金价。",
      "📡 来源：FRED DFII10，每交易日更新。",
      "🔑 评分规则（权重 13%）：",
      "  · < 1.5% → +3（低实际利率，强利好）",
      "  · 1.5%–2.0% → -1（中性偏负）",
      "  · ≥ 2.0% → -2（高实际利率，持金成本高，利空）",
    ],
  },
  score_dxy: {
    title: "美元指数（评分维度）",
    content: [
      "📌 含义：美元强弱对黄金的压制/提振作用。美元贬值时，以美元计价的黄金对外国买家变便宜，需求上升。",
      "📡 来源：Yahoo Finance DX-Y.NYB（ICE 美元指数期货）或 FRED 广义美元指数（DTWEXBGS）。",
      "🔑 评分规则（权重 13%）：",
      "  · DXY 模式：< 100 → +3；100–103 → +1；103–106 → -1；≥ 106 → -3",
      "  · FRED广义指数模式（阈值不同）：< 105 → +3；105–110 → +1；110–118 → -1；≥ 118 → -3",
    ],
  },
  score_fed: {
    title: "降息预期（评分维度）",
    content: [
      "📌 含义：市场对美联储降息的预期强度。降息预期升温 → 美元走弱 + 实际利率下行 → 利好黄金。",
      "📡 来源：优先使用 ZQ=F 联邦基金期货推算；后端不可用时降级为 TIPS 线性插值。",
      "🔑 评分规则（权重 14%）：",
      "  · > 70% → +3（强降息预期）",
      "  · > 50% → +2（中等预期）",
      "  · > 30% → 0（中性）",
      "  · ≤ 30% → -2（维持/加息预期，利空）",
    ],
  },
  score_cpi: {
    title: "CPI 通胀率（评分维度）",
    content: [
      "📌 含义：通胀适度时美联储有降息空间，利好黄金；通胀过高则加息压力上升，利空黄金。",
      "📡 来源：FRED CPIAUCSL，月度数据（美国劳工部发布），约滞后 5 周。",
      "🔑 评分规则（权重 13%）：",
      "  · < 2.5% → +3（低通胀，降息空间大）",
      "  · 2.5%–3.0% → +1（温和通胀）",
      "  · 3.0%–3.5% → -1（偏高，美联储谨慎）",
      "  · ≥ 3.5% → -2（高通胀，加息压力，利空）",
    ],
  },
  score_etf: {
    title: "ETF 资金流向（评分维度）",
    content: [
      "📌 含义：GLD ETF 当日涨跌幅代表机构资金对黄金的态度。流入为正面信号，流出为负面信号。",
      "📡 来源：Yahoo Finance，代码 GLD（SPDR Gold Shares）。",
      "🔑 评分规则（权重 12%）：",
      "  · 流入（GLD +0.5% 以上）→ +2",
      "  · 持平（±0.5%）→ 0",
      "  · 流出（GLD -0.5% 以下）→ -2",
      "⚠️ 注意：若检测到 GLD 与 GC=F 方向矛盾 > 3%，判定数据无效，强制评分为 0。",
    ],
  },
  score_cot: {
    title: "COT 多头情绪（评分维度）",
    content: [
      "📌 含义：CFTC（美国商品期货交易委员会）发布的持仓报告（Commitments of Traders）中，黄金期货非商业净多头比例。反映大型投机者的情绪。",
      "📡 来源：CFTC 官方数据（cftc.gov），每周二截止，周五发布。后端通过解析 CFTC 周报获取。",
      "📐 计算：净多头比例 = 非商业净多头合约数 / (多头 + 空头总合约数) × 100%",
      "🔑 评分规则（权重 12%）：",
      "  · > 30%（极端多头）→ +2（注意情绪过热风险）",
      "  · 10%–30%（健康多头）→ +1",
      "  · -10%–10%（中性）→ 0",
      "  · ≤ -10%（净空头）→ -2",
    ],
  },
  score_vix: {
    title: "VIX 地缘风险（评分维度）",
    content: [
      "📌 含义：市场恐慌程度对黄金避险买盘的提振作用。",
      "📡 来源：Yahoo Finance，代码 ^VIX（CBOE 波动率指数）。",
      "🔑 评分规则（权重 10%）：",
      "  · > 25（高恐慌）→ +3（强避险需求）",
      "  · 20–25（偏高）→ +2",
      "  · 15–20（中性）→ 0",
      "  · < 15（低波动）→ -1",
      "⚠️ Risk-off 修正：若黄金当日跌幅 > 2%，判定为系统性抛售（股、债、商品同跌），VIX 避险加分自动归零并显示「避险失效」警示。",
    ],
  },
  // 技术指标
  tech_ma50: {
    title: "站上 50 日均线（MA50）",
    content: [
      "📌 含义：50 日简单移动平均线，代表中期趋势方向。价格站上 MA50 说明中期趋势向上。",
      "📡 来源：Yahoo Finance 历史日 K 线数据，系统自动计算最近 50 个交易日收盘均值。",
      "📐 计算：MA50 = 最近 50 个交易日收盘价之和 / 50",
      "🎯 意义：MA50 是机构常用趋势判断线。价格 > MA50 为中期多头，< MA50 为中期空头。",
    ],
  },
  tech_ma200: {
    title: "站上 200 日均线（MA200）",
    content: [
      "📌 含义：200 日简单移动平均线，代表长期主趋势。被称为「牛熊分界线」，是最重要的长期趋势指标之一。",
      "📡 来源：Yahoo Finance 历史日 K 线数据，计算最近 200 个交易日（约 1 年）收盘均值。",
      "📐 计算：MA200 = 最近 200 个交易日收盘价之和 / 200",
      "🎯 意义：黄金长期处于 MA200 上方，是牛市结构的基础判断。价格跌破 MA200 是重要的看空信号。",
    ],
  },
  tech_rsi: {
    title: "RSI 健康区间（35–65）",
    content: [
      "📌 含义：相对强弱指数（RSI，14 日），衡量价格涨跌动能是否过热或过冷。系统采用「健康区间」而非传统超买超卖阈值。",
      "📡 来源：Yahoo Finance 历史日 K 线数据，本地计算。",
      "📐 计算：",
      "  1. 计算每日涨跌额 delta",
      "  2. 14 日平均上涨幅度（avgGain）和平均下跌幅度（avgLoss）",
      "  3. RSI = 100 - 100 / (1 + avgGain/avgLoss)",
      "🔑 判断：RSI 35–65 为健康区间（动能适中，趋势可持续）。RSI < 35 或 > 65 算不满足（过热或过冷）。RSI < 30 单独标记为超卖。",
    ],
  },
  tech_rsi_div: {
    title: "RSI 底背离",
    content: [
      "📌 含义：价格创出新低，但 RSI 未同步创新低，形成正向背离（底背离），是潜在反转的技术信号。",
      "📡 来源：Yahoo Finance 历史日 K 线数据，后端 Python 计算（前端降级路径默认为 false）。",
      "📐 计算逻辑（后端）：比对最近 N 日价格低点与对应 RSI 低点，若价格低点下移但 RSI 低点上移，则触发底背离信号。",
      "⚠️ 注意：底背离是辅助信号，需配合其他指标确认。仅在后端模式下有效，降级路径（纯前端）恒为 false。",
    ],
  },
  tech_macd: {
    title: "MACD 多头（MACD > Signal）",
    content: [
      "📌 含义：MACD（移动平均汇聚散离指标）中的 DIF 线（快线）在 Signal 线（慢线）上方，代表短期动能优于中期动能，多头趋势延续。",
      "📡 来源：Yahoo Finance 历史日 K 线数据，本地计算。",
      "📐 计算：",
      "  · EMA12 = 12 日指数移动平均（平滑因子 2/13）",
      "  · EMA26 = 26 日指数移动平均（平滑因子 2/27）",
      "  · DIF（MACD线）= EMA12 - EMA26",
      "  · Signal 线 = DIF 的 9 日 EMA",
      "  · 系统判断：DIF > 0（即 EMA12 > EMA26）视为多头。",
      "⚠️ 注意：降级路径（前端直连）无法计算 Signal 线的历史 EMA，金叉（MACD Cross）信号始终为 false。",
    ],
  },
  tech_volume: {
    title: "量能放大（Volume Surge）",
    content: [
      "📌 含义：近期成交量明显放大，说明当前价格走势有资金支撑，趋势更可信。",
      "📡 来源：Yahoo Finance 历史日 K 线数据（volume 字段），本地计算。",
      "📐 计算：近 5 日平均成交量 > 近 20 日平均成交量 × 130%，则视为量能放大。",
      "🎯 意义：上涨放量（量价齐升）是强势信号；下跌缩量说明卖压有限；上涨缩量需警惕假突破。",
    ],
  },
};

// ─── Tab 导航配置 ─────────────────────────────────────────────────────────────
export const TABS = [
  { id: "overview",    label: "信号总览" },
  { id: "scoring",    label: "评分明细" },
  { id: "technical",  label: "技术指标" },
  { id: "calculator", label: "仓位计算" },
  { id: "sources",    label: "数据来源" },
];

// 评分层颜色映射
export const LAYER_COLOR = {
  "宏观结构": "#3b82f6",  // COLORS.blue
  "宏观节奏": "#f59e0b",  // COLORS.amber
  "情绪博弈": "#c9a84c",  // COLORS.gold
};

// 数据来源列表（Tab: 数据来源）
export const DATA_SOURCES_LIST = [
  { name: "Yahoo Finance API",      endpoint: "query1.finance.yahoo.com/v8/finance/chart/GC%3DF", data: "GC=F金价、DXY、GLD ETF", delay: "15分钟",   free: true,  key: false, quality: "好"  },
  { name: "FRED API",               endpoint: "api.stlouisfed.org/fred/series/observations",      data: "TIPS实际利率、CPI、美元指数",              delay: "日/月更新", free: true,  key: true,  quality: "最好" },
  { name: "CFTC COT数据",           endpoint: "cftc.gov/files/dea/history/",                      data: "黄金非商业净多头寸",                       delay: "每周五",   free: true,  key: false, quality: "最好" },
  { name: "Alpha Vantage",          endpoint: "alphavantage.co/query",                             data: "技术指标（可选增强）",                     delay: "实时~15分钟", free: true, key: true, quality: "好"  },
  { name: "Anthropic web search",   endpoint: "api.anthropic.com/v1/messages",                    data: "宏观数据降级兜底",                         delay: "不定",     free: false, key: false, quality: "差"  },
];
