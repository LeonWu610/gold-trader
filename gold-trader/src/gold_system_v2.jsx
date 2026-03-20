import { useState, useEffect, useCallback, useRef } from "react";

/**
 * 黄金交易系统 v2 — 真实数据版
 * ================================
 * 数据来源优先级：
 *   1. 本地后端 Python 脚本输出的 gold_signal.json（最准确）
 *   2. Yahoo Finance 非官方 JSON API（直接前端调用，无需key，15分钟延迟）
 *   3. FRED API（宏观数据，完全免费，需申请key）
 *   4. 降级：Anthropic web search（兜底，精度最低）
 */

const COLORS = {
  bg: "#0a0b0e", surface: "#111318", card: "#161a21",
  border: "#1e2330", borderLight: "#252d3d",
  gold: "#c9a84c", goldLight: "#e8c96e", goldDim: "#8a6e2e",
  green: "#22c55e", greenDim: "#166534",
  red: "#ef4444", redDim: "#7f1d1d",
  amber: "#f59e0b", amberDim: "#78350f",
  blue: "#3b82f6", blueDim: "#1e3a5f",
  text: "#e8eaf0", textSub: "#7a8299", textDim: "#4a5268",
};

const css = `
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

// ─── 各指标说明字典（含数据含义、来源、计算方法）───────────────────────────
const INFO_DICT = {
  // 顶部价格行
  "gold_price": {
    title: "黄金期货价格 GC=F",
    content: [
      "📌 含义：COMEX（纽约商品交易所）黄金期货主力合约的最新成交价，单位为美元/盎司。",
      "📡 来源：Yahoo Finance 非官方 JSON API（query1.finance.yahoo.com），与 Yahoo Finance 网页显示一致，延迟约 15 分钟。优先从本地 Python 后端（yfinance 库）获取。",
      "📐 计算：直接使用交易所实时报价，无需额外换算。涨跌幅 = (当前价 - 昨收价) / 昨收价 × 100%。",
      "⚠️ 注意：期货价格包含展期成本（contango/backwardation），与现货金价略有差异（通常差几美元）。",
    ]
  },
  "dxy": {
    title: "美元指数 DXY",
    content: [
      "📌 含义：衡量美元相对于一篮子主要货币（欧元、日元、英镑、加拿大元、瑞典克朗、瑞士法郎）的综合强弱。指数越高表示美元越强。",
      "📡 来源：Yahoo Finance，代码 DX-Y.NYB（ICE 美元指数期货）。若后端通过 FRED 获取则使用广义美元指数（DTWEXBGS），阈值会相应调整。",
      "📐 计算：以 1973 年 3 月为基期 100，欧元权重最大（57.6%）。与黄金呈显著负相关：美元升值通常压制金价。",
      "🔑 关键位：100 以下为弱美元利好黄金；100–106 中性；106 以上对黄金明显压制。",
    ]
  },
  "tips": {
    title: "TIPS 实际利率（DFII10）",
    content: [
      "📌 含义：10 年期通胀保值国债（TIPS）的收益率，代表剔除通胀预期后的真实资金成本。是黄金最重要的基本面指标之一。",
      "📡 来源：美联储经济数据库 FRED，序列代码 DFII10（10-Year Treasury Inflation-Indexed Security, Constant Maturity），每个交易日更新。",
      "📐 计算：TIPS 实际利率 = 名义国债收益率 - 通胀盈亏平衡率。当实际利率为负或极低时，持有黄金的机会成本接近零，对金价利好。",
      "🔑 评分规则：< 1.5% → +3（利好）；1.5%–2.0% → -1（中性偏负）；≥ 2.0% → -2（利空）。",
    ]
  },
  "cpi": {
    title: "美国 CPI 通胀率（CPIAUCSL）",
    content: [
      "📌 含义：美国城市消费者价格指数的同比涨幅（YoY%），反映整体通胀水平。",
      "📡 来源：FRED，序列代码 CPIAUCSL（Consumer Price Index for All Urban Consumers: All Items），美国劳工统计局每月发布，约滞后 5 周。",
      "📐 计算：YoY% = (最新月指数 / 12个月前指数 - 1) × 100。系统获取最近 14 条月度数据，用最新值与第 13 条（约 12 个月前）计算同比。",
      "🔑 评分规则：< 2.5% → +3（低通胀，美联储无压力降息）；2.5%–3.0% → +1；3.0%–3.5% → -1；≥ 3.5% → -2（高通胀，加息压力上升，压制金价）。",
    ]
  },
  // 信号总览
  "price_zone": {
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
    ]
  },
  "fed_cut": {
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
    ]
  },
  "etf_flow": {
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
    ]
  },
  "vix": {
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
    ]
  },
  "tech_summary": {
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
    ]
  },
  "key_levels": {
    title: "关键支撑位 / 阻力位",
    content: [
      "📌 含义：基于近 60 个交易日价格数据自动计算的动态价格区间。",
      "📐 计算方法：",
      "  · 支撑位 = 过去 60 个交易日的最低价（近三个月价格底部）",
      "  · 阻力位 = 过去 60 个交易日的最高价（近三个月价格顶部）",
      "  · ATR = 14 日平均真实波幅，用于定义支撑带宽度",
      "📡 来源：Yahoo Finance 历史日 K 线数据（yfinance 库），由后端 Python 计算。",
      "⚠️ 注意：这是纯价格统计区间，不代表强弱支撑。实际交易时应结合成交量、关键整数关口（如 3000、3100）综合判断。",
    ]
  },
  // 评分明细
  "score_tips": {
    title: "TIPS 实际利率（评分维度）",
    content: [
      "📌 含义：10 年期 TIPS 收益率。黄金无息资产，实际利率越低则持有黄金的机会成本越低，利好金价。",
      "📡 来源：FRED DFII10，每交易日更新。",
      "🔑 评分规则（权重 13%）：",
      "  · < 1.5% → +3（低实际利率，强利好）",
      "  · 1.5%–2.0% → -1（中性偏负）",
      "  · ≥ 2.0% → -2（高实际利率，持金成本高，利空）",
    ]
  },
  "score_dxy": {
    title: "美元指数（评分维度）",
    content: [
      "📌 含义：美元强弱对黄金的压制/提振作用。美元贬值时，以美元计价的黄金对外国买家变便宜，需求上升。",
      "📡 来源：Yahoo Finance DX-Y.NYB（ICE 美元指数期货）或 FRED 广义美元指数（DTWEXBGS）。",
      "🔑 评分规则（权重 13%）：",
      "  · DXY 模式：< 100 → +3；100–103 → +1；103–106 → -1；≥ 106 → -3",
      "  · FRED广义指数模式（阈值不同）：< 105 → +3；105–110 → +1；110–118 → -1；≥ 118 → -3",
    ]
  },
  "score_fed": {
    title: "降息预期（评分维度）",
    content: [
      "📌 含义：市场对美联储降息的预期强度。降息预期升温 → 美元走弱 + 实际利率下行 → 利好黄金。",
      "📡 来源：优先使用 ZQ=F 联邦基金期货推算；后端不可用时降级为 TIPS 线性插值。",
      "🔑 评分规则（权重 14%）：",
      "  · > 70% → +3（强降息预期）",
      "  · > 50% → +2（中等预期）",
      "  · > 30% → 0（中性）",
      "  · ≤ 30% → -2（维持/加息预期，利空）",
    ]
  },
  "score_cpi": {
    title: "CPI 通胀率（评分维度）",
    content: [
      "📌 含义：通胀适度时美联储有降息空间，利好黄金；通胀过高则加息压力上升，利空黄金。",
      "📡 来源：FRED CPIAUCSL，月度数据（美国劳工部发布），约滞后 5 周。",
      "🔑 评分规则（权重 13%）：",
      "  · < 2.5% → +3（低通胀，降息空间大）",
      "  · 2.5%–3.0% → +1（温和通胀）",
      "  · 3.0%–3.5% → -1（偏高，美联储谨慎）",
      "  · ≥ 3.5% → -2（高通胀，加息压力，利空）",
    ]
  },
  "score_etf": {
    title: "ETF 资金流向（评分维度）",
    content: [
      "📌 含义：GLD ETF 当日涨跌幅代表机构资金对黄金的态度。流入为正面信号，流出为负面信号。",
      "📡 来源：Yahoo Finance，代码 GLD（SPDR Gold Shares）。",
      "🔑 评分规则（权重 12%）：",
      "  · 流入（GLD +0.5% 以上）→ +2",
      "  · 持平（±0.5%）→ 0",
      "  · 流出（GLD -0.5% 以下）→ -2",
      "⚠️ 注意：若检测到 GLD 与 GC=F 方向矛盾 > 3%，判定数据无效，强制评分为 0。",
    ]
  },
  "score_cot": {
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
    ]
  },
  "score_vix": {
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
    ]
  },
  // 技术指标
  "tech_ma50": {
    title: "站上 50 日均线（MA50）",
    content: [
      "📌 含义：50 日简单移动平均线，代表中期趋势方向。价格站上 MA50 说明中期趋势向上。",
      "📡 来源：Yahoo Finance 历史日 K 线数据，系统自动计算最近 50 个交易日收盘均值。",
      "📐 计算：MA50 = 最近 50 个交易日收盘价之和 / 50",
      "🎯 意义：MA50 是机构常用趋势判断线。价格 > MA50 为中期多头，< MA50 为中期空头。",
    ]
  },
  "tech_ma200": {
    title: "站上 200 日均线（MA200）",
    content: [
      "📌 含义：200 日简单移动平均线，代表长期主趋势。被称为「牛熊分界线」，是最重要的长期趋势指标之一。",
      "📡 来源：Yahoo Finance 历史日 K 线数据，计算最近 200 个交易日（约 1 年）收盘均值。",
      "📐 计算：MA200 = 最近 200 个交易日收盘价之和 / 200",
      "🎯 意义：黄金长期处于 MA200 上方，是牛市结构的基础判断。价格跌破 MA200 是重要的看空信号。",
    ]
  },
  "tech_rsi": {
    title: "RSI 健康区间（35–65）",
    content: [
      "📌 含义：相对强弱指数（RSI，14 日），衡量价格涨跌动能是否过热或过冷。系统采用「健康区间」而非传统超买超卖阈值。",
      "📡 来源：Yahoo Finance 历史日 K 线数据，本地计算。",
      "📐 计算：",
      "  1. 计算每日涨跌额 delta",
      "  2. 14 日平均上涨幅度（avgGain）和平均下跌幅度（avgLoss）",
      "  3. RSI = 100 - 100 / (1 + avgGain/avgLoss)",
      "🔑 判断：RSI 35–65 为健康区间（动能适中，趋势可持续）。RSI < 35 或 > 65 算不满足（过热或过冷）。RSI < 30 单独标记为超卖。",
    ]
  },
  "tech_rsi_div": {
    title: "RSI 底背离",
    content: [
      "📌 含义：价格创出新低，但 RSI 未同步创新低，形成正向背离（底背离），是潜在反转的技术信号。",
      "📡 来源：Yahoo Finance 历史日 K 线数据，后端 Python 计算（前端降级路径默认为 false）。",
      "📐 计算逻辑（后端）：比对最近 N 日价格低点与对应 RSI 低点，若价格低点下移但 RSI 低点上移，则触发底背离信号。",
      "⚠️ 注意：底背离是辅助信号，需配合其他指标确认。仅在后端模式下有效，降级路径（纯前端）恒为 false。",
    ]
  },
  "tech_macd": {
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
    ]
  },
  "tech_volume": {
    title: "量能放大（Volume Surge）",
    content: [
      "📌 含义：近期成交量明显放大，说明当前价格走势有资金支撑，趋势更可信。",
      "📡 来源：Yahoo Finance 历史日 K 线数据（volume 字段），本地计算。",
      "📐 计算：近 5 日平均成交量 > 近 20 日平均成交量 × 130%，则视为量能放大。",
      "🎯 意义：上涨放量（量价齐升）是强势信号；下跌缩量说明卖压有限；上涨缩量需警惕假突破。",
    ]
  },
};

// ─── InfoModal 弹窗组件 ────────────────────────────────────────────────────────
const InfoModal = ({ info, onClose }) => {
  if (!info) return null;
  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, zIndex: 1000,
        background: "rgba(0,0,0,0.65)", backdropFilter: "blur(4px)",
        display: "flex", alignItems: "center", justifyContent: "center",
        padding: 24, animation: "fadeIn 0.15s ease",
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: COLORS.surface, border: `1px solid ${COLORS.borderLight}`,
          borderRadius: 12, padding: "24px 26px", maxWidth: 520, width: "100%",
          boxShadow: `0 24px 64px rgba(0,0,0,0.6), 0 0 0 1px ${COLORS.gold}20`,
          maxHeight: "80vh", overflowY: "auto",
        }}
      >
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 16, gap: 12 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: COLORS.goldLight, lineHeight: 1.4 }}>{info.title}</div>
          <button
            onClick={onClose}
            style={{ background: "transparent", border: "none", color: COLORS.textDim, cursor: "pointer", fontSize: 18, lineHeight: 1, flexShrink: 0, padding: "0 2px" }}
          >×</button>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {info.content.map((line, i) => (
            <div key={i} style={{ fontSize: 12.5, color: line.startsWith("  ·") || line.startsWith("  ") ? COLORS.textSub : COLORS.text, lineHeight: 1.7, paddingLeft: line.startsWith("  ") ? 8 : 0 }}>
              {line}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

// ─── InfoIcon 触发按钮 ─────────────────────────────────────────────────────────
const InfoIcon = ({ infoKey, onClick }) => (
  <span
    onClick={e => { e.stopPropagation(); onClick(INFO_DICT[infoKey]); }}
    title="点击查看指标说明"
    style={{
      display: "inline-flex", alignItems: "center", justifyContent: "center",
      width: 15, height: 15, borderRadius: "50%",
      border: `1px solid ${COLORS.textDim}60`, color: COLORS.textDim,
      fontSize: 9, cursor: "pointer", flexShrink: 0, lineHeight: 1,
      transition: "all 0.15s", userSelect: "none",
      fontFamily: "serif", fontWeight: "bold",
    }}
    onMouseEnter={e => { e.currentTarget.style.borderColor = COLORS.gold; e.currentTarget.style.color = COLORS.gold; }}
    onMouseLeave={e => { e.currentTarget.style.borderColor = `${COLORS.textDim}60`; e.currentTarget.style.color = COLORS.textDim; }}
  >i</span>
);

// ─── 数据源 1：Yahoo Finance 非官方 JSON API（前端直调，15分钟延迟）────────
// 这是 Yahoo Finance 内部用的查询接口，无需API Key，免费
// 与你在 Yahoo Finance 网页看到的数据来自同一数据源
const fetchYahooPrice = async (symbol) => {
  const proxyUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`;
  console.log(`[Yahoo] 请求 ${symbol}:`, proxyUrl);
  try {
    const resp = await fetch(proxyUrl);
    console.log(`[Yahoo] ${symbol} 响应状态:`, resp.status, resp.statusText);
    if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
    const data = await resp.json();
    console.log(`[Yahoo] ${symbol} 原始数据:`, data);
    if (!data.chart?.result?.[0]) throw new Error("chart.result 为空，可能被限流或symbol不存在");
    const meta = data.chart.result[0].meta;
    const quotes = data.chart.result[0].indicators.quote[0];
    const closes = quotes.close.filter(Boolean);
    const current = meta.regularMarketPrice;
    const prev = closes[closes.length - 2] || closes[closes.length - 1];
    const changePct = ((current - prev) / prev * 100);
    const result = {
      price: Math.round(current * 100) / 100,
      change_pct: Math.round(changePct * 100) / 100,
      high: Math.round(meta.regularMarketDayHigh * 100) / 100,
      low: Math.round(meta.regularMarketDayLow * 100) / 100,
      market_state: meta.marketState,
      exchange_delay: meta.exchangeTimezoneName,
      source: "Yahoo Finance（15min延迟）"
    };
    console.log(`[Yahoo] ${symbol} 解析结果:`, result);
    return result;
  } catch (err) {
    console.error(`[Yahoo] ❌ ${symbol} 失败:`, err.message);
    throw err;
  }
};

