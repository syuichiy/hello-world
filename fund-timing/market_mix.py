"""保有が「市場ポートフォリオ（時価総額比）」からどれだけ離れているかを計算する。

使い方（fund-timing フォルダで）:
    ./market.command             # ダブルクリックでも可
    ./.venv/bin/python market_mix.py

アプリの設定やデータは一切変更しません（読むだけの計算ツールです）。

■ なにを計算するか
アプリの資産クラス（米国／グローバル／高配当…）は「商品の性格」による分類なので、
たとえば「高配当」に分類された商品が中身では日本株100%、ということが起きます。
ここでは商品ごとに「中身がどの地域か」を割り当て直して、地域の比率を出します。
その比率を、全世界株式の時価総額比（＝市場ポートフォリオ）と並べて差を見ます。

■ 中身の比率について
各商品の地域比率は指数の構成から置いた概算です。相場で動くので、
正確を期すなら各ファンドの月次レポートの数字で EXPOSURE を上書きしてください。
"""
import sys
import datetime as dt

import db
import seed_funds

# 全世界株式の時価総額比（MSCI ACWI ベースのおおよその値）。
# 相場で動くため、厳密な比較をしたいときはここを最新値に置き換える。
MARKET = {"米国": 64.0, "日本": 5.0, "他の先進国": 20.0, "新興国": 11.0}

REGIONS = ["米国", "日本", "他の先進国", "新興国"]
EXTRA = ["金", "債券・REIT"]          # 株式ではないぶん（別枠で表示する）

# 協会コード → 中身の地域比率(%)。合計が100を超えるものはレバレッジ・合成（金プラス等）。
EXPOSURE = {
    # --- インデックス（全世界・先進国） ---
    "0331418A": {"米国": 63, "日本": 5, "他の先進国": 21, "新興国": 11},   # オルカン
    "9I31123A": {"米国": 63, "日本": 5, "他の先進国": 21, "新興国": 11},   # 楽天プラス オルカン
    "9I311179": {"米国": 61, "日本": 5, "他の先進国": 22, "新興国": 12},   # 楽天・VT（小型込み）
    "03316183": {"米国": 66, "他の先進国": 23, "新興国": 11},              # オルカン(除く日本)
    "03319172": {"米国": 74, "他の先進国": 26},                            # Slim 先進国株式
    "2931113C": {"米国": 75, "他の先進国": 25},                            # ニッセイ外国株式
    "4731B15C": {"米国": 75, "他の先進国": 25},                            # たわら先進国
    "0131410B": {"米国": 75, "他の先進国": 25},                            # Funds-i 外国株式
    "0331C177": {"新興国": 100},                                           # Slim 新興国株式

    # --- 米国 ---
    "03311187": {"米国": 100},   # Slim S&P500
    "89311199": {"米国": 100},   # SBI・V・S&P500
    "89311216": {"米国": 100},   # SBI・V・全米
    "9I312179": {"米国": 100},   # 楽天・VTI
    "9I31223A": {"米国": 100},   # 楽天プラス S&P500
    "9I314241": {"米国": 97, "他の先進国": 3},    # 楽天プラス NASDAQ100
    "29313233": {"米国": 97, "他の先進国": 3},    # ニッセイ NASDAQ100
    "04317188": {"米国": 97, "他の先進国": 3},    # iFreeNEXT NASDAQ100
    "04311181": {"米国": 100},   # FANG+
    "2931225B": {"米国": 100},   # メガ10
    "39312149": {"米国": 100},   # AB 米国成長株
    "25311177": {"米国": 100},   # おおぶね
    "9I312249": {"米国": 100},   # 楽天・SCHD
    "8931224C": {"米国": 100},   # SBI・S・米国高配当

    # --- 日本 ---
    "03317172": {"日本": 100},   # Slim TOPIX
    "03311182": {"日本": 100},   # Slim 日経平均
    "29311041": {"日本": 100},   # ニッセイ日経225
    "8931123C": {"日本": 100},   # SBI日本高配当株式（分配）
    "0331118B": {"日本": 100},   # 日経平均高配当利回り株
    "0131124A": {"日本": 100},   # Funds-i 日経半導体株
    "80311083": {"日本": 100},   # スパークス厳選投資
    "9C311125": {"日本": 90, "米国": 10},         # ひふみプラス

    # --- 半導体（台湾・韓国・オランダの比率が高い） ---
    "9I315241": {"米国": 78, "他の先進国": 12, "新興国": 10},   # 楽天プラス SOX
    "01313098": {"米国": 70, "他の先進国": 10, "新興国": 20},   # 野村 世界半導体株投資

    # --- アクティブ（世界株） ---
    "18312991": {"米国": 50, "他の先進国": 45, "新興国": 5},    # 世界のベスト
    "6831221A": {"米国": 65, "他の先進国": 25, "新興国": 10},   # WCM 世界成長株
    "96312073": {"米国": 55, "日本": 10, "他の先進国": 25, "新興国": 10},  # セゾン達人

    # --- レバレッジ・合成（合計が100を超える） ---
    "AY311247": {"米国": 200},                                  # auAM レバレッジNASDAQ100（2倍）
    "02315228": {"米国": 100, "金": 100},                       # Tracers S&P500ゴールドプラス
    "02311263": {"米国": 63, "日本": 5, "他の先進国": 21, "新興国": 11, "金": 100},  # 同オルカン版

    # --- バランス（株式以外を含む） ---
    "03312175": {"日本": 12.5, "米国": 9, "他の先進国": 3.5, "新興国": 12.5,
                 "債券・REIT": 62.5},                           # Slim バランス8資産均等
}

