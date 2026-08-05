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

import sqlite3

import db
import fund_data
import app as appmod
from app import (_cache_ttl_hours, _fresh_target, _prev_business_day,
                 _MARKET_CLOSE, _MARKET_SETTLED)


def _cache_fetched_at(isin: str):
    """キャッシュを取得した日時を読む（get_cached_series は中身しか返さないため）。"""
    try:
        with sqlite3.connect(db.DB_PATH) as c:
            r = c.execute("SELECT fetched_at FROM cache WHERE isin=? AND assoc_code=?",
                          (isin, "")).fetchone()
        return dt.datetime.fromisoformat(r[0]) if r and r[0] else None
    except Exception:
        return None


def probe(ticker: str) -> None:
    print(f"\n=== {ticker} ===")
    target = _fresh_target("stock")
    now = dt.datetime.now()
    if now.weekday() >= 5:
        session = "休場（土日）"
    elif now.time() < dt.time(9, 0):
        session = "寄り前"
    elif now.time() < _MARKET_CLOSE:
        session = "場中"
    else:
        session = "取引終了後"
    print(f"目標（ここまで揃っていれば新しい）: {target}"
          f"（今 {now:%Y-%m-%d %H:%M}／{session}・前営業日 {_prev_business_day()}）")
    print(f"  ※ 大引けは {_MARKET_CLOSE:%H:%M}。終値が確定するまで見て "
          f"{_MARKET_SETTLED:%H:%M} 以降に当日分を取りにいきます。")

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

    # キャッシュは「最終日」だけでなく「いつ取得したか」も見る。
    # 場中は日付が当日でも、取得が数時間前なら画面の株価は止まったままになる。
    cached = db.get_cached_series(ticker, "", max_age_hours=24 * 365)
    if cached and cached.get("dates"):
        last = cached["dates"][-1]
        fetched = _cache_fetched_at(ticker)
        ttl = _cache_ttl_hours("stock")
        state = "古いので自動で取り直します" if last < target.isoformat() else "日付は最新"
        print(f"  [キャッシュ] 最終日 {last} … {state}")
        if fetched:
            age_min = (dt.datetime.now() - fetched).total_seconds() / 60
            print(f"               取得したのは {fetched:%m/%d %H:%M}（{age_min:.0f}分前）"
                  f"／有効期限 {ttl * 60:.0f}分 → "
                  + ("期限切れなので次のアクセスで取り直します" if age_min > ttl * 60
                     else "この間は同じ株価が表示されます"))
    else:
        print("  [キャッシュ] なし")

    # 実際にアプリが画面へ返す値。取得元・キャッシュが正しくても、ここが古ければ
    # 表示側（範囲の切り出しなど）に原因がある。
    for label, force in (("アプリの表示値", False), ("↻最新に更新と同じ", True)):
        try:
            s = appmod.load_series(ticker, "", "", force=force, kind="stock")
            dates, nav = s.get("dates") or [], s.get("nav") or []
            if dates:
                print(f"  [{label}] 最終日 {dates[-1]} / 終値 {nav[-1]:,} 円"
                      + ("" if dates[-1] >= target.isoformat() else "  ← 目標より古い"))
            else:
                print(f"  [{label}] データが空です")
        except Exception as e:
            print(f"  [{label}] 失敗 {type(e).__name__}: {e}")

    # 直近の値動き。ここで「今日の値が昨日と同じ」なら、データ自体が動いていない。
    try:
        s = appmod.load_series(ticker, "", "", kind="stock")
        dates, nav = s.get("dates") or [], s.get("nav") or []
        if len(dates) >= 2:
            print("  [直近の値動き]")
            prev = None
            for d, v in zip(dates[-6:], nav[-6:]):
                diff = "" if prev is None else f"  前日比 {v - prev:+,.1f} 円"
                print(f"      {d}  {v:>10,.1f} 円{diff}")
                prev = v
            if nav[-1] == nav[-2]:
                print("      ※ 最新2日の終値が同じです。データ提供側が当日分を"
                      "まだ確定していない可能性があります。")
    except Exception:
        pass

    # 銘柄一覧の「基準価額」に出る数字そのもの（表示側の切り出しまで通した結果）
    try:
        row = next((w for w in db.list_watchlist()
                    if (w["isin"] or "").upper() == ticker.upper()), None)
        if row is not None:
            summary = appmod._summarize_fund(row, "1y")
            if summary.get("ok"):
                print(f"  [銘柄一覧の表示] 基準価額 {summary.get('latest_price'):,} 円"
                      f" / 騰落 {summary.get('change_pct')}%")
            else:
                print(f"  [銘柄一覧の表示] エラー: {summary.get('error')}")
    except Exception as e:
        print(f"  [銘柄一覧の表示] 確認できませんでした（{type(e).__name__}: {e}）")


def show_env() -> None:
    """実行しているコードが新しいかどうかを確かめる（アプリの再起動忘れ対策）。"""
    import os
    here = os.path.dirname(os.path.abspath(__file__))
    marks = [("株の場中キャッシュ短縮", hasattr(appmod, "_cache_ttl_hours")),
             ("取得元を鮮度で切り替え", "want = _prev_business_day()" in
              open(os.path.join(here, "fund_data.py"), encoding="utf-8").read())]
    print("いま動かしているコード:")
    print(f"  フォルダ : {here}")
    print(f"  データ   : {db.DB_PATH}"
          + ("" if os.path.exists(db.DB_PATH) else "  ← まだありません（アプリを一度起動してください）"))
    for name, ok in marks:
        print(f"  {'✅' if ok else '❌ 古いファイルです'} {name}")
    print("  ※ アプリ(app.py)を起動したままファイルを差し替えた場合は、"
          "ターミナルで Ctrl+C → 起動し直してください。")


def main() -> None:
    show_env()
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
