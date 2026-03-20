/**
 * gold_system_v2.jsx — 视图层
 * ================================
 * 纯 UI：React 组件 + 状态管理 + 页面渲染。
 * 不含任何数据抓取逻辑（见 data.js）或静态常量（见 constants.js）。
 */

import { useState, useEffect, useCallback } from "react";
import {
  COLORS, GLOBAL_CSS, INFO_DICT,
  TABS, LAYER_COLOR, DATA_SOURCES_LIST,
} from "./constants";
import { fetchAllData, computeScore, FRED_KEY } from "./data";

// ─── 原子 UI 组件 ──────────────────────────────────────────────────────────────

const Spinner = ({ size = 14 }) => (
  <div style={{
    width: size, height: size,
    border: `1.5px solid ${COLORS.border}`,
    borderTop: `1.5px solid ${COLORS.gold}`,
    borderRadius: "50%",
    animation: "spin 0.8s linear infinite",
    display: "inline-block", flexShrink: 0,
  }} />
);

const Tag = ({ text, color, bg }) => (
  <span style={{
    fontSize: 11, fontFamily: "'Space Mono',monospace",
    padding: "2px 8px", borderRadius: 3,
    background: bg, color, letterSpacing: "0.04em",
  }}>{text}</span>
);

// ─── 指标说明弹窗 ─────────────────────────────────────────────────────────────
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
          background: COLORS.surface,
          border: `1px solid ${COLORS.borderLight}`,
          borderRadius: 12, padding: "24px 26px",
          maxWidth: 520, width: "100%",
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
            <div
              key={i}
              style={{
                fontSize: 12.5, lineHeight: 1.7,
                color: line.startsWith("  ·") || line.startsWith("  ") ? COLORS.textSub : COLORS.text,
                paddingLeft: line.startsWith("  ") ? 8 : 0,
              }}
            >{line}</div>
          ))}
        </div>
      </div>
    </div>
  );
};

// ─── 指标说明触发图标 ─────────────────────────────────────────────────────────
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
    onMouseEnter={e => {
      e.currentTarget.style.borderColor = COLORS.gold;
      e.currentTarget.style.color       = COLORS.gold;
    }}
    onMouseLeave={e => {
      e.currentTarget.style.borderColor = `${COLORS.textDim}60`;
      e.currentTarget.style.color       = COLORS.textDim;
    }}
  >i</span>
);

// ─── 指标卡片（顶部价格行）────────────────────────────────────────────────────
const MetricCard = ({ label, value, sub, subColor, loading, infoKey, onInfo }) => (
  <div style={{ background: COLORS.card, border: `0.5px solid ${COLORS.border}`, borderRadius: 8, padding: "14px 16px" }}>
    <div style={{ fontSize: 11, color: COLORS.textDim, marginBottom: 8, letterSpacing: "0.03em", display: "flex", alignItems: "center", gap: 5 }}>
      {label}
      {infoKey && onInfo && <InfoIcon infoKey={infoKey} onClick={onInfo} />}
    </div>
    {loading
      ? <div className="shimmer" style={{ height: 26, width: "65%" }} />
      : <div style={{ fontSize: 20, fontWeight: 700, fontFamily: "'Space Mono',monospace", color: COLORS.text, letterSpacing: "-0.02em" }}>{value ?? "—"}</div>
    }
    {sub && !loading && <div style={{ fontSize: 11, color: subColor || COLORS.textDim, marginTop: 4 }}>{sub}</div>}
  </div>
);

