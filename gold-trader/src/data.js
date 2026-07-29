/**
 * data.js — 数据层
 * ================================
 * 负责所有外部数据获取（Yahoo Finance、FRED、本地 Python 后端）
 * 以及综合评分计算（computeScore）。
 *
 * 数据来源优先级：
 *   1. 本地 Python 后端（yfinance + FRED，无 CORS 问题）
 *   2. Yahoo Finance 非官方 JSON API（前端直连，15 分钟延迟）
 *   3. FRED API（宏观数据，支持 CORS）
 *   4. 降级：Anthropic web search（兜底，精度最低）
 */

import { COLORS } from "./constants";

// ─── 后端地址配置 ──────────────────────────────────────────────────────────────
// 优先读取 REACT_APP_BACKEND_URL（Railway 部署时注入），本地默认 localhost:5001
export const BACKEND_BASE = process.env.REACT_APP_BACKEND_URL || "http://localhost:5001";
export const LOCAL_API = `${BACKEND_BASE}/api/gold`;

// 浏览器端不保存任何第三方 API 密钥；敏感数据请求统一由后端处理。
export const FRED_KEY = "";

// ─── 数据源 1：Yahoo Finance 非官方 JSON API ──────────────────────────────────
// 与 Yahoo Finance 网页同源，无需 API Key，延迟约 15 分钟。
export const fetchYahooPrice = async (symbol) => {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`;
  console.log(`[Yahoo] 请求 ${symbol}:`, url);
  try {
    const resp = await fetch(url);
    console.log(`[Yahoo] ${symbol} 状态:`, resp.status, resp.statusText);
    if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
    const data = await resp.json();
    if (!data.chart?.result?.[0]) throw new Error("chart.result 为空");
    const meta   = data.chart.result[0].meta;
    const quotes = data.chart.result[0].indicators.quote[0];
    const closes = quotes.close.filter(Boolean);
    const current = meta.regularMarketPrice;
    const prev    = closes[closes.length - 2] || closes[closes.length - 1];
    const result = {
      price:         Math.round(current * 100) / 100,
      change_pct:    Math.round(((current - prev) / prev * 100) * 100) / 100,
      high:          Math.round(meta.regularMarketDayHigh * 100) / 100,
      low:           Math.round(meta.regularMarketDayLow  * 100) / 100,
      market_state:  meta.marketState,
      exchange_delay: meta.exchangeTimezoneName,
      source:        "Yahoo Finance（15min延迟）",
    };
    console.log(`[Yahoo] ${symbol} 结果:`, result);
    return result;
  } catch (err) {
    console.error(`[Yahoo] ❌ ${symbol} 失败:`, err.message);
    throw err;
  }
};

// ─── 数据源 2：FRED API（宏观数据）──────────────────────────────────────────
export const fetchFredSeries = async (seriesId, limit = 3) => {
  if (!FRED_KEY) {
    console.warn(`[FRED] ⚠️ ${seriesId} 跳过：未配置 FRED_KEY`);
    return null;
  }
  const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${seriesId}&api_key=${FRED_KEY}&file_type=json&limit=${limit}&sort_order=desc`;
  console.log(`[FRED] 请求 ${seriesId}`);
  try {
    const resp = await fetch(url);
    const data = await resp.json();
    if (data.error_message) throw new Error(`FRED API错误: ${data.error_message}`);
    const obs = (data.observations || []).filter(o => o.value !== ".");
    if (!obs.length) {
      console.warn(`[FRED] ${seriesId} 无有效观测值`);
      return null;
    }
    // CPI 同比计算：需要 13 条数据（最新月 + 12 个月前）
    if (seriesId === "CPIAUCSL" && obs.length >= 13) {
      const latest  = parseFloat(obs[0].value);
      const yearAgo = parseFloat(obs[12].value);
      const yoy     = parseFloat(((latest - yearAgo) / yearAgo * 100).toFixed(2));
      console.log(`[FRED] CPIAUCSL 同比: ${yoy}%`);
      return { value: yoy, date: obs[0].date, index: latest };
    }
    const result = { value: parseFloat(obs[0].value), date: obs[0].date };
    console.log(`[FRED] ${seriesId} 结果:`, result);
    return result;
  } catch (err) {
    console.error(`[FRED] ❌ ${seriesId} 失败:`, err.message);
    throw err;
  }
};

