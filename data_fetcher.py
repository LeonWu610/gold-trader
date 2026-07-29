"""
黄金交易系统 — 数据抓取后端（HTTP API 服务版）
==============================================
数据源：
  - Yahoo Finance (yfinance)  → 金价GC=F、DXY、标普500
  - FRED API                  → TIPS实际利率、CPI
  - CFTC                      → COT黄金持仓（每周五）
  - GLD ETF持仓               → 通过yfinance

运行方式：
  /path/to/.venv/bin/python data_fetcher.py
  → 启动本地 HTTP 服务于 http://localhost:5001
  → 前端从 http://localhost:5001/api/gold 取数据

安装依赖：
  pip install yfinance pandas requests fredapi
"""

import io
import json
import time
import random
import zipfile
import datetime
import threading
import requests
import yfinance as yf
import pandas as pd
from http.server import HTTPServer, BaseHTTPRequestHandler
from typing import Optional

# yfinance 1.2+ 使用 curl_cffi 自动伪装浏览器指纹，不需要手动设置 Session

# ─── 配置 ────────────────────────────────────────────────────────────────────
import os

FRED_API_KEY = os.environ.get("FRED_API_KEY", "")
ALPHA_VANTAGE_KEY = os.environ.get("ALPHA_VANTAGE_KEY", "")
POLYGON_KEY = os.environ.get("POLYGON_KEY", "")
PORT = int(os.environ.get("PORT", 5001))
# 逗号分隔。生产环境请配置为 GitHub Pages 的完整站点地址；本地默认允许 CRA 开发服务器。
ALLOWED_ORIGINS = {
    origin.strip().rstrip("/")
    for origin in os.environ.get("ALLOWED_ORIGINS", "http://localhost:3000").split(",")
    if origin.strip()
}


def get_allowed_origin(request_origin: Optional[str]) -> Optional[str]:
    """仅向白名单来源返回 CORS 响应头，避免开放 API 被任意网页调用。"""
    if request_origin and request_origin.rstrip("/") in ALLOWED_ORIGINS:
        return request_origin.rstrip("/")
    return None

# ─── Fallback: Polygon.io ────────────────────────────────────────────────────

def polygon_get_gold_price() -> Optional[dict]:
    """
    用 Polygon.io 获取黄金现货最新价格（C:XAUUSD）。
    先尝试 Last Quote（实时 bid/ask 中间价），失败则用 Previous Close。
    返回 {"price": float, "prev_close": float, "change_pct": float} 或 None。
    """
    headers = {"Authorization": f"Bearer {POLYGON_KEY}"}
    price = None
    prev_close = None

    # 方案A：Last Quote → 实时价格
    try:
        url = "https://api.polygon.io/v1/last_quote/currencies/XAU/USD"
        resp = requests.get(url, headers=headers, timeout=15)
        data = resp.json()
        if data.get("status") == "success" and "last" in data:
            ask = data["last"].get("ask", 0)
            bid = data["last"].get("bid", 0)
            if ask > 0 and bid > 0:
                price = round((ask + bid) / 2, 2)
                print(f"  ✅ [Polygon] 黄金 Last Quote: ${price}")
    except Exception as e:
        print(f"  ⚠️  [Polygon] Last Quote 失败: {e}")

    # 方案B：Previous Close → 含昨收盘+今开盘
    try:
        url = f"https://api.polygon.io/v2/aggs/ticker/C:XAUUSD/prev?adjusted=true&apiKey={POLYGON_KEY}"
        resp = requests.get(url, timeout=15)
        data = resp.json()
        results = data.get("results", [])
        if results:
            bar = results[0]
            prev_close = round(float(bar["c"]), 2)
            open_price = round(float(bar["o"]), 2)
            if price is None:
                price = prev_close
            print(f"  ✅ [Polygon] 前收盘: ${prev_close}, 开盘: ${open_price}")
    except Exception as e:
        print(f"  ⚠️  [Polygon] Previous Close 失败: {e}")

    if price is None:
        return None

    change_pct = round((price - prev_close) / prev_close * 100, 2) if prev_close and prev_close > 0 else 0.0
    return {"price": price, "prev_close": prev_close, "change_pct": change_pct}


def polygon_get_history(days: int = 365) -> Optional[pd.DataFrame]:
    """
    用 Polygon.io 获取黄金现货（C:XAUUSD）历史日线数据，用于技术指标计算。
    返回包含 Open/High/Low/Close/Volume 列的 DataFrame，索引为 datetime，或 None。
    """
    try:
        to_date   = datetime.date.today().isoformat()
        from_date = (datetime.date.today() - datetime.timedelta(days=days + 30)).isoformat()
        url = (
            f"https://api.polygon.io/v2/aggs/ticker/C:XAUUSD/range/1/day"
            f"/{from_date}/{to_date}"
            f"?adjusted=true&sort=asc&limit=500&apiKey={POLYGON_KEY}"
        )
        resp = requests.get(url, timeout=20)
        data = resp.json()
        results = data.get("results", [])
        if not results:
            print(f"  ⚠️  [Polygon] 历史数据为空: {data.get('status')}")
            return None

        df = pd.DataFrame(results)
        df["Datetime"] = pd.to_datetime(df["t"], unit="ms", utc=True).dt.tz_convert("America/New_York")
        df = df.rename(columns={"o": "Open", "h": "High", "l": "Low", "c": "Close", "v": "Volume"})
        df = df.set_index("Datetime")[["Open", "High", "Low", "Close", "Volume"]]
        df = df.dropna().tail(days)
        print(f"  ✅ [Polygon] 历史数据: {len(df)} 条")
        return df
    except Exception as e:
        print(f"  ⚠️  [Polygon] 历史数据失败: {e}")
        return None


# ─── Fallback: Alpha Vantage ─────────────────────────────────────────────────

def alphavantage_get_quote(symbol: str) -> Optional[dict]:
    """
    用 Alpha Vantage GLOBAL_QUOTE 获取单只股票/ETF最新价格。
    symbol 如 'GLD', 'SPY', 'DIA'。
    返回 {"price": float, "change_pct": float, "volume": int} 或 None。
    """
    try:
        url = (
            f"https://www.alphavantage.co/query"
            f"?function=GLOBAL_QUOTE&symbol={symbol}&apikey={ALPHA_VANTAGE_KEY}"
        )
        resp = requests.get(url, timeout=15)
        data = resp.json()
        quote = data.get("Global Quote", {})
        price_str = quote.get("05. price", "")
        change_pct_str = quote.get("10. change percent", "0%").replace("%", "")
        volume_str = quote.get("06. volume", "0")

        if not price_str:
            print(f"  ⚠️  [AlphaVantage] {symbol} 返回为空: {data}")
            return None

        price      = round(float(price_str), 2)
        change_pct = round(float(change_pct_str), 2)
        volume     = int(volume_str) if volume_str.isdigit() else None
        print(f"  ✅ [AlphaVantage] {symbol}: ${price} ({change_pct:+.2f}%)")
        return {"price": price, "change_pct": change_pct, "volume": volume}
    except Exception as e:
        print(f"  ⚠️  [AlphaVantage] {symbol} 失败: {e}")
        return None