// ─── 评分明细行 ───────────────────────────────────────────────────────────────
const ScoreRow = ({ item, onInfo }) => {
  const pct   = ((item.score + 3) / 6) * 100;
  const color = item.score >= 2 ? COLORS.green : item.score >= 0 ? COLORS.amber : COLORS.red;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 9 }}>
      <div style={{ minWidth: 140, fontSize: 12, color: COLORS.textSub, display: "flex", alignItems: "center", gap: 4 }}>
        <span style={{ flex: 1, minWidth: 0 }}>{item.name}</span>
        {item.infoKey && onInfo && <InfoIcon infoKey={item.infoKey} onClick={onInfo} />}
      </div>
      <div style={{ minWidth: 56, fontSize: 11, fontFamily: "'Space Mono',monospace", color: COLORS.text }}>{item.value}</div>
      <div style={{ flex: 1, height: 3, background: COLORS.border, borderRadius: 2, overflow: "hidden" }}>
        <div style={{ width: `${Math.max(4, pct)}%`, height: "100%", background: color, borderRadius: 2, transition: "width 0.5s" }} />
      </div>
      <div style={{ minWidth: 28, fontSize: 12, fontFamily: "'Space Mono',monospace", textAlign: "right", color }}>
        {item.score > 0 ? `+${item.score}` : item.score}
      </div>
    </div>
  );
};

// ─── Tab: 信号总览 ────────────────────────────────────────────────────────────
const OverviewTab = ({ analysis, rawData, macroData, techData, onInfo }) => {
  const items = [
    {
      label: "黄金价格区间", infoKey: "price_zone",
      value: analysis.goldPrice ? `$${analysis.goldPrice?.toLocaleString()}` : "—",
      status: rawData?._signal?.breakout      ? "突破阻力"
            : rawData?._signal?.in_deep_support ? "深度支撑"
            : rawData?._signal?.in_support      ? "支撑区"
            : techData?.support && analysis.goldPrice < techData.support ? "跌破支撑"
            : techData?.resistance && analysis.goldPrice > techData.resistance ? "突破"
            : "区间内",
      sColor: rawData?._signal?.breakout      ? COLORS.green
            : rawData?._signal?.in_deep_support ? COLORS.goldLight
            : rawData?._signal?.in_support      ? COLORS.gold
            : techData?.support && analysis.goldPrice < techData.support ? COLORS.red
            : COLORS.textSub,
    },
    {
      label: "降息预期", infoKey: "fed_cut",
      value: macroData?.fed_cut_prob != null
        ? `${macroData.fed_cut_prob}% · ${macroData.fed_cut_source || "概率推算"}`
        : "—",
      status: macroData?.fed_cut_prob > 60 ? "多"
            : macroData?.fed_cut_prob > 40 ? "中"
            : macroData?.fed_cut_prob != null ? "空" : "无",
      sColor: macroData?.fed_cut_prob > 60 ? COLORS.green
            : macroData?.fed_cut_prob > 40 ? COLORS.amber
            : macroData?.fed_cut_prob != null ? COLORS.red : COLORS.textSub,
    },
    {
      label: "ETF资金流向", infoKey: "etf_flow",
      value: rawData?._signal?.etf_data_valid === false
        ? `${macroData?.etf_flow || "—"} ⚠数据疑问`
        : (macroData?.etf_flow || "—"),
      status: rawData?._signal?.etf_data_valid === false ? "待确认"
            : macroData?.etf_flow === "流入" ? "多"
            : macroData?.etf_flow === "流出" ? "空" : "中",
      sColor: rawData?._signal?.etf_data_valid === false ? COLORS.textDim
            : macroData?.etf_flow === "流入" ? COLORS.green
            : macroData?.etf_flow === "流出" ? COLORS.red : COLORS.amber,
    },
    {
      label: "地缘风险（VIX）", infoKey: "vix",
      value: macroData?.vix_value != null
        ? (rawData?._signal?.vix_risk_off
            ? `VIX ${macroData.vix_value} · 避险失效`
            : `VIX ${macroData.vix_value} · ${macroData.vix_risk_level}风险`)
        : "—",
      status: rawData?._signal?.vix_risk_off ? "失效"
            : macroData?.vix_risk_level === "高"   ? "避险"
            : macroData?.vix_risk_level === "中高" ? "偏多"
            : macroData?.vix_risk_level === "低"   ? "偏空"
            : macroData?.vix_value != null ? "中性" : "无",
      sColor: rawData?._signal?.vix_risk_off ? COLORS.textDim
            : macroData?.vix_risk_level === "高"   ? COLORS.green
            : macroData?.vix_risk_level === "中高" ? COLORS.amber
            : macroData?.vix_risk_level === "低"   ? COLORS.red : COLORS.textSub,
    },
    {
      label: "技术面综合", infoKey: "tech_summary",
      value:  analysis ? `${analysis.techScore}/6 项满足` : "—",
      status: analysis.techScore >= 4 ? "强" : analysis.techScore >= 3 ? "中" : "弱",
      sColor: analysis.techScore >= 4 ? COLORS.green : analysis.techScore >= 3 ? COLORS.amber : COLORS.red,
    },
    {
      label: "关键支撑/阻力", infoKey: "key_levels",
      value:  techData ? `$${techData.support} / $${techData.resistance}` : "—",
      status: "参考", sColor: COLORS.textSub,
    },
  ];

  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
      {items.map((item, i) => (
        <div
          key={i}
          style={{
            background: COLORS.card, border: `0.5px solid ${COLORS.border}`,
            borderRadius: 8, padding: "13px 16px",
            display: "flex", justifyContent: "space-between", alignItems: "center",
            animation: "fadeIn 0.4s ease both", animationDelay: `${i * 0.05}s`,
          }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 11, color: COLORS.textDim, marginBottom: 4, display: "flex", alignItems: "center", gap: 5 }}>
              {item.label}
              {item.infoKey && <InfoIcon infoKey={item.infoKey} onClick={onInfo} />}
            </div>
            <div style={{ fontSize: 14, fontWeight: 500, color: COLORS.text }}>{item.value}</div>
          </div>
          <Tag text={item.status} color={item.sColor} bg={`${item.sColor}18`} />
        </div>
      ))}
    </div>
  );
};

