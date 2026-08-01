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
_BUY_WORDS = ("買付", "買い付け", "現物買", "買", "再投資", "取得", "buy")
_SELL_WORDS = ("解約", "売却", "現物売", "売", "償還", "sell")
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
    t = str(text or "").lower()
    if any(w in t for w in _SKIP_WORDS):
        return None
    # 「買付」「解約」の判定は語の出現順ではなく、売り語を先に見る
    # （"投信金額解約" のように売買語が語尾に付く形式に対応）
    if any(w in t for w in _SELL_WORDS):
        return "sell"
    if any(w in t for w in _BUY_WORDS):
        return "buy"
    return None


# 列の役割ごとの手がかり。証券会社によって呼び方が違うため候補を広めに持つ。
# 前にあるものほど優先（"約定日" と "受渡日" が両方あれば約定日を使う）。
COLUMN_HINTS = {
    "date":  ("約定日", "取引日", "売買日", "年月日", "日付", "受渡日"),
    "name":  ("ファンド名", "銘柄名", "商品名", "ファンド", "銘柄", "商品"),
    "side":  ("取引区分", "売買区分", "取引", "売買", "区分"),
    "units": ("約定数量", "数量", "口数", "株数"),
    "price": ("約定単価", "基準価額", "単価", "約定価格", "価格"),
    "fee":   ("手数料", "委託手数料", "経費", "諸費用", "諸経費"),
    "acct":  ("預り", "口座", "課税区分"),
    "div":   ("分配金",),
}
# 見出し行を探すときの手がかり（この語を多く含む行を見出しとみなす）
_HEADER_MARKERS = ("約定日", "取引日", "日付", "銘柄", "ファンド", "商品",
                   "数量", "口数", "株数", "単価", "基準価額", "取引", "売買")


def _detect_header(rows):
    """見出しらしい行を探して (行番号, 列名リスト) を返す。
    証券会社によっては前置き（照会条件など）が数行入るため、
    手がかり語を最も多く含む行を見出しとみなす。

    手がかり語が少ない（列名が英語など見慣れない）場合も、データ行が続いていれば
    最初の列らしい行を見出しとして返す。列の対応づけは画面で選んでもらえるため、
    ここで弾かずに取り込めるようにする。"""
    best, best_score = -1, 0
    first = -1                                 # 列数のある最初の行（手がかりが無いとき用）
    for i, r in enumerate(rows[:40]):          # 前置きは長くても数十行
        cells = [str(c or "").strip() for c in r]
        if len(cells) < 4 or not any(cells):
            continue
        if first < 0:
            first = i
        score = sum(1 for k in _HEADER_MARKERS if k in "".join(cells))
        if score > best_score:
            best, best_score = i, score
    if best_score >= 3:
        return best, [str(c or "").strip() for c in rows[best]]
    # 手がかり語では決められない → データ行が1行以上続くならそこを見出しとみなす
    if first >= 0 and any(len(r) >= 4 and any(str(c or "").strip() for c in r)
                          for r in rows[first + 1:]):
        return first, [str(c or "").strip() for c in rows[first]]
    return -1, []


def _col(header, keywords):
    """列名に keywords のいずれかを含む列の位置を返す（無ければ -1）。
    keywords は優先順で、先に挙げたものを優先して探す。"""
    for k in keywords:
        for i, h in enumerate(header):
            if k in h:
                return i
    return -1


def auto_columns(header):
    """見出しから、役割ごとの列位置を推定する。"""
    return {role: _col(header, hints) for role, hints in COLUMN_HINTS.items()}


# 取り込みに最低限必要な列
REQUIRED = ("date", "name", "side", "units", "price")
# 役割名の表示（画面で列を選んでもらうときのラベル）
ROLE_LABELS = {"date": "約定日", "name": "銘柄・ファンド名", "side": "取引（売買）",
               "units": "数量（口数・株数）", "price": "単価（基準価額・株価）",
               "fee": "手数料", "acct": "口座（特定/NISA）", "div": "分配金コース"}


def header_signature(header) -> str:
    """見出し行から、CSVの形式を表す文字列を作る。
    同じ証券会社・同じ種類のCSVなら同じ値になるので、一度指定した列の対応づけを
    次回以降も使い回すための鍵として使う。"""
    return "|".join(str(h or "").strip() for h in (header or []))


def _guess_broker(header, text):
    """見出しと本文から証券会社を推定する（表示用。取り込み処理は列名で判断する）。
    社名などの強い手がかりがあるときだけ名乗り、曖昧なら空にする
    （列構成が似ている他社のCSVを誤って別の会社と表示しないため）。"""
    j = "".join(header) + text[:600]
    if "eスマート" in j or "カブコム" in j or "三菱ＵＦＪ" in j or "三菱UFJ" in j:
        return "三菱UFJ eスマート証券"
    if "楽天" in j:
        return "楽天証券"
    if "約定履歴照会" in j or "ＳＢＩ" in j or "SBI" in j:
        return "SBI証券"
    return ""


