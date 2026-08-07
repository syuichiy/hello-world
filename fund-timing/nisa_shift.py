"""集中している銘柄を売って、NISAへ移していく計画を試算する。

使い方（fund-timing フォルダで）:
    ./nisa.command                    # ダブルクリックでも可
    ./.venv/bin/python nisa_shift.py
    ./.venv/bin/python nisa_shift.py --stock 6501.JP --growth 8 --fund-growth 7

アプリの設定やデータは一切変更しません（読むだけの計算ツールです）。

■ 前提にしている制度（新NISA）
    年間 360万円（つみたて投資枠120万＋成長投資枠240万）
    生涯 1,800万円（簿価＝取得金額ベース。うち成長投資枠は1,200万まで）
    使った枠は、売却すると簿価ぶんが翌年に復活する

■ 使った枠の求め方
アプリで口座を「NISA」に設定した保有の【投資金額】の合計を、使用済みの簿価として扱います。
実際の枠と食い違う場合は --used で直接指定してください。
"""
import argparse
import sys

import db
import seed_funds

TAX = 0.20315          # 譲渡益課税（所得税・住民税・復興特別所得税）
NISA_LIFETIME = 18_000_000
NISA_ANNUAL = 3_600_000


def money(v):
    return f"{v:,.0f}"


def man(v):
    """万円で読みやすく。"""
    return f"{v / 10_000:,.0f}万"


def pad(text, width):
    import unicodedata
    w = sum(2 if unicodedata.east_asian_width(ch) in "WFA" else 1 for ch in text)
    return text + " " * max(0, width - w)


def load():
    """保有の評価額・取得価額・口座種別をまとめて読む。"""
    hists = db.get_all_amount_histories()
    out = []
    for it in db.list_watchlist():
        h = hists.get(it["watch_id"]) or {}
        value = float(h[max(h.keys())]) if h else 0.0
        invested = float(it.get("invested") or 0)
        if value <= 0:
            value = invested          # 評価額が出せないものは取得額で代用
        out.append({
            "id": it["watch_id"], "name": it.get("name") or "",
            "isin": (it.get("isin") or "").upper(),
            "kind": it.get("kind") or "fund",
            "account": it.get("account_type") or "taxable",
            "value": value, "invested": invested,
            "date": max(h.keys()) if h else None,
        })
    return out


def pick_source(holdings, want):
    """移す元の銘柄を選ぶ。指定が無ければ特定口座で一番大きいものにする。"""
    if want:
        w = want.upper()
        for h in holdings:
            if h["isin"] == w or w in h["name"].upper():
                return h
        print(f"「{want}」に一致する保有が見つかりません。")
        sys.exit(1)
    tax_side = [h for h in holdings if h["account"] != "nisa"]
    if not tax_side:
        print("特定口座の保有がありません。")
        sys.exit(1)
    return max(tax_side, key=lambda h: h["value"])


def sell_to_net(value, book, net_needed):
    """税引後で net_needed を得るのに必要な売却額と税額を返す。

    売却は持ち分に比例して行われるので、取得価額も同じ割合だけ減る。
    利益率 g = (value - book) / value のとき、手取りは 売却額 × (1 - g×税率)。
    """
    if value <= 0:
        return 0.0, 0.0, 0.0
    gain_fr = max(0.0, (value - book) / value)
    keep = 1 - gain_fr * TAX
    gross = min(value, net_needed / keep if keep > 0 else value)
    gain = gross * gain_fr
    tax = gain * TAX
    return gross, tax, gross - tax