// ─── Tab: 评分明细 ────────────────────────────────────────────────────────────
const ScoringTab = ({ analysis, onInfo }) => (
  <div style={{ background: COLORS.card, border: `0.5px solid ${COLORS.border}`, borderRadius: 10, padding: "18px 20px", animation: "fadeIn 0.3s ease" }}>
    {["宏观结构", "宏观节奏", "情绪博弈"].map(layer => (
      <div key={layer} style={{ marginBottom: 20 }}>
        <div style={{ fontSize: 11, color: LAYER_COLOR[layer], letterSpacing: "0.08em", marginBottom: 10, fontFamily: "'Space Mono',monospace" }}>
          {layer.toUpperCase()}
        </div>
        {analysis.scoreItems.filter(s => s.layer === layer).map((s, i) => (
          <ScoreRow key={i} item={s} onInfo={onInfo} />
        ))}
        <div style={{ height: 0.5, background: COLORS.border, margin: "12px 0" }} />
      </div>
    ))}
    <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 10 }}>
      <span style={{ fontSize: 13, color: COLORS.textDim }}>加权综合评分</span>
      <span style={{
        fontSize: 24, fontWeight: 700, fontFamily: "'Space Mono',monospace",
        color: analysis.normalized >= 3 ? COLORS.green : analysis.normalized >= 0 ? COLORS.amber : COLORS.red,
      }}>
        {analysis.normalized > 0 ? `+${analysis.normalized}` : analysis.normalized}
      </span>
      <span style={{ fontSize: 12, color: COLORS.textDim }}>/ ±15</span>
    </div>
  </div>
);