# ─── yfinance 限流重试装饰器 ──────────────────────────────────────────────────
def yf_ticker_with_retry(symbol, period="5d", interval="1d", max_retries=1):
    """
    单 ticker 下载，限流时快速失败，不再等待（改为立即走 fallback）。
    yfinance 1.2+ 内置 curl_cffi 伪装浏览器，无需手动设置 session。
    """
    for attempt in range(max_retries):
        try:
            if attempt > 0:
                wait = 2  # 仅短暂等待 2s
                print(f"  ⏳ [{symbol}] 限流重试 {attempt}/{max_retries}，等待 {wait}s ...")
                time.sleep(wait)
            else:
                time.sleep(random.uniform(0.5, 1.5))

            # 不传 session，让 yfinance 自己处理 curl_cffi
            ticker = yf.Ticker(symbol)
            hist = ticker.history(period=period, interval=interval, auto_adjust=True)
            if hist.empty:
                raise ValueError(f"{symbol} 返回空数据")
            print(f"  ✅ [{symbol}] 下载成功, rows={len(hist)}, 最新价格={round(float(hist['Close'].iloc[-1]),2)}")
            return hist
        except Exception as e:
            msg = str(e)
            print(f"  ⚠️  [{symbol}] attempt {attempt+1} 失败: {msg[:100]}")
            if attempt == max_retries - 1:
                raise
    return None


# ─── 1. 金价及基础行情（Yahoo Finance + Fallback）────────────────────────────
def fetch_price_data() -> dict:
    """
    逐个下载 symbol，Yahoo Finance 优先，失败自动切换 fallback：
      GC=F       → Polygon.io (gold spot C:XAUUSD)
      DX-Y.NYB   → FRED DTWEXBGS (美元广义指数，已有key)
      GLD / SPY  → Alpha Vantage GLOBAL_QUOTE
    """
    symbols = ["GC=F", "DX-Y.NYB", "GLD", "SPY"]
    names   = {"GC=F": "黄金期货", "DX-Y.NYB": "美元指数DXY", "GLD": "黄金ETF", "SPY": "标普500"}
    result  = {}
    gld_hist_cache = None  # 缓存 GLD 数据供 ETF 流向计算

    for symbol in symbols:
        # ── 主路径：Yahoo Finance ──
        yf_ok = False
        try:
            print(f"  📥 [Yahoo] 下载 {symbol}...")
            hist = yf_ticker_with_retry(symbol, period="10d", interval="1d")
            if symbol == "GLD":
                gld_hist_cache = hist

            if len(hist) >= 2:
                current    = float(hist["Close"].iloc[-1])
                prev       = float(hist["Close"].iloc[-2])
                change_pct = (current - prev) / prev * 100
                result[symbol] = {
                    "name":       names[symbol],
                    "price":      round(current, 2),
                    "change_pct": round(change_pct, 2),
                    "volume":     int(hist["Volume"].iloc[-1]) if "Volume" in hist.columns else None,
                    "source":     "Yahoo Finance",
                }
                yf_ok = True
            else:
                raise ValueError("数据行数不足")

        except Exception as e:
            print(f"  ❌ [Yahoo] {symbol} 失败: {str(e)[:80]}，尝试 fallback...")

        # ── Fallback ──
        if not yf_ok:
            fb = None
            if symbol == "GC=F":
                # Polygon.io → 黄金现货价格
                print(f"  🔄 [Fallback] {symbol} → Polygon.io")
                fb = polygon_get_gold_price()
                if fb:
                    result[symbol] = {
                        "name":       names[symbol],
                        "price":      fb["price"],
                        "change_pct": fb["change_pct"],
                        "volume":     None,
                        "source":     "Polygon.io",
                    }

            elif symbol == "DX-Y.NYB":
                # FRED DTWEXBGS → 美元广义指数（已有key）
                print(f"  🔄 [Fallback] {symbol} → FRED DTWEXBGS")
                try:
                    params = {
                        "series_id": "DTWEXBGS",
                        "api_key": FRED_API_KEY,
                        "file_type": "json",
                        "limit": 5,
                        "sort_order": "desc",
                        "observation_start": (datetime.date.today() - datetime.timedelta(days=30)).isoformat()
                    }
                    resp = requests.get("https://api.stlouisfed.org/fred/series/observations",
                                        params=params, timeout=20)
                    obs = [o for o in resp.json().get("observations", []) if o["value"] != "."]
                    if len(obs) >= 2:
                        cur  = float(obs[0]["value"])
                        prev = float(obs[1]["value"])
                        result[symbol] = {
                            "name":       names[symbol],
                            "price":      round(cur, 2),
                            "change_pct": round((cur - prev) / prev * 100, 2),
                            "volume":     None,
                            "source":     "FRED",
                        }
                        print(f"  ✅ [FRED] DXY: {cur}")
                        fb = result[symbol]
                except Exception as ef:
                    print(f"  ⚠️  [FRED] DXY 失败: {ef}")

            elif symbol in ("GLD", "SPY"):
                # Alpha Vantage → ETF 价格
                print(f"  🔄 [Fallback] {symbol} → Alpha Vantage")
                fb = alphavantage_get_quote(symbol)
                if fb:
                    result[symbol] = {
                        "name":       names[symbol],
                        "price":      fb["price"],
                        "change_pct": fb["change_pct"],
                        "volume":     fb.get("volume"),
                        "source":     "Alpha Vantage",
                    }

            if fb is None and symbol not in result:
                result[symbol] = {"error": f"Yahoo + fallback 均失败"}

        # 每个 symbol 之间随机等待，避免连续触发限流
        if symbol != symbols[-1]:
            wait = random.uniform(3, 7)
            print(f"  ⏳ 等待 {wait:.1f}s...")
            time.sleep(wait)

    # GLD ETF 资金流向：优先用 totalAssets（持仓盎司数），fallback 量价判断
    # yfinance Ticker.info['totalAssets'] 返回基金总资产（USD），除以金价得持仓盎司数
    if "GLD" in result and "price" in result["GLD"]:
        etf_flow = None
        # 方案A：yfinance info.totalAssets（真实持仓）
        try:
            gld_ticker = yf.Ticker("GLD")
            info = gld_ticker.info
            total_assets = info.get("totalAssets") if info else None
            # 注意：yfinance info 字段可能叫 totalAssets 或 netAssets
            if total_assets is None:
                total_assets = info.get("netAssets") if info else None
            # 如果拿到的是字符串（如 "50B"），需要解析
            if isinstance(total_assets, str):
                # 常见格式: "50.2B", "3.1T", "800M"
                multipliers = {"K": 1e3, "M": 1e6, "B": 1e9, "T": 1e12}
                for suffix, mult in multipliers.items():
                    if total_assets.upper().endswith(suffix):
                        total_assets = float(total_assets[:-1]) * mult
                        break
                else:
                    total_assets = float(total_assets.replace(",", ""))

            if total_assets:
                gold_price_est = result.get("GC=F", {}).get("price")
                if gold_price_est:
                    # 持仓盎司数 = 总资产 / 当前金价
                    holdings_oz = total_assets / gold_price_est
                # 取前一交易日做对比：需要历史持仓，yfinance 不直接提供
                # fallback：用5日均量+价格方向做粗略判断
                # 此处只记录当前持仓，流向判断仍用 fallback
                result["GLD"]["holdings_oz_est"] = round(holdings_oz, 0)
                result["GLD"]["total_assets"] = total_assets
                print(f"  ✅ [GLD] 估算持仓: {holdings_oz:,.0f} oz (${total_assets:,.0f} / ${gold_price_est})")
        except Exception as e:
            print(f"  ⚠️  [GLD] 获取 totalAssets 失败: {e}")

        # 方案B：量价综合判断（fallback，精度较低）
        # 注意：Yahoo Finance auto_adjust=True 理论上已除权，但偶尔在除权日仍有
        # 数据异常（大幅跳空）。此处用量能 + 5日价格首尾趋势做综合判断，
        # 并对极端单日涨跌（>3%）做平滑处理，避免除权数据干扰。
        if gld_hist_cache is not None:
            try:
                gld_vol   = gld_hist_cache["Volume"].dropna().tail(10).tolist()
                gld_close = gld_hist_cache["Close"].dropna().tail(10).tolist()
                if len(gld_vol) >= 5 and len(gld_close) >= 5:
                    # 检测是否有除权跳空（相邻两天变化超3%）
                    daily_changes = [
                        abs(gld_close[i] - gld_close[i-1]) / gld_close[i-1]
                        for i in range(1, len(gld_close))
                    ]
                    has_big_jump = any(chg > 0.03 for chg in daily_changes)

                    if has_big_jump:
                        # 除权日附近：改用更长周期（10日）的整体趋势，忽略单日异常
                        price_up = gld_close[-1] > gld_close[0] if len(gld_close) >= 10 else None
                        # 量能也用更长周期平均
                        avg_vol_recent = sum(gld_vol[-3:]) / 3
                        avg_vol_prior  = sum(gld_vol[:5]) / 5
                        print(f"  ⚠️  [GLD] 检测到可能的除权跳空，改用10日趋势判断")
                    else:
                        # 正常情况：5日量价
                        gld_vol5   = gld_vol[-5:]
                        gld_close5 = gld_close[-5:]
                        price_up   = gld_close5[-1] > gld_close5[0]
                        avg_vol_recent = sum(gld_vol5[-2:]) / 2
                        avg_vol_prior  = sum(gld_vol5[:3]) / 3

                    vol_up = avg_vol_recent > avg_vol_prior * 1.1
                    if price_up is None:
                        etf_flow = "持平"  # 无法判断
                    elif price_up and vol_up:
                        etf_flow = "流入"
                    elif not price_up and vol_up:
                        etf_flow = "流出"
                    else:
                        etf_flow = "持平"
                    result["GLD"]["etf_flow"] = etf_flow
                else:
                    result["GLD"]["etf_flow"] = None
            except Exception:
                result["GLD"]["etf_flow"] = None
        else:
            result["GLD"]["etf_flow"] = None

    return result