def main():
    ap = argparse.ArgumentParser(add_help=True)
    ap.add_argument("--stock", default=None, help="移す元の銘柄（ティッカーか名前の一部）")
    ap.add_argument("--growth", type=float, default=None, help="移す元の年利(%%)")
    ap.add_argument("--fund-growth", type=float, default=None, help="その他の資産の年利(%%)")
    ap.add_argument("--used", type=float, default=None, help="使用済みのNISA簿価（円）")
    ap.add_argument("--years", type=int, default=12, help="表示する年数")
    args = ap.parse_args()

    db.init_db()
    holdings = load()
    if not holdings:
        print("保有がありません。")
        return

    plan = db.get_setting("plan", {}) or {}
    default_rate = float(plan.get("return_rate") or 0) or 5.0
    g_src = (args.growth if args.growth is not None else default_rate) / 100.0
    g_oth = (args.fund_growth if args.fund_growth is not None else default_rate) / 100.0

    src = pick_source(holdings, args.stock)
    others = [h for h in holdings if h["id"] != src["id"]]
    total = sum(h["value"] for h in holdings)
    other_val = sum(h["value"] for h in others)

    used = args.used
    if used is None:
        used = sum(h["invested"] for h in holdings if h["account"] == "nisa")
    room = max(0.0, NISA_LIFETIME - used)

    print("=" * 72)
    print("  集中している銘柄をNISAへ移す計画（試算）")
    print("=" * 72)
    print(f"移す元 : {src['name']}"
          + (f"（{src['date']} 時点）" if src["date"] else ""))
    print(f"         評価額 {money(src['value'])} 円 ／ 取得 {money(src['invested'])} 円")
    if src["value"] > 0:
        gain_fr = max(0.0, (src["value"] - src["invested"]) / src["value"])
        print(f"         含み益 {money(src['value'] - src['invested'])} 円"
              f"（売却額の {gain_fr * 100:.0f}%）"
              f" → 税引後で360万を作るには {money(3_600_000 / (1 - gain_fr * TAX))} 円の売却が必要")
        if src["invested"] <= 0:
            print("         ⚠️ 投資金額が未入力のため、売却額の全部を利益とみなしています。")
            print("            銘柄一覧で投資金額を入れると、税額が正しく出ます。")
    print(f"総資産 : {money(total)} 円 ／ うちこの銘柄が {src['value'] / total * 100:.1f}%")
    print()
    print(f"NISA   : 使用済み簿価 {money(used)} 円"
          + ("（口座を『NISA』にした保有の投資金額の合計）" if args.used is None else "（指定値）"))
    print(f"         生涯枠の残り {money(room)} 円"
          f" → 年360万なら あと {room / NISA_ANNUAL:.1f} 年ぶん")
    if room <= 0:
        print("         ※ 生涯枠を使い切っています。以降の移し先は特定口座になります。")
    print()
    print(f"想定    : この銘柄 年{g_src * 100:.1f}% ／ その他の資産 年{g_oth * 100:.1f}% で伸びるとする"
          "（--growth / --fund-growth で変更できます）")
    print()

    # --- 年ごとの試算 -----------------------------------------------------
    v, b = src["value"], src["invested"]
    oth = other_val
    left = room
    tax_sum = 0.0
    print(pad("年", 6) + pad("売却額", 12) + pad("税額", 11) + pad("NISA投入", 11)
          + pad("残り評価額", 13) + pad("総資産", 13) + "比率")
    print("-" * 72)
    print(pad("いま", 6) + pad("", 12) + pad("", 11) + pad("", 11)
          + pad(man(v), 13) + pad(man(v + oth), 13)
          + f"{v / (v + oth) * 100:.1f}%")
    for year in range(1, args.years + 1):
        v *= 1 + g_src
        oth *= 1 + g_oth
        want = min(NISA_ANNUAL, left)
        gross, tax, net = sell_to_net(v, b, want) if want > 0 else (0.0, 0.0, 0.0)
        if gross > 0:
            b -= b * (gross / v) if v > 0 else 0
            v -= gross
            oth += net
            left -= net
            tax_sum += tax
        tot = v + oth
        mark = ""
        if want > 0 and left <= 0:
            mark = "  ← 生涯枠を使い切り"
        print(pad(f"{year}年後", 6) + pad(man(gross) if gross else "—", 12)
              + pad(man(tax) if tax else "—", 11)
              + pad(man(net) if net else "—", 11)
              + pad(man(v), 13) + pad(man(tot), 13)
              + f"{v / tot * 100:.1f}%" + mark)
        if left <= 0:
            break        # 生涯枠を使い切ったらここで打ち切る（以降は移し先が無い）
    print("-" * 72)
    print(f"NISAへ移せた合計 {man(room - max(0.0, left))} 円 ／ 納めた税の合計 {man(tax_sum)} 円")
    print()

    # --- 枠を使い切ったあと -------------------------------------------------
    print("【枠を使い切ったあと】")
    print(f"  この時点で {src['name'][:20]} は約 {man(v)} 円 ＝ 資産の {v / (v + oth) * 100:.0f}% 残ります。")
    print("  NISAという移し先が無くなるため、選べるのは次の3つです。")
    print()
    print("  A) 持ち続ける … 税金はかかりませんが、集中はこの比率のまま続きます")
    print("  B) 特定口座で受ける … 課税されますが集中を下げられます（下に試算）")
    print("  C) NISA内の保有を売って枠を再生する … 翌年に簿価ぶんの枠が戻りますが、")
    print("     非課税で伸ばせるはずだった分を手放すことになります")
    print()
    start_share = v / (v + oth) * 100
    if start_share < 10:
        print(f"  ※ この時点ですでに資産の{start_share:.0f}%まで下がっているので、")
        print("     B)の試算は省略します。")
    else:
        v2, b2, oth2 = v, b, oth
        print("  B) を選び、毎年360万ぶんずつ特定口座へ移した場合:")
        print("   " + pad("年", 8) + pad("売却額", 12) + pad("税額", 11)
              + pad("残り評価額", 13) + "比率")
        for i in range(1, 11):
            v2 *= 1 + g_src
            oth2 *= 1 + g_oth
            gross, tax, net = sell_to_net(v2, b2, NISA_ANNUAL)
            if gross <= 0:
                break
            b2 -= b2 * (gross / v2) if v2 > 0 else 0
            v2 -= gross
            oth2 += net
            share = v2 / (v2 + oth2) * 100
            print("   " + pad(f"+{i}年", 8) + pad(man(gross), 12) + pad(man(tax), 11)
                  + pad(man(v2), 13) + f"{share:.1f}%")
            if share < 10:
                print("     （資産の10%を下回りました）")
                break
    print()
    print("※ 値上がり率は仮定です。税額は譲渡益に対する20.315%で計算しています。")
    print("※ 制度の枠（年360万・生涯1,800万）は簿価ベースです。投資助言ではありません。")


if __name__ == "__main__":
    main()
