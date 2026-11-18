#!/usr/bin/env python3
"""抓取期货/指数日线 OHLC，输出给静态页面用的 JSON。

设计要点
--------
· 数据源只有 yfinance（连续合约，如 ES=F）。沙箱/数据中心 IP 常被 Yahoo 限流，
  因此本脚本主要在 GitHub Actions 里跑；本地跑不通不代表代码有问题。
· 输出「每个品种一个文件 + 一份 manifest」，页面按需加载，避免单文件过大。
· 取数失败的品种不会让整体失败：manifest 里标记 status，页面跳过即可。
· 页面端只消费 OHLC，均线在浏览器里算（单一实现，避免两处公式漂移）。

用法
----
    python fetch_data.py                 # 抓全部品种
    python fetch_data.py --days 400      # 只要最近 400 根日线
    python fetch_data.py --only ES,NQ,GC # 只抓几个
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.join(BASE_DIR, "data")

# 分组与代码沿袭 Finviz 的 Futures -> Charts 分类，尽量对应到 yfinance 可取的连续合约。
# key = yfinance 代码, name = 展示名, group = 分类
INSTRUMENTS: list[dict] = [
    # ---------------- 股指 Indices
    {"key": "ES=F",  "name": "S&P 500",         "group": "Indices"},
    {"key": "NQ=F",  "name": "Nasdaq 100",      "group": "Indices"},
    {"key": "YM=F",  "name": "Dow 30",          "group": "Indices"},
    {"key": "RTY=F", "name": "Russell 2000",    "group": "Indices"},
    {"key": "NKD=F", "name": "Nikkei 225",      "group": "Indices"},
    {"key": "^VIX",  "name": "VIX",             "group": "Indices"},

    # ---------------- 利率 Rates
    {"key": "ZQ=F",  "name": "30-Day Fed Funds", "group": "Rates"},
    {"key": "ZT=F",  "name": "2-Year Note",     "group": "Rates"},
    {"key": "ZF=F",  "name": "5-Year Note",     "group": "Rates"},
    {"key": "ZN=F",  "name": "10-Year Note",    "group": "Rates"},
    {"key": "TN=F",  "name": "Ultra 10-Year",   "group": "Rates"},
    {"key": "ZB=F",  "name": "30-Year Bond",    "group": "Rates"},
    {"key": "UB=F",  "name": "Ultra Bond",      "group": "Rates"},
    {"key": "^TNX",  "name": "10-Year Yield",   "group": "Rates"},

    # ---------------- 能源 Energy
    {"key": "CL=F",  "name": "Crude Oil WTI",   "group": "Energy"},
    {"key": "BZ=F",  "name": "Crude Oil Brent", "group": "Energy"},
    {"key": "NG=F",  "name": "Natural Gas",     "group": "Energy"},
    {"key": "RB=F",  "name": "Gasoline RBOB",   "group": "Energy"},
    {"key": "HO=F",  "name": "Heating Oil",     "group": "Energy"},

    # ---------------- 金属 Metals
    {"key": "GC=F",  "name": "Gold",            "group": "Metals"},
    {"key": "SI=F",  "name": "Silver",          "group": "Metals"},
    {"key": "PL=F",  "name": "Platinum",        "group": "Metals"},
    {"key": "PA=F",  "name": "Palladium",       "group": "Metals"},
    {"key": "HG=F",  "name": "Copper",          "group": "Metals"},

    # ---------------- 农产品 Grains
    {"key": "ZS=F",  "name": "Soybeans",        "group": "Grains"},
    {"key": "ZM=F",  "name": "Soybean Meal",    "group": "Grains"},
    {"key": "ZL=F",  "name": "Soybean Oil",     "group": "Grains"},
    {"key": "ZC=F",  "name": "Corn",            "group": "Grains"},
    {"key": "ZW=F",  "name": "Wheat",           "group": "Grains"},
    {"key": "ZR=F",  "name": "Rough Rice",      "group": "Grains"},

    # ---------------- 软商品与肉类 Softs & Meats
    {"key": "KC=F",  "name": "Coffee",          "group": "Softs & Meats"},
    {"key": "CC=F",  "name": "Cocoa",           "group": "Softs & Meats"},
    {"key": "SB=F",  "name": "Sugar",           "group": "Softs & Meats"},
    {"key": "CT=F",  "name": "Cotton",          "group": "Softs & Meats"},
    {"key": "LB=F",  "name": "Lumber",          "group": "Softs & Meats"},
    {"key": "LC=F",  "name": "Live Cattle",     "group": "Softs & Meats"},
    {"key": "FC=F",  "name": "Feeder Cattle",   "group": "Softs & Meats"},
    {"key": "LH=F",  "name": "Lean Hogs",       "group": "Softs & Meats"},

    # ---------------- 外汇 Currencies
    {"key": "DX=F",  "name": "US Dollar Index", "group": "Currencies"},
    {"key": "6E=F",  "name": "Euro",            "group": "Currencies"},
    {"key": "6J=F",  "name": "Japanese Yen",    "group": "Currencies"},
    {"key": "6B=F",  "name": "British Pound",   "group": "Currencies"},
    {"key": "6C=F",  "name": "Canadian Dollar", "group": "Currencies"},
    {"key": "6S=F",  "name": "Swiss Franc",     "group": "Currencies"},
    {"key": "6A=F",  "name": "Australian Dollar", "group": "Currencies"},

    # ---------------- 加密 Crypto
    {"key": "BTC=F", "name": "Bitcoin",         "group": "Crypto"},
]


def slug(key: str) -> str:
    """代码转文件名：ES=F -> ES，^VIX -> VIX。"""
    return key.replace("=F", "").replace("^", "").replace("/", "_")


def fetch_one(yf, key: str, days: int) -> dict | None:
    """取单个品种的日线，返回 {dates, o,h,l,c,v} 或 None。"""
    import pandas as pd

    df = None
    for attempt in (1, 2):
        try:
            df = yf.download(
                key, period=f"{days}d", interval="1d",
                auto_adjust=False, progress=False, threads=False, timeout=30,
            )
            if df is not None and not df.empty:
                break
        except Exception as e:                                # noqa: BLE001
            print(f"    ! {key} 第{attempt}次失败 {type(e).__name__}: {str(e)[:70]}")
        df = None
        if attempt == 1:
            time.sleep(3)

    if df is None or df.empty:
        return None

    if isinstance(df.columns, pd.MultiIndex):
        df.columns = df.columns.get_level_values(0)
    df.columns = [str(c).lower() for c in df.columns]

    need = ["open", "high", "low", "close"]
    if not set(need).issubset(df.columns):
        return None

    sub = df[need + (["volume"] if "volume" in df.columns else [])].copy()
    sub = sub.dropna(subset=need)
    sub = sub[~sub.index.duplicated(keep="last")].sort_index()
    if sub.empty:
        return None

    # 价格必须是正数；异常值直接丢弃，避免图上出现穿轴的尖刺
    for c in need:
        sub = sub[sub[c] > 0]
    if sub.empty:
        return None

    out = {
        "dates": [d.strftime("%Y-%m-%d") for d in sub.index],
        "o": [round(float(x), 4) for x in sub["open"]],
        "h": [round(float(x), 4) for x in sub["high"]],
        "l": [round(float(x), 4) for x in sub["low"]],
        "c": [round(float(x), 4) for x in sub["close"]],
    }
    if "volume" in sub.columns:
        out["v"] = [int(x) if x == x else 0 for x in sub["volume"]]
    return out


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="抓取期货日线并生成静态 JSON")
    p.add_argument("--days", type=int, default=500, help="保留最近多少根日线")
    p.add_argument("--only", default="", help="只抓这些代码，逗号分隔，如 ES,GC")
    p.add_argument("--sleep", type=float, default=0.8, help="每个品种之间的间隔秒数")
    a = p.parse_args(argv)

    try:
        import yfinance as yf
    except ImportError:
        print("需要 yfinance：pip install yfinance", file=sys.stderr)
        return 2

    os.makedirs(OUT_DIR, exist_ok=True)
    only = {s.strip().upper() for s in a.only.split(",") if s.strip()}

    todo = [it for it in INSTRUMENTS
            if not only or slug(it["key"]).upper() in only
            or it["key"].upper() in only]

    print(f"准备抓取 {len(todo)} 个品种，每品种最多 {a.days} 根日线\n")

    manifest: list[dict] = []
    ok = fail = 0

    for it in todo:
        s = slug(it["key"])
        print(f"  [{s}] {it['name']} ({it['key']}) ...", end=" ", flush=True)
        d = fetch_one(yf, it["key"], a.days)
        if d is None:
            print("失败")
            manifest.append({**it, "file": None, "status": "failed", "bars": 0})
            fail += 1
        else:
            payload = {
                "key": it["key"], "name": it["name"],
                "group": it["group"], "bars": len(d["dates"]),
                "last": d["c"][-1], "lastDate": d["dates"][-1],
                **d,
            }
            with open(os.path.join(OUT_DIR, f"{s}.json"), "w",
                      encoding="utf-8") as f:
                json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
            manifest.append({
                **it, "file": f"{s}.json", "status": "ok",
                "bars": len(d["dates"]), "last": d["c"][-1],
                "lastDate": d["dates"][-1],
            })
            print(f"ok  {len(d['dates'])} 根  末值 {d['c'][-1]:.2f}  "
                  f"{d['dates'][-1]}")
            ok += 1
        time.sleep(a.sleep)

    meta = {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "source": "yfinance (continuous futures)",
        "requested_days": a.days,
        "count": len(manifest),
        "ok": ok,
        "failed": fail,
        "instruments": manifest,
    }
    with open(os.path.join(OUT_DIR, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)

    print(f"\n完成：{ok} 成功 / {fail} 失败 → {OUT_DIR}")
    if ok == 0:
        print("警告：没有任何品种取到数据。Yahoo 对数据中心 IP 限流很常见，"
              "请在 GitHub Actions 中运行。", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
