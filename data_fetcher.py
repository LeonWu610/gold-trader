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

import json
import time
import random
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
FRED_API_KEY         = os.environ.get("FRED_API_KEY",      "721dba314c828e61fa4d0bc748b32463")
ALPHA_VANTAGE_KEY    = os.environ.get("ALPHA_VANTAGE_KEY", "6CF3LRAR9CS2XTKN")
POLYGON_KEY          = os.environ.get("POLYGON_KEY",       "OgVZlxub_KCvbdzNPXOwkeQc1oxlvmSk")
PORT = int(os.environ.get("PORT", 5001))   # Railway 会注入 $PORT

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

    # GLD ETF 资金流向（用量价综合判断：价格方向 + 成交量变化）
    if "GLD" in result and "price" in result["GLD"] and gld_hist_cache is not None:
        try:
            gld_vol   = gld_hist_cache["Volume"].dropna().tail(5).tolist()
            gld_close = gld_hist_cache["Close"].dropna().tail(5).tolist()
            if len(gld_vol) >= 5 and len(gld_close) >= 5:
                avg_vol_recent = sum(gld_vol[-2:]) / 2
                avg_vol_prior  = sum(gld_vol[:3]) / 3
                price_up = gld_close[-1] > gld_close[0]
                vol_up   = avg_vol_recent > avg_vol_prior * 1.1
                if price_up and vol_up:
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

    return result


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
    try:
        params = {
            "series_id": "CPIAUCSL",
            "api_key": api_key,
            "file_type": "json",
            "limit": 14,
            "sort_order": "desc",
            "observation_start": (datetime.date.today() - datetime.timedelta(days=400)).isoformat()
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


# ─── 4. CFTC黄金COT持仓（每周五发布）────────────────────────────────────────
def fetch_cot_data() -> dict:
    """
    CFTC公开数据，无需API key
    黄金期货合约代码：088691
    数据每周五美东时间15:30更新
    """
    try:
        # CFTC提供CSV下载
        url = "https://www.cftc.gov/dea/futures/deacmesf.htm"
        # 实际使用时解析HTML表格或使用专门的COT数据库
        # 这里演示用Quandl/Nasdaq数据接口（需注册免费账号）
        # 替代方案：https://www.cotpricecharts.com/
        
        # 简化版：直接请求CFTC的原始数据文件
        cot_url = "https://www.cftc.gov/files/dea/history/fut_disagg_txt_2025.zip"
        # 注意：实际生产中应解压ZIP并解析CSV
        # 此处返回示例结构，真实实现需解压处理
        return {
            "source": "CFTC",
            "status": "未实现",
            "net_long_est": None,   # 无真实数据，不返回假数字
            "update_day": "每周五15:30 ET",
            "note": "需解析CFTC ZIP文件后启用"
        }
    except Exception as e:
        return {"error": str(e)}


# ─── 5. 评分引擎 ─────────────────────────────────────────────────────────────
def compute_signal_score(price_data: dict, fred_data: dict, tech_data: dict, cot_data: dict) -> dict:
    scores = []

    gold_price = price_data.get("GC=F", {}).get("price", 0)
    # DXY：优先用 price_data 里的 Yahoo Finance DXY（90-110范围），
    #       fallback 时 price_data 里存的是 FRED DTWEXBGS（基期2006=100，当前~120）
    dxy_raw = price_data.get("DX-Y.NYB", {}).get("price", 104)
    dxy_source = price_data.get("DX-Y.NYB", {}).get("source", "Yahoo Finance")
    tips = fred_data.get("DFII10", {}).get("value", 1.9)
    # CPI：返回同比%（如 2.83），若为 None 则数据不足，不参与评分
    cpi_raw = fred_data.get("CPIAUCSL", {}).get("value", None)
    # 安全校验：若 cpi 异常大（>20%）说明拿到了原始指数，置为 None
    cpi = cpi_raw if (cpi_raw is not None and cpi_raw < 20) else None

    # 推算降息预期概率：实际利率越高，市场认为降息越远
    tips_for_fed = tips if tips is not None else 1.9
    fed_cut_prob_est = max(10, min(90, round(100 - tips_for_fed * 30)))

    # ETF 流向：从 price_data 中读取（已在 fetch_price_data 里计算）
    etf_flow = price_data.get("GLD", {}).get("etf_flow", None)

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

    # 央行购金：无实时数据源，不参与评分
    scores.append({"layer": "宏观结构", "name": "央行购金", "value": "无实时数据", "score": 0, "weight": 0})

    # 降息预期（由 TIPS 推算）
    fed_score = 3 if fed_cut_prob_est > 70 else (2 if fed_cut_prob_est > 50 else (0 if fed_cut_prob_est > 30 else -2))
    scores.append({"layer": "宏观节奏", "name": "降息预期（推算）", "value": f"{fed_cut_prob_est}%", "score": fed_score, "weight": 0.14})

    # 宏观节奏层（35%权重）
    # CPI 同比%：适度通胀利好黄金，通胀过高或过低均有副作用
    if cpi is not None:
        cpi_score = 3 if cpi < 2.5 else (1 if cpi < 3.0 else (-1 if cpi < 3.5 else -2))
        cpi_weight = 0.13
        cpi_value = f"{cpi:.2f}%"
    else:
        cpi_score = 0
        cpi_weight = 0
        cpi_value = "数据异常"
    scores.append({"layer": "宏观节奏", "name": "CPI同比通胀率", "value": cpi_value, "score": cpi_score, "weight": cpi_weight})

    # ETF 资金流向
    if etf_flow is not None:
        etf_score = 2 if etf_flow == "流入" else (-2 if etf_flow == "流出" else 0)
        etf_weight = 0.12
    else:
        etf_score = 0
        etf_weight = 0
        etf_flow = "无数据"
    scores.append({"layer": "情绪博弈", "name": "ETF资金流向", "value": etf_flow, "score": etf_score, "weight": etf_weight})

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

    # 交易信号判断
    in_support = 4700 <= gold_price <= 4850
    in_deep_support = 4400 <= gold_price <= 4500
    breakout = gold_price > 5000

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
        "etf_flow": etf_flow if etf_flow != "无数据" else None,
        "dxy_source": dxy_source,
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

    print("⏳ 获取COT持仓...")
    cot_data = fetch_cot_data()

    print("⏳ 计算综合评分...")
    signal = compute_signal_score(price_data, fred_data, tech_data, cot_data)

    output = {
        "timestamp": datetime.datetime.now().isoformat(),
        "data_sources": {
            "price":  price_data,
            "macro":  fred_data,
            "technical": tech_data,
            "cot":    cot_data,
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
    def do_GET(self):
        # 允许前端跨域访问（CORS）
        if self.path == "/api/gold" or self.path == "/api/gold/":
            try:
                data = get_cached_data()
                body = json.dumps(data, ensure_ascii=False, indent=2).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            except BrokenPipeError:
                # 客户端提前断开连接，忽略即可，不影响服务
                pass
            except ConnectionResetError:
                # 连接被重置，同样忽略
                pass
            except Exception as e:
                print(f"[ERROR] /api/gold 处理异常: {e}")
                try:
                    err = json.dumps({"error": str(e)}).encode("utf-8")
                    self.send_response(500)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Access-Control-Allow-Origin", "*")
                    self.send_header("Content-Length", str(len(err)))
                    self.end_headers()
                    self.wfile.write(err)
                except (BrokenPipeError, ConnectionResetError):
                    pass
        elif self.path == "/api/refresh":
            # 强制刷新缓存
            try:
                _cache["ts"] = 0
                data = get_cached_data()
                body = json.dumps({"ok": True, "ts": _cache["ts"]}).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                pass
        else:
            try:
                self.send_response(404)
                self.end_headers()
            except (BrokenPipeError, ConnectionResetError):
                pass

    def do_OPTIONS(self):
        # 处理浏览器预检请求
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def log_message(self, format, *args):
        # 简化请求日志
        print(f"[HTTP] {self.address_string()} {format % args}")


# ─── 主入口 ───────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    print("=" * 55)
    print("  黄金交易信号系统 — 本地后端服务")
    print("=" * 55)
    print(f"🚀 启动本地 API 服务于 http://localhost:{PORT}")
    print(f"📡 数据接口: http://localhost:{PORT}/api/gold")
    print(f"🔑 FRED Key: {FRED_API_KEY[:8]}...")
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