// ─── 数据源 2：FRED API（宏观数据，完全免费）──────────────────────────────
// 申请地址：https://fred.stlouisfed.org/docs/api/api_key.html（5分钟）
const FRED_KEY = "721dba314c828e61fa4d0bc748b32463"; // FRED API Key

const fetchFredSeries = async (seriesId, limit = 3) => {
  if (!FRED_KEY) {
    console.warn(`[FRED] ⚠️ ${seriesId} 跳过：未配置 FRED_KEY`);
    return null;
  }
  const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${seriesId}&api_key=${FRED_KEY}&file_type=json&limit=${limit}&sort_order=desc`;
  console.log(`[FRED] 请求 ${seriesId}:`, url);
  try {
    const resp = await fetch(url);
    console.log(`[FRED] ${seriesId} 响应状态:`, resp.status, resp.statusText);
    const data = await resp.json();
    console.log(`[FRED] ${seriesId} 原始数据:`, data);
    if (data.error_message) throw new Error(`FRED API错误: ${data.error_message}`);
    const obs = (data.observations || []).filter(o => o.value !== ".");
    if (!obs.length) {
      console.warn(`[FRED] ${seriesId} 无有效观测值`);
      return null;
    }
    // CPI 同比计算：需要13条数据（最新月 + 12个月前）
    if (seriesId === "CPIAUCSL" && obs.length >= 13) {
      const latest   = parseFloat(obs[0].value);
      const yearAgo  = parseFloat(obs[12].value);
      const yoy = parseFloat(((latest - yearAgo) / yearAgo * 100).toFixed(2));
      console.log(`[FRED] CPIAUCSL 同比: ${yoy}% (${latest} / ${yearAgo})`);
      return { value: yoy, date: obs[0].date, index: latest };
    }
    const result = { value: parseFloat(obs[0].value), date: obs[0].date };
    console.log(`[FRED] ${seriesId} 解析结果:`, result);
    return result;
  } catch (err) {
    console.error(`[FRED] ❌ ${seriesId} 失败:`, err.message);
    throw err;
  }
};

// ─── 数据源 3：降级到 Anthropic web search（无API Key场景兜底）──────────
const fetchViaAnthropicSearch = async (query) => {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 800,
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      messages: [{ role: "user", content: query + "\n只返回纯JSON，无解释。" }]
    })
  });
  const data = await response.json();
  const text = data.content.filter(b => b.type === "text").map(b => b.text).join("");
  const match = text.match(/\{[\s\S]*?\}/);
  return match ? JSON.parse(match[0]) : null;
};

// ─── 数据源 0：Python 后端（本地或云端）──────────────────────────────────
// 优先级：
//   1. 环境变量 REACT_APP_BACKEND_URL（部署到 Railway 时设置）
//   2. 本地开发默认 localhost:5001
const BACKEND_BASE = process.env.REACT_APP_BACKEND_URL || "http://localhost:5001";
const LOCAL_API = `${BACKEND_BASE}/api/gold`;

const fetchFromLocalBackend = async (onProgress) => {
  onProgress("正在连接本地 Python 后端...");
  console.log("[Local] 尝试连接本地后端:", LOCAL_API);
  const resp = await fetch(LOCAL_API, { signal: AbortSignal.timeout(35000) });
  if (!resp.ok) throw new Error(`本地后端响应 ${resp.status}`);
  const raw = await resp.json();
  console.log("[Local] ✅ 本地后端原始数据:", raw);

  // 将 Python 后端的数据结构适配为前端期望的格式
  const pd = raw.data_sources?.price || {};
  const fd = raw.data_sources?.macro || {};
  const td = raw.data_sources?.technical || {};

  const gold = pd["GC=F"] || {};
  const dxy  = pd["DX-Y.NYB"] || {};
  const gld  = pd["GLD"] || {};

  // 动态读取每个数据的实际来源
  const goldSource  = gold.source  || "Yahoo Finance";
  const dxySource   = dxy.source   || "Yahoo Finance";
  const techSource  = td.source    || (goldSource === "Yahoo Finance" ? "Yahoo Finance历史数据" : "Polygon.io历史数据");

  return {
    price: {
      gold: { price: gold.price, change_pct: gold.change_pct, market_state: "BACKEND", source: goldSource },
      dxy:  { price: dxy.price,  change_pct: dxy.change_pct, source: dxySource },
      gld:  { price: gld.price,  change_pct: gld.change_pct, etf_flow: gld.etf_flow },
    },
    macro: {
      tips:             fd["DFII10"]?.value,
      tips_date:        fd["DFII10"]?.date,
      cpi:              fd["CPIAUCSL"]?.value,      // 正常同比值如 2.83，数据不足时为 null
      cpi_date:         fd["CPIAUCSL"]?.date,
      breakeven:        fd["T10YIE"]?.value,
      // 从 signal 字段读取推算值和真实 ETF 流向
      fed_cut_prob:     raw.signal?.fed_cut_prob_est ?? null,
      fed_cut_source:   raw.signal?.fed_cut_source ?? null,
      etf_flow:         raw.signal?.etf_flow ?? null,
      central_bank_buying: null,  // 明确无数据（WGC季度更新，仅作展示）
      // VIX 地缘风险（后端已计算）
      vix_value:        raw.signal?.vix?.value      ?? null,
      vix_risk_level:   raw.signal?.vix?.risk_level ?? null,
      vix_date:         raw.signal?.vix?.date       ?? null,
      // COT 持仓情绪（CFTC 官方，每周五更新）
      cot_net_long:     raw.signal?.cot?.net_long     ?? null,
      cot_net_pct:      raw.signal?.cot?.net_long_pct ?? null,
      cot_sentiment:    raw.signal?.cot?.sentiment    ?? null,
      cot_date:         raw.signal?.cot?.report_date  ?? null,
    },
    tech: {
      price:       td.price,
      ma20:        td.ma20,  ma50: td.ma50,  ma200: td.ma200,
      above_ma20:  td.above_ma20,
      above_ma50:  td.above_ma50,
      above_ma200: td.above_ma200,
      rsi:         td.rsi,
      rsi_healthy: td.rsi >= 35 && td.rsi <= 65,
      rsi_oversold: td.rsi < 30,
      rsi_divergence: td.rsi_divergence,   // 底背离信号（后端已计算）
      macd_positive: td.macd_above_signal,
      macd_cross:   td.macd_cross,         // 金叉信号
      atr:         td.atr,                 // ATR波动率，用于动态支撑带
      support:     td.support,
      resistance:  td.resistance,
      volume_surge: td.volume_surge,
      source:      techSource,
    },
    // 后端已计算的布尔判断，前端直接读取避免重复硬编码
    _signal: {
      in_support:       raw.signal?.in_support        ?? null,
      in_deep_support:  raw.signal?.in_deep_support   ?? null,
      breakout:         raw.signal?.breakout           ?? null,
      // 后端综合评分：直接使用，跳过前端重复计算（避免权重不一致）
      normalized_score: raw.signal?.normalized_score  ?? null,
      tech_score:       raw.signal?.tech_score        ?? null,
      action:           raw.signal?.action            ?? null,
      // 数据可靠性标记
      etf_data_valid:   raw.signal?.etf_data_valid    ?? true,   // false = GLD/GC=F方向矛盾，ETF流向不可靠
      vix_risk_off:     raw.signal?.vix_risk_off      ?? false,  // true = 黄金同步下跌，VIX避险失效
    },
    sources: {
      price: `行情: ${goldSource} | DXY: ${dxySource} | ETF: ${pd["GLD"]?.source || "Yahoo Finance"}`,
      macro: "FRED API（官方数据）",
      tech:  `技术指标: ${techSource} + 本地计算`,
    }
  };
};

// ─── 主数据抓取器（优先级：本地后端 → FRED直连 → 降级）────────────────────
const fetchAllData = async (onProgress) => {

  // 优先级 1：本地 Python 后端（yfinance + FRED，无 CORS 问题）
  try {
    const data = await fetchFromLocalBackend(onProgress);
    console.log("[fetchAllData] ✅ 使用本地 Python 后端数据");
    return data;
  } catch (e) {
    console.warn("[fetchAllData] 本地后端不可用，降级到直连模式:", e.message);
    onProgress("本地后端未启动，切换到直连模式...");
  }

  const result = { price: null, macro: null, tech: null, sources: {} };

  // 优先级 2：Yahoo Finance 直连（可能受 CORS 限制）
  onProgress("正在从 Yahoo Finance 直连获取金价...");
  console.log("[Step1] 尝试 Yahoo Finance 直连");
  try {
    const [gold, dxy, gld] = await Promise.all([
      fetchYahooPrice("GC=F"),
      fetchYahooPrice("DX-Y.NYB"),
      fetchYahooPrice("GLD"),
    ]);
    result.price = { gold, dxy, gld };
    result.sources.price = "Yahoo Finance API（直连）";
    console.log("[Step1] ✅ Yahoo Finance 直连成功", result.price);
  } catch (e) {
    console.error("[Step1] ❌ Yahoo Finance 直连失败（CORS/403）:", e.message);
    result.sources.price = "Yahoo Finance 被CORS拦截，请启动本地后端";
  }

  // 优先级 2：FRED 直连（FRED 支持跨域，通常可以成功）
  onProgress("正在从 FRED 直连获取宏观数据...");
  console.log("[Step2] 尝试 FRED 直连, Key:", FRED_KEY ? `${FRED_KEY.slice(0,8)}...` : "未配置");
  try {
    if (!FRED_KEY) throw new Error("FRED key 未配置");
    const [tips, cpi, breakeven] = await Promise.all([
      fetchFredSeries("DFII10"),
      fetchFredSeries("CPIAUCSL", 14),   // 需要14条才能算出同比（最新月 + 12个月前）
      fetchFredSeries("T10YIE"),
    ]);
    const tipsVal = tips?.value ?? 1.9;
    // CPI 安全校验：>20 说明拿到了原始指数，视为无效
    const cpiVal = (cpi?.value !== null && cpi?.value !== undefined && cpi?.value < 20)
      ? cpi?.value : null;
    result.macro = {
      tips:         tips?.value,   tips_date: tips?.date,
      cpi:          cpiVal,        cpi_date:  cpi?.date,
      breakeven:    breakeven?.value,
      // 与后端逻辑保持一致：用 TIPS 推算降息概率（降级路径无ZQ=F期货）
      fed_cut_prob: Math.max(10, Math.min(90, Math.round(100 - tipsVal * 30))),
      fed_cut_source: "TIPS推算（降级模式）",
      // ETF 流向：降级路径只有价格涨跌数据，用 change_pct 粗略判断
      etf_flow: (result.price?.gld?.change_pct ?? 0) > 0.5  ? "流入"
              : (result.price?.gld?.change_pct ?? 0) < -0.5 ? "流出"
              : "持平",
      central_bank_buying: null,  // 无数据
      // 降级路径无VIX数据，地缘风险字段留空
      vix_value: null,
      vix_risk_level: null,
    };
    result.sources.macro = "FRED API（直连）";
    console.log("[Step2] ✅ FRED 直连成功", result.macro);
  } catch (e) {
    console.error("[Step2] ❌ FRED 直连失败:", e.message);
    result.sources.macro = "FRED 获取失败";
  }

  // 优先级 2：技术指标（Yahoo Finance 历史数据，同样受 CORS 限制）
  onProgress("正在计算技术指标...");
  console.log("[Step3] 尝试 Yahoo Finance 历史数据直连");
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/GC%3DF?interval=1d&range=1y`;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    const closes  = data.chart.result[0].indicators.quote[0].close.filter(Boolean);
    const volumes = data.chart.result[0].indicators.quote[0].volume.filter(Boolean);
    const highs   = data.chart.result[0].indicators.quote[0].high.filter(Boolean);
    const lows    = data.chart.result[0].indicators.quote[0].low.filter(Boolean);
    const current = closes[closes.length - 1];
    const sma = (arr, n) => arr.slice(-n).reduce((a,b)=>a+b,0)/n;
    const ma20  = sma(closes, 20);
    const ma50  = sma(closes, Math.min(50, closes.length));
    const ma200 = sma(closes, Math.min(200, closes.length));
    const deltas = closes.slice(1).map((v,i) => v - closes[i]);
    const gains  = deltas.map(d => d > 0 ? d : 0).slice(-14);
    const losses = deltas.map(d => d < 0 ? -d : 0).slice(-14);
    const avgGain = gains.reduce((a,b)=>a+b,0)/14;
    const avgLoss = losses.reduce((a,b)=>a+b,0)/14;
    const rsi = avgLoss === 0 ? 100 : Math.round(100 - 100/(1+avgGain/avgLoss));
    const recentCloses = closes.slice(-40);
    let ema12 = recentCloses[0], ema26 = recentCloses[0];
    for(let c of recentCloses) {
      ema12 = ema12 * (1 - 2/13) + c * (2/13);
      ema26 = ema26 * (1 - 2/27) + c * (2/27);
    }
    // ATR(14): 简化版（仅用 high-low 代替真实 TrueRange，降级时精度够用）
    const recentHLs = highs.slice(-14).map((h,i)=>h - lows.slice(-14)[i]);
    const atrVal = Math.round(recentHLs.reduce((a,b)=>a+b,0)/recentHLs.length * 100)/100;
    const supportVal    = Math.round(Math.min(...lows.slice(-60)));
    const resistanceVal = Math.round(Math.max(...highs.slice(-60)));
    result.tech = {
      price: Math.round(current * 100)/100,
      ma20: Math.round(ma20), ma50: Math.round(ma50), ma200: Math.round(ma200),
      above_ma20: current > ma20, above_ma50: current > ma50, above_ma200: current > ma200,
      rsi, rsi_healthy: rsi >= 35 && rsi <= 65, rsi_oversold: rsi < 30,
      rsi_divergence: false,  // 降级路径无法计算底背离，置为 false
      macd_positive: ema12 > ema26,
      macd_cross: false,      // 降级路径无前一日信号线，无法判断金叉
      atr: atrVal,
      support: supportVal,
      resistance: resistanceVal,
      volume_surge: sma(volumes, 5) > sma(volumes, 20) * 1.3,
      source: "Yahoo Finance历史数据（直连）"
    };
    result.sources.tech = "Yahoo Finance历史数据（直连）";
    console.log("[Step3] ✅ 技术指标计算成功", result.tech);
  } catch (e) {
    console.error("[Step3] ❌ 技术指标直连失败（CORS/403）:", e.message);
    result.sources.tech = "Yahoo Finance 被CORS拦截，请启动本地后端";
  }

  return result;
};