# ─── 2a. VIX 波动率指数（地缘风险代理）───────────────────────────────────────
# VIX > 25 = 市场恐慌/风险上升
# VIX < 15 = 市场平稳/风险较低
# 15~25 = 中性
# 数据来源：yfinance（^VIX），日频，免费无限制

def fetch_vix_risk() -> dict:
    """
    用 VIX 指数作为地缘/市场风险的代理变量。
    """
    try:
        hist = yf_ticker_with_retry("^VIX", period="5d", interval="1d")
        if hist is not None and not hist.empty:
            vix_close = float(hist["Close"].iloc[-1])
            vix_prev  = float(hist["Close"].iloc[-2]) if len(hist) >= 2 else vix_close
            vix_change = vix_close - vix_prev

            # 风险判断
            if vix_close > 25:
                risk_level = "高"
                risk_desc  = "市场恐慌，地缘风险上升"
            elif vix_close > 20:
                risk_level = "中高"
                risk_desc  = "风险温和上升"
            elif vix_close > 15:
                risk_level = "中性"
                risk_desc  = "市场情绪平稳"
            else:
                risk_level = "低"
                risk_desc  = "风险偏好良好"

            print(f"  ✅ [VIX] VIX: {vix_close:.1f} (Δ{vix_change:+.1f}) → {risk_level}风险")
            return {
                "value": round(vix_close, 1),
                "change": round(vix_change, 1),
                "risk_level": risk_level,
                "risk_desc": risk_desc,
                "source": "CBOE VIX（yfinance）",
                "date": str(hist.index[-1].date()),
            }
        else:
            raise ValueError("^VIX 数据为空")
    except Exception as e:
        print(f"  ⚠️  [VIX] 获取失败: {e}")
        return {"value": None, "risk_level": "未知", "source": "获取失败"}


# ─── 2. 实际利率与通胀（FRED API）────────────────────────────────────────────
def fetch_fred_data(api_key: str) -> dict:
    """
    FRED API 完全免费，需申请key（5分钟完成）
    关键序列：
      DFII10   = 10年期TIPS实际收益率（日频）
      CPIAUCSL = CPI价格指数（月频，需取13个月计算同比）
      DTWEXBGS = 美元广义指数（日频，基期2006=100）
      T10YIE   = 10年盈亏平衡通胀率（市场隐含通胀预期）
    """
    base_url = "https://api.stlouisfed.org/fred/series/observations"

    result = {}

    # ── 普通序列（取最新值）
    simple_series = {
        "DFII10":   "10年TIPS实际利率",
        "DTWEXBGS": "美元广义指数",
        "T10YIE":   "10年盈亏平衡通胀率",
    }
    for series_id, name in simple_series.items():
        params = {
            "series_id": series_id,
            "api_key": api_key,
            "file_type": "json",
            "limit": 5,
            "sort_order": "desc",
            "observation_start": (datetime.date.today() - datetime.timedelta(days=90)).isoformat()
        }
        for attempt in range(3):
            try:
                resp = requests.get(base_url, params=params, timeout=30)
                obs = [o for o in resp.json().get("observations", []) if o["value"] != "."]
                if obs:
                    result[series_id] = {
                        "name": name,
                        "value": float(obs[0]["value"]),
                        "date": obs[0]["date"]
                    }
                else:
                    result[series_id] = {"error": "无有效观测值"}
                break
            except Exception as e:
                if attempt < 2:
                    time.sleep(5 * (attempt + 1))
                    print(f"  ⚠️  FRED {series_id} 失败，重试: {e}")
                else:
                    result[series_id] = {"error": str(e)}

    # ── CPIAUCSL：需要取13个月数据，计算同比增长率（年化%）
    # limit=20 给足够余量：FRED 可能返回未发布月份的 '.' 占位符，过滤后确保 ≥ 13 条有效数据
    try:
        params = {
            "series_id": "CPIAUCSL",
            "api_key": api_key,
            "file_type": "json",
            "limit": 20,
            "sort_order": "desc",
            "observation_start": (datetime.date.today() - datetime.timedelta(days=600)).isoformat()
        }
        for attempt in range(3):
            try:
                resp = requests.get(base_url, params=params, timeout=30)
                obs = [o for o in resp.json().get("observations", []) if o["value"] != "."]
                if len(obs) >= 13:
                    latest_val   = float(obs[0]["value"])   # 最新月
                    year_ago_val = float(obs[12]["value"])  # 12个月前
                    yoy_pct = round((latest_val - year_ago_val) / year_ago_val * 100, 2)
                    result["CPIAUCSL"] = {
                        "name": "CPI同比通胀率",
                        "value": yoy_pct,          # 例如 2.83
                        "date": obs[0]["date"],
                        "index": latest_val         # 同时保留原始指数值
                    }
                    print(f"  ✅ [FRED] CPI同比: {yoy_pct}% (指数 {latest_val})")
                elif obs:
                    # 数据不足13个月，明确返回 None，不用原始指数值参与评分
                    result["CPIAUCSL"] = {
                        "name": "CPI指数（数据不足，无法计算同比）",
                        "value": None,
                        "index_only": float(obs[0]["value"]),
                        "date": obs[0]["date"],
                        "error": "历史数据不足13个月，无法计算同比"
                    }
                else:
                    result["CPIAUCSL"] = {"error": "无有效观测值"}
                break
            except Exception as e:
                if attempt < 2:
                    time.sleep(5 * (attempt + 1))
                    print(f"  ⚠️  FRED CPIAUCSL 失败，重试: {e}")
                else:
                    result["CPIAUCSL"] = {"error": str(e)}
    except Exception as e:
        result["CPIAUCSL"] = {"error": str(e)}

    return result