def parse(raw: bytes, mapping: dict | None = None) -> dict:
    """CSVを解析して売買の一覧を返す。

    mapping で列位置（{"date":0,"name":2,...}）を明示できる。省略時は見出しから
    自動判定し、必要な列が見つからなければ needs_mapping=True と見出し一覧を返して
    画面で選んでもらう（証券会社ごとの列名の違いに、決め打ちせず対応するため）。
    """
    text = decode(raw)
    rows = list(csv.reader(io.StringIO(text)))
    if not rows:
        return {"ok": False, "error": "CSVが空です。"}

    hi, header = _detect_header(rows)
    if hi < 0:
        return {"ok": False, "error": "取引履歴の見出し行が見つかりませんでした。"
                                      "証券会社の「取引履歴」「約定履歴」のCSVか確認してください。"}
    broker = _guess_broker(header, text)

    cols = dict(auto_columns(header))
    if mapping:
        for k, v in mapping.items():
            if k in COLUMN_HINTS:
                cols[k] = int(v) if v not in (None, "", -1) else -1
    missing = [k for k in REQUIRED if cols.get(k, -1) < 0]
    if missing:
        # 自動で決められなかった → 画面で列を選んでもらう
        return {
            "ok": True, "needs_mapping": True, "broker": broker,
            "header": header, "columns": cols,
            "missing": [{"role": k, "label": ROLE_LABELS[k]} for k in missing],
            "roles": [{"role": k, "label": ROLE_LABELS[k], "required": k in REQUIRED}
                      for k in COLUMN_HINTS],
            "samples": [[str(c or "") for c in r] for r in rows[hi + 1:hi + 4]],
        }

    i_date, i_name = cols["date"], cols["name"]
    i_side, i_units, i_price = cols["side"], cols["units"], cols["price"]
    i_fee, i_acct, i_div = cols.get("fee", -1), cols.get("acct", -1), cols.get("div", -1)

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
        # 任意の列は、無い場合も行が短い場合も安全に取り出す
        def cell(i):
            return str(r[i] or "").strip() if 0 <= i < len(r) else ""
        acct, div = cell(i_acct), cell(i_div)
        out.append({
            "date": date, "name": name, "side": side,
            "units": units, "price": price,
            "fee": _to_num(cell(i_fee)),
            # 預り区分（NISA/特定）と分配金コース。取り込み時の参考として持っておく
            "account_type": "nisa" if "NISA" in acct.upper() else ("taxable" if acct else ""),
            "dividend_mode": ("receive" if "受取" in div else
                              "reinvest" if "再投資" in div else ""),
        })
    # 1件も取り込めなかったときは、何が理由で除外されたかを分かるようにする
    # （列の指定を間違えている／取引欄の書き方が想定外、などに気づけるように）
    reasons = []
    if not out and skipped:
        seen = []
        for s in skipped:
            r = s.get("reason") or ""
            if r and r not in seen:
                seen.append(r)
        reasons = seen[:8]
    return {"ok": True, "broker": broker, "rows": out, "skipped": skipped,
            "header": header, "columns": cols, "reasons": reasons}


# 部分一致で同一商品とみなすのに必要な最低文字数。これより短い名前（口座の
# ニックネーム "NASDAQ100" など）で部分一致させると、別の商品に誤って
# 結び付いてしまうため、正式名称どうしの照合に限定する。
_MIN_PARTIAL_LEN = 12


def _lookup(key, table, pick):
    """正規化名 key に対応する候補を table（{正規化名: [項目]}）から1件選ぶ。
    完全一致 → 正式名称どうしの部分一致 の順。絞り込めなければ None。"""
    hs = table.get(key)
    if hs:
        cands = pick(hs)
        return cands[0] if len(cands) == 1 else None
    partial = [h for k, items in table.items()
               if len(k) >= _MIN_PARTIAL_LEN and len(key) >= _MIN_PARTIAL_LEN
               and (k in key or key in k) for h in items]
    cands = pick(partial)
    return cands[0] if len(cands) == 1 else None


def suggest_catalog(rows, catalog, watched_ids=()):
    """CSVの商品名に対して、まだ保有していない登録商品（カタログ）を提案する。
    保有に無い商品をその場で一覧へ追加して取り込めるようにするために使う。

    自動で選ぶのは完全一致・正式名称どうしの部分一致だけにする。名前が似ている
    別商品（例「Tracers NASDAQ100ゴールドプラス」と「Tracers S&P500ゴールドプラス」）を
    取り違えると誤ったデータが入るため、あいまいな一致では選ばない。
    代わりに order で「選びやすい順（似ている順）」を返し、画面の候補の並びに使う。

    戻り値: {正規化名: {"catalog_id": id or None, "order": [id, ...]}}
    """
    import difflib
    items = [c for c in catalog if c.get("name") and c.get("id") not in watched_ids]
    table = {}
    for c in items:
        table.setdefault(normalize_name(c["name"]), []).append(c)
    norm = {c["id"]: normalize_name(c["name"]) for c in items}

    out = {}
    for key in {normalize_name(r["name"]) for r in rows}:
        hit = _lookup(key, table, lambda hs: hs)
        ranked = sorted(items, reverse=True,
                        key=lambda c: difflib.SequenceMatcher(None, key, norm[c["id"]]).ratio())
        out[key] = {"catalog_id": hit["id"] if hit else None,
                    "order": [c["id"] for c in ranked[:8]]}
    return out


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