// ─── 评分计算 ────────────────────────────────────────────────────────────────
const computeScore = (data) => {
  if (!data.price || !data.macro || !data.tech) return null;

  const goldPrice = data.price.gold?.price || data.price.gold_price || 0;
  const dxyVal    = data.price.dxy?.price || 104;
  const dxySource = data.price.dxy?.source || "Yahoo Finance";
  const tips      = data.macro.tips || 1.9;

  // CPI：安全校验，>20 说明拿到了原始指数，视为无效
  const cpiRaw  = data.macro.cpi;
  const cpi     = (cpiRaw !== null && cpiRaw !== undefined && cpiRaw < 20) ? cpiRaw : null;

  // 降息预期：从后端推算值读取，没有则不默认
  const fedProb = data.macro.fed_cut_prob ?? null;

  // ETF 流向：从后端真实数据读取，没有则不默认
  const etfFlow = data.macro.etf_flow ?? null;

  // 央行购金：WGC季度数据延迟太大，改为纯展示字段（不参与评分）
  // 保留字段供未来展示使用
  const cbBuying = data.macro.central_bank_buying ?? null;

  const scoreItems = [
    { layer:"宏观结构", name:"TIPS实际利率",
      value:`${(+tips).toFixed(2)}%`,
      score: tips<1.5?3:tips<2.0?-1:-2,
      weight: 0.13, infoKey: "score_tips" },
    { layer:"宏观结构", name:`美元指数${dxySource==="FRED"?"(广义指数)":"DXY"}`,
      value:(+dxyVal).toFixed(1),
      score: dxySource==="FRED"
        ? (dxyVal<105?3:dxyVal<110?1:dxyVal<118?-1:-3)
        : (dxyVal<100?3:dxyVal<103?1:dxyVal<106?-1:-3),
      weight: 0.13, infoKey: "score_dxy" },
    // 央行购金已移除，改为独立展示字段（WGC季度更新，不适合做日度评分因子）
    // ⚠️ 各项无数据时 score=0 但 weight 始终保留，防止分母缩水导致评分虚高
    { layer:"宏观节奏",
      name: data.macro.fed_cut_source
        ? `降息预期（${data.macro.fed_cut_source}）`
        : (fedProb !== null ? "降息预期（TIPS推算）" : "降息预期"),
      value: fedProb !== null ? `${fedProb}%` : "获取中…",
      score: fedProb===null?0: fedProb>70?3:fedProb>50?2:fedProb>30?0:-2,
      weight: 0.14, infoKey: "score_fed" },
    { layer:"宏观节奏", name:"CPI通胀率",
      value: cpi !== null ? `${(+cpi).toFixed(2)}%` : "数据异常",
      score: cpi===null?0: cpi<2.5?3:cpi<3.0?1:cpi<3.5?-1:-2,
      weight: 0.13, infoKey: "score_cpi" },
    { layer:"情绪博弈", name:"ETF资金流向",
      value: etfFlow ?? "无数据",
      score: etfFlow==="流入"?2:etfFlow==="流出"?-2:etfFlow==="持平"?0:0,
      weight: 0.12, infoKey: "score_etf" },
    // COT: 数据来自后端 CFTC 解析，这里用 data.macro（computeScore 函数参数）而不是 macroData
    // 评分区间与后端 compute_signal_score 保持一致：
    //   > 30%  → score=2（极端多头，情绪过热）
    //   > 10%  → score=1（健康多头）
    //   > -10% → score=0（中性）
    //   ≤ -10% → score=-2（空头）
    { layer:"情绪博弈", name:`COT多头情绪${data.macro?.cot_date ? `（${data.macro.cot_date}）` : ""}`,
      value: data.macro?.cot_net_pct != null
        ? `${data.macro.cot_net_pct > 0 ? "+" : ""}${data.macro.cot_net_pct.toFixed(1)}% 净多`
        : data.macro?.cot_sentiment ?? "无数据（需后端模式）",
      score: data.macro?.cot_net_pct != null
        ? (data.macro.cot_net_pct > 30 ? 2 : data.macro.cot_net_pct > 10 ? 1 : data.macro.cot_net_pct > -10 ? 0 : -2)
        : 0,
      weight: 0.12, infoKey: "score_cot"
    },
    // VIX 地缘风险：来自后端 ^VIX 指数（与后端 layer 保持一致：宏观结构）
    // 评分与后端对齐: VIX>25+金价未大跌→score=3, VIX>20→score=2, >15→score=0, 其他→score=-1
    // risk-off場景（黄金同步大跌）展示由后端 vix_risk_off 控制，前端只做展示
    { layer:"宏观结构",
      name: `VIX地缘风险${data.macro?.vix_value != null ? `（当前${data.macro.vix_value}）` : ""}`,
      value: data.macro?.vix_value != null
        ? `${data.macro.vix_risk_level}风险 · VIX ${data.macro.vix_value}`
        : "无数据（需后端模式）",
      score: data.macro?.vix_value != null
        ? (data.macro.vix_value > 25 ? 3 : data.macro.vix_value > 20 ? 2 : data.macro.vix_value > 15 ? 0 : -1)
        : 0,
      weight: 0.10, infoKey: "score_vix"
    },
  ];

  // 权重归一化，避免无数据字段压缩评分范围
  const totalWeight = scoreItems.reduce((s,i) => s + i.weight, 0);
  const weighted = totalWeight > 0
    ? scoreItems.reduce((s,i) => s + i.score*i.weight, 0) / totalWeight
    : 0;
  const normalized = Math.round(weighted * 15);  // 映射到 ±15

  // 与后端 compute_signal_score tech_score_raw 完全对齐：
  //   [above_ma200, above_ma50, rsi_healthy, rsi_divergence, macd_above_signal, volume_surge]
  // 注意：后端用 rsi_divergence（底背离），前端之前错误地用了 rsi_oversold（超卖），现已修正
  const techItems = [
    data.tech.above_ma200, data.tech.above_ma50,
    data.tech.rsi_healthy, data.tech.rsi_divergence || false,
    data.tech.macd_positive, data.tech.volume_surge,
  ];
  const techScore = techItems.filter(Boolean).length;

  // 动态支撑阻力：优先用后端传回的计算值，避免硬编码
  // 后端 signal 里已含 in_support / in_deep_support / breakout 布尔值
  // 这里在前端也保留一套计算逻辑作为降级（后端未启动时仍然工作）
  const techSupport    = data.tech?.support    || 0;
  const techResistance = data.tech?.resistance || 0;
  const atr            = data.tech?.atr        || 0;
  const supportBand    = atr > 0 ? atr * 2 : techSupport * 0.03;

  // 优先用后端已计算的布尔值；后端不可用时本地计算
  const inSupport      = data._signal?.in_support      ??
    (techSupport > 0 && goldPrice >= techSupport && goldPrice <= techSupport + supportBand);
  const inDeepSupport  = data._signal?.in_deep_support ??
    (techSupport > 0 && goldPrice < techSupport && goldPrice >= techSupport * 0.97);
  const breakout       = data._signal?.breakout        ??
    (techResistance > 0 && goldPrice >= techResistance * 0.98);

  // ── 优先使用后端计算的综合评分（包含 VIX/COT 等前端无法直接算到的权重）
  // 后端不可用（降级路径）时才退回前端本地计算结果
  const normalizedFinal = data._signal?.normalized_score ?? normalized;
  const techScoreFinal  = data._signal?.tech_score       ?? techScore;

  // 交易信号文案：优先用后端 action 文字，但颜色和描述在前端本地生成
  const backendAction = data._signal?.action ?? null;

  let action, actionColor, actionDesc;
  if (breakout && normalizedFinal >= 4 && techScoreFinal >= 3) {
    const resStr = techResistance ? `$${techResistance.toLocaleString()}` : "阻力位";
    action="追多突破"; actionColor=COLORS.green; actionDesc=`价格有效突破${resStr}，趋势延续做多`;
  } else if ((inSupport||inDeepSupport) && normalizedFinal>=3 && techScoreFinal>=3) {
    const supStr = techSupport ? `$${techSupport.toLocaleString()}` : "支撑区";
    action="建仓做多"; actionColor=COLORS.gold; actionDesc=`${supStr}支撑+技术确认叠加，分批建仓`;
  } else if ((inSupport||inDeepSupport) && normalizedFinal>=2 && techScoreFinal>=2) {
    action="试探轻仓"; actionColor=COLORS.amber; actionDesc="条件初步满足，轻仓试探，等信号叠加";
  } else if (normalizedFinal<0) {
    action="观望空仓"; actionColor=COLORS.red; actionDesc="基本面转弱，等待评分回升";
  } else {
    action="持仓观望"; actionColor=COLORS.textSub; actionDesc="价格未到支撑区或信号不足，耐心等待";
  }
  // 如果后端 action 与前端推导不同，以后端为准（后端掌握完整权重）
  if (backendAction && backendAction !== action) {
    action = backendAction;
  }

  return { scoreItems, normalized: normalizedFinal, techScore: techScoreFinal,
           techItems, goldPrice, action, actionColor, actionDesc,
           techSupport, techResistance, inSupport, inDeepSupport, breakout };
};