# ─── 3. 技术指标（yfinance + Polygon fallback）───────────────────────────────
def fetch_technical_indicators(symbol: str = "GC=F") -> dict:
    """
    用历史数据本地计算技术指标。
    数据源优先级：Yahoo Finance (yfinance) → Polygon.io (C:XAUUSD)
    """
    hist = None

    # 主路径：Yahoo Finance
    try:
        print(f"  📥 [Yahoo] 下载 {symbol} 历史数据（1年）...")
        hist = yf_ticker_with_retry(symbol, period="1y", interval="1d")
        if hist is None or hist.empty:
            raise ValueError("数据为空")
        if "Close" not in hist.columns:
            raise ValueError(f"Close列缺失: {list(hist.columns)}")
        hist = hist[["Open", "High", "Low", "Close", "Volume"]].dropna()
        print(f"  ✅ [Yahoo] 技术指标历史数据: {len(hist)} 条")
    except Exception as e:
        print(f"  ❌ [Yahoo] 技术指标数据失败: {str(e)[:80]}，尝试 Polygon fallback...")
        hist = None

    # Fallback：Polygon.io (仅对 GC=F 黄金期货，对应 C:XAUUSD 现货)
    if hist is None and symbol == "GC=F":
        print(f"  🔄 [Fallback] 技术指标 → Polygon.io")
        hist = polygon_get_history(days=365)

    if hist is None or len(hist) == 0:
        return {"error": "历史数据获取失败（Yahoo + Polygon 均失败）"}

    try:
        if "Close" not in hist.columns:
            return {"error": f"Close列缺失，实际列: {list(hist.columns)}"}
        hist = hist[["Open", "High", "Low", "Close", "Volume"]].dropna()
        if len(hist) < 50:
            return {"error": "历史数据不足"}

        close  = hist["Close"]
        volume = hist["Volume"]

        # ── 均线
        ma20  = close.rolling(20).mean().iloc[-1]
        ma50  = close.rolling(50).mean().iloc[-1]
        ma200 = close.rolling(200).mean().iloc[-1]
        current_price = close.iloc[-1]

        # ── RSI（14日）
        delta = close.diff()
        gain = delta.clip(lower=0).rolling(14).mean()
        loss = (-delta.clip(upper=0)).rolling(14).mean()
        rs = gain / loss
        rsi_series = 100 - (100 / (1 + rs))
        rsi = round(float(rsi_series.iloc[-1]), 1)

        # ── RSI底背离检测（简化：近20日价格新低但RSI高于前低）
        recent_close = close.tail(20)
        recent_rsi = rsi_series.tail(20)
        price_min_idx = recent_close.argmin()
        rsi_at_price_min = float(recent_rsi.iloc[price_min_idx])
        rsi_divergence = bool(
            price_min_idx < len(recent_close) - 3 and  # 价格低点不在最近3天
            rsi_at_price_min < rsi - 5  # 当前RSI高于价格低点时的RSI
        )

        # ── MACD（12/26/9）
        ema12 = close.ewm(span=12).mean()
        ema26 = close.ewm(span=26).mean()
        macd_line = ema12 - ema26
        signal_line = macd_line.ewm(span=9).mean()
        macd_cross = bool(
            macd_line.iloc[-1] > signal_line.iloc[-1] and
            macd_line.iloc[-2] <= signal_line.iloc[-2]
        )
        macd_above = bool(macd_line.iloc[-1] > signal_line.iloc[-1])

        # ── ATR（14日波动率）
        high = hist["High"]
        low = hist["Low"]
        tr = pd.DataFrame({
            "hl": high - low,
            "hc": (high - close.shift()).abs(),
            "lc": (low - close.shift()).abs()
        }).max(axis=1)
        atr = round(float(tr.rolling(14).mean().iloc[-1]), 2)

        # ── 布林带（20日）
        bb_mid = close.rolling(20).mean()
        bb_std = close.rolling(20).std()
        bb_upper = bb_mid + 2 * bb_std
        bb_lower = bb_mid - 2 * bb_std

        # ── 支撑阻力（近60日高低点）
        recent_60 = hist.tail(60)
        support = round(float(recent_60["Low"].min()), 0)
        resistance = round(float(recent_60["High"].max()), 0)

        # ── 量能分析
        avg_volume_5d = float(volume.tail(5).mean())
        avg_volume_20d = float(volume.tail(20).mean())
        volume_surge = bool(avg_volume_5d > avg_volume_20d * 1.3)

        return {
            "price":        round(float(current_price), 2),
            "ma20":         round(float(ma20), 2),
            "ma50":         round(float(ma50), 2),
            "ma200":        round(float(ma200), 2),
            "above_ma20":   bool(current_price > ma20),
            "above_ma50":   bool(current_price > ma50),
            "above_ma200":  bool(current_price > ma200),
            "rsi":          rsi,
            "rsi_divergence": rsi_divergence,
            "macd_cross":   macd_cross,
            "macd_above_signal": macd_above,
            "macd_value":   round(float(macd_line.iloc[-1]), 2),
            "atr":          atr,
            "bb_upper":     round(float(bb_upper.iloc[-1]), 2),
            "bb_lower":     round(float(bb_lower.iloc[-1]), 2),
            "support":      support,
            "resistance":   resistance,
            "volume_surge": volume_surge,
        }

    except Exception as e:
        return {"error": str(e)}


# ─── 4a. 联邦基金期货隐含降息概率（30天Fed Fund Futures）────────────────────
# 合约：ZQ=F（CBOT 30日联邦基金期货，最近月合约）
# 原理：期货价格 = 100 - 隐含联邦基金利率
#       隐含利率 = 100 - 期货价格
#       降息概率 = (隐含利率 - 当前利率) / 降息幅度 （简化：0.25bp一档）
# fallback：用 FRED DFEDTARU（目标利率上限，日频）+ TIPS 推算

