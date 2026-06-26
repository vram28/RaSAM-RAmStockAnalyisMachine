"""
Stock Analyst Recommendations Dashboard
----------------------------------------
A small Flask web app that aggregates analyst recommendations (the same
firm-level ratings published by Morningstar, BofA, Citi, Morgan Stanley, etc.)
via the Yahoo Finance data feed, then derives a Strong Buy / Buy / Hold / Sell
signal for each stock and ranks the day's winners and losers.

Why not scrape Morningstar/Fidelity/BofA/Citi directly?
  Those sites require authentication, sit behind paywalls, and their Terms of
  Service prohibit scraping. Yahoo Finance legally aggregates the analyst
  ratings and the actual upgrade/downgrade actions issued by those firms, so we
  use that as the data source.
"""

from __future__ import annotations

import json
import math
import os
import random
import time
import concurrent.futures
from datetime import datetime, timezone

import yfinance as yf
from flask import Flask, jsonify, render_template, request

app = Flask(__name__)

# A default watchlist of widely-followed large-cap names. Users can override
# this from the UI by entering their own comma-separated tickers.
DEFAULT_TICKERS = [
    "AAPL", "MSFT", "GOOGL", "AMZN", "NVDA", "META", "TSLA", "AMD",
    "NFLX", "JPM", "BAC", "C", "WMT", "DIS", "KO", "PEP",
    "XOM", "CVX", "PFE", "JNJ", "INTC", "CRM", "ORCL", "ADBE",
]

# Simple in-memory cache so repeated "Check now" clicks within a short window
# don't hammer the data source.
_CACHE: dict[str, tuple[float, dict]] = {}
_CACHE_TTL_SECONDS = 30

# Per-ticker results are also persisted to disk. Yahoo Finance aggressively
# rate-limits (HTTP 429); caching each ticker means repeated "Check now" clicks
# and restarts reuse data instead of re-hammering the endpoint.
CACHE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".cache")
TICKER_CACHE_TTL = 50  # seconds — slightly under the 60s auto-refresh interval


def _with_retry(fn, *, attempts: int = 4, base_delay: float = 1.5):
    """Call fn(), retrying with exponential backoff + jitter on HTTP 429."""
    last_exc = None
    for i in range(attempts):
        try:
            return fn()
        except Exception as exc:  # noqa: BLE001 - inspect message for rate limit
            last_exc = exc
            msg = str(exc)
            if "429" in msg or "Too Many Requests" in msg:
                if i < attempts - 1:
                    time.sleep(base_delay * (2 ** i) + random.uniform(0, 0.75))
                    continue
            raise
    if last_exc:
        raise last_exc
    return None


def _ticker_cache_path(symbol: str) -> str:
    safe = "".join(c for c in symbol if c.isalnum() or c in ("-", ".", "_"))
    return os.path.join(CACHE_DIR, f"{safe}.json")


def _read_ticker_cache(symbol: str) -> dict | None:
    path = _ticker_cache_path(symbol)
    try:
        if os.path.exists(path) and (time.time() - os.path.getmtime(path)) < TICKER_CACHE_TTL:
            with open(path, "r", encoding="utf-8") as fh:
                return json.load(fh)
    except Exception:
        return None
    return None


def _write_ticker_cache(symbol: str, data: dict) -> None:
    try:
        os.makedirs(CACHE_DIR, exist_ok=True)
        with open(_ticker_cache_path(symbol), "w", encoding="utf-8") as fh:
            json.dump(data, fh)
    except Exception:
        pass


def rating_from_mean(mean: float | None) -> str:
    """Map Yahoo's 1-5 analyst mean (1 = Strong Buy ... 5 = Strong Sell)
    to a human-readable recommendation."""
    if mean is None or (isinstance(mean, float) and math.isnan(mean)):
        return "No Rating"
    if mean <= 1.5:
        return "Strong Buy"
    if mean <= 2.5:
        return "Buy"
    if mean <= 3.5:
        return "Hold"
    if mean <= 4.5:
        return "Sell"
    return "Strong Sell"


def _safe_float(value) -> float | None:
    try:
        f = float(value)
        if math.isnan(f):
            return None
        return f
    except (TypeError, ValueError):
        return None


def _recent_firm_actions(ticker: yf.Ticker, limit: int = 4) -> list[dict]:
    """Most recent firm-level upgrade/downgrade actions (BofA, Citi, etc.)."""
    actions: list[dict] = []
    try:
        df = _with_retry(lambda: ticker.upgrades_downgrades)
        if df is not None and not df.empty:
            df = df.sort_index(ascending=False).head(limit)
            for grade_date, row in df.iterrows():
                date_str = ""
                try:
                    date_str = grade_date.strftime("%Y-%m-%d")
                except Exception:
                    date_str = str(grade_date)
                actions.append({
                    "date": date_str,
                    "firm": str(row.get("Firm", "")).strip(),
                    "toGrade": str(row.get("ToGrade", "")).strip(),
                    "fromGrade": str(row.get("FromGrade", "")).strip(),
                    "action": str(row.get("Action", "")).strip(),
                })
    except Exception:
        pass
    return actions


