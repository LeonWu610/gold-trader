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

const fetchFredSeries = async (seriesId) => {
  if (!FRED_KEY) {
    console.warn(`[FRED] ⚠️ ${seriesId} 跳过：未配置 FRED_KEY`);
    return null;
  }
  const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${seriesId}&api_key=${FRED_KEY}&file_type=json&limit=3&sort_order=desc`;
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
      dxy:  { price: dxy.price,  change_pct: dxy.change_pct  },
      gld:  { price: gld.price,  change_pct: gld.change_pct, etf_flow: gld.etf_flow },
    },
    macro: {
      tips:      fd["DFII10"]?.value,
      tips_date: fd["DFII10"]?.date,
      cpi:       fd["CPIAUCSL"]?.value,
      cpi_date:  fd["CPIAUCSL"]?.date,
      breakeven: fd["T10YIE"]?.value,
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
      macd_positive: td.macd_above_signal,
      support:     td.support,
      resistance:  td.resistance,
      volume_surge: td.volume_surge,
      source:      techSource,
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
      fetchFredSeries("CPIAUCSL"),
      fetchFredSeries("T10YIE"),
    ]);
    result.macro = {
      tips: tips?.value, tips_date: tips?.date,
      cpi: cpi?.value,   cpi_date: cpi?.date,
      breakeven: breakeven?.value,
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
    result.tech = {
      price: Math.round(current * 100)/100,
      ma20: Math.round(ma20), ma50: Math.round(ma50), ma200: Math.round(ma200),
      above_ma20: current > ma20, above_ma50: current > ma50, above_ma200: current > ma200,
      rsi, rsi_healthy: rsi >= 35 && rsi <= 65, rsi_oversold: rsi < 30,
      macd_positive: ema12 > ema26,
      support: Math.round(Math.min(...lows.slice(-60))),
      resistance: Math.round(Math.max(...highs.slice(-60))),
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
  const dxy = data.price.dxy?.price || data.price.dxy || 104;
  const tips = data.macro.tips || data.macro.tips_yield || 1.9;
  const cpi = data.macro.cpi || 3.0;
  const fedProb = data.macro.fed_cut_prob || 40;
  const etfFlow = data.macro.etf_flow || "持平";
  const geo = data.macro.geopolitical || "中";
  const cbBuying = data.macro.central_bank_buying || "持续";

  const scoreItems = [
    { layer:"宏观结构", name:"TIPS实际利率", value:`${(+tips).toFixed(2)}%`,
      score: tips<1.5?3:tips<2.0?-1:-2, weight:0.13 },
    { layer:"宏观结构", name:"美元指数DXY", value:(+dxy).toFixed(1),
      score: dxy<100?3:dxy<103?1:dxy<106?-1:-3, weight:0.13 },
    { layer:"宏观结构", name:"央行购金", value:cbBuying,
      score: cbBuying==="持续"?3:cbBuying==="放缓"?0:-2, weight:0.14 },
    { layer:"宏观节奏", name:"降息预期概率", value:`${fedProb}%`,
      score: fedProb>70?3:fedProb>50?2:fedProb>30?0:-2, weight:0.14 },
    { layer:"宏观节奏", name:"CPI通胀率", value:`${(+cpi).toFixed(1)}%`,
      score: cpi<2.5?3:cpi<3.0?1:cpi<3.5?-1:-2, weight:0.13 },
    { layer:"宏观节奏", name:"地缘风险", value:geo,
      score: geo==="高"?2:geo==="中"?1:-1, weight:0.08 },
    { layer:"情绪博弈", name:"ETF资金流向", value:etfFlow,
      score: etfFlow==="流入"?2:etfFlow==="持平"?0:-2, weight:0.12 },
    { layer:"情绪博弈", name:"COT多头情绪", value:"市场数据",
      score: 0, weight:0.08 },  // 有COT数据时填入
  ];

  const weighted = scoreItems.reduce((s,i) => s + i.score*i.weight, 0);
  const normalized = Math.round(weighted * 5);

  const techItems = [
    data.tech.above_ma200, data.tech.above_ma50,
    data.tech.rsi_healthy, data.tech.rsi_oversold || false,
    data.tech.macd_positive, data.tech.volume_surge,
  ];
  const techScore = techItems.filter(Boolean).length;

  const inSupport = goldPrice >= 4700 && goldPrice <= 4850;
  const inDeepSupport = goldPrice >= 4400 && goldPrice <= 4500;
  const breakout = goldPrice > 5000;

  let action, actionColor, actionDesc;
  if (breakout && normalized >= 4 && techScore >= 3) {
    action="追多突破"; actionColor=COLORS.green; actionDesc="价格有效突破$5,000，趋势延续做多";
  } else if ((inSupport||inDeepSupport) && normalized>=3 && techScore>=3) {
    action="建仓做多"; actionColor=COLORS.gold; actionDesc="支撑区+技术确认叠加，分批建仓";
  } else if ((inSupport||inDeepSupport) && normalized>=2 && techScore>=2) {
    action="试探轻仓"; actionColor=COLORS.amber; actionDesc="条件初步满足，轻仓试探，等信号叠加";
  } else if (normalized<0) {
    action="观望空仓"; actionColor=COLORS.red; actionDesc="基本面转弱，等待评分回升";
  } else {
    action="持仓观望"; actionColor=COLORS.textSub; actionDesc="价格未到支撑区或信号不足，耐心等待";
  }

  return { scoreItems, normalized, techScore, techItems, goldPrice, action, actionColor, actionDesc };
};

// ─── UI 组件 ─────────────────────────────────────────────────────────────────
const Spinner = ({ size=14 }) => (
  <div style={{width:size,height:size,border:`1.5px solid ${COLORS.border}`,borderTop:`1.5px solid ${COLORS.gold}`,borderRadius:"50%",animation:"spin 0.8s linear infinite",display:"inline-block",flexShrink:0}}/>
);

const Tag = ({ text, color, bg }) => (
  <span style={{fontSize:11,fontFamily:"'Space Mono',monospace",padding:"2px 8px",borderRadius:3,background:bg,color,letterSpacing:"0.04em"}}>{text}</span>
);

const MetricCard = ({ label, value, sub, subColor, loading }) => (
  <div style={{background:COLORS.card,border:`0.5px solid ${COLORS.border}`,borderRadius:8,padding:"14px 16px"}}>
    <div style={{fontSize:11,color:COLORS.textDim,marginBottom:8,letterSpacing:"0.03em"}}>{label}</div>
    {loading ? <div className="shimmer" style={{height:26,width:"65%"}}/> :
      <div style={{fontSize:20,fontWeight:700,fontFamily:"'Space Mono',monospace",color:COLORS.text,letterSpacing:"-0.02em"}}>{value ?? "—"}</div>}
    {sub && !loading && <div style={{fontSize:11,color:subColor||COLORS.textDim,marginTop:4}}>{sub}</div>}
  </div>
);

const ScoreRow = ({ item }) => {
  const pct = ((item.score + 3) / 6) * 100;
  const color = item.score>=2?COLORS.green:item.score>=0?COLORS.amber:COLORS.red;
  return (
    <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:9}}>
      <div style={{minWidth:140,fontSize:12,color:COLORS.textSub}}>{item.name}</div>
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
              subColor={goldData?.change_pct>=0?COLORS.green:COLORS.red}/>
            <MetricCard label="美元指数 DX-Y" loading={loading&&!dxyData}
              value={dxyData?.price?.toFixed(2)||"—"}
              sub="关键位 100 / 106"/>
            <MetricCard label="TIPS 实际利率" loading={loading&&!macroData}
              value={macroData?.tips?`${(+macroData.tips).toFixed(2)}%`:(macroData?.tips_yield?`${macroData.tips_yield}%`:"—")}
              sub={macroData?.tips_date||"FRED DFII10"}/>
            <MetricCard label="美国 CPI" loading={loading&&!macroData}
              value={macroData?.cpi?`${(+macroData.cpi).toFixed(1)}%`:"—"}
              sub={macroData?.cpi_date||"FRED CPIAUCSL"}/>
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
                {label:"黄金价格区间",value:analysis.goldPrice?`$${analysis.goldPrice?.toLocaleString()}`:"—",status:analysis.goldPrice>5000?"突破":analysis.goldPrice>=4700&&analysis.goldPrice<=4850?"支撑区":"区间外",sColor:analysis.goldPrice>5000?COLORS.green:analysis.goldPrice>=4700&&analysis.goldPrice<=4850?COLORS.gold:COLORS.textSub},
                {label:"降息预期",value:macroData?.fed_cut_month?`${macroData.fed_cut_month} · ${macroData.fed_cut_prob}%`:"见宏观数据",status:macroData?.fed_cut_prob>60?"多":macroData?.fed_cut_prob>40?"中":"空",sColor:macroData?.fed_cut_prob>60?COLORS.green:macroData?.fed_cut_prob>40?COLORS.amber:COLORS.red},
                {label:"ETF资金流向",value:macroData?.etf_flow||"—",status:macroData?.etf_flow==="流入"?"多":macroData?.etf_flow==="流出"?"空":"中",sColor:macroData?.etf_flow==="流入"?COLORS.green:macroData?.etf_flow==="流出"?COLORS.red:COLORS.amber},
                {label:"地缘风险溢价",value:macroData?.geopolitical?`${macroData.geopolitical}风险`:"—",status:macroData?.geopolitical==="高"?"多":macroData?.geopolitical==="中"?"中":"无",sColor:macroData?.geopolitical==="高"?COLORS.green:COLORS.textSub},
                {label:"技术面综合",value:analysis?`${analysis.techScore}/6 项满足`:"—",status:analysis.techScore>=4?"强":analysis.techScore>=3?"中":"弱",sColor:analysis.techScore>=4?COLORS.green:analysis.techScore>=3?COLORS.amber:COLORS.red},
                {label:"关键支撑/阻力",value:techData?`$${techData.support} / $${techData.resistance}`:"—",status:"参考",sColor:COLORS.textSub},
              ].map((item,i)=>(
                <div key={i} style={{background:COLORS.card,border:`0.5px solid ${COLORS.border}`,borderRadius:8,padding:"13px 16px",display:"flex",justifyContent:"space-between",alignItems:"center",animation:"fadeIn 0.4s ease both",animationDelay:`${i*0.05}s`}}>
                  <div>
                    <div style={{fontSize:11,color:COLORS.textDim,marginBottom:4}}>{item.label}</div>
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
                  {analysis.scoreItems.filter(s=>s.layer===layer).map((s,i)=><ScoreRow key={i} item={s}/>)}
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
                  {label:"站上50日均线",ok:techData.above_ma50,desc:`MA50: $${techData.ma50?.toLocaleString()}`},
                  {label:"站上200日均线",ok:techData.above_ma200,desc:`MA200: $${techData.ma200?.toLocaleString()}`},
                  {label:"RSI健康区间",ok:techData.rsi_healthy,desc:`当前RSI: ${techData.rsi}（35~65健康）`},
                  {label:"RSI超卖区域",ok:techData.rsi_oversold,desc:"RSI<30，超卖反弹信号"},
                  {label:"MACD多头",ok:techData.macd_positive,desc:"MACD在信号线上方"},
                  {label:"量能放大",ok:techData.volume_surge,desc:"近5日均量超20日均量130%"},
                ].map((item,i)=>(
                  <div key={i} style={{background:COLORS.card,border:`0.5px solid ${item.ok?COLORS.green+"30":COLORS.border}`,borderRadius:8,padding:"13px 16px",display:"flex",gap:12,alignItems:"center",animation:"fadeIn 0.4s ease both",animationDelay:`${i*0.05}s`}}>
                    <div style={{width:20,height:20,borderRadius:"50%",flexShrink:0,background:item.ok?`${COLORS.green}20`:COLORS.border,display:"flex",alignItems:"center",justifyContent:"center",fontSize:11,color:item.ok?COLORS.green:COLORS.textDim}}>{item.ok?"✓":"×"}</div>
                    <div>
                      <div style={{fontSize:13,fontWeight:500,color:item.ok?COLORS.text:COLORS.textDim}}>{item.label}</div>
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