def fetch_fed_cut_prob() -> dict:
    """
    用30天联邦基金期货（ZQ=F）计算市场隐含降息概率。
    返回 {"prob": float(%), "implied_rate": float, "current_rate": float, "source": str}
    """
    result = {"prob": None, "implied_rate": None, "current_rate": None, "source": None}

    # ── 步骤1：获取当前联邦基金利率目标上限（FRED DFEDTARU，日频）
    try:
        params = {
            "series_id": "DFEDTARU",
            "api_key": FRED_API_KEY,
            "file_type": "json",
            "limit": 5,
            "sort_order": "desc",
        }
        resp = requests.get("https://api.stlouisfed.org/fred/series/observations",
                            params=params, timeout=20)
        obs = [o for o in resp.json().get("observations", []) if o["value"] != "."]
        current_rate = float(obs[0]["value"]) if obs else None
        print(f"  ✅ [FedRate] 当前目标利率上限: {current_rate}%")
    except Exception as e:
        print(f"  ⚠️  [FedRate] FRED DFEDTARU 失败: {e}")
        current_rate = None

    # ── 步骤2：用 yfinance 拉取 ZQ=F（最近月30天联邦基金期货）
    try:
        hist = yf_ticker_with_retry("ZQ=F", period="5d", interval="1d")
        if hist is not None and not hist.empty:
            futures_price = float(hist["Close"].iloc[-1])
            implied_rate = round(100 - futures_price, 4)   # 隐含年化利率 %
            result["implied_rate"] = implied_rate
            result["source"] = "ZQ=F（30天联邦基金期货）"
            print(f"  ✅ [ZQ=F] 期货价格: {futures_price:.4f}, 隐含利率: {implied_rate:.4f}%")
        else:
            raise ValueError("ZQ=F 数据为空")
    except Exception as e:
        print(f"  ⚠️  [ZQ=F] 期货数据失败: {e}")
        implied_rate = None

    # ── 步骤3：计算降息概率
    if implied_rate is not None and current_rate is not None:
        # 每次降息25bp（0.25%），判断期货隐含利率相对当前利率的偏离
        rate_diff = current_rate - implied_rate  # 正值 = 市场预期降息
        # 概率 = diff / 0.25 × 100，截断到 [5, 95]
        raw_prob = rate_diff / 0.25 * 100
        prob = max(5, min(95, round(raw_prob)))
        result["prob"] = prob
        result["current_rate"] = current_rate
        print(f"  ✅ [FedCut] 降息概率: {prob}% (利差: {rate_diff:.4f}%)")
    elif current_rate is not None:
        # fallback：TIPS 线性推算（已知误差较大，明确标注）
        # 从 FRED 获取 DFII10 TIPS，若无则不推算
        result["prob"] = None
        result["source"] = "ZQ=F失败，降息概率不可用"
        print(f"  ⚠️  [FedCut] ZQ=F不可用，降息概率设为 None")
    else:
        result["prob"] = None
        result["source"] = "数据不可用"

    return result


# ─── 4. CFTC黄金COT持仓（每周五发布）────────────────────────────────────────
# 黄金期货（COMEX）合约代码：088691
# CFTC Disaggregated COT 报告，无需API Key，完全免费
# 字段说明：
#   NonComm_Positions_Long_All  = 非商业（投机）多头合约数
#   NonComm_Positions_Short_All = 非商业（投机）空头合约数
#   Net Long = Long - Short → 正值代表市场偏多头，负值代表偏空头

GOLD_CFTC_CODE = "088691"  # COMEX 黄金期货合约代码

def fetch_cot_data() -> dict:
    """
    从 CFTC 官方网站下载 Disaggregated Futures COT 报告（ZIP→CSV）。
    无需 API Key，每周五美东时间 15:30 更新。
    黄金合约代码：088691
    """
    year = datetime.date.today().year
    # CFTC 每年维护一个 ZIP 文件，当年数据最全
    # 备用 URL3：Legacy Futures-Only COT（不含期权，字段名不同但含同等净多头数据，用于 Disaggregated 下载失败时）
    urls_to_try = [
        f"https://www.cftc.gov/files/dea/history/fut_disagg_txt_{year}.zip",
        f"https://www.cftc.gov/files/dea/history/fut_disagg_txt_{year - 1}.zip",
        f"https://www.cftc.gov/files/dea/history/dea_fut_txt_{year}.zip",    # Legacy format 备用
    ]

    # 模拟浏览器请求头，避免被 CFTC WAF 拦截
    cot_headers = {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
    }

    for url in urls_to_try:
        try:
            print(f"  📥 [COT] 下载 {url}")
            resp = requests.get(url, headers=cot_headers, timeout=90)
            if resp.status_code != 200:
                print(f"  ⚠️  [COT] HTTP {resp.status_code}，尝试下一个 URL")
                continue

            # 解压 ZIP，读取唯一的 .txt（CSV格式）文件
            with zipfile.ZipFile(io.BytesIO(resp.content)) as zf:
                csv_name = next((n for n in zf.namelist() if n.lower().endswith(".txt")), None)
                if not csv_name:
                    print(f"  ⚠️  [COT] ZIP 内无 .txt 文件: {zf.namelist()}")
                    continue
                with zf.open(csv_name) as f:
                    df = pd.read_csv(f, encoding="latin-1", low_memory=False)

            # 筛选黄金合约（CFTC_Contract_Market_Code == "088691"）
            # 列名可能含空格，做宽容匹配
            code_col = next((c for c in df.columns if "contract_market_code" in c.lower()), None)
            if code_col is None:
                print(f"  ⚠️  [COT] 找不到合约代码列，实际列: {list(df.columns[:10])}")
                continue

            gold_df = df[df[code_col].astype(str).str.strip() == GOLD_CFTC_CODE].copy()
            if gold_df.empty:
                print(f"  ⚠️  [COT] 未找到黄金合约 {GOLD_CFTC_CODE}")
                continue

            # 按报告日期排序，取最新一行
            date_col = next((c for c in df.columns if "report" in c.lower() and "date" in c.lower()), None)
            if date_col:
                gold_df[date_col] = pd.to_datetime(gold_df[date_col], errors="coerce")
                gold_df = gold_df.sort_values(date_col, ascending=False)
            latest = gold_df.iloc[0]

            # 非商业（投机）净多头 = Long - Short
            # CFTC 报告格式说明（两种格式，列名不同）：
            #   Disaggregated 格式（当前）：
            #     "M_Money_Positions_Long_All"  / "M_Money_Positions_Short_All"
            #     M_Money = Managed Money = 等价于旧版 NonCommercial（非商业投机资金）
            #   Legacy 格式（旧版）：
            #     "NonComm_Positions_Long_All" / "NonComm_Positions_Short_All"
            # 策略：优先精确匹配已知列名，再做模糊匹配兜底
            LONG_COL_CANDIDATES  = [
                "M_Money_Positions_Long_All",    # Disaggregated 格式（首选）
                "NonComm_Positions_Long_All",    # Legacy 格式
                "NonComm_Positions_Long_All_",   # Legacy 格式（带尾下划线变体）
            ]
            SHORT_COL_CANDIDATES = [
                "M_Money_Positions_Short_All",   # Disaggregated 格式（首选）
                "NonComm_Positions_Short_All",   # Legacy 格式
                "NonComm_Positions_Short_All_",  # Legacy 格式（带尾下划线变体）
            ]

            long_col  = next((c for c in LONG_COL_CANDIDATES  if c in df.columns), None)
            short_col = next((c for c in SHORT_COL_CANDIDATES if c in df.columns), None)

            # 最终 fallback：模糊搜索（含 m_money 或 noncomm，且 long/short 不混淆）
            if long_col is None or short_col is None:
                cols_lower = {c: c.lower() for c in df.columns}
                def find_col(must_contain, must_not_contain=None):
                    for c, cl in cols_lower.items():
                        if all(k in cl for k in must_contain):
                            if must_not_contain and any(k in cl for k in must_not_contain):
                                continue
                            return c
                    return None
                if long_col is None:
                    long_col  = (find_col(["m_money", "long"],   ["short", "spread"])
                              or find_col(["noncomm", "long"],   ["short", "spread"]))
                if short_col is None:
                    short_col = (find_col(["m_money", "short"],  ["long",  "spread"])
                              or find_col(["noncomm", "short"],  ["long",  "spread"]))

            print(f"  🔍 [COT] 匹配到列 → long={long_col}, short={short_col}")

            if long_col is None or short_col is None:
                print(f"  ⚠️  [COT] 找不到目标列，实际列名（前30列）: {list(df.columns[:30])}")
                continue

            net_long   = int(latest[long_col]) - int(latest[short_col])
            long_pos   = int(latest[long_col])
            short_pos  = int(latest[short_col])
            report_date = str(latest[date_col].date()) if date_col else "未知"

            # 净多/总持仓比（情绪极端值判断）
            total_open_interest_col = next(
                (c for c in df.columns if "open_interest" in c.lower() and "all" in c.lower()), None)
            oi = int(latest[total_open_interest_col]) if total_open_interest_col else None
            net_pct = round(net_long / oi * 100, 1) if oi and oi > 0 else None

            print(f"  ✅ [COT] 黄金净多头: {net_long:+,} 手 | 净多/OI: {net_pct}% | 日期: {report_date}")
            return {
                "source": "CFTC（官方）",
                "report_date": report_date,
                "net_long": net_long,          # 净多头合约数（手），正=多头主导
                "long_positions": long_pos,
                "short_positions": short_pos,
                "open_interest": oi,
                "net_long_pct": net_pct,        # 净多头占总持仓比例%
                "sentiment": (
                    "极度多头" if net_pct is not None and net_pct > 40 else
                    "多头"     if net_pct is not None and net_pct > 15 else
                    "弱多头"   if net_pct is not None and net_pct > 0 else
                    "中性"     if net_pct is not None and net_pct > -10 else
                    "空头"
                ),
                "update_day": "每周五15:30 ET",
            }

        except Exception as e:
            print(f"  ⚠️  [COT] {url} 解析失败: {e}")
            continue

    # 全部失败
    return {
        "source": "CFTC",
        "status": "获取失败",
        "net_long": None,
        "update_day": "每周五15:30 ET",
        "note": "下载或解析 CFTC ZIP 失败，请检查网络"
    }


