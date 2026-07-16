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


def demo_csv(isin: str, assoc_code: str) -> str:
    """fund_data.set_fetch_override に渡す関数。生CSVテキストを返す。

    ファンドごと（isin）に異なる値動きになるよう乱数シードを変える。
    """
    seed = abs(hash((isin or "") + (assoc_code or ""))) % (2 ** 31)
    rows = _generate_series(seed=seed)
    buf = io.StringIO()
    buf.write("年月日,基準価額(円),純資産総額（百万円）,分配金,決算期\n")
    for d, nav, assets in rows:
        buf.write(f"{d.strftime('%Y/%m/%d')},{nav},{assets},0,0\n")
    return buf.getvalue()


if __name__ == "__main__":
    print(demo_csv("JP90C000H1T1", "0331418A")[:400])
