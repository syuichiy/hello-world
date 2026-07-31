"""証券会社の取引履歴CSVを読み取って、売買の記録に取り込める形へ変換する。

対応フォーマット:
  SBI証券  「約定履歴照会」CSV
      先頭に照会条件などの前置きがあり、その後に
      約定日,銘柄,銘柄コード,市場,取引,期限,預り,課税,約定数量,約定単価,
      手数料/諸経費等,税額,受渡日,受渡金額/決済損益
  楽天証券 「取引履歴（投資信託）」CSV
      約定日,受渡日,ファンド名,分配金,口座,取引,買付方法,数量［口］,単価,経費,
      為替レート,受付金額[現地通貨],受渡金額/(ポイント利用)[円],決済通貨

どちらも Shift-JIS(cp932) が既定。単価は投信なら1万口あたり、株なら1株あたり。
"""
from __future__ import annotations

import csv
import io
import re
import unicodedata

# 取引の種別 → buy / sell。ここに無いもの（コース変更の出庫・入庫など）は取り込まない。
_BUY_WORDS = ("買付", "買い付け", "現物買", "買", "再投資")
_SELL_WORDS = ("解約", "売却", "現物売", "売", "償還")
# 売買ではない行（口座間の移動など）。金額が動かないので取り込むと二重計上になる。
_SKIP_WORDS = ("コース変更", "出庫", "入庫", "振替", "移管")