// ─── 数据源 3：Anthropic web search（降级兜底）────────────────────────────
export const fetchViaAnthropicSearch = async (query) => {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 800,
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      messages: [{ role: "user", content: query + "\n只返回纯JSON，无解释。" }],
    }),
  });
  const data = await response.json();
  const text  = data.content.filter(b => b.type === "text").map(b => b.text).join("");
  const match = text.match(/\{[\s\S]*?\}/);
  return match ? JSON.parse(match[0]) : null;
};

// ─── 数据源 0：GitHub Pages 同域静态数据 ─────────────────────────────────────
const mapBackendResponse = (raw) => {
  const pd = raw.data_sources?.price    || {};
  const fd = raw.data_sources?.macro    || {};
  const td = raw.data_sources?.technical || {};

  const gold = pd["GC=F"]     || {};
  const dxy  = pd["DX-Y.NYB"] || {};
  const gld  = pd["GLD"]      || {};

  const goldSource = gold.source || "Yahoo Finance";
  const dxySource  = dxy.source  || "Yahoo Finance";
  const techSource = td.source   || (goldSource === "Yahoo Finance" ? "Yahoo Finance历史数据" : "Polygon.io历史数据");

  return {
    price: {
      gold: { price: gold.price, change_pct: gold.change_pct, market_state: "BACKEND", source: goldSource },
      dxy:  { price: dxy.price,  change_pct: dxy.change_pct,  source: dxySource },
      gld:  { price: gld.price,  change_pct: gld.change_pct,  etf_flow: gld.etf_flow },
    },
    macro: {
      tips:               fd["DFII10"]?.value,
      tips_date:          fd["DFII10"]?.date,
      cpi:                fd["CPIAUCSL"]?.value,
      cpi_date:           fd["CPIAUCSL"]?.date,
      breakeven:          fd["T10YIE"]?.value,
      fed_cut_prob:       raw.signal?.fed_cut_prob_est ?? null,
      fed_cut_source:     raw.signal?.fed_cut_source   ?? null,
      etf_flow:           raw.signal?.etf_flow         ?? null,
      central_bank_buying: null,
      vix_value:          raw.signal?.vix?.value        ?? null,
      vix_risk_level:     raw.signal?.vix?.risk_level   ?? null,
      vix_date:           raw.signal?.vix?.date         ?? null,
      cot_net_long:       raw.signal?.cot?.net_long     ?? null,
      cot_net_pct:        raw.signal?.cot?.net_long_pct ?? null,
      cot_sentiment:      raw.signal?.cot?.sentiment    ?? null,
      cot_date:           raw.signal?.cot?.report_date  ?? null,
    },
    tech: {
      price:         td.price,
      ma20:          td.ma20,  ma50: td.ma50,  ma200: td.ma200,
      above_ma20:    td.above_ma20,
      above_ma50:    td.above_ma50,
      above_ma200:   td.above_ma200,
      rsi:           td.rsi,
      rsi_healthy:   td.rsi >= 35 && td.rsi <= 65,
      rsi_oversold:  td.rsi < 30,
      rsi_divergence: td.rsi_divergence,
      macd_positive: td.macd_above_signal,
      macd_cross:    td.macd_cross,
      atr:           td.atr,
      support:       td.support,
      resistance:    td.resistance,
      volume_surge:  td.volume_surge,
      source:        techSource,
    },
    _signal: {
      in_support:       raw.signal?.in_support       ?? null,
      in_deep_support:  raw.signal?.in_deep_support  ?? null,
      breakout:         raw.signal?.breakout          ?? null,
      normalized_score: raw.signal?.normalized_score ?? null,
      tech_score:       raw.signal?.tech_score       ?? null,
      action:           raw.signal?.action           ?? null,
      etf_data_valid:   raw.signal?.etf_data_valid   ?? true,
      vix_risk_off:     raw.signal?.vix_risk_off     ?? false,
    },
    sources: {
      price: `行情: ${goldSource} | DXY: ${dxySource} | ETF: ${pd["GLD"]?.source || "Yahoo Finance"}`,
      macro: "FRED API（官方数据）",
      tech:  `技术指标: ${techSource} + 本地计算`,
    },
  };
};