def analyze_ticker(symbol: str) -> dict:
    """Fetch and analyze a single ticker. Always returns a dict (never raises)."""
    symbol = symbol.upper().strip()
    result = {
        "symbol": symbol,
        "name": symbol,
        "price": None,
        "previousClose": None,
        "changePercent": None,
        "recommendation": "No Rating",
        "recommendationMean": None,
        "numberOfAnalysts": None,
        "targetMeanPrice": None,
        "upsidePercent": None,
        "firmActions": [],
        "error": None,
    }

    # Serve from disk cache when fresh to avoid Yahoo Finance rate limits.
    cached = _read_ticker_cache(symbol)
    if cached is not None:
        return cached

    try:
        ticker = yf.Ticker(symbol)

        info = {}
        try:
            info = _with_retry(lambda: ticker.info) or {}
        except Exception:
            info = {}

        price = _safe_float(info.get("currentPrice") or info.get("regularMarketPrice"))
        previous_close = _safe_float(info.get("previousClose") or info.get("regularMarketPreviousClose"))

        change_percent = None
        if price is not None and previous_close not in (None, 0):
            change_percent = (price - previous_close) / previous_close * 100.0

        rec_mean = _safe_float(info.get("recommendationMean"))
        target_mean = _safe_float(info.get("targetMeanPrice"))
        num_analysts = info.get("numberOfAnalystOpinions")

        upside = None
        if target_mean is not None and price not in (None, 0):
            upside = (target_mean - price) / price * 100.0

        result.update({
            "name": info.get("shortName") or info.get("longName") or symbol,
            "price": price,
            "previousClose": previous_close,
            "changePercent": change_percent,
            "recommendation": rating_from_mean(rec_mean),
            "recommendationMean": rec_mean,
            "numberOfAnalysts": num_analysts,
            "targetMeanPrice": target_mean,
            "upsidePercent": upside,
            "firmActions": _recent_firm_actions(ticker),
        })
        # Only cache successful fetches that returned a price.
        if result.get("price") is not None:
            _write_ticker_cache(symbol, result)
    except Exception as exc:  # never let one bad ticker break the batch
        result["error"] = str(exc)

    return result


def build_payload(tickers: list[str]) -> dict:
    """Fetch all tickers (low concurrency) and assemble the response payload."""
    stocks: list[dict] = []
    # Keep concurrency low: Yahoo Finance rate-limits bursts with HTTP 429.
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        futures = {pool.submit(analyze_ticker, t): t for t in tickers}
        for fut in concurrent.futures.as_completed(futures):
            stocks.append(fut.result())

    # Sort by daily change for winners/losers ranking.
    rated = [s for s in stocks if s["changePercent"] is not None]
    rated.sort(key=lambda s: s["changePercent"], reverse=True)

    winners = [s for s in rated if s["changePercent"] > 0][:5]
    losers = [s for s in reversed(rated) if s["changePercent"] < 0][:5]

    # Default display order: best recommendation first, then by upside.
    def sort_key(s):
        mean = s["recommendationMean"] if s["recommendationMean"] is not None else 99
        upside = s["upsidePercent"] if s["upsidePercent"] is not None else -999
        return (mean, -upside)

    stocks.sort(key=sort_key)

    counts = {"Strong Buy": 0, "Buy": 0, "Hold": 0, "Sell": 0, "Strong Sell": 0, "No Rating": 0}
    for s in stocks:
        counts[s["recommendation"]] = counts.get(s["recommendation"], 0) + 1

    return {
        "updatedAt": datetime.now(timezone.utc).isoformat(),
        "stocks": stocks,
        "winners": winners,
        "losers": losers,
        "counts": counts,
    }


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/recommendations")
def recommendations():
    raw = request.args.get("tickers", "").strip()
    if raw:
        tickers = [t.strip().upper() for t in raw.replace("\n", ",").split(",") if t.strip()]
    else:
        tickers = DEFAULT_TICKERS

    # de-duplicate while preserving order, cap to a sane number
    seen, tickers_clean = set(), []
    for t in tickers:
        if t not in seen:
            seen.add(t)
            tickers_clean.append(t)
    tickers_clean = tickers_clean[:40]

    cache_key = ",".join(tickers_clean)
    now = time.time()
    cached = _CACHE.get(cache_key)
    if cached and (now - cached[0]) < _CACHE_TTL_SECONDS:
        payload = dict(cached[1])
        payload["cached"] = True
        return jsonify(payload)

    payload = build_payload(tickers_clean)
    payload["cached"] = False
    _CACHE[cache_key] = (now, payload)
    return jsonify(payload)


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=True)