def decode(raw: bytes) -> str:
    """証券会社CSVの文字コードを判定して文字列にする（既定はShift-JIS）。"""
    for enc in ("cp932", "utf-8-sig", "utf-8"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    return raw.decode("cp932", errors="replace")


def normalize_name(s: str) -> str:
    """商品名を比較用に正規化する。
    全角英数・全角カッコ・スペース・記号の違いを吸収して、同じ商品を同じ文字列にする。"""
    s = unicodedata.normalize("NFKC", s or "")
    s = s.replace("＜", "<").replace("＞", ">")
    s = re.sub(r"[\s　]+", "", s)
    s = re.sub(r"""[()（）「」『』\[\]【】・,，.、'"”“’]""", "", s)
    return s.lower()


def _to_num(v) -> float:
    """"29,513" や "--"、"30,000(382)" のような値を数値にする（取れなければ0）。"""
    s = str(v or "").strip()
    s = re.sub(r"\(.*?\)", "", s)          # 「(382)」などの括弧書きは除く
    s = s.replace(",", "").replace("￥", "").replace("円", "")
    m = re.search(r"-?\d+(?:\.\d+)?", s)
    return float(m.group()) if m else 0.0


def _to_date(v) -> str:
    """"2026/07/02" や "2025/1/15" を "YYYY-MM-DD" にする。読めなければ空文字。"""
    m = re.search(r"(\d{4})\D+(\d{1,2})\D+(\d{1,2})", str(v or ""))
    if not m:
        return ""
    y, mo, d = (int(x) for x in m.groups())
    return f"{y:04d}-{mo:02d}-{d:02d}"


def _side_of(text: str):
    """取引の種別から buy / sell を決める。売買でなければ None。"""
    t = str(text or "")
    if any(w in t for w in _SKIP_WORDS):
        return None
    # 「買付」「解約」の判定は語の出現順ではなく、売り語を先に見る
    # （"投信金額解約" のように売買語が語尾に付く形式に対応）
    if any(w in t for w in _SELL_WORDS):
        return "sell"
    if any(w in t for w in _BUY_WORDS):
        return "buy"
    return None


def _find_header(rows, required):
    """必要な列名がすべて含まれる行を見出しとして探し、(行番号, 列名リスト) を返す。"""
    for i, r in enumerate(rows):
        cells = [str(c or "").strip() for c in r]
        joined = "".join(cells)
        if all(k in joined for k in required):
            return i, cells
    return -1, []


def _col(header, *keywords):
    """列名に keywords のいずれかを含む列の位置を返す（無ければ -1）。"""
    for i, h in enumerate(header):
        for k in keywords:
            if k in h:
                return i
    return -1


def parse(raw: bytes) -> dict:
    """CSVを解析して {broker, rows:[{date, name, side, units, price, fee, account, dividend_mode}], skipped}
    を返す。broker は "SBI証券" / "楽天証券" / ""（判別できず）。"""
    text = decode(raw)
    rows = list(csv.reader(io.StringIO(text)))
    if not rows:
        return {"ok": False, "error": "CSVが空です。"}

    # 楽天は先頭行が見出し。SBIは前置きの後に見出しが来る。
    hi, header = _find_header(rows, ("約定日", "単価"))
    if hi < 0:
        hi, header = _find_header(rows, ("約定日", "約定単価"))
    if hi < 0:
        return {"ok": False, "error": "取引履歴の見出し行が見つかりませんでした。"
                                      "証券会社の「取引履歴」「約定履歴」のCSVか確認してください。"}

    joined = "".join(header)
    broker = "楽天証券" if "ファンド名" in joined else ("SBI証券" if "銘柄" in joined else "")

    i_date = _col(header, "約定日")
    i_name = _col(header, "ファンド名", "銘柄")
    i_side = _col(header, "取引")
    i_units = _col(header, "数量")
    i_price = _col(header, "単価")
    i_fee = _col(header, "手数料", "経費")
    i_acct = _col(header, "預り", "口座")
    i_div = _col(header, "分配金")
    if min(i_date, i_name, i_side, i_units, i_price) < 0:
        return {"ok": False, "error": "必要な列（約定日・銘柄名・取引・数量・単価）が見つかりませんでした。"}

    out, skipped = [], []
    for r in rows[hi + 1:]:
        if not r or len(r) <= max(i_date, i_name, i_side, i_units, i_price):
            continue
        name = str(r[i_name] or "").strip()
        date = _to_date(r[i_date])
        if not name or not date:
            continue
        side = _side_of(r[i_side])
        if side is None:
            skipped.append({"name": name, "date": date, "reason": str(r[i_side] or "").strip()})
            continue
        units = _to_num(r[i_units])
        price = _to_num(r[i_price])
        if units <= 0 or price <= 0:
            skipped.append({"name": name, "date": date, "reason": "数量または単価が読み取れません"})
            continue
        acct = str(r[i_acct] or "").strip() if i_acct >= 0 else ""
        div = str(r[i_div] or "").strip() if i_div >= 0 else ""
        out.append({
            "date": date, "name": name, "side": side,
            "units": units, "price": price,
            "fee": _to_num(r[i_fee]) if i_fee >= 0 else 0.0,
            # 預り区分（NISA/特定）と分配金コース。取り込み時の参考として持っておく
            "account_type": "nisa" if "NISA" in acct.upper() else ("taxable" if acct else ""),
            "dividend_mode": ("receive" if "受取" in div else
                              "reinvest" if "再投資" in div else ""),
        })
    return {"ok": True, "broker": broker, "rows": out, "skipped": skipped}


# 部分一致で同一商品とみなすのに必要な最低文字数。これより短い名前（口座の
# ニックネーム "NASDAQ100" など）で部分一致させると、別の商品に誤って
# 結び付いてしまうため、正式名称どうしの照合に限定する。
_MIN_PARTIAL_LEN = 12


def match_holdings(rows, holdings, broker=""):
    """CSVの商品名を、保有（ウォッチリスト）へ突き合わせる。

    holdings は db.list_watchlist() の結果。同じ商品を複数の証券会社で持てるため、
    CSVの発行元（broker）と同じ証券会社の保有を優先する。
    照合は 正式名称の完全一致 → 口座名の完全一致 → 正式名称どうしの部分一致 の順。
    確実に1件に絞れないものは None にして、画面で選んでもらう。

    戻り値: {正規化名: {"watch_id": id or None, "how": "name"|"label"|"partial"|None}}
    """
    def pref(hs):
        """同じ証券会社の保有を優先する（無ければ全体から選ぶ）。"""
        same = [h for h in hs if broker and (h.get("broker") or "") == broker]
        return same or hs

    by_name, by_label = {}, {}
    for h in holdings:
        if h.get("name"):
            by_name.setdefault(normalize_name(h["name"]), []).append(h)
        if h.get("label"):
            by_label.setdefault(normalize_name(h["label"]), []).append(h)

    result = {}
    for key in {normalize_name(r["name"]) for r in rows}:
        hit, how = None, None
        for table, label in ((by_name, "name"), (by_label, "label")):
            hs = table.get(key)
            if hs:
                cands = pref(hs)
                if len(cands) == 1:
                    hit, how = cands[0], label
                break
        if hit is None:
            # 正式名称どうしの部分一致（末尾の「（愛称）」有無などの差を吸収する）。
            # 短い名前は誤判定のもとなので対象外にする。
            partial = [h for k, hs in by_name.items() if len(k) >= _MIN_PARTIAL_LEN
                       and len(key) >= _MIN_PARTIAL_LEN and (k in key or key in k)
                       for h in hs]
            cands = pref(partial)
            if len(cands) == 1:
                hit, how = cands[0], "partial"
        result[key] = {"watch_id": hit["watch_id"] if hit else None, "how": how}
    return result