# ─── 5. 评分引擎 ─────────────────────────────────────────────────────────────
def compute_signal_score(price_data: dict, fred_data: dict, tech_data: dict,
                         cot_data: dict, fed_cut_data: dict = None, vix_data: dict = None) -> dict:
    scores = []
    if fed_cut_data is None:
        fed_cut_data = {}
    if vix_data is None:
        vix_data = {}

    gold_price = price_data.get("GC=F", {}).get("price", 0)
    # 黄金当日涨跌幅：供 VIX/ETF 条件判断使用（提前提取，避免重复）
    gold_change_pct = price_data.get("GC=F", {}).get("change_pct", 0) or 0
    # DXY：优先用 price_data 里的 Yahoo Finance DXY（90-110范围），
    #       fallback 时 price_data 里存的是 FRED DTWEXBGS（基期2006=100，当前~120）
    dxy_raw = price_data.get("DX-Y.NYB", {}).get("price", 104)
    dxy_source = price_data.get("DX-Y.NYB", {}).get("source", "Yahoo Finance")
    tips = fred_data.get("DFII10", {}).get("value", 1.9)
    # CPI：返回同比%（如 2.83），若为 None 则数据不足，不参与评分
    cpi_raw = fred_data.get("CPIAUCSL", {}).get("value", None)
    # 安全校验：若 cpi 异常大（>20%）说明拿到了原始指数，置为 None
    cpi = cpi_raw if (cpi_raw is not None and cpi_raw < 20) else None

    # 降息预期概率：
    #   优先用 ZQ=F 联邦基金期货隐含概率（市场实际定价）
    #   fallback：TIPS 线性推算（已知误差较大，明确标注）
    fed_cut_prob_futures = fed_cut_data.get("prob", None)
    fed_cut_source = fed_cut_data.get("source", None)
    if fed_cut_prob_futures is not None:
        fed_cut_prob_est = fed_cut_prob_futures
        fed_cut_label = f"降息预期（ZQ=F期货）"
    else:
        # TIPS 线性推算 fallback
        tips_for_fed = tips if tips is not None else 1.9
        fed_cut_prob_est = max(10, min(90, round(100 - tips_for_fed * 30)))
        fed_cut_label = "降息预期（TIPS推算，精度较低）"

    # ETF 流向：从 price_data 中读取（已在 fetch_price_data 里计算）
    # ⚠️ 一致性校验：GLD 与 GC=F 在同一交易日应高度相关。
    #    若两者涨跌方向相反且差距 > 3%，大概率是 yfinance 的"前收盘日期不一致"数据问题，
    #    此时 GLD change_pct 不可靠，ETF 流向标记无效，不参与评分。
    etf_flow_raw = price_data.get("GLD", {}).get("etf_flow", None)
    gld_change_pct = price_data.get("GLD", {}).get("change_pct", None)
    gc_change_pct  = gold_change_pct  # 已在上方提取
    etf_data_valid = True
    if (gld_change_pct is not None and gc_change_pct is not None and
            abs(gld_change_pct - gc_change_pct) > 3.0 and
            gld_change_pct * gc_change_pct < 0):   # 方向相反
        etf_data_valid = False
        print(f"  ⚠️  [ETF] GLD({gld_change_pct:+.2f}%) 与 GC=F({gc_change_pct:+.2f}%) 方向矛盾，ETF流向数据疑问，不参与评分")
    etf_flow = etf_flow_raw if etf_data_valid else None

    # 宏观结构层（40%权重）
    tips_score = 3 if tips < 1.5 else (-1 if tips < 2.0 else -2)
    scores.append({"layer": "宏观结构", "name": "实际利率TIPS", "value": f"{tips:.2f}%", "score": tips_score, "weight": 0.13})

    # DXY 评分：兼容两种数据源
    # FRED DTWEXBGS 基期2006=100，历史区间大致 85-130
    # Yahoo DX-Y.NYB 区间大致 90-115
    if dxy_source == "FRED":
        # DTWEXBGS：弱美元利好黄金，强美元利空
        dxy_score = 3 if dxy_raw < 105 else (1 if dxy_raw < 110 else (-1 if dxy_raw < 118 else -3))
    else:
        # Yahoo DXY（传统DXY指数）
        dxy_score = 3 if dxy_raw < 100 else (1 if dxy_raw < 103 else (-1 if dxy_raw < 106 else -3))
    scores.append({"layer": "宏观结构", "name": "美元指数DXY", "value": f"{dxy_raw:.1f} ({'广义指数' if dxy_source == 'FRED' else 'DXY'})", "score": dxy_score, "weight": 0.13})

    # 央行购金：WGC季度数据延迟太大，降格为纯展示字段，不参与评分
    # 后续可接入 WGC 季度报告作为展示数据

    # VIX 地缘/市场风险（代理变量）
    # ⚠️ 条件判断：VIX高 + 黄金当日大跌（> -2%）= risk-off 系统性抛售，
    #    此时资金逃离风险资产（包括黄金），VIX的"避险利好黄金"逻辑失效，评分归零。
    #    VIX高 + 黄金稳定或上涨 = 真实避险流入黄金，给正分。
    # （gold_change_pct 已在函数顶部提取，此处直接使用）
    vix_value = vix_data.get("value", None)
    vix_risk_level = vix_data.get("risk_level", "未知")
    vix_date = vix_data.get("date", "")
    if vix_value is not None:
        risk_off_selldown = (gold_change_pct < -2.0 and vix_value > 20)
        if risk_off_selldown:
            # 系统性抛售：黄金与VIX同步恶化，VIX的避险信号对黄金失效
            vix_score = 0
            vix_label = f"VIX风险（{vix_risk_level}，黄金同步下跌·避险失效）"
            print(f"  ⚠️  [VIX] risk-off 抛售（金价{gold_change_pct:+.1f}%，VIX={vix_value}），VIX评分归零")
        else:
            # 正常避险逻辑：VIX高 = 避险需求流入黄金
            # ⚠️ VIX>25 给 score=3 的最高档需要黄金自身未大跌（防止单因子虚高）：
            #   VIX>25 + 金价稳（>-1%）= 强避险流入 → score=3
            #   VIX>25 + 金价轻微下跌（-1%~-2%）= 避险减弱  → score=2
            if vix_value > 25:
                vix_score = 3 if gold_change_pct >= -1.0 else 2  # 金价轻跌时略减
            elif vix_value > 20:
                vix_score = 2   # 中高风险，温和利好
            elif vix_value > 15:
                vix_score = 0   # 中性
            else:
                vix_score = -1  # 风险偏好好，黄金避险需求弱
            vix_label = f"VIX风险（{vix_risk_level}）"
        vix_weight = 0.10
    else:
        vix_score = 0
        vix_weight = 0
        vix_label = "VIX风险（获取失败）"
    scores.append({"layer": "宏观结构", "name": vix_label,
                   "value": f"VIX {vix_value:.1f}" if vix_value else "无数据",
                   "score": vix_score, "weight": vix_weight})

    # 降息预期（优先 ZQ=F 期货，fallback TIPS 推算）
    fed_score = 3 if fed_cut_prob_est > 70 else (2 if fed_cut_prob_est > 50 else (0 if fed_cut_prob_est > 30 else -2))
    scores.append({"layer": "宏观节奏", "name": fed_cut_label, "value": f"{fed_cut_prob_est}%", "score": fed_score, "weight": 0.14})

    # 宏观节奏层（35%权重）
    # CPI 同比%：适度通胀利好黄金，通胀过高或过低均有副作用
    # ⚠️ 无数据时 score=0 但 weight 保留（防止分母缩水拉高虚分）
    if cpi is not None:
        cpi_score = 3 if cpi < 2.5 else (1 if cpi < 3.0 else (-1 if cpi < 3.5 else -2))
        cpi_value = f"{cpi:.2f}%"
    else:
        cpi_score = 0
        cpi_value = "数据异常"
    scores.append({"layer": "宏观节奏", "name": "CPI同比通胀率", "value": cpi_value, "score": cpi_score, "weight": 0.13})

    # ETF 资金流向
    # ⚠️ 无数据（获取失败或数据校验不通过）时 score=0 但 weight 保留 0.12，
    #    防止分母从 0.87 缩到 0.75，导致同等分子被放大 16%，normalized 虚高
    if etf_flow is not None:
        etf_score = 2 if etf_flow == "流入" else (-2 if etf_flow == "流出" else 0)
        etf_display = etf_flow
    else:
        etf_score = 0
        etf_display = "无数据"
    scores.append({"layer": "情绪博弈", "name": "ETF资金流向", "value": etf_display, "score": etf_score, "weight": 0.12})

    # COT 非商业净多头情绪
    cot_net_pct = cot_data.get("net_long_pct", None)
    cot_sentiment = cot_data.get("sentiment", None)
    cot_date = cot_data.get("report_date", "")
    if cot_net_pct is not None:
        # 净多占比评分（与前端保持一致）：
        #   > 30% → 极端多头，score=2（可能过热，略有反向风险）
        #   > 10% → 健康多头，score=1
        #   > -10% → 中性，score=0
        #   ≤ -10% → 空头，score=-2
        if cot_net_pct > 30:
            cot_score = 2   # 极端多头，情绪过热
        elif cot_net_pct > 10:
            cot_score = 1   # 健康多头
        elif cot_net_pct > -10:
            cot_score = 0   # 中性
        else:
            cot_score = -2  # 空头
        cot_weight = 0.12
        cot_value = f"{cot_net_pct:+.1f}% 净多（{cot_sentiment}）" if cot_sentiment else f"{cot_net_pct:+.1f}%"
    else:
        cot_score = 0
        cot_weight = 0
        cot_value = "获取失败"
    scores.append({
        "layer": "情绪博弈",
        "name": f"COT多头情绪（{cot_date}）" if cot_date else "COT多头情绪",
        "value": cot_value,
        "score": cot_score,
        "weight": cot_weight,
    })

    # 技术面
    tech_score_raw = sum([
        tech_data.get("above_ma200", False),
        tech_data.get("above_ma50", False),
        35 <= tech_data.get("rsi", 50) <= 65,
        tech_data.get("rsi_divergence", False),
        tech_data.get("macd_above_signal", False),
        tech_data.get("volume_surge", False),
    ])

    # 加权总分（权重归一化，避免无数据字段压缩评分范围）
    total_weight = sum(s["weight"] for s in scores)
    if total_weight > 0:
        weighted = sum(s["score"] * s["weight"] for s in scores) / total_weight
    else:
        weighted = 0
    normalized = round(weighted * 15)  # 映射到 ±15

    # 交易信号判断：动态支撑/阻力，来自技术面实际计算值
    # support / resistance 由 fetch_technical_indicators 计算（近60日低/高点）
    tech_support    = tech_data.get("support", 0)
    tech_resistance = tech_data.get("resistance", 9_999_999)
    atr             = tech_data.get("atr", 0)

    # 支撑区：价格在 support 到 support + 2*ATR 之间（贴近支撑但未跌破）
    # 用 ATR 动态衡量"靠近支撑"的范围，比硬编码绝对值更稳健
    support_band = atr * 2 if atr > 0 else tech_support * 0.03
    in_support      = (tech_support <= gold_price <= tech_support + support_band)
    in_deep_support = (gold_price < tech_support and gold_price >= tech_support * 0.97)  # 微幅跌破支撑但未超3%

    # 突破：价格超过阻力位的98%（允许2%误差防止假突破误判）
    breakout = (tech_resistance > 0 and gold_price >= tech_resistance * 0.98)

    if breakout and normalized >= 4 and tech_score_raw >= 3:
        action = "追多突破"
    elif (in_support or in_deep_support) and normalized >= 3 and tech_score_raw >= 3:
        action = "建仓做多"
    elif (in_support or in_deep_support) and normalized >= 2 and tech_score_raw >= 2:
        action = "试探轻仓"
    elif normalized < 0:
        action = "观望空仓"
    else:
        action = "持仓观望"

    return {
        "gold_price": gold_price,
        "scores": scores,
        "normalized_score": normalized,
        "tech_score": tech_score_raw,
        "action": action,
        "fed_cut_prob_est": fed_cut_prob_est,
        "fed_cut_source":   "ZQ=F期货" if fed_cut_prob_futures is not None else "TIPS推算",
        "etf_flow": etf_flow if etf_flow != "无数据" else None,
        "etf_data_valid": etf_data_valid,   # False 表示 GLD/GC=F 涨跌方向矛盾，ETF流向不可靠
        "vix_risk_off": risk_off_selldown if vix_value is not None else False,  # True 表示黄金同步下跌，VIX避险逻辑失效
        "dxy_source": dxy_source,
        # 动态支撑阻力：传给前端用于信号判断，避免前端硬编码
        "tech_support":    tech_support,
        "tech_resistance": tech_resistance,
        "atr":             atr,
        "in_support":      in_support,
        "in_deep_support": in_deep_support,
        "breakout":        breakout,
        "vix": {
            "value":       vix_value,
            "risk_level":  vix_risk_level,
            "date":        vix_date,
            "source":      vix_data.get("source"),
        },
        "cot": {
            "net_long":     cot_data.get("net_long"),
            "net_long_pct": cot_net_pct,
            "sentiment":    cot_sentiment,
            "report_date":  cot_date,
            "source":       cot_data.get("source"),
        },
        "tech_details": {
            "above_ma50":   tech_data.get("above_ma50"),
            "above_ma200":  tech_data.get("above_ma200"),
            "rsi":          tech_data.get("rsi"),
            "rsi_divergence": tech_data.get("rsi_divergence"),
            "macd_cross":   tech_data.get("macd_cross"),
            "support":      tech_data.get("support"),
            "resistance":   tech_data.get("resistance"),
            "atr":          tech_data.get("atr"),
        }
    }