// ─── Tab: 技术指标 ────────────────────────────────────────────────────────────
const TechnicalTab = ({ techData, onInfo }) => {
  const checkItems = [
    { label: "站上50日均线",  infoKey: "tech_ma50",    ok: techData.above_ma50,              desc: `MA50: $${techData.ma50?.toLocaleString()}` },
    { label: "站上200日均线", infoKey: "tech_ma200",   ok: techData.above_ma200,             desc: `MA200: $${techData.ma200?.toLocaleString()}` },
    { label: "RSI健康区间",   infoKey: "tech_rsi",     ok: techData.rsi_healthy,             desc: `当前RSI: ${techData.rsi}（35~65健康）` },
    { label: "RSI底背离",     infoKey: "tech_rsi_div", ok: techData.rsi_divergence || false, desc: "价格创新低但RSI未创新低，反转信号" },
    { label: "MACD多头",      infoKey: "tech_macd",    ok: techData.macd_positive,           desc: "MACD在信号线上方" },
    { label: "量能放大",      infoKey: "tech_volume",  ok: techData.volume_surge,            desc: "近5日均量超20日均量130%" },
  ];
  const stats = [
    { l: "支撑位", v: `$${techData.support?.toLocaleString()}`,    c: COLORS.green },
    { l: "阻力位", v: `$${techData.resistance?.toLocaleString()}`, c: COLORS.red   },
    { l: "RSI",    v: techData.rsi,  c: techData.rsi > 70 ? COLORS.red : techData.rsi < 30 ? COLORS.green : COLORS.amber },
    { l: "MA20",   v: `$${techData.ma20?.toLocaleString()}`,       c: COLORS.textSub },
  ];

  return (
    <div style={{ animation: "fadeIn 0.3s ease" }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
        {checkItems.map((item, i) => (
          <div
            key={i}
            style={{
              background: COLORS.card,
              border: `0.5px solid ${item.ok ? COLORS.green + "30" : COLORS.border}`,
              borderRadius: 8, padding: "13px 16px",
              display: "flex", gap: 12, alignItems: "center",
              animation: "fadeIn 0.4s ease both", animationDelay: `${i * 0.05}s`,
            }}
          >
            <div style={{
              width: 20, height: 20, borderRadius: "50%", flexShrink: 0,
              background: item.ok ? `${COLORS.green}20` : COLORS.border,
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 11, color: item.ok ? COLORS.green : COLORS.textDim,
            }}>{item.ok ? "✓" : "×"}</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 500, color: item.ok ? COLORS.text : COLORS.textDim, display: "flex", alignItems: "center", gap: 5 }}>
                {item.label}
                {item.infoKey && <InfoIcon infoKey={item.infoKey} onClick={onInfo} />}
              </div>
              <div style={{ fontSize: 11, color: COLORS.textDim, marginTop: 2 }}>{item.desc}</div>
            </div>
          </div>
        ))}
      </div>
      <div style={{ background: COLORS.card, border: `0.5px solid ${COLORS.border}`, borderRadius: 8, padding: "13px 16px", display: "flex", gap: 24 }}>
        {stats.map((item, i) => (
          <div key={i}>
            <div style={{ fontSize: 11, color: COLORS.textDim, marginBottom: 4 }}>{item.l}</div>
            <div style={{ fontSize: 18, fontWeight: 700, fontFamily: "'Space Mono',monospace", color: item.c }}>{item.v}</div>
          </div>
        ))}
      </div>
    </div>
  );
};