export const fetchStaticData = async (onProgress) => {
  onProgress("正在读取最近一次定时生成的数据...");
  const staticDataUrl = `${process.env.PUBLIC_URL || ""}/gold_signal.json?ts=${Date.now()}`;
  const resp = await fetch(staticDataUrl, { cache: "no-store", signal: AbortSignal.timeout(15000) });
  if (!resp.ok) throw new Error(`静态数据响应 ${resp.status}`);
  const raw = await resp.json();
  if (!raw?.data_sources || !raw?.signal) throw new Error("静态数据格式无效");
  console.log("[Static] ✅ 使用 GitHub Actions 生成的数据:", raw.timestamp);
  return { ...mapBackendResponse(raw), generatedAt: raw.timestamp };
};

// 仅用于本地开发环境或未来切回独立 API 时的兼容路径。
export const fetchFromLocalBackend = async (onProgress) => {
  onProgress("正在连接本地 Python 后端...");
  console.log("[Local] 尝试连接:", LOCAL_API);
  const resp = await fetch(LOCAL_API, { signal: AbortSignal.timeout(35000) });
  if (!resp.ok) throw new Error(`本地后端响应 ${resp.status}`);
  const raw = await resp.json();
  console.log("[Local] ✅ 原始数据:", raw);
  return mapBackendResponse(raw);
};