# ─── 主入口 ───────────────────────────────────────────────────────────────────
def run_full_analysis() -> dict:
    print("⏳ 抓取行情数据（Yahoo Finance批量）...")
    price_data = fetch_price_data()

    # ⚠️ 两次 yfinance 调用之间等待，避免连续触发限流
    wait_sec = random.uniform(8, 15)
    print(f"⏳ 等待 {wait_sec:.1f}s 避免限流...")
    time.sleep(wait_sec)

    print("⏳ 计算技术指标...")
    tech_data = fetch_technical_indicators("GC=F")

    print("⏳ 抓取宏观数据（FRED API）...")
    fred_data = fetch_fred_data(FRED_API_KEY)

    print("⏳ 获取VIX波动率（地缘风险代理）...")
    vix_data = fetch_vix_risk()

    print("⏳ 获取联邦基金期货隐含降息概率（ZQ=F）...")
    fed_cut_data = fetch_fed_cut_prob()

    print("⏳ 获取COT持仓...")
    cot_data = fetch_cot_data()

    print("⏳ 计算综合评分...")
    signal = compute_signal_score(price_data, fred_data, tech_data, cot_data, fed_cut_data, vix_data)

    output = {
        "timestamp": datetime.datetime.now().isoformat(),
        "data_sources": {
            "price":    price_data,
            "macro":    fred_data,
            "technical": tech_data,
            "cot":      cot_data,
            "fed_cut":  fed_cut_data,
            "vix":      vix_data,
        },
        "signal": signal
    }

    print("\n" + "="*50)
    print(f"黄金价格:   ${signal['gold_price']:,.2f}")
    print(f"综合评分:   {signal['normalized_score']:+d} / ±15")
    print(f"技术确认:   {signal['tech_score']}/6 项")
    print(f"交易信号:   【{signal['action']}】")
    print("="*50)

    return output