// ─── Tab: 仓位计算 ────────────────────────────────────────────────────────────
const CalculatorTab = ({ rrCalc, setRrCalc }) => {
  const fields = [
    { key: "entry",   label: "入场价格", unit: "USD/oz" },
    { key: "stop",    label: "止损价格", unit: "USD/oz" },
    { key: "target",  label: "目标价格", unit: "USD/oz" },
    { key: "capital", label: "账户资金", unit: "USD"    },
    { key: "riskPct", label: "单笔风险%", unit: "%"     },
  ];

  const rr = (() => {
    const { entry, stop, target, capital, riskPct } = rrCalc;
    const risk = entry - stop, reward = target - entry;
    if (risk <= 0 || reward <= 0) return null;
    const ratio   = (reward / risk).toFixed(2);
    const maxLoss = capital * (riskPct / 100);
    const sizeOz  = Math.floor(maxLoss / risk);
    return {
      ratio, sizeOz,
      maxLoss: Math.round(maxLoss).toLocaleString(),
      gain:    Math.round(sizeOz * reward).toLocaleString(),
      good:    parseFloat(ratio) >= 2,
    };
  })();

  const resultItems = rr ? [
    { label: "风险收益比 R:R", value: `1 : ${rr.ratio}`, color: rr.good ? COLORS.green : COLORS.red,
      sub: rr.good ? "达标（≥2.0）" : "不达标，建议调整止损或目标" },
    { label: "建议仓位",  value: `${rr.sizeOz} oz`, color: COLORS.goldLight,
      sub: `名义价值 $${(rr.sizeOz * rrCalc.entry).toLocaleString()}` },
    { label: "最大亏损额", value: `-$${rr.maxLoss}`, color: COLORS.red,
      sub: `账户资金的 ${rrCalc.riskPct}%` },
    { label: "潜在盈利", value: `+$${rr.gain}`, color: COLORS.green,
      sub: `账户回报 ${((rr.sizeOz * (rrCalc.target - rrCalc.entry)) / rrCalc.capital * 100).toFixed(1)}%` },
  ] : [];

  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, animation: "fadeIn 0.3s ease" }}>
      {/* 参数输入 */}
      <div style={{ background: COLORS.card, border: `0.5px solid ${COLORS.border}`, borderRadius: 10, padding: 18 }}>
        <div style={{ fontSize: 12, color: COLORS.textDim, marginBottom: 14 }}>交易参数</div>
        {fields.map(f => (
          <div key={f.key} style={{ marginBottom: 10 }}>
            <div style={{ fontSize: 11, color: COLORS.textDim, marginBottom: 4 }}>{f.label}</div>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input
                type="number"
                value={rrCalc[f.key]}
                onChange={e => setRrCalc(r => ({ ...r, [f.key]: parseFloat(e.target.value) }))}
                style={{
                  flex: 1, background: COLORS.surface,
                  border: `0.5px solid ${COLORS.borderLight}`,
                  borderRadius: 6, padding: "7px 10px",
                  color: COLORS.text, fontSize: 13,
                  fontFamily: "'Space Mono',monospace", outline: "none",
                }}
              />
              <span style={{ fontSize: 11, color: COLORS.textDim, minWidth: 36 }}>{f.unit}</span>
            </div>
          </div>
        ))}
      </div>
      {/* 计算结果 */}
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {rr ? resultItems.map((item, i) => (
          <div
            key={i}
            style={{
              background: COLORS.card, border: `0.5px solid ${COLORS.border}`,
              borderRadius: 8, padding: "13px 16px",
              animation: "fadeIn 0.4s ease both", animationDelay: `${i * 0.07}s`,
            }}
          >
            <div style={{ fontSize: 11, color: COLORS.textDim, marginBottom: 5 }}>{item.label}</div>
            <div style={{ fontSize: 20, fontWeight: 700, fontFamily: "'Space Mono',monospace", color: item.color }}>{item.value}</div>
            <div style={{ fontSize: 11, color: COLORS.textDim, marginTop: 3 }}>{item.sub}</div>
          </div>
        )) : (
          <div style={{ color: COLORS.textDim, fontSize: 13, padding: 20 }}>请输入有效价格参数</div>
        )}
      </div>
    </div>
  );
};

