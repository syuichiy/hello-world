#!/usr/bin/env python3
"""株価がどこまで取得できているかを調べる診断ツール。

使い方（fund-timing フォルダで）:
    ./.venv/bin/python check_stock.py            # 保有している株を全部調べる
    ./.venv/bin/python check_stock.py 6501.JP    # ティッカーを指定して調べる

取得元（Stooq / yfinance / Yahoo）ごとに「どこまでのデータを持っているか」と
アプリのキャッシュがいつのものかを表示します。
「昨日・今日の株価が出ない」ときに、原因が取得元にあるのかキャッシュにあるのかが分かります。
"""
import sys
import datetime as dt

import db
import fund_data
from app import _fresh_target, _prev_business_day


def probe(ticker: str) -> None:
    print(f"\n=== {ticker} ===")
    target = _fresh_target("stock")
    print(f"目標（ここまで揃っていれば新しい）: {target}"
          f"（今 {dt.datetime.now():%Y-%m-%d %H:%M}・前営業日 {_prev_business_day()}）")

    for label, fn in (("Stooq", fund_data._fetch_stock_stooq),
                      ("yfinance", fund_data._fetch_stock_yfinance),
                      ("Yahoo直接", fund_data._fetch_stock_yahoo)):
        try:
            rows = fn(ticker)
            last = max(r[0] for r in rows)
            gap = (target - last).days
            mark = "OK  " if last >= target else "遅れ"
            print(f"  [{mark}] {label:<9} 最終日 {last}（{len(rows)}件）"
                  + (f" … 目標より {gap}日 遅れています" if gap > 0 else ""))
        except Exception as e:
            print(f"  [失敗] {label:<9} {type(e).__name__}: {e}")

    cached = db.get_cached_series(ticker, "")
    if cached and cached.get("dates"):
        last = cached["dates"][-1]
        print(f"  [キャッシュ] 最終日 {last} … "
              + ("古いので自動で取り直します" if last < target.isoformat() else "最新です"))
    else:
        print("  [キャッシュ] なし")


def main() -> None:
    db.init_db()
    if len(sys.argv) > 1:
        for t in sys.argv[1:]:
            probe(t)
        return
    tickers = [w["isin"] for w in db.list_watchlist()
               if (w["kind"] or "fund") == "stock" and w["isin"]]
    if not tickers:
        print("株の銘柄が登録されていません。ティッカーを指定してください（例: 6501.JP）。")
        return
    for t in dict.fromkeys(tickers):
        probe(t)


if __name__ == "__main__":
    main()