def export_static_data(output_path: str) -> dict:
    """生成供 GitHub Pages 使用的静态数据文件，并在失败时让 CI 任务明确失败。"""
    data = run_full_analysis()
    output_dir = os.path.dirname(output_path)
    if output_dir:
        os.makedirs(output_dir, exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as output_file:
        json.dump(data, output_file, ensure_ascii=False, indent=2)
    print(f"✅ 静态数据已写入 {output_path}")
    return data


# ─── 缓存（避免每次请求都重新抓取）────────────────────────────────────────────
_cache = {"data": None, "ts": 0}
_cache_lock = threading.Lock()   # 防止并发重复抓取
_warming = False                 # 是否正在预热中
CACHE_TTL = 15 * 60             # 15分钟缓存

def refresh_data_bg():
    """后台线程：抓取数据并更新缓存，完成后通知前端可用"""
    global _warming
    with _cache_lock:
        _warming = True
    try:
        print("🔄 后台开始抓取数据...")
        new_data = run_full_analysis()
        with _cache_lock:
            _cache["data"] = new_data
            _cache["ts"] = time.time()
        with open("gold_signal.json", "w", encoding="utf-8") as f:
            json.dump(new_data, f, ensure_ascii=False, indent=2)
        print("✅ 数据已更新并写入 gold_signal.json")
    except Exception as e:
        print(f"❌ 后台抓取失败: {e}")
    finally:
        with _cache_lock:
            _warming = False

def get_cached_data():
    """返回缓存数据。如果还没有数据则阻塞等待；如果缓存过期则异步刷新。"""
    now = time.time()
    with _cache_lock:
        has_data = _cache["data"] is not None
        expired  = now - _cache["ts"] > CACHE_TTL
        warming  = _warming

    if not has_data:
        # 首次请求，等后台预热完成（最多120s）
        print("⏳ 等待后台数据预热...")
        for _ in range(120):
            time.sleep(1)
            with _cache_lock:
                if _cache["data"] is not None:
                    break
        with _cache_lock:
            if _cache["data"] is None:
                raise RuntimeError("数据预热超时，请稍后重试")

    elif expired and not warming:
        # 缓存过期，启动后台刷新，本次仍返回旧数据
        print(f"⚡ 缓存已过期，后台刷新中（当前数据仍可用）")
        t = threading.Thread(target=refresh_data_bg, daemon=True)
        t.start()
    else:
        print(f"⚡ 使用缓存数据（{int(now - _cache['ts'])}秒前更新）")

    with _cache_lock:
        return _cache["data"]


# ─── HTTP 请求处理器 ──────────────────────────────────────────────────────────
class GoldAPIHandler(BaseHTTPRequestHandler):

    # ── 辅助方法：发送 JSON 响应（含 CORS 头）────────────────────────────────
    def _send_json(self, payload: dict, status: int = 200) -> None:
        """将 payload 序列化为 JSON 并写回响应，自动附加 CORS 头。"""
        body = json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        origin = get_allowed_origin(self.headers.get("Origin"))
        if origin:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        try:
            if self.path in ("/api/gold", "/api/gold/"):
                # 主数据接口：返回缓存的黄金交易信号数据
                data = get_cached_data()
                self._send_json(data)

            elif self.path == "/api/refresh":
                # 强制使缓存失效，触发后台重新抓取
                _cache["ts"] = 0
                get_cached_data()
                self._send_json({"ok": True, "ts": _cache["ts"]})

            else:
                self.send_response(404)
                self.end_headers()

        except (BrokenPipeError, ConnectionResetError):
            # 客户端提前断开，忽略，不影响服务稳定性
            pass
        except Exception as e:
            print(f"[HTTP][ERROR] {self.path} 处理异常: {e}")
            try:
                self._send_json({"error": str(e)}, status=500)
            except (BrokenPipeError, ConnectionResetError):
                pass

    def do_OPTIONS(self):
        # 处理浏览器 CORS 预检请求，仅响应受信任的前端来源。
        origin = get_allowed_origin(self.headers.get("Origin"))
        if not origin:
            self.send_response(403)
            self.end_headers()
            return
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", origin)
        self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def log_message(self, format, *args):
        # 简化请求日志（避免默认格式中的 stderr 输出）
        print(f"[HTTP] {self.address_string()} {format % args}")


# ─── 主入口 ───────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    print("=" * 55)
    print("  黄金交易信号系统 — 本地后端服务")
    print("=" * 55)
    print(f"🚀 启动本地 API 服务于 http://localhost:{PORT}")
    print(f"📡 数据接口: http://localhost:{PORT}/api/gold")
    print(f"🔑 FRED Key configured: {'yes' if FRED_API_KEY else 'no'}")
    print(f"⏱  缓存时间: {CACHE_TTL // 60} 分钟")
    print("=" * 55)

    # ⚡ 先启动 HTTP 服务，再后台异步预热数据
    # 这样前端不会因为等待数据而超时
    server = HTTPServer(("0.0.0.0", PORT), GoldAPIHandler)
    print(f"\n✅ HTTP 服务已就绪: http://0.0.0.0:{PORT}/api/gold")
    print("⏳ 正在后台抓取数据，约30秒后可用...\n")

    # 后台线程预热数据
    warm_thread = threading.Thread(target=refresh_data_bg, daemon=True)
    warm_thread.start()

    print("按 Ctrl+C 停止服务\n")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n🛑 服务已停止")
        server.server_close()