// ─── 技术指标计算（前端降级用）────────────────────────────────────────────────
// 仅在本地后端不可用时调用，直接从 Yahoo Finance 历史数据计算。
const computeTechFromYahoo = async () => {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/GC%3DF?interval=1d&range=1y`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const data    = await resp.json();
  const q       = data.chart.result[0].indicators.quote[0];
  const closes  = q.close.filter(Boolean);
  const volumes = q.volume.filter(Boolean);
  const highs   = q.high.filter(Boolean);
  const lows    = q.low.filter(Boolean);
  const current = closes[closes.length - 1];

  const sma = (arr, n) => arr.slice(-n).reduce((a, b) => a + b, 0) / n;
  const ma20  = sma(closes, 20);
  const ma50  = sma(closes, Math.min(50,  closes.length));
  const ma200 = sma(closes, Math.min(200, closes.length));

  const deltas  = closes.slice(1).map((v, i) => v - closes[i]);
  const gains   = deltas.map(d => d > 0 ? d : 0).slice(-14);
  const losses  = deltas.map(d => d < 0 ? -d : 0).slice(-14);
  const avgGain = gains.reduce((a, b) => a + b, 0) / 14;
  const avgLoss = losses.reduce((a, b) => a + b, 0) / 14;
  const rsi     = avgLoss === 0 ? 100 : Math.round(100 - 100 / (1 + avgGain / avgLoss));

  const recentCloses = closes.slice(-40);
  let ema12 = recentCloses[0], ema26 = recentCloses[0];
  for (const c of recentCloses) {
    ema12 = ema12 * (1 - 2 / 13) + c * (2 / 13);
    ema26 = ema26 * (1 - 2 / 27) + c * (2 / 27);
  }

  const recentHLs = highs.slice(-14).map((h, i) => h - lows.slice(-14)[i]);
  const atrVal    = Math.round(recentHLs.reduce((a, b) => a + b, 0) / recentHLs.length * 100) / 100;

  return {
    price:         Math.round(current * 100) / 100,
    ma20:          Math.round(ma20), ma50: Math.round(ma50), ma200: Math.round(ma200),
    above_ma20:    current > ma20,  above_ma50: current > ma50, above_ma200: current > ma200,
    rsi,           rsi_healthy: rsi >= 35 && rsi <= 65, rsi_oversold: rsi < 30,
    rsi_divergence: false,   // 降级路径无法计算底背离
    macd_positive: ema12 > ema26,
    macd_cross:    false,    // 降级路径无前一日信号线
    atr:           atrVal,
    support:       Math.round(Math.min(...lows.slice(-60))),
    resistance:    Math.round(Math.max(...highs.slice(-60))),
    volume_surge:  sma(volumes, 5) > sma(volumes, 20) * 1.3,
    source:        "Yahoo Finance历史数据（直连）",
  };
};

// ─── 主数据抓取器（优先级：静态数据 → 本地后端 → 直连降级）──────────────────
export const fetchAllData = async (onProgress) => {
  // 生产环境由 GitHub Actions 定时生成的同域 JSON 提供数据。
  try {
    return await fetchStaticData(onProgress);
  } catch (e) {
    console.warn("[fetchAllData] 静态数据不可用:", e.message);
  }

  // 本地开发时仍可启动 Python 服务获得即时数据。
  if (process.env.NODE_ENV === "development") {
    try {
      const data = await fetchFromLocalBackend(onProgress);
      console.log("[fetchAllData] ✅ 使用本地 Python 后端数据");
      return data;
    } catch (e) {
      console.warn("[fetchAllData] 本地后端不可用，降级到直连模式:", e.message);
    }
  }

  onProgress("静态数据暂不可用，切换到浏览器直连模式...");

  const result = { price: null, macro: null, tech: null, sources: {} };

  // 优先级 2a：Yahoo Finance 直连（金价行情）
  onProgress("正在从 Yahoo Finance 直连获取金价...");
  try {
    const [gold, dxy, gld] = await Promise.all([
      fetchYahooPrice("GC=F"),
      fetchYahooPrice("DX-Y.NYB"),
      fetchYahooPrice("GLD"),
    ]);
    result.price  = { gold, dxy, gld };
    result.sources.price = "Yahoo Finance API（直连）";
    console.log("[Step1] ✅ Yahoo Finance 直连成功");
  } catch (e) {
    console.error("[Step1] ❌ Yahoo Finance 直连失败（CORS/403）:", e.message);
    result.sources.price = "Yahoo Finance 被CORS拦截，请启动本地后端";
  }

  // 优先级 2b：FRED 直连（宏观数据，支持 CORS）
  onProgress("正在从 FRED 直连获取宏观数据...");
  try {
    if (!FRED_KEY) throw new Error("FRED key 未配置");
    const [tips, cpi, breakeven] = await Promise.all([
      fetchFredSeries("DFII10"),
      fetchFredSeries("CPIAUCSL", 14),
      fetchFredSeries("T10YIE"),
    ]);
    const tipsVal = tips?.value ?? 1.9;
    const cpiVal  = (cpi?.value !== null && cpi?.value !== undefined && cpi?.value < 20)
      ? cpi?.value : null;
    result.macro = {
      tips:    tips?.value,   tips_date: tips?.date,
      cpi:     cpiVal,        cpi_date:  cpi?.date,
      breakeven: breakeven?.value,
      // TIPS 线性插值估算降息概率（降级模式，精度有限）
      fed_cut_prob:   Math.max(10, Math.min(90, Math.round(100 - tipsVal * 30))),
      fed_cut_source: "TIPS推算（降级模式）",
      etf_flow: (result.price?.gld?.change_pct ?? 0) > 0.5  ? "流入"
               : (result.price?.gld?.change_pct ?? 0) < -0.5 ? "流出"
               : "持平",
      central_bank_buying: null,
      vix_value:     null,
      vix_risk_level: null,
    };
    result.sources.macro = "FRED API（直连）";
    console.log("[Step2] ✅ FRED 直连成功");
  } catch (e) {
    console.error("[Step2] ❌ FRED 直连失败:", e.message);
    result.sources.macro = "FRED 获取失败";
  }

  // 优先级 2c：技术指标（Yahoo Finance 历史数据）
  onProgress("正在计算技术指标...");
  try {
    result.tech = await computeTechFromYahoo();
    result.sources.tech = "Yahoo Finance历史数据（直连）";
    console.log("[Step3] ✅ 技术指标计算成功");
  } catch (e) {
    console.error("[Step3] ❌ 技术指标直连失败（CORS/403）:", e.message);
    result.sources.tech = "Yahoo Finance 被CORS拦截，请启动本地后端";
  }

  return result;
};

// ─── 综合评分计算 ─────────────────────────────────────────────────────────────
// 将原始数据映射为评分项，计算加权总分，确定交易信号。
// 与后端 compute_signal_score 逻辑保持一致（权重、阈值、VIX修正均相同）。
export const computeScore = (data) => {
  if (!data.price || !data.macro || !data.tech) return null;

  const goldPrice = data.price.gold?.price || 0;
  const dxyVal    = data.price.dxy?.price  || 104;
  const dxySource = data.price.dxy?.source || "Yahoo Finance";
  const tips      = data.macro.tips || 1.9;

  // CPI 安全校验：> 20 说明拿到了原始指数而非同比%，视为无效
  const cpiRaw = data.macro.cpi;
  const cpi    = (cpiRaw !== null && cpiRaw !== undefined && cpiRaw < 20) ? cpiRaw : null;

  const fedProb = data.macro.fed_cut_prob ?? null;
  const etfFlow = data.macro.etf_flow     ?? null;

  const scoreItems = [
    {
      layer: "宏观结构", name: "TIPS实际利率",
      value:  `${(+tips).toFixed(2)}%`,
      score:  tips < 1.5 ? 3 : tips < 2.0 ? -1 : -2,
      weight: 0.13, infoKey: "score_tips",
    },
    {
      layer: "宏观结构",
      name:  `美元指数${dxySource === "FRED" ? "(广义指数)" : "DXY"}`,
      value:  (+dxyVal).toFixed(1),
      score:  dxySource === "FRED"
        ? (dxyVal < 105 ? 3 : dxyVal < 110 ? 1 : dxyVal < 118 ? -1 : -3)
        : (dxyVal < 100 ? 3 : dxyVal < 103 ? 1 : dxyVal < 106 ? -1 : -3),
      weight: 0.13, infoKey: "score_dxy",
    },
    {
      layer: "宏观节奏",
      name:  data.macro.fed_cut_source
        ? `降息预期（${data.macro.fed_cut_source}）`
        : (fedProb !== null ? "降息预期（TIPS推算）" : "降息预期"),
      value:  fedProb !== null ? `${fedProb}%` : "获取中…",
      score:  fedProb === null ? 0 : fedProb > 70 ? 3 : fedProb > 50 ? 2 : fedProb > 30 ? 0 : -2,
      weight: 0.14, infoKey: "score_fed",
    },
    {
      layer: "宏观节奏", name: "CPI通胀率",
      value:  cpi !== null ? `${(+cpi).toFixed(2)}%` : "数据异常",
      score:  cpi === null ? 0 : cpi < 2.5 ? 3 : cpi < 3.0 ? 1 : cpi < 3.5 ? -1 : -2,
      weight: 0.13, infoKey: "score_cpi",
    },
    {
      layer: "情绪博弈", name: "ETF资金流向",
      value:  etfFlow ?? "无数据",
      score:  etfFlow === "流入" ? 2 : etfFlow === "流出" ? -2 : 0,
      weight: 0.12, infoKey: "score_etf",
    },
    {
      layer: "情绪博弈",
      name:  `COT多头情绪${data.macro?.cot_date ? `（${data.macro.cot_date}）` : ""}`,
      value:  data.macro?.cot_net_pct != null
        ? `${data.macro.cot_net_pct > 0 ? "+" : ""}${data.macro.cot_net_pct.toFixed(1)}% 净多`
        : data.macro?.cot_sentiment ?? "无数据（需后端模式）",
      score:  data.macro?.cot_net_pct != null
        ? (data.macro.cot_net_pct > 30 ? 2 : data.macro.cot_net_pct > 10 ? 1 : data.macro.cot_net_pct > -10 ? 0 : -2)
        : 0,
      weight: 0.12, infoKey: "score_cot",
    },
    {
      layer: "宏观结构",
      name:  `VIX地缘风险${data.macro?.vix_value != null ? `（当前${data.macro.vix_value}）` : ""}`,
      value:  data.macro?.vix_value != null
        ? `${data.macro.vix_risk_level}风险 · VIX ${data.macro.vix_value}`
        : "无数据（需后端模式）",
      score:  data.macro?.vix_value != null
        ? (data.macro.vix_value > 25 ? 3 : data.macro.vix_value > 20 ? 2 : data.macro.vix_value > 15 ? 0 : -1)
        : 0,
      weight: 0.10, infoKey: "score_vix",
    },
  ];

  // 权重归一化（避免无数据字段压缩评分范围导致虚高）
  const totalWeight = scoreItems.reduce((s, i) => s + i.weight, 0);
  const weighted    = totalWeight > 0
    ? scoreItems.reduce((s, i) => s + i.score * i.weight, 0) / totalWeight
    : 0;
  const normalized = Math.round(weighted * 15); // 映射到 ±15

  // 技术面 6 项：与后端 tech_score_raw 完全对齐
  const techItems = [
    data.tech.above_ma200,
    data.tech.above_ma50,
    data.tech.rsi_healthy,
    data.tech.rsi_divergence || false,
    data.tech.macd_positive,
    data.tech.volume_surge,
  ];
  const techScore = techItems.filter(Boolean).length;

  // 支撑/阻力区间（优先用后端 signal 布尔值，降级时本地计算）
  const techSupport    = data.tech?.support    || 0;
  const techResistance = data.tech?.resistance || 0;
  const atr            = data.tech?.atr        || 0;
  const supportBand    = atr > 0 ? atr * 2 : techSupport * 0.03;

  const inSupport     = data._signal?.in_support     ??
    (techSupport > 0 && goldPrice >= techSupport && goldPrice <= techSupport + supportBand);
  const inDeepSupport = data._signal?.in_deep_support ??
    (techSupport > 0 && goldPrice < techSupport && goldPrice >= techSupport * 0.97);
  const breakout      = data._signal?.breakout        ??
    (techResistance > 0 && goldPrice >= techResistance * 0.98);

  // 优先使用后端综合评分（含 VIX/COT 等前端无法直接获取的权重）
  const normalizedFinal = data._signal?.normalized_score ?? normalized;
  const techScoreFinal  = data._signal?.tech_score       ?? techScore;
  const backendAction   = data._signal?.action           ?? null;

  // 交易信号
  let action, actionColor, actionDesc;
  if (breakout && normalizedFinal >= 4 && techScoreFinal >= 3) {
    const resStr = techResistance ? `$${techResistance.toLocaleString()}` : "阻力位";
    action = "追多突破"; actionColor = COLORS.green;
    actionDesc = `价格有效突破${resStr}，趋势延续做多`;
  } else if ((inSupport || inDeepSupport) && normalizedFinal >= 3 && techScoreFinal >= 3) {
    const supStr = techSupport ? `$${techSupport.toLocaleString()}` : "支撑区";
    action = "建仓做多"; actionColor = COLORS.gold;
    actionDesc = `${supStr}支撑+技术确认叠加，分批建仓`;
  } else if ((inSupport || inDeepSupport) && normalizedFinal >= 2 && techScoreFinal >= 2) {
    action = "试探轻仓"; actionColor = COLORS.amber;
    actionDesc = "条件初步满足，轻仓试探，等信号叠加";
  } else if (normalizedFinal < 0) {
    action = "观望空仓"; actionColor = COLORS.red;
    actionDesc = "基本面转弱，等待评分回升";
  } else {
    action = "持仓观望"; actionColor = COLORS.textSub;
    actionDesc = "价格未到支撑区或信号不足，耐心等待";
  }
  // 后端 action 与前端推导不一致时，以后端为准
  if (backendAction && backendAction !== action) {
    action = backendAction;
  }

  return {
    scoreItems, normalized: normalizedFinal, techScore: techScoreFinal,
    techItems, goldPrice, action, actionColor, actionDesc,
    techSupport, techResistance, inSupport, inDeepSupport, breakout,
  };
};