# 個別株はティッカーで割り当てる（末尾 .JP は日本）。
STOCK_EXPOSURE = {"6501.JP": {"日本": 100}}


def exposure_for(item):
    """1商品の中身の地域比率を返す。分からなければ名前から推定する。"""
    code = (item.get("assoc_code") or "").strip()
    if code in EXPOSURE:
        return dict(EXPOSURE[code]), True
    isin = (item.get("isin") or "").strip().upper()
    if isin in STOCK_EXPOSURE:
        return dict(STOCK_EXPOSURE[isin]), True
    if (item.get("kind") or "fund") == "stock":
        return ({"日本": 100} if isin.endswith(".JP") else {"米国": 100}), False
    # 未知の投信は、アプリの資産クラスからざっくり当てる
    cls = item.get("asset_class") or seed_funds.classify(item.get("name", ""),
                                                         item.get("category", ""))
    fallback = {
        "米国": {"米国": 100},
        "非米国": {"日本": 60, "他の先進国": 20, "新興国": 20},
        "グローバル": {"米国": 63, "日本": 5, "他の先進国": 21, "新興国": 11},
        "高配当": {"米国": 50, "日本": 30, "他の先進国": 20},
        "高リターン": {"米国": 90, "他の先進国": 10},
        "バリュー": {"米国": 50, "日本": 30, "他の先進国": 20},
    }
    return dict(fallback.get(cls, fallback["グローバル"])), False


def latest_values():
    """保有ごとの評価額。評価額の履歴が無ければ投資金額で代用する。"""
    hists = db.get_all_amount_histories()
    out = {}
    for it in db.list_watchlist():
        wid = it["watch_id"]
        h = hists.get(wid) or {}
        if h:
            d = max(h.keys())
            out[wid] = (float(h[d]), d, it)
        else:
            out[wid] = (float(it.get("invested") or 0), None, it)
    return out


def bar(pct, width=26, scale=70.0):
    n = int(round(min(pct, scale) / scale * width))
    return "█" * n + "·" * (width - n)


def pad(text, width):
    """全角を2文字ぶんとして数えて桁を揃える（日本語が混ざっても表が崩れないように）。"""
    import unicodedata
    w = sum(2 if unicodedata.east_asian_width(ch) in "WFA" else 1 for ch in text)
    return text + " " * max(0, width - w)