// ─── UI 组件 ─────────────────────────────────────────────────────────────────
const Spinner = ({ size=14 }) => (
  <div style={{width:size,height:size,border:`1.5px solid ${COLORS.border}`,borderTop:`1.5px solid ${COLORS.gold}`,borderRadius:"50%",animation:"spin 0.8s linear infinite",display:"inline-block",flexShrink:0}}/>
);

const Tag = ({ text, color, bg }) => (
  <span style={{fontSize:11,fontFamily:"'Space Mono',monospace",padding:"2px 8px",borderRadius:3,background:bg,color,letterSpacing:"0.04em"}}>{text}</span>
);

const MetricCard = ({ label, value, sub, subColor, loading, infoKey, onInfo }) => (
  <div style={{background:COLORS.card,border:`0.5px solid ${COLORS.border}`,borderRadius:8,padding:"14px 16px"}}>
    <div style={{fontSize:11,color:COLORS.textDim,marginBottom:8,letterSpacing:"0.03em",display:"flex",alignItems:"center",gap:5}}>
      {label}
      {infoKey && onInfo && <InfoIcon infoKey={infoKey} onClick={onInfo}/>}
    </div>
    {loading ? <div className="shimmer" style={{height:26,width:"65%"}}/> :
      <div style={{fontSize:20,fontWeight:700,fontFamily:"'Space Mono',monospace",color:COLORS.text,letterSpacing:"-0.02em"}}>{value ?? "—"}</div>}
    {sub && !loading && <div style={{fontSize:11,color:subColor||COLORS.textDim,marginTop:4}}>{sub}</div>}
  </div>
);

