"""デモ用ダミーCSV生成（投信協会CSVと同じ列・文字コードを模擬）。

ネット接続なしでアプリのUI・サインを試すために使う。
実データと同じく「年月日,基準価額(円),純資産総額（百万円）,分配金,決算期」形式。
"""
from __future__ import annotations

import datetime as dt
import io
import math
import random


def _generate_series(days: int = 800, seed: int = 42):
    random.seed(seed)
    start = dt.date.today() - dt.timedelta(days=int(days * 1.4))
    price = 10000.0
    assets = 500000.0
    rows = []
    d = start
    t = 0
    while len(rows) < days:
        # 土日はスキップ（営業日のみ）
        if d.weekday() < 5:
            # トレンド＋周期＋ノイズで、上下動のある値動きを作る
            trend = 0.00025
            cycle = 0.9 * math.sin(t / 45.0) + 0.5 * math.sin(t / 13.0)
            noise = random.gauss(0, 0.006)
            price *= (1 + trend + cycle * 0.0016 + noise)
            price = max(4000.0, price)
            assets *= (1 + trend + noise * 0.5)
            rows.append((d, round(price), round(assets)))
            t += 1
        d += dt.timedelta(days=1)
    return rows


# デモで「分配金あり（受取型）」を再現する高配当系ファンド（1万口あたりの年間分配金の目安・円）。
# 実データではCSVの分配金列から自動計算される。ここはUI確認用のダミー。
_DEMO_DIST_ANNUAL = {
    "JP90C000Q9K2": 300.0,   # SBI日本高配当株式（分配）ファンド
    "JP90C000MED5": 1200.0,  # ネクストジェネレーション（予想分配金提示型）
    "JP90C0002EX1": 1500.0,  # 世界のベスト（毎月決算型）
}


def demo_csv(isin: str, assoc_code: str) -> str:
    """fund_data.set_fetch_override に渡す関数。生CSVテキストを返す。

    ファンドごと（isin）に異なる値動きになるよう乱数シードを変える。
    高配当系ファンドは四半期ごとに分配金を計上して「分配金あり」を再現する。
    """
    seed = abs(hash((isin or "") + (assoc_code or ""))) % (2 ** 31)
    rows = _generate_series(seed=seed)
    annual = _DEMO_DIST_ANNUAL.get((isin or "").upper(), 0.0)
    per_pay = round(annual / 4)   # 四半期ごとに年4回
    buf = io.StringIO()
    buf.write("年月日,基準価額(円),純資産総額（百万円）,分配金,決算期\n")
    for i, (d, nav, assets) in enumerate(rows):
        # 末尾から数えて営業日ベースで約63日（≒四半期）おきに分配金を計上
        dist = per_pay if (annual > 0 and (len(rows) - 1 - i) % 63 == 0 and i != 0) else 0
        buf.write(f"{d.strftime('%Y/%m/%d')},{nav},{assets},{dist},0\n")
    return buf.getvalue()


def demo_stock_dividends(ticker: str):
    """fund_data.set_stock_dividend_override に渡す関数。
    直近1年ぶんの1株あたり配当（円）の実績を [(YYYY-MM-DD, 円), ...] で返す。
    日立(6501)は年2回・合計 約200円/株 を想定したダミー。"""
    if (ticker or "").upper() not in ("6501.JP", "6501.T"):
        return []
    today = dt.date.today()
    return [
        ((today - dt.timedelta(days=190)).isoformat(), 100.0),
        ((today - dt.timedelta(days=10)).isoformat(), 100.0),
    ]


if __name__ == "__main__":
    print(demo_csv("JP90C000H1T1", "0331418A")[:400])


def demo_stock_csv(ticker: str) -> str:
    """fund_data.set_stock_override に渡す関数。Stooq形式のCSVを返す。"""
    seed = abs(hash("stock:" + (ticker or ""))) % (2 ** 31)
    rows = _generate_series(seed=seed)
    buf = io.StringIO()
    buf.write("Date,Open,High,Low,Close,Volume\n")
    for d, nav, _assets in rows:
        px = nav / 3  # 株価らしい水準に
        buf.write(f"{d.isoformat()},{px:.1f},{px*1.01:.1f},{px*0.99:.1f},{px:.1f},1000000\n")
    return buf.getvalue()