def main():
    db.init_db()
    vals = latest_values()
    holdings = [(v, d, it) for (v, d, it) in vals.values() if v > 0]
    if not holdings:
        print("評価額を計算できる保有がありません。銘柄一覧で口数と投資金額を入力してください。")
        return

    total = sum(v for v, _, _ in holdings)
    mix = {k: 0.0 for k in REGIONS + EXTRA}
    unknown = []
    for v, _, it in holdings:
        exp, known = exposure_for(it)
        if not known:
            unknown.append(it.get("name", ""))
        for region, pct in exp.items():
            mix[region] = mix.get(region, 0.0) + v * pct / 100.0

    equity = sum(mix[r] for r in REGIONS)
    print("=" * 68)
    print("  保有の中身 vs 市場ポートフォリオ（全世界株式の時価総額比）")
    print("=" * 68)
    dates = [d for _, d, _ in holdings if d]
    print(f"評価額の合計 {total:,.0f} 円 ／ {len(holdings)}件"
          + (f" ／ {max(dates)} 時点" if dates else ""))
    print(f"うち株式のエクスポージャー {equity:,.0f} 円"
          f"（評価額の {equity / total * 100:.0f}%）")
    if equity > total * 1.02:
        print("  ※ 100%を超えるのはレバレッジ・ゴールドプラス等で、")
        print("     元本より大きい金額ぶん値動きしているためです。")
    print()

    print(pad("地域", 14) + "いまの比率      市場        差   いまの比率")
    print("-" * 68)
    diffs = {}
    for r in REGIONS:
        cur = mix[r] / equity * 100 if equity else 0
        mk = MARKET[r]
        diffs[r] = cur - mk
        sign = "+" if cur - mk >= 0 else ""
        print(pad(r, 14) + f"{cur:>8.1f}%{mk:>9.0f}%"
              + f"{sign + format(cur - mk, '.1f') + 'pt':>10}   {bar(cur)}")
    print("-" * 68)
    non_us = sum(mix[r] for r in REGIONS if r != "米国") / equity * 100 if equity else 0
    us = mix["米国"] / equity * 100 if equity else 0
    print(pad("米国 / 非米国", 14) + f"{us:.1f}% / {non_us:.1f}%"
          + "      （市場は 64% / 36%）")
    print()

    for k in EXTRA:
        if mix.get(k, 0) > 0:
            print(f"（株式以外）{k}: {mix[k]:,.0f} 円"
                  f"／評価額の {mix[k] / total * 100:.1f}%")
    if any(mix.get(k, 0) > 0 for k in EXTRA):
        print()

    # 市場並みに戻すとしたら、どれだけ動かすことになるか
    print("市場ポートフォリオに合わせるなら（株式ぶん "
          f"{equity:,.0f} 円 に対して）")
    for r in REGIONS:
        gap = -diffs[r] / 100 * equity
        if abs(gap) < equity * 0.01:
            print("  " + pad(r, 12) + "ほぼ市場どおり")
        else:
            verb = "増やす" if gap > 0 else "減らす"
            print("  " + pad(r, 12) + f"{abs(gap):>12,.0f} 円 {verb}")
    print()

    # 何が効いているか（地域の偏りに効いている上位）
    print("米国比率を押し上げている／下げている商品（上位）")
    contrib = []
    for v, _, it in holdings:
        exp, _ = exposure_for(it)
        us_amt = v * exp.get("米国", 0) / 100.0
        eq_amt = sum(v * exp.get(r, 0) / 100.0 for r in REGIONS)
        contrib.append((us_amt - eq_amt * MARKET["米国"] / 100.0, it.get("name", ""), v))
    contrib.sort(reverse=True)
    for c, name, v in contrib[:5]:
        if c > 0:
            print("  ↑ " + pad(name[:30], 46) + f"{c:>12,.0f} 円ぶん米国寄り")
    for c, name, v in contrib[-3:]:
        if c < 0:
            print("  ↓ " + pad(name[:30], 46) + f"{-c:>12,.0f} 円ぶん非米国寄り")

    if unknown:
        print()
        print("※ 中身の地域が登録されていないため推定した商品:")
        for n in unknown[:8]:
            print("   -", n)
        print("   market_mix.py の EXPOSURE に協会コードを足すと精度が上がります。")

    print()
    print("※ 地域比率は指数構成からの概算です。投資助言ではありません。")


if __name__ == "__main__":
    main()