// ─── Tab: 数据来源 ────────────────────────────────────────────────────────────
const SourcesTab = () => (
  <div style={{ display: "flex", flexDirection: "column", gap: 10, animation: "fadeIn 0.3s ease" }}>
    {DATA_SOURCES_LIST.map((s, i) => (
      <div
        key={i}
        style={{
          background: COLORS.card, border: `0.5px solid ${COLORS.border}`,
          borderRadius: 8, padding: "13px 16px",
          display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10,
        }}
      >
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 13, fontWeight: 500, color: COLORS.text, marginBottom: 3 }}>{s.name}</div>
          <div style={{ fontSize: 11, color: COLORS.textDim, fontFamily: "'Space Mono',monospace" }}>{s.endpoint}</div>
          <div style={{ fontSize: 12, color: COLORS.textSub, marginTop: 4 }}>{s.data}</div>
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <Tag text={`延迟: ${s.delay}`} color={COLORS.textSub} bg={COLORS.border} />
          <Tag text={s.free ? "免费" : "收费"} color={s.free ? COLORS.green : COLORS.red} bg={s.free ? `${COLORS.green}18` : `${COLORS.red}18`} />
          {s.key && <Tag text="需申请Key" color={COLORS.amber} bg={`${COLORS.amber}18`} />}
          <Tag
            text={`质量: ${s.quality}`}
            color={s.quality === "最好" ? COLORS.green : s.quality === "好" ? COLORS.amber : COLORS.red}
            bg={`${s.quality === "最好" ? COLORS.green : s.quality === "好" ? COLORS.amber : COLORS.red}18`}
          />
        </div>
      </div>
    ))}
    <div style={{ padding: "12px 16px", border: `0.5px solid ${COLORS.border}`, borderRadius: 8, fontSize: 11, color: COLORS.textDim, lineHeight: 1.8 }}>
      推荐配置：填入 FRED_API_KEY（免费申请，5分钟）获取官方宏观数据。
      金价数据来自 Yahoo Finance 同一接口，与网页显示一致（15分钟延迟）。
      如需真实时报价，需使用 Twelve Data 或 Polygon.io（有免费层）。
    </div>
  </div>
);