const ScoreRow = ({ item, onInfo }) => {
  const pct = ((item.score + 3) / 6) * 100;
  const color = item.score>=2?COLORS.green:item.score>=0?COLORS.amber:COLORS.red;
  return (
    <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:9}}>
      <div style={{minWidth:140,fontSize:12,color:COLORS.textSub,display:"flex",alignItems:"center",gap:4}}>
        <span style={{flex:1,minWidth:0}}>{item.name}</span>
        {item.infoKey && onInfo && <InfoIcon infoKey={item.infoKey} onClick={onInfo}/>}
      </div>
      <div style={{minWidth:56,fontSize:11,fontFamily:"'Space Mono',monospace",color:COLORS.text}}>{item.value}</div>
      <div style={{flex:1,height:3,background:COLORS.border,borderRadius:2,overflow:"hidden"}}>
        <div style={{width:`${Math.max(4,pct)}%`,height:"100%",background:color,borderRadius:2,transition:"width 0.5s"}}/>
      </div>
      <div style={{minWidth:28,fontSize:12,fontFamily:"'Space Mono',monospace",textAlign:"right",color}}>{item.score>0?`+${item.score}`:item.score}</div>
    </div>
  );
};

// ─── 主应用 ───────────────────────────────────────────────────────────────────
export default function GoldSystemV2() {
  const [rawData, setRawData] = useState(null);
  const [progress, setProgress] = useState("");
  const [loading, setLoading] = useState(false);
  const [sources, setSources] = useState({});
  const [lastUpdated, setLastUpdated] = useState(null);
  const [activeTab, setActiveTab] = useState("overview");
  const [rrCalc, setRrCalc] = useState({entry:4760,stop:4620,target:5100,capital:100000,riskPct:1});
  const [infoModal, setInfoModal] = useState(null); // { title, content[] } | null

  const loadData = useCallback(async () => {
    setLoading(true);
    setProgress("初始化数据管道...");
    try {
      const result = await fetchAllData(setProgress);
      setRawData(result);
      setSources(result.sources || {});
      setLastUpdated(new Date().toLocaleTimeString("zh-CN", {hour:"2-digit",minute:"2-digit",second:"2-digit"}));
    } catch(e) {
      setProgress(`错误: ${e.message}`);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    loadData();
    const timer = setInterval(loadData, 15 * 60 * 1000);
    return () => clearInterval(timer);
  }, [loadData]);

  const analysis = rawData ? computeScore(rawData) : null;
  const goldData = rawData?.price?.gold;
  const dxyData = rawData?.price?.dxy;
  const techData = rawData?.tech;
  const macroData = rawData?.macro;

  // R:R 计算
  const rr = (() => {
    const {entry,stop,target,capital,riskPct} = rrCalc;
    const risk = entry-stop, reward = target-entry;
    if(risk<=0||reward<=0) return null;
    const ratio = (reward/risk).toFixed(2);
    const maxLoss = capital*(riskPct/100);
    const sizeOz = Math.floor(maxLoss/risk);
    return {
      ratio, sizeOz,
      maxLoss: Math.round(maxLoss).toLocaleString(),
      gain: Math.round(sizeOz*reward).toLocaleString(),
      good: parseFloat(ratio)>=2
    };
  })();

  const layerColor = {"宏观结构":COLORS.blue,"宏观节奏":COLORS.amber,"情绪博弈":COLORS.gold};
  const tabs = [{id:"overview",label:"信号总览"},{id:"scoring",label:"评分明细"},{id:"technical",label:"技术指标"},{id:"calculator",label:"仓位计算"},{id:"sources",label:"数据来源"}];

  return (
    <>
      <style>{css}</style>
      <div style={{minHeight:"100vh",background:COLORS.bg,paddingBottom:48}}>

        {/* Header */}
        <div style={{borderBottom:`1px solid ${COLORS.border}`,background:`${COLORS.surface}ee`,backdropFilter:"blur(12px)",padding:"12px 24px",display:"flex",alignItems:"center",justifyContent:"space-between",position:"sticky",top:0,zIndex:100}}>
          <div style={{display:"flex",alignItems:"center",gap:10}}>
            <div style={{width:7,height:7,borderRadius:"50%",background:COLORS.gold,boxShadow:`0 0 8px ${COLORS.gold}`,animation:loading?"pulse 1s infinite":"none"}}/>
            <span style={{fontFamily:"'Space Mono',monospace",fontSize:12,color:COLORS.gold,letterSpacing:"0.1em"}}>GOLD SIGNAL ENGINE v2</span>
            {lastUpdated && <span style={{fontSize:11,color:COLORS.textDim}}>更新于 {lastUpdated}（15分钟自动刷新）</span>}
          </div>
          <div style={{display:"flex",gap:8,alignItems:"center"}}>
            {loading && <><Spinner/><span style={{fontSize:11,color:COLORS.textDim}}>{progress}</span></>}
            <button onClick={loadData} disabled={loading} style={{background:"transparent",border:`0.5px solid ${COLORS.borderLight}`,color:COLORS.textSub,fontSize:11,padding:"5px 12px",borderRadius:4,cursor:"pointer",fontFamily:"'Space Mono',monospace"}}>
              {loading?"获取中...":"立即刷新"}
            </button>
          </div>
        </div>

        <div style={{maxWidth:980,margin:"0 auto",padding:"20px 20px 0"}}>

          {/* 数据源提示条 */}
          {rawData && (
            <div style={{background:`${COLORS.blueDim}30`,border:`0.5px solid ${COLORS.blue}30`,borderRadius:6,padding:"8px 14px",marginBottom:16,fontSize:11,color:COLORS.textDim,display:"flex",gap:16,flexWrap:"wrap"}}>
              <span>金价: <span style={{color:COLORS.text}}>{sources.price||"—"}</span></span>
              <span>宏观: <span style={{color:FRED_KEY?COLORS.green:COLORS.amber}}>{sources.macro||"—"}</span></span>
              <span>技术: <span style={{color:COLORS.text}}>{sources.tech||"—"}</span></span>
              {!FRED_KEY && <span style={{color:COLORS.amber}}>⚠ 填入 FRED_KEY 可获取官方宏观数据</span>}
            </div>
          )}

          {/* 价格行 */}
          <div style={{display:"grid",gridTemplateColumns:"repeat(4,minmax(0,1fr))",gap:10,marginBottom:16}}>
            <MetricCard label="黄金期货 GC=F" loading={loading&&!goldData}
              value={goldData?`$${goldData.price?.toLocaleString()}`:"—"}
              sub={goldData?`${goldData.change_pct>=0?"+":""}${goldData.change_pct?.toFixed(2)}% · ${goldData.market_state}`:null}
              subColor={goldData?.change_pct>=0?COLORS.green:COLORS.red}
              infoKey="gold_price" onInfo={setInfoModal}/>
            <MetricCard label="美元指数 DX-Y" loading={loading&&!dxyData}
              value={dxyData?.price?.toFixed(2)||"—"}
              sub="关键位 100 / 106"
              infoKey="dxy" onInfo={setInfoModal}/>
            <MetricCard label="TIPS 实际利率" loading={loading&&!macroData}
              value={macroData?.tips?`${(+macroData.tips).toFixed(2)}%`:(macroData?.tips_yield?`${macroData.tips_yield}%`:"—")}
              sub={macroData?.tips_date||"FRED DFII10"}
              infoKey="tips" onInfo={setInfoModal}/>
            <MetricCard label="美国 CPI" loading={loading&&!macroData}
              value={macroData?.cpi?`${(+macroData.cpi).toFixed(1)}%`:"—"}
              sub={macroData?.cpi_date||"FRED CPIAUCSL"}
              infoKey="cpi" onInfo={setInfoModal}/>
          </div>

          {/* 主决策卡片 */}
          {analysis && (
            <div style={{background:COLORS.card,border:`0.5px solid ${analysis.actionColor}40`,borderRadius:10,padding:"18px 22px",marginBottom:16,boxShadow:`0 0 40px ${analysis.actionColor}08`,animation:"fadeIn 0.4s ease"}}>
              <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",flexWrap:"wrap",gap:16}}>
                <div>
                  <div style={{fontSize:11,color:COLORS.textDim,marginBottom:6,letterSpacing:"0.06em"}}>综合交易信号</div>
                  <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:6}}>
                    <span style={{fontSize:26,fontWeight:700,fontFamily:"'Space Mono',monospace",color:analysis.actionColor,textShadow:`0 0 20px ${analysis.actionColor}50`}}>{analysis.action}</span>
                  </div>
                  <div style={{fontSize:13,color:COLORS.textSub}}>{analysis.actionDesc}</div>
                  {/* 高分但不在入场区：解释性提示，防止用户误解 */}
                  {analysis.normalized >= 4 && analysis.action === "持仓观望" && (
                    <div style={{marginTop:8,fontSize:11,color:COLORS.amber,background:`${COLORS.amber}12`,border:`0.5px solid ${COLORS.amber}30`,borderRadius:4,padding:"5px 10px",display:"inline-block"}}>
                      ⚠ 宏观评分较高，但价格偏离支撑区，等待价格回调至支撑位再行入场
                    </div>
                  )}
                </div>
                <div style={{display:"flex",gap:24}}>
                  <div style={{textAlign:"center"}}>
                    <div style={{fontSize:11,color:COLORS.textDim,marginBottom:4}}>综合评分</div>
                    <div style={{fontSize:30,fontWeight:700,fontFamily:"'Space Mono',monospace",color:analysis.normalized>=3?COLORS.green:analysis.normalized>=0?COLORS.amber:COLORS.red,textShadow:`0 0 16px currentColor`}}>{analysis.normalized>0?`+${analysis.normalized}`:analysis.normalized}</div>
                    <div style={{fontSize:10,color:COLORS.textDim}}>/ ±15</div>
                  </div>
                  <div style={{textAlign:"center"}}>
                    <div style={{fontSize:11,color:COLORS.textDim,marginBottom:4}}>技术确认</div>
                    <div style={{fontSize:30,fontWeight:700,fontFamily:"'Space Mono',monospace",color:analysis.techScore>=4?COLORS.green:analysis.techScore>=3?COLORS.amber:COLORS.textSub}}>{analysis.techScore}/6</div>
                    <div style={{fontSize:10,color:COLORS.textDim}}>项满足</div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Tabs */}
          <div style={{display:"flex",gap:2,marginBottom:14,background:COLORS.surface,borderRadius:8,padding:3,width:"fit-content"}}>
            {tabs.map(t=>(
              <button key={t.id} onClick={()=>setActiveTab(t.id)} style={{padding:"5px 14px",borderRadius:6,border:"none",cursor:"pointer",fontSize:12,fontFamily:"'DM Sans',sans-serif",background:activeTab===t.id?COLORS.card:"transparent",color:activeTab===t.id?COLORS.text:COLORS.textDim,transition:"all 0.2s"}}>
                {t.label}
              </button>
            ))}
          </div>

          {/* Tab: 信号总览 */}
          {activeTab==="overview" && analysis && (
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
              {[
                {label:"黄金价格区间", infoKey:"price_zone",
                  value:analysis.goldPrice?`$${analysis.goldPrice?.toLocaleString()}`:"—",
                  status: rawData?._signal?.breakout ? "突破阻力" :
                         rawData?._signal?.in_deep_support ? "深度支撑" :
                         rawData?._signal?.in_support ? "支撑区" :
                         techData?.support && analysis.goldPrice < techData.support ? "跌破支撑" :
                         techData?.resistance && analysis.goldPrice > techData.resistance ? "突破" : "区间内",
                  sColor: rawData?._signal?.breakout ? COLORS.green :
                         rawData?._signal?.in_deep_support ? COLORS.goldLight :
                         rawData?._signal?.in_support ? COLORS.gold :
                         techData?.support && analysis.goldPrice < techData.support ? COLORS.red : COLORS.textSub},
                {label:"降息预期", infoKey:"fed_cut",
                  value: macroData?.fed_cut_prob != null
                    ? `${macroData.fed_cut_prob}% · ${macroData.fed_cut_source || "概率推算"}`
                    : "—",
                  status: macroData?.fed_cut_prob>60?"多":macroData?.fed_cut_prob>40?"中":macroData?.fed_cut_prob!=null?"空":"无",
                  sColor: macroData?.fed_cut_prob>60?COLORS.green:macroData?.fed_cut_prob>40?COLORS.amber:macroData?.fed_cut_prob!=null?COLORS.red:COLORS.textSub},
                // ETF：若数据疑问（GLD与GC=F方向矛盾）则加注警示
                {label:"ETF资金流向", infoKey:"etf_flow",
                  value: rawData?._signal?.etf_data_valid === false
                    ? `${macroData?.etf_flow || "—"} ⚠数据疑问`
                    : (macroData?.etf_flow || "—"),
                  status: rawData?._signal?.etf_data_valid === false ? "待确认"
                    : macroData?.etf_flow==="流入"?"多":macroData?.etf_flow==="流出"?"空":"中",
                  sColor: rawData?._signal?.etf_data_valid === false ? COLORS.textDim
                    : macroData?.etf_flow==="流入"?COLORS.green:macroData?.etf_flow==="流出"?COLORS.red:COLORS.amber},
                // VIX：若黄金同步大跌（risk-off抛售）则显示避险失效警示
                {label:"地缘风险（VIX）", infoKey:"vix",
                  value: macroData?.vix_value!=null
                    ? (rawData?._signal?.vix_risk_off
                        ? `VIX ${macroData.vix_value} · 避险失效`
                        : `VIX ${macroData.vix_value} · ${macroData.vix_risk_level}风险`)
                    : "—",
                  status: rawData?._signal?.vix_risk_off ? "失效"
                    : macroData?.vix_risk_level==="高"?"避险":macroData?.vix_risk_level==="中高"?"偏多":macroData?.vix_risk_level==="低"?"偏空":macroData?.vix_value!=null?"中性":"无",
                  sColor: rawData?._signal?.vix_risk_off ? COLORS.textDim
                    : macroData?.vix_risk_level==="高"?COLORS.green:macroData?.vix_risk_level==="中高"?COLORS.amber:macroData?.vix_risk_level==="低"?COLORS.red:COLORS.textSub},
                {label:"技术面综合", infoKey:"tech_summary",
                  value:analysis?`${analysis.techScore}/6 项满足`:"—",
                  status:analysis.techScore>=4?"强":analysis.techScore>=3?"中":"弱",
                  sColor:analysis.techScore>=4?COLORS.green:analysis.techScore>=3?COLORS.amber:COLORS.red},
                {label:"关键支撑/阻力", infoKey:"key_levels",
                  value:techData?`$${techData.support} / $${techData.resistance}`:"—",
                  status:"参考",sColor:COLORS.textSub},
              ].map((item,i)=>(
                <div key={i} style={{background:COLORS.card,border:`0.5px solid ${COLORS.border}`,borderRadius:8,padding:"13px 16px",display:"flex",justifyContent:"space-between",alignItems:"center",animation:"fadeIn 0.4s ease both",animationDelay:`${i*0.05}s`}}>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{fontSize:11,color:COLORS.textDim,marginBottom:4,display:"flex",alignItems:"center",gap:5}}>
                      {item.label}
                      {item.infoKey && <InfoIcon infoKey={item.infoKey} onClick={setInfoModal}/>}
                    </div>
                    <div style={{fontSize:14,fontWeight:500,color:COLORS.text}}>{item.value}</div>
                  </div>
                  <Tag text={item.status} color={item.sColor} bg={`${item.sColor}18`}/>
                </div>
              ))}
            </div>
          )}

          {/* Tab: 评分明细 */}
          {activeTab==="scoring" && analysis && (
            <div style={{background:COLORS.card,border:`0.5px solid ${COLORS.border}`,borderRadius:10,padding:"18px 20px",animation:"fadeIn 0.3s ease"}}>
              {["宏观结构","宏观节奏","情绪博弈"].map(layer=>(
                <div key={layer} style={{marginBottom:20}}>
                  <div style={{fontSize:11,color:layerColor[layer],letterSpacing:"0.08em",marginBottom:10,fontFamily:"'Space Mono',monospace"}}>{layer.toUpperCase()}</div>
                  {analysis.scoreItems.filter(s=>s.layer===layer).map((s,i)=><ScoreRow key={i} item={s} onInfo={setInfoModal}/>)}
                  <div style={{height:0.5,background:COLORS.border,margin:"12px 0"}}/>
                </div>
              ))}
              <div style={{display:"flex",justifyContent:"flex-end",alignItems:"center",gap:10}}>
                <span style={{fontSize:13,color:COLORS.textDim}}>加权综合评分</span>
                <span style={{fontSize:24,fontWeight:700,fontFamily:"'Space Mono',monospace",color:analysis.normalized>=3?COLORS.green:analysis.normalized>=0?COLORS.amber:COLORS.red}}>{analysis.normalized>0?`+${analysis.normalized}`:analysis.normalized}</span>
                <span style={{fontSize:12,color:COLORS.textDim}}>/ ±15</span>
              </div>
            </div>
          )}

          {/* Tab: 技术指标 */}
          {activeTab==="technical" && techData && (
            <div style={{animation:"fadeIn 0.3s ease"}}>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:10}}>
                {[
                  {label:"站上50日均线", infoKey:"tech_ma50", ok:techData.above_ma50,desc:`MA50: $${techData.ma50?.toLocaleString()}`},
                  {label:"站上200日均线", infoKey:"tech_ma200", ok:techData.above_ma200,desc:`MA200: $${techData.ma200?.toLocaleString()}`},
                  {label:"RSI健康区间", infoKey:"tech_rsi", ok:techData.rsi_healthy,desc:`当前RSI: ${techData.rsi}（35~65健康）`},
                  {label:"RSI底背离", infoKey:"tech_rsi_div", ok:techData.rsi_divergence||false,desc:"价格创新低但RSI未创新低，反转信号"},
                  {label:"MACD多头", infoKey:"tech_macd", ok:techData.macd_positive,desc:"MACD在信号线上方"},
                  {label:"量能放大", infoKey:"tech_volume", ok:techData.volume_surge,desc:"近5日均量超20日均量130%"},
                ].map((item,i)=>(
                  <div key={i} style={{background:COLORS.card,border:`0.5px solid ${item.ok?COLORS.green+"30":COLORS.border}`,borderRadius:8,padding:"13px 16px",display:"flex",gap:12,alignItems:"center",animation:"fadeIn 0.4s ease both",animationDelay:`${i*0.05}s`}}>
                    <div style={{width:20,height:20,borderRadius:"50%",flexShrink:0,background:item.ok?`${COLORS.green}20`:COLORS.border,display:"flex",alignItems:"center",justifyContent:"center",fontSize:11,color:item.ok?COLORS.green:COLORS.textDim}}>{item.ok?"✓":"×"}</div>
                    <div style={{flex:1,minWidth:0}}>
                      <div style={{fontSize:13,fontWeight:500,color:item.ok?COLORS.text:COLORS.textDim,display:"flex",alignItems:"center",gap:5}}>
                        {item.label}
                        {item.infoKey && <InfoIcon infoKey={item.infoKey} onClick={setInfoModal}/>}
                      </div>
                      <div style={{fontSize:11,color:COLORS.textDim,marginTop:2}}>{item.desc}</div>
                    </div>
                  </div>
                ))}
              </div>
              <div style={{background:COLORS.card,border:`0.5px solid ${COLORS.border}`,borderRadius:8,padding:"13px 16px",display:"flex",gap:24}}>
                {[{l:"支撑位",v:`$${techData.support?.toLocaleString()}`,c:COLORS.green},{l:"阻力位",v:`$${techData.resistance?.toLocaleString()}`,c:COLORS.red},{l:"RSI",v:techData.rsi,c:techData.rsi>70?COLORS.red:techData.rsi<30?COLORS.green:COLORS.amber},{l:"MA20",v:`$${techData.ma20?.toLocaleString()}`,c:COLORS.textSub}].map((item,i)=>(
                  <div key={i}>
                    <div style={{fontSize:11,color:COLORS.textDim,marginBottom:4}}>{item.l}</div>
                    <div style={{fontSize:18,fontWeight:700,fontFamily:"'Space Mono',monospace",color:item.c}}>{item.v}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Tab: 仓位计算 */}
          {activeTab==="calculator" && (
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16,animation:"fadeIn 0.3s ease"}}>
              <div style={{background:COLORS.card,border:`0.5px solid ${COLORS.border}`,borderRadius:10,padding:18}}>
                <div style={{fontSize:12,color:COLORS.textDim,marginBottom:14}}>交易参数</div>
                {[{key:"entry",label:"入场价格",unit:"USD/oz"},{key:"stop",label:"止损价格",unit:"USD/oz"},{key:"target",label:"目标价格",unit:"USD/oz"},{key:"capital",label:"账户资金",unit:"USD"},{key:"riskPct",label:"单笔风险%",unit:"%"}].map(f=>(
                  <div key={f.key} style={{marginBottom:10}}>
                    <div style={{fontSize:11,color:COLORS.textDim,marginBottom:4}}>{f.label}</div>
                    <div style={{display:"flex",gap:8,alignItems:"center"}}>
                      <input type="number" value={rrCalc[f.key]} onChange={e=>setRrCalc(r=>({...r,[f.key]:parseFloat(e.target.value)}))}
                        style={{flex:1,background:COLORS.surface,border:`0.5px solid ${COLORS.borderLight}`,borderRadius:6,padding:"7px 10px",color:COLORS.text,fontSize:13,fontFamily:"'Space Mono',monospace",outline:"none"}}/>
                      <span style={{fontSize:11,color:COLORS.textDim,minWidth:36}}>{f.unit}</span>
                    </div>
                  </div>
                ))}
              </div>
              <div style={{display:"flex",flexDirection:"column",gap:10}}>
                {rr ? [
                  {label:"风险收益比 R:R",value:`1 : ${rr.ratio}`,color:rr.good?COLORS.green:COLORS.red,sub:rr.good?"达标（≥2.0）":"不达标，建议调整止损或目标"},
                  {label:"建议仓位",value:`${rr.sizeOz} oz`,color:COLORS.goldLight,sub:`名义价值 $${(rr.sizeOz*rrCalc.entry).toLocaleString()}`},
                  {label:"最大亏损额",value:`-$${rr.maxLoss}`,color:COLORS.red,sub:`账户资金的 ${rrCalc.riskPct}%`},
                  {label:"潜在盈利",value:`+$${rr.gain}`,color:COLORS.green,sub:`账户回报 ${((rr.sizeOz*(rrCalc.target-rrCalc.entry))/rrCalc.capital*100).toFixed(1)}%`},
                ].map((item,i)=>(
                  <div key={i} style={{background:COLORS.card,border:`0.5px solid ${COLORS.border}`,borderRadius:8,padding:"13px 16px",animation:"fadeIn 0.4s ease both",animationDelay:`${i*0.07}s`}}>
                    <div style={{fontSize:11,color:COLORS.textDim,marginBottom:5}}>{item.label}</div>
                    <div style={{fontSize:20,fontWeight:700,fontFamily:"'Space Mono',monospace",color:item.color}}>{item.value}</div>
                    <div style={{fontSize:11,color:COLORS.textDim,marginTop:3}}>{item.sub}</div>
                  </div>
                )) : <div style={{color:COLORS.textDim,fontSize:13,padding:20}}>请输入有效价格参数</div>}
              </div>
            </div>
          )}

          {/* Tab: 数据来源 */}
          {activeTab==="sources" && (
            <div style={{display:"flex",flexDirection:"column",gap:10,animation:"fadeIn 0.3s ease"}}>
              {[
                {name:"Yahoo Finance API",endpoint:"query1.finance.yahoo.com/v8/finance/chart/GC%3DF",data:"GC=F金价、DXY、GLD ETF",delay:"15分钟",free:true,key:false,quality:"好"},
                {name:"FRED API",endpoint:"api.stlouisfed.org/fred/series/observations",data:"TIPS实际利率、CPI、美元指数",delay:"日/月更新",free:true,key:true,quality:"最好"},
                {name:"CFTC COT数据",endpoint:"cftc.gov/files/dea/history/",data:"黄金非商业净多头寸",delay:"每周五",free:true,key:false,quality:"最好"},
                {name:"Alpha Vantage",endpoint:"alphavantage.co/query",data:"技术指标（可选增强）",delay:"实时~15分钟",free:true,key:true,quality:"好"},
                {name:"Anthropic web search",endpoint:"api.anthropic.com/v1/messages",data:"宏观数据降级兜底",delay:"不定",free:false,key:false,quality:"差"},
              ].map((s,i)=>(
                <div key={i} style={{background:COLORS.card,border:`0.5px solid ${COLORS.border}`,borderRadius:8,padding:"13px 16px",display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:10}}>
                  <div style={{flex:1}}>
                    <div style={{fontSize:13,fontWeight:500,color:COLORS.text,marginBottom:3}}>{s.name}</div>
                    <div style={{fontSize:11,color:COLORS.textDim,fontFamily:"'Space Mono',monospace"}}>{s.endpoint}</div>
                    <div style={{fontSize:12,color:COLORS.textSub,marginTop:4}}>{s.data}</div>
                  </div>
                  <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                    <Tag text={`延迟: ${s.delay}`} color={COLORS.textSub} bg={COLORS.border}/>
                    <Tag text={s.free?"免费":"收费"} color={s.free?COLORS.green:COLORS.red} bg={s.free?`${COLORS.green}18`:`${COLORS.red}18`}/>
                    {s.key&&<Tag text="需申请Key" color={COLORS.amber} bg={`${COLORS.amber}18`}/>}
                    <Tag text={`质量: ${s.quality}`} color={s.quality==="最好"?COLORS.green:s.quality==="好"?COLORS.amber:COLORS.red} bg={`${s.quality==="最好"?COLORS.green:s.quality==="好"?COLORS.amber:COLORS.red}18`}/>
                  </div>
                </div>
              ))}
              <div style={{padding:"12px 16px",border:`0.5px solid ${COLORS.border}`,borderRadius:8,fontSize:11,color:COLORS.textDim,lineHeight:1.8}}>
                推荐配置：填入 FRED_API_KEY（免费申请，5分钟）获取官方宏观数据。
                金价数据来自 Yahoo Finance 同一接口，与网页显示一致（15分钟延迟）。
                如需真实时报价，需使用 Twelve Data 或 Polygon.io（有免费层）。
              </div>
            </div>
          )}

          {/* 免责声明 */}
          <div style={{marginTop:20,padding:"10px 14px",border:`0.5px solid ${COLORS.border}`,borderRadius:6,fontSize:11,color:COLORS.textDim}}>
            数据仅供辅助分析，不构成投资建议。所有交易决策请结合自身风险承受能力独立判断。
          </div>
        </div>
      </div>
    </>
  );
}