// ─── 主应用 ───────────────────────────────────────────────────────────────────
export default function GoldSystemV2() {
  const [rawData,     setRawData]     = useState(null);
  const [progress,    setProgress]    = useState("");
  const [loading,     setLoading]     = useState(false);
  const [sources,     setSources]     = useState({});
  const [lastUpdated, setLastUpdated] = useState(null);
  const [activeTab,   setActiveTab]   = useState("overview");
  const [rrCalc,      setRrCalc]      = useState({ entry: 4760, stop: 4620, target: 5100, capital: 100000, riskPct: 1 });
  const [infoModal,   setInfoModal]   = useState(null); // { title, content[] } | null

  const loadData = useCallback(async () => {
    setLoading(true);
    setProgress("初始化数据管道...");
    try {
      const result = await fetchAllData(setProgress);
      setRawData(result);
      setSources(result.sources || {});
      setLastUpdated(new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" }));
    } catch (e) {
      setProgress(`错误: ${e.message}`);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    loadData();
    const timer = setInterval(loadData, 15 * 60 * 1000);
    return () => clearInterval(timer);
  }, [loadData]);

  const analysis  = rawData ? computeScore(rawData) : null;
  const goldData  = rawData?.price?.gold;
  const dxyData   = rawData?.price?.dxy;
  const techData  = rawData?.tech;
  const macroData = rawData?.macro;

  return (
    <>
      <style>{GLOBAL_CSS}</style>
      <div style={{ minHeight: "100vh", background: COLORS.bg, paddingBottom: 48 }}>

        {/* ── Header ── */}
        <div style={{
          borderBottom: `1px solid ${COLORS.border}`,
          background: `${COLORS.surface}ee`,
          backdropFilter: "blur(12px)",
          padding: "12px 24px",
          display: "flex", alignItems: "center", justifyContent: "space-between",
          position: "sticky", top: 0, zIndex: 100,
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{
              width: 7, height: 7, borderRadius: "50%",
              background: COLORS.gold, boxShadow: `0 0 8px ${COLORS.gold}`,
              animation: loading ? "pulse 1s infinite" : "none",
            }} />
            <span style={{ fontFamily: "'Space Mono',monospace", fontSize: 12, color: COLORS.gold, letterSpacing: "0.1em" }}>
              GOLD SIGNAL ENGINE v2
            </span>
            {lastUpdated && (
              <span style={{ fontSize: 11, color: COLORS.textDim }}>
                更新于 {lastUpdated}（15分钟自动刷新）
              </span>
            )}
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            {loading && (
              <><Spinner /><span style={{ fontSize: 11, color: COLORS.textDim }}>{progress}</span></>
            )}
            <button
              onClick={loadData}
              disabled={loading}
              style={{
                background: "transparent", border: `0.5px solid ${COLORS.borderLight}`,
                color: COLORS.textSub, fontSize: 11, padding: "5px 12px", borderRadius: 4,
                cursor: "pointer", fontFamily: "'Space Mono',monospace",
              }}
            >
              {loading ? "获取中..." : "立即刷新"}
            </button>
          </div>
        </div>

        <div style={{ maxWidth: 980, margin: "0 auto", padding: "20px 20px 0" }}>

          {/* ── 数据源提示条 ── */}
          {rawData && (
            <div style={{
              background: `${COLORS.blueDim}30`,
              border: `0.5px solid ${COLORS.blue}30`,
              borderRadius: 6, padding: "8px 14px", marginBottom: 16,
              fontSize: 11, color: COLORS.textDim,
              display: "flex", gap: 16, flexWrap: "wrap",
            }}>
              <span>金价: <span style={{ color: COLORS.text }}>{sources.price || "—"}</span></span>
              <span>宏观: <span style={{ color: FRED_KEY ? COLORS.green : COLORS.amber }}>{sources.macro || "—"}</span></span>
              <span>技术: <span style={{ color: COLORS.text }}>{sources.tech || "—"}</span></span>
              {!FRED_KEY && <span style={{ color: COLORS.amber }}>⚠ 填入 FRED_KEY 可获取官方宏观数据</span>}
            </div>
          )}

          {/* ── 顶部价格行 ── */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4,minmax(0,1fr))", gap: 10, marginBottom: 16 }}>
            <MetricCard
              label="黄金期货 GC=F" loading={loading && !goldData}
              value={goldData ? `$${goldData.price?.toLocaleString()}` : "—"}
              sub={goldData ? `${goldData.change_pct >= 0 ? "+" : ""}${goldData.change_pct?.toFixed(2)}% · ${goldData.market_state}` : null}
              subColor={goldData?.change_pct >= 0 ? COLORS.green : COLORS.red}
              infoKey="gold_price" onInfo={setInfoModal}
            />
            <MetricCard
              label="美元指数 DX-Y" loading={loading && !dxyData}
              value={dxyData?.price?.toFixed(2) || "—"}
              sub="关键位 100 / 106"
              infoKey="dxy" onInfo={setInfoModal}
            />
            <MetricCard
              label="TIPS 实际利率" loading={loading && !macroData}
              value={macroData?.tips ? `${(+macroData.tips).toFixed(2)}%` : "—"}
              sub={macroData?.tips_date || "FRED DFII10"}
              infoKey="tips" onInfo={setInfoModal}
            />
            <MetricCard
              label="美国 CPI" loading={loading && !macroData}
              value={macroData?.cpi ? `${(+macroData.cpi).toFixed(1)}%` : "—"}
              sub={macroData?.cpi_date || "FRED CPIAUCSL"}
              infoKey="cpi" onInfo={setInfoModal}
            />
          </div>

          {/* ── 主决策卡片 ── */}
          {analysis && (
            <div style={{
              background: COLORS.card,
              border: `0.5px solid ${analysis.actionColor}40`,
              borderRadius: 10, padding: "18px 22px", marginBottom: 16,
              boxShadow: `0 0 40px ${analysis.actionColor}08`,
              animation: "fadeIn 0.4s ease",
            }}>
              <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", flexWrap: "wrap", gap: 16 }}>
                <div>
                  <div style={{ fontSize: 11, color: COLORS.textDim, marginBottom: 6, letterSpacing: "0.06em" }}>综合交易信号</div>
                  <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 6 }}>
                    <span style={{
                      fontSize: 26, fontWeight: 700, fontFamily: "'Space Mono',monospace",
                      color: analysis.actionColor,
                      textShadow: `0 0 20px ${analysis.actionColor}50`,
                    }}>
                      {analysis.action}
                    </span>
                  </div>
                  <div style={{ fontSize: 13, color: COLORS.textSub }}>{analysis.actionDesc}</div>
                  {/* 高分但未到入场区：解释性提示 */}
                  {analysis.normalized >= 4 && analysis.action === "持仓观望" && (
                    <div style={{
                      marginTop: 8, fontSize: 11, color: COLORS.amber,
                      background: `${COLORS.amber}12`,
                      border: `0.5px solid ${COLORS.amber}30`,
                      borderRadius: 4, padding: "5px 10px", display: "inline-block",
                    }}>
                      ⚠ 宏观评分较高，但价格偏离支撑区，等待价格回调至支撑位再行入场
                    </div>
                  )}
                </div>
                <div style={{ display: "flex", gap: 24 }}>
                  <div style={{ textAlign: "center" }}>
                    <div style={{ fontSize: 11, color: COLORS.textDim, marginBottom: 4 }}>综合评分</div>
                    <div style={{
                      fontSize: 30, fontWeight: 700, fontFamily: "'Space Mono',monospace",
                      color: analysis.normalized >= 3 ? COLORS.green : analysis.normalized >= 0 ? COLORS.amber : COLORS.red,
                      textShadow: "0 0 16px currentColor",
                    }}>
                      {analysis.normalized > 0 ? `+${analysis.normalized}` : analysis.normalized}
                    </div>
                    <div style={{ fontSize: 10, color: COLORS.textDim }}>/ ±15</div>
                  </div>
                  <div style={{ textAlign: "center" }}>
                    <div style={{ fontSize: 11, color: COLORS.textDim, marginBottom: 4 }}>技术确认</div>
                    <div style={{
                      fontSize: 30, fontWeight: 700, fontFamily: "'Space Mono',monospace",
                      color: analysis.techScore >= 4 ? COLORS.green : analysis.techScore >= 3 ? COLORS.amber : COLORS.textSub,
                    }}>
                      {analysis.techScore}/6
                    </div>
                    <div style={{ fontSize: 10, color: COLORS.textDim }}>项满足</div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* ── Tab 导航 ── */}
          <div style={{ display: "flex", gap: 2, marginBottom: 14, background: COLORS.surface, borderRadius: 8, padding: 3, width: "fit-content" }}>
            {TABS.map(t => (
              <button
                key={t.id}
                onClick={() => setActiveTab(t.id)}
                style={{
                  padding: "5px 14px", borderRadius: 6, border: "none", cursor: "pointer",
                  fontSize: 12, fontFamily: "'DM Sans',sans-serif",
                  background: activeTab === t.id ? COLORS.card : "transparent",
                  color:      activeTab === t.id ? COLORS.text  : COLORS.textDim,
                  transition: "all 0.2s",
                }}
              >{t.label}</button>
            ))}
          </div>

          {/* ── Tab 内容 ── */}
          {activeTab === "overview"    && analysis   && <OverviewTab    analysis={analysis}  rawData={rawData}   macroData={macroData} techData={techData} onInfo={setInfoModal} />}
          {activeTab === "scoring"     && analysis   && <ScoringTab     analysis={analysis}  onInfo={setInfoModal} />}
          {activeTab === "technical"   && techData   && <TechnicalTab   techData={techData}  onInfo={setInfoModal} />}
          {activeTab === "calculator"                && <CalculatorTab  rrCalc={rrCalc}      setRrCalc={setRrCalc} />}
          {activeTab === "sources"                   && <SourcesTab />}

          {/* ── 免责声明 ── */}
          <div style={{ marginTop: 20, padding: "10px 14px", border: `0.5px solid ${COLORS.border}`, borderRadius: 6, fontSize: 11, color: COLORS.textDim }}>
            数据仅供辅助分析，不构成投资建议。所有交易决策请结合自身风险承受能力独立判断。
          </div>
        </div>
      </div>

      {/* ── 指标说明弹窗 ── */}
      {infoModal && <InfoModal info={infoModal} onClose={() => setInfoModal(null)} />}
    </>
  );
}
