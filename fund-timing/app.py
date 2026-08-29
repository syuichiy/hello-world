"""投資信託 売り時・買い時サイン アプリ（ローカルWebアプリ）。

- 複数の投資信託を一覧で並べて売買判断（ウォッチリスト比較）
- 名前で投信を検索（内部DBのカタログをLIKE検索）
- 投信一覧・ウォッチリスト・価格キャッシュを内部DB(SQLite: funds.db)に格納

起動:
    python3 app.py            # ブラウザで http://127.0.0.1:5000 を開く（自動）
    python3 app.py --demo     # ネット接続なしでUIを試す（ダミーデータ）
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import math
import os
import re
import socket
import threading
import time
import webbrowser
from urllib.parse import urlparse, parse_qs

from flask import Flask, jsonify, render_template, request, Response

import fund_data
import signals as signal_mod
import db
import seed_funds
import broker_import

app = Flask(__name__)
# 静的ファイル(app.js/style.css)を毎回検証させ、更新後に古いJS/CSSが使われないようにする
app.config["SEND_FILE_MAX_AGE_DEFAULT"] = 0


@app.after_request
def _no_store_static(resp):
    """アプリ更新時にブラウザが古い app.js / style.css を使い続けないようにする。"""
    if request.path.startswith("/static/") or request.path == "/":
        resp.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
        resp.headers["Pragma"] = "no-cache"
        resp.headers["Expires"] = "0"
    return resp


DEMO_MODE = False


@app.errorhandler(Exception)
def _handle_error(e):
    """APIは必ずJSONでエラーを返す（HTMLエラーページでフロントが壊れるのを防ぐ）。"""
    import traceback
    traceback.print_exc()
    if request.path.startswith("/api/"):
        return jsonify({"ok": False,
                        "error": f"サーバー内部エラー: {type(e).__name__}: {e}"}), 500
    raise e


# ------------------------------------------------------------------ 入力解析
ISIN_RE = re.compile(r"\b([A-Z]{2}[A-Z0-9]{9}\d)\b")
ASSOC_RE = re.compile(r"associFundCd=([A-Za-z0-9]+)")


def parse_identifier(text: str):
    """ユーザー入力から (isin, assoc_code) を取り出す。
    受け付ける形式:
      - toushin-libのURL（isinCd/associFundCd を含む）
      - みんかぶ/Yahoo!ファイナンス/日経のURL（協会コードを含む）
      - 楽天証券などのURL（ISINを含む）
      - "JP90C000H1T1,0331418A" / "JP90C000H1T1 0331418A"
    """
    text = (text or "").strip()
    if not text:
        return None, None

    isin = None
    assoc = None

    if "toushin-lib" in text or "isinCd=" in text or "associFundCd=" in text:
        try:
            q = parse_qs(urlparse(text).query)
            if "isinCd" in q:
                isin = q["isinCd"][0].strip().upper()
            if "associFundCd" in q:
                assoc = q["associFundCd"][0].strip()
        except Exception:
            pass

    # 各種金融サイトのURLからコードを抽出（貼り付けでの登録を楽にする）
    if isin is None:
        m = re.search(r"[?&]ID=([A-Za-z]{2}[A-Za-z0-9]{9}\d)", text)  # 楽天証券
        if m:
            isin = m.group(1).upper()
    if assoc is None:
        for pat in (r"itf\.minkabu\.jp/fund/([0-9A-Za-z]{8})",        # みんかぶ
                    r"finance\.yahoo\.co\.jp/quote/([0-9A-Za-z]{8})",  # Yahoo
                    r"[?&]fcode=([0-9A-Za-z]{8})",                     # 日経
                    r"KEY1=([0-9A-Za-z]{8})"):                         # 野村/三菱UFJ 等
            m = re.search(pat, text)
            if m:
                assoc = m.group(1)
                break

    if isin is None or assoc is None:
        parts = re.split(r"[,\s]+", text)
        for p in parts:
            p = p.strip()
            if isin is None and re.fullmatch(r"[A-Za-z]{2}[A-Za-z0-9]{9}\d", p):
                isin = p.upper()
            elif assoc is None and re.fullmatch(r"[A-Za-z0-9]{6,12}", p) and p.upper() != isin:
                assoc = p

    if isin is None:
        m = ISIN_RE.search(text.upper())
        if m:
            isin = m.group(1)
    if assoc is None:
        m = ASSOC_RE.search(text)
        if m:
            assoc = m.group(1)

    return isin, assoc


# ------------------------------------------------------------------ データ取得（キャッシュ利用）
# 取得失敗の再試行を一定時間抑制する（データ源の回数制限・連続アクセスの保護）
_FAIL_TTL_SEC = 600
_fail_cache: dict = {}

# キャッシュが「前営業日にも届いていない」＝明らかに古いときは、12時間待たずに取り直す。
# ただし祝日などで実際に新しいデータが無いこともあるため、再確認は1時間に1回までにする。
_STALE_RECHECK_SEC = 3600
_stale_recheck: dict = {}


def _prev_business_day(today=None):
    """前営業日（土日を除く）を返す。祝日は判定しない（そのぶんは再確認の間隔で吸収する）。"""
    d = (today or dt.date.today()) - dt.timedelta(days=1)
    while d.weekday() >= 5:          # 5=土, 6=日
        d -= dt.timedelta(days=1)
    return d


# 東証の立会時間。2024年11月から大引けが15:00→15:30に延長された。
# 終値が確定してデータ提供側に反映されるまでの余裕を見て、15:45を「取引終了後」とする。
_MARKET_OPEN = dt.time(9, 0)
_MARKET_CLOSE = dt.time(15, 30)
_MARKET_SETTLED = dt.time(15, 45)


def _fresh_target(kind: str = "fund"):
    """「ここまで揃っていれば新しい」とみなす日付。

    株は当日の終値が大引け（15:30）以降に出るため、取引終了後は当日を目標にする。
    投信の基準価額は当日中には公表されない（海外資産を含むものは翌営業日）ので、
    こちらは常に前営業日を目標にする。
    """
    now = dt.datetime.now()
    if kind == "stock" and now.weekday() < 5 and now.time() >= _MARKET_SETTLED:
        return now.date()
    return _prev_business_day()


# 株は場中（9:00〜15:30）に値が動くので、取引時間内はキャッシュを短くする。
# 投信の基準価額は1日1回なので12時間のままでよい。
_STOCK_TTL_OPEN_MIN = 15
# 取得に失敗したときに「最後に取れた値」で表示を続ける許容期間
_STALE_FALLBACK_HOURS = 24 * 14


def _cache_ttl_hours(kind: str = "fund") -> float:
    """キャッシュを何時間有効とみなすか。株の場中だけ短くする。"""
    if kind != "stock":
        return db.CACHE_TTL_HOURS
    now = dt.datetime.now()
    if now.weekday() < 5 and _MARKET_OPEN <= now.time() <= _MARKET_SETTLED:
        return _STOCK_TTL_OPEN_MIN / 60
    return db.CACHE_TTL_HOURS


def _is_stale(cached, kind: str = "fund") -> bool:
    """キャッシュの最終日が目標の日付より前なら、古いとみなす。"""
    dates = (cached or {}).get("dates") or []
    if not dates:
        return True
    try:
        return dt.date.fromisoformat(dates[-1]) < _fresh_target(kind)
    except (ValueError, TypeError):
        return False


def load_series(isin: str, assoc: str, name: str = "", force: bool = False,
                kind: str = "fund") -> dict:
    """価格シリーズをdictで返す。内部DBのキャッシュを使い、無ければ取得して保存。

    kind="fund" は投信協会CSV（基準価額）、kind="stock" は株価（Stooq→Yahoo）。
    取得失敗は10分間キャッシュし、画面更新のたびに再アクセスして
    データ源の回数制限を消費しないようにする（「最新に更新」なら再試行）。

    キャッシュは約12時間で切れる。以前は価格推移の表示中にセッション内で固定していたが、
    アプリを起動したままだと翌日公開された基準価額（＝昨日分）がいつまでも反映されない
    不具合があったため固定をやめた。「↻最新に更新」・アプリ再起動・12時間経過のいずれかで
    キャッシュが更新され、表やグラフにも反映される。
    """
    isin = (isin or "").strip().upper()
    assoc = (assoc or "").strip()
    key = (isin, assoc)
    if not force:
        cached = db.get_cached_series(isin, assoc, max_age_hours=_cache_ttl_hours(kind))
        if cached:
            if name and not cached.get("name"):
                cached["name"] = name
            # 前営業日にも届いていないキャッシュは、有効期限を待たずに取り直す
            # （新しい基準価額が公表されているのに反映されない、を防ぐ）。
            if not (_is_stale(cached, kind)
                    and (time.time() - _stale_recheck.get(key, 0)) > _STALE_RECHECK_SEC):
                return cached
            _stale_recheck[key] = time.time()
            try:
                fresh = (fund_data.get_stock_series(isin, name) if kind == "stock"
                         else fund_data.get_fund_series(isin, assoc, name)).to_dict()
            except Exception:
                return cached          # 取り直せなければ手持ちのキャッシュで表示を続ける
            db.set_cached_series(isin, assoc, fresh["name"], fresh)
            return fresh
        failed = _fail_cache.get(key)
        if failed and (time.time() - failed[0]) < _FAIL_TTL_SEC:
            stale = db.get_cached_series(isin, assoc, max_age_hours=_STALE_FALLBACK_HOURS)
            if stale:
                if name and not stale.get("name"):
                    stale["name"] = name
                return stale
            raise fund_data.FundDataError(failed[1])
    try:
        if kind == "stock":
            series = fund_data.get_stock_series(isin, name)
        else:
            series = fund_data.get_fund_series(isin, assoc, name)
    except fund_data.FundDataError as e:
        _fail_cache[key] = (time.time(), str(e))
        # 期限切れでも手元にデータがあれば、それで表示を続ける。
        # 株は有効期限を15分に縮めたので、一時的な取得失敗で値が消えないようにする。
        if not force:
            stale = db.get_cached_series(isin, assoc, max_age_hours=_STALE_FALLBACK_HOURS)
            if stale:
                if name and not stale.get("name"):
                    stale["name"] = name
                return stale
        raise
    _fail_cache.pop(key, None)
    d = series.to_dict()
    db.set_cached_series(isin, assoc, d["name"], d)
    return d


def _apply_range(series: dict, range_key: str):
    dates, nav, assets = series["dates"], series["nav"], series["net_assets"]
    n = len(dates)
    if range_key == "all" or n == 0:
        return dates, nav, assets
    days = {"3m": 91, "6m": 182, "1y": 365, "3y": 365 * 3, "5y": 365 * 5}.get(range_key, 365 * 3)
    last = dt.date.fromisoformat(dates[-1])
    cutoff = last - dt.timedelta(days=days)
    start = 0
    for i, d in enumerate(dates):
        if dt.date.fromisoformat(d) >= cutoff:
            start = i
            break
    return dates[start:], nav[start:], assets[start:]


def _nan_clean(seq):
    return [None if (v is None or (isinstance(v, float) and math.isnan(v))) else v for v in seq]


def _safe_num(v, default=0.0):
    """NaN/infを除いた数値を返す。NaNはJSONに出力できず、API応答全体が壊れて
    画面が「応答を返せませんでした」になるため、返す直前に必ず通す。"""
    try:
        f = float(v)
    except (TypeError, ValueError):
        return default
    return default if (math.isnan(f) or math.isinf(f)) else f


def _downsample(seq, target=60):
    n = len(seq)
    if n <= target:
        return list(seq)
    step = n / target
    return [seq[min(int(i * step), n - 1)] for i in range(target)]


# ------------------------------------------------------------------ 画面
@app.route("/")
def index():
    return render_template("index.html", demo=DEMO_MODE)


@app.route("/vendor/plotly.min.js")
def plotly_js():
    from plotly.offline import get_plotlyjs
    return Response(get_plotlyjs(), mimetype="application/javascript")


# ------------------------------------------------------------------ 検索・カタログ
@app.route("/api/search")
def api_search():
    q = request.args.get("q", "")
    results = db.search_catalog(q, limit=30)
    # 売却済みの保有しか無い商品は「保有中」にしない（買い直しのときに紛らわしいため）
    active, sold_only = _watched_catalog_ids()
    for r in results:
        r["watched"] = r["id"] in active
        r["sold_out"] = r["id"] in sold_only
    return jsonify({"ok": True, "results": results})


@app.route("/api/catalog", methods=["POST"])
def api_catalog_add():
    data = request.get_json(silent=True) or {}
    name = (data.get("name") or "").strip()
    query = (data.get("query") or "").strip()
    isin, assoc = parse_identifier(query)
    if not isin and not assoc:
        return jsonify({"ok": False, "error":
                        "協会コード（8桁）またはISIN（JP90…）を読み取れませんでした。"
                        "「協会コード」「ISIN」「ISIN,協会コード」のいずれかで入力してください。"}), 400
    try:
        row = db.add_catalog(name, isin or "", assoc or "", data.get("category", ""))
    except ValueError as e:
        return jsonify({"ok": False, "error": str(e)}), 400
    # 追加と同時にウォッチリストへ入れる
    if data.get("watch", True):
        db.add_watch(row["id"], broker=(data.get("broker") or ""))
    return jsonify({"ok": True, "fund": row})


# ------------------------------------------------------------------ ウォッチリスト
@app.route("/api/watchlist", methods=["GET"])
def api_watchlist():
    return jsonify({"ok": True, "items": db.list_watchlist()})


@app.route("/api/watchlist", methods=["POST"])
def api_watchlist_add():
    data = request.get_json(silent=True) or {}
    catalog_id = data.get("catalog_id")
    if catalog_id is None:
        return jsonify({"ok": False, "error": "catalog_id が必要です。"}), 400
    if not db.get_catalog(int(catalog_id)):
        return jsonify({"ok": False, "error": "指定の投信が見つかりません。"}), 404
    # force=true は「すでに同じ商品を同じ証券会社で持っているが、
    # NISAと特定など別口座として分けて登録したい」場合に使う
    force = bool(data.get("force"))
    added = db.add_watch(int(catalog_id), broker=(data.get("broker") or ""), force=force)
    return jsonify({"ok": True, "added": added})


@app.route("/api/watchlist", methods=["DELETE"])
def api_watchlist_remove():
    data = request.get_json(silent=True) or {}
    watch_id = data.get("watch_id")
    if watch_id is None:
        return jsonify({"ok": False, "error": "watch_id が必要です。"}), 400
    db.remove_watch(int(watch_id))
    return jsonify({"ok": True})


def _holding_timeline(trades, current_units, current_invested=0.0, kind="fund"):
    """「その日の時点の口数と取得原価」を、いまの値から売買をさかのぼって作る。

    積立のように後から買い増した場合、いまの口数で過去を計算すると
    過去の評価額まで増えてしまう（3万円の積立が、買い増した翌日から
    過去に遡って6万円になる）。日付ごとの口数を使ってそれを防ぐ。

    取得原価も一緒に戻すのは、比率（評価額 ÷ 投資金額）を過去の日付で出すため。
    いまの投資金額で過去の評価額を割ると、売る前の口数が多かった期間の比率が
    跳ね上がってしまう（数百%の山になる）。

    さかのぼる向きで作るのは、売買の記録が一部しか無くても使えるようにするため。
    記録のある増減だけを反映し、最初の記録より前は「その時点のまま」とみなす
    （記録が1件も無ければ全期間いまの口数・投資金額＝従来どおり）。
    戻り値は ((最初の記録より前の口数, 原価), [(日付, 口数, 原価), ...])。
    """
    div = 1.0 if kind == "stock" else 10000.0
    u = float(current_units or 0)
    c = float(current_invested or 0)
    items = []
    for t in sorted(trades or [], key=lambda x: ((x.get("date") or ""), x.get("id") or 0),
                    reverse=True):
        d = t.get("date") or ""
        n = float(t.get("units") or 0)
        p = float(t.get("price") or 0)
        fee = float(t.get("fee") or 0)
        if not d or n <= 0:
            continue
        items.append((d, max(0.0, u), max(0.0, c)))     # その売買の直後（＝その日）の状態
        if t.get("side") == "buy":
            u -= n
            c -= n * p / div + fee
        else:
            before = u + n
            # 売却は移動平均法で原価を按分するので、さかのぼるときは口数に比例して戻す。
            # 売り切っていて按分できないときは、その売買の単価で買っていたとみなす。
            c = c * (before / u) if u > 0 else c + n * p / div
            u = before
        u, c = max(0.0, u), max(0.0, c)
    items.reverse()
    return (max(0.0, u), max(0.0, c)), items


def _units_at(timeline, date):
    """その日付の時点で持っていた口数。"""
    (base_u, _), items = timeline
    u = base_u
    for d, uu, _cc in items:
        if d <= date:
            u = uu
        else:
            break
    return u


def _basis_at(timeline, date):
    """その日付の時点の取得原価（投資金額）。売買の記録が無ければ、いまの投資金額のまま。"""
    (_, base_c), items = timeline
    c = base_c
    for d, _uu, cc in items:
        if d <= date:
            c = cc
        else:
            break
    return c


def _is_sold_out(pos, units):
    """全額売却済みか。買った記録があり、売り切って口数が残っていない状態を指す。

    口数が0でも「まだ入力していない」だけのことがあるため、取引履歴を根拠にする。
    （口数だけで判断すると、入力前の商品まで画面から消えてしまう）
    """
    return bool(pos and (pos.get("buy_amount") or 0) > 0
                and (pos.get("units") or 0) <= 0 and float(units or 0) <= 0)


def _watched_catalog_ids():
    """(いま持っている商品のカタログid, 売り切っただけの商品のカタログid) を返す。

    検索・ランキングの「追加済み」判定に使う。全額売却済みの保有しか無い商品は
    もう持っていないので「追加済み」にせず、買い直したときに再び追加できるようにする。
    """
    sold = _sold_out_ids()
    active, sold_only = set(), set()
    for w in db.list_watchlist():
        (sold_only if w["watch_id"] in sold else active).add(w["id"])
    return active, (sold_only - active)


def _sold_out_ids():
    """全額売却済みの保有IDの集合。銘柄一覧・価格推移から外すのに使う。"""
    by_watch = {}
    for t in db.list_trades():
        by_watch.setdefault(t["watch_id"], []).append(t)
    out = set()
    for it in db.list_watchlist():
        tr = by_watch.get(it["watch_id"])
        if not tr:
            continue
        pos = db.trade_position(tr, it.get("kind", "fund") or "fund")
        if _is_sold_out(pos, it.get("units")):
            out.add(it["watch_id"])
    return out


def _summarize_fund(row, range_key, force=False):
    """カタログ1件の現在の判定サマリを返す（一覧・ランキング共通）。"""
    summary = {
        "catalog_id": row["id"],
        "name": row["name"],
        "isin": row["isin"],
        "category": row.get("category", ""),
        "asset_class": row.get("asset_class", "") or "",
        "kind": row.get("kind", "fund") or "fund",
    }
    try:
        series = load_series(row["isin"], row["assoc_code"], row["name"], force=force,
                             kind=row.get("kind", "fund") or "fund")
        dates, prices, _ = _apply_range(series, range_key)
        if len(prices) < 5:
            raise fund_data.FundDataError("データが不足しています")
        a = signal_mod.analyze(dates, prices)
        change = None
        if prices[0]:
            change = round((prices[-1] - prices[0]) / prices[0] * 100, 2)
        # 前日比（直近2営業日の変化率）。期間の騰落率とは別物なので分けて持つ。
        prev_change = None
        _valid = [p for p in prices if p]
        if len(_valid) >= 2 and _valid[-2]:
            prev_change = round((_valid[-1] - _valid[-2]) / _valid[-2] * 100, 2)
        # 時間軸別スコア（ポートフォリオ全体判定用・全履歴で計算）
        hz_full = signal_mod.analyze_horizons(series["dates"], series["nav"])
        hz = [{"key": h["key"], "ok": h["ok"], "score": h.get("score")} for h in hz_full]
        # 分配金/配当：協会CSVの分配金列（株はYahoo等の配当実績）から直近1年の実績を集計。
        # 利回り = 直近1年の分配金(1万口/1株あたり) ÷ 現在の基準価額/株価。
        latest = a.stats.get("latest_price")
        # 既存キャッシュにNaNが残っている場合もあるため _safe_num で必ず正規化する
        div_ttm = _safe_num(fund_data.ttm_dividend(series.get("dates"), series.get("dists")))
        _latest = _safe_num(latest)
        div_yield = _safe_num(div_ttm / _latest) if (_latest and div_ttm) else 0.0
        summary.update({
            "ok": True,
            "verdict": a.verdict,
            "verdict_label": a.verdict_label,
            "score": a.score,
            "latest_price": latest,
            "latest_date": dates[-1],
            "div_ttm": round(div_ttm, 2),      # 直近1年の分配金（1万口/1株あたり・円）
            "div_yield": round(div_yield, 5),  # 分配金利回り（実績・小数）
            "rsi": a.stats.get("rsi"),
            "deviation_pct": a.stats.get("deviation_pct"),
            "uptrend": (a.stats.get("sma_short") or 0) >= (a.stats.get("sma_long") or 0),
            "change_pct": change,          # 表示期間の騰落率（前日比ではない）
            "prev_change_pct": prev_change,  # 前日比
            "spark": _downsample([p for p in prices if p is not None], 60),
            "hz": hz,
        })
    except fund_data.FundDataError as e:
        summary.update({"ok": False, "error": str(e)})
    except Exception as e:  # 想定外エラーでも一覧全体を壊さず行単位で表示する
        summary.update({"ok": False, "error": f"{type(e).__name__}: {e}"})
    return summary


def _build_summaries(range_key, force=False):
    """ウォッチリスト各投信の判定サマリ一覧を作る（評価額・損益つき）。"""
    histories = db.get_all_amount_histories()
    trades_by_watch = {}
    for t in db.list_trades():
        trades_by_watch.setdefault(t["watch_id"], []).append(t)
    summaries = []
    for it in db.list_watchlist():
        s = _summarize_fund(it, range_key, force)
        s["watch_id"] = it["watch_id"]
        wid = it["watch_id"]
        # 正式なファンド名（catalog名）を表示。口座ニックネームは account に添える
        s["account"] = it.get("label") or ""
        units = float(it.get("units") or 0)
        s["invested"] = float(it.get("invested") or 0)
        s["sell_policy"] = it.get("sell_policy") or "full"
        s["broker"] = it.get("broker") or ""
        s["account_type"] = it.get("account_type") or "taxable"   # nisa=非課税 / taxable=特定
        s["dividend_mode"] = it.get("dividend_mode") or ""         # ''=自動 / receive / reinvest
        # 売買の記録があれば、平均取得単価と実現損益を添える（無ければ手入力のまま）
        _tr = trades_by_watch.get(wid)
        if _tr:
            _pos = db.trade_position(_tr, it.get("kind", "fund") or "fund")
            s["avg_price"] = _pos["avg_price"]
            s["realized"] = _pos["realized"]
            s["trade_count"] = _pos["count"]
            s["sold_out"] = _is_sold_out(_pos, it.get("units"))
        else:
            s["avg_price"] = None
            s["realized"] = 0
            s["trade_count"] = 0
            s["sold_out"] = False
        hist = histories.get(wid, {})

        stock = s.get("kind") == "stock"
        divisor = 1.0 if stock else 10000.0
        # 口数は画面で入力された値をそのまま使う（自動推定はしない）
        s["units"] = units

        # 評価額 = 現在価格 × 画面入力の口数（＝現在の評価額）。
        last_hist_date = max(hist.keys()) if hist else None
        if s.get("ok") and units > 0 and s.get("latest_price"):
            s["value"] = round(s["latest_price"] * units / divisor)
            # 当日の評価額をDBへ反映（記録期間より後の日付だけ追記＝過去の実額は壊さない）
            _persist_today_value(wid, s.get("latest_date"), s["value"])
        elif s.get("sold_out"):
            # 全額売却済み。口数0で履歴の最新額を出すと、売ったのに評価額が残り、
            # 総資産・資産配分・リバランスの売却候補にまで混ざってしまう。
            s["value"] = 0
        elif hist:
            s["value"] = round(hist[last_hist_date])     # 口数未入力/価格未取得なら履歴の最新で表示
        else:
            s["value"] = None

        inv = s["invested"]
        if s.get("value") is not None and inv > 0:
            s["pl"] = round(s["value"] - inv)
            s["pl_pct"] = round((s["value"] - inv) / inv * 100, 1)
        else:
            s["pl"] = None
            s["pl_pct"] = None
        summaries.append(s)
    return summaries


@app.route("/api/watchlist/analyze")
def api_watchlist_analyze():
    """ウォッチリスト各投信の判定サマリ＋保有全体（ポートフォリオ）の目安を返す。"""
    range_key = request.args.get("range", "1y")
    force = request.args.get("force") in ("1", "true", "yes")
    summaries = _build_summaries(range_key, force)
    portfolio = signal_mod.portfolio_advice(summaries)
    for s in summaries:
        s.pop("_w", None)  # portfolio_adviceが付ける内部ウェイトは返さない
    allocation = _build_allocation(summaries)
    return jsonify({"ok": True, "range": range_key, "items": summaries,
                    "portfolio": portfolio, "allocation": allocation,
                    "brokers": seed_funds.BROKERS})


def _build_allocation(summaries):
    """資産クラスごとの配分と、理想ポートフォリオとのリバランス指標を返す。"""
    ok_items = [s for s in summaries if s.get("ok")]
    if not ok_items:
        return None
    any_units = any((s.get("value") or 0) > 0 for s in ok_items)
    total = sum(s.get("value") or 0 for s in ok_items) if any_units else len(ok_items)

    by_class = {}
    for s in ok_items:
        cls = s.get("asset_class") or seed_funds.classify(s["name"], s.get("category", ""))
        w = (s.get("value") or 0) if any_units else 1
        by_class[cls] = by_class.get(cls, 0) + w

    targets = db.get_setting("targets", None) or dict(seed_funds.DEFAULT_TARGETS)
    classes = []
    for name, icon, color in seed_funds.ASSET_CLASSES:
        val = by_class.get(name, 0)
        share = (val / total * 100) if total else 0.0
        tgt = float(targets.get(name, 0))
        diff = share - tgt
        if abs(diff) <= 5:
            action, action_label = "ok", "✅ 適正"
        elif diff < 0:
            action, action_label = "buy", "⬆️ 買い足し"
        else:
            action, action_label = "reduce", "⬇️ 減らす"
        amount = round(abs(diff) / 100 * total) if (any_units and abs(diff) > 5) else None
        classes.append({
            "name": name, "icon": icon, "color": color,
            "value": round(val) if any_units else None,
            "share": round(share, 1), "target": tgt,
            "diff": round(diff, 1), "action": action,
            "action_label": action_label, "amount": amount,
        })
    # 分類がASSET_CLASSES以外になることは無い想定だが、あれば末尾に追加
    known = {c["name"] for c in classes}
    for cls, val in by_class.items():
        if cls not in known:
            share = (val / total * 100) if total else 0.0
            classes.append({"name": cls, "icon": "❓", "color": "#94a3b8",
                            "value": round(val) if any_units else None,
                            "share": round(share, 1), "target": 0,
                            "diff": round(share, 1), "action": "reduce",
                            "action_label": "⬇️ 減らす", "amount": None})
    plan = _build_rebalance_plan(summaries, classes, total, any_units)
    return {"ok": True, "weights_mode": "value" if any_units else "equal",
            "total_value": round(total) if any_units else None,
            "classes": classes, "targets": targets, "plan": plan,
            "presets": seed_funds.TARGET_PRESETS}


def _timing_score(s):
    """銘柄の現在のタイミングスコア（+=押し目/買い時, −=過熱/売り時）。"""
    scores = [h["score"] for h in (s.get("hz") or [])
              if h.get("ok") and h.get("key") in ("short", "mid") and h.get("score") is not None]
    if scores:
        return sum(scores) / len(scores)
    return s.get("score") or 0


def _long_score(s):
    """長期（1年〜）ホライズンのスコア。＋なら長期上昇トレンド＝値上がり予測。"""
    for h in (s.get("hz") or []):
        if h.get("key") == "long" and h.get("ok") and h.get("score") is not None:
            return h["score"]
    return None


PARTIAL_SELL_RATIO = 0.5  # 「一部売却可能」の売却上限（保有評価額に対する割合）


def _sell_eligibility(s):
    """売却可否の判定。(eligible, cap_ratio, exclude_reason) を返す。

    除外ルール（優先順）:
      1. 売却不可設定
      2. 長期上昇トレンド（値上がり予測）→ 無理に売らない
      3. 短中期が安値圏 → 今売ると損になりやすい
    """
    policy = s.get("sell_policy") or "full"
    if policy == "locked":
        return False, 0.0, "🔒 売却不可に設定されています"
    ls = _long_score(s)
    if ls is not None and ls >= 25:
        return False, 0.0, ("📈 長期上昇トレンド（値上がりが見込まれる形）のため、"
                            "無理に売却せず保有継続を推奨")
    if _timing_score(s) >= 20:
        return False, 0.0, "🔻 短中期が安値圏のため、今売ると損になりやすく見送り"
    cap = PARTIAL_SELL_RATIO if policy == "partial" else 1.0
    return True, cap, None


def _sell_timing(ts):
    if ts <= -15:
        return "good", "🟢 売り時（過熱・高値圏）"
    if ts >= 20:
        return "bad", "🔴 安値圏（今売ると損になりやすい）"
    return "neutral", "🟡 中立（売却可）"


def _buy_timing(ts):
    if ts >= 20:
        return "good", "🟢 買い時（押し目）"
    if ts <= -15:
        return "caution", "🟠 過熱圏（積立での購入向き）"
    return "neutral", "🟡 中立"


def _build_rebalance_plan(summaries, classes, total, any_units):
    """具体的な売買アドバイス：どれを売り、その資金でどれを買うか。

    売りはテクニカルで高値圏の銘柄を優先し、安値圏の銘柄は損失回避のため除外。
    売却候補が全て安値圏のクラスは「見送り」にする（無理にリバランスしない）。
    """
    if not any_units:
        return {"status": "no_units",
                "summary": "保有口数を入力すると、具体的な売買アドバイスを表示します。"}

    icon_of = {name: icon for name, icon, _ in seed_funds.ASSET_CLASSES}
    over = [c for c in classes if c["diff"] > 5]
    under = [c for c in classes if c["diff"] < -5]
    if not over and not under:
        return {"status": "none",
                "summary": "✅ リバランスの必要はありません。全クラスが目標との乖離±5pt以内です。"}

    ok_items = [s for s in summaries if s.get("ok") and (s.get("value") or 0) > 0]

    sells, deferred, excluded = [], [], []
    proceeds = 0.0
    policy_label = {"full": "○売却可", "partial": "△一部売却可（最大50%）", "locked": "✕売却不可"}
    for c in over:
        excess = c["diff"] / 100.0 * total
        funds = [s for s in ok_items
                 if (s.get("asset_class") or "") == c["name"]]
        funds.sort(key=_timing_score)  # 過熱（負のスコア）が先＝売り時から
        sellable = []
        for f in funds:
            eligible, cap, reason = _sell_eligibility(f)
            if eligible:
                sellable.append((f, cap))
            else:
                excluded.append({"name": f["name"], "cls": c["name"], "icon": c["icon"],
                                 "reason": reason})
        if not sellable:
            deferred.append({
                "cls": c["name"], "icon": c["icon"],
                "reason": (f"{c['name']}は目標より{c['diff']:+.1f}pt多めですが、"
                           "売却できる銘柄がありません（売却不可設定・値上がり予測・安値圏のため）。"
                           "無理に売らず、積立の配分変更や、条件が変わってからの売却がおすすめです。"),
            })
            continue
        remaining = excess
        for f, cap in sellable:
            if remaining <= total * 0.01:
                break
            max_amt = f["value"] * cap
            amt = min(remaining, max_amt)
            if amt < total * 0.01:
                continue
            ts = _timing_score(f)
            timing, timing_label = _sell_timing(ts)
            pol = f.get("sell_policy") or "full"
            sells.append({"name": f["name"], "cls": c["name"], "icon": c["icon"],
                          "amount": round(amt), "timing": timing,
                          "timing_label": timing_label,
                          "policy": pol,
                          "policy_label": policy_label.get(pol, "")})
            proceeds += amt
            remaining -= amt
        if remaining > total * 0.05:
            # 売却上限（一部売却など）で過剰分を売り切れない場合の注記
            deferred.append({
                "cls": c["name"], "icon": c["icon"],
                "reason": (f"{c['name']}は売却制限（一部売却可・売却不可・見送り銘柄）のため、"
                           f"過剰分のうち約 {round(remaining):,} 円は今回調整しきれません。"
                           "残りは積立配分での調整がおすすめです。"),
            })

    buys = []
    if under and proceeds > 0:
        shortfall_total = sum(-c["diff"] for c in under)
        for c in under:
            budget = proceeds * (-c["diff"]) / shortfall_total if shortfall_total else 0
            if budget < total * 0.01:
                continue
            cand = _buy_candidate_for_class(summaries, c["name"])
            buys.append({"name": cand["name"], "cls": c["name"], "icon": c["icon"],
                         "amount": round(budget),
                         "timing": cand["timing"], "timing_label": cand["timing_label"],
                         "in_watchlist": cand["in_watchlist"]})

    if sells:
        status = "partial" if deferred else "ok"
        summary = (f"🔁 以下の売買で目標配分に近づけられます"
                   f"（約 {round(proceeds):,} 円を移動）。")
        if deferred:
            summary += " 一部は売却制限・損失回避のため見送り/部分調整です。"
    elif deferred:
        status = "defer"
        summary = ("⏸ 配分の乖離はありますが、売却候補が「売却不可設定」「長期上昇トレンド"
                   "（値上がり予測）」「安値圏」のいずれかに該当するため、"
                   "損失回避の観点から今回のリバランスは見送りを推奨します。"
                   "無理に売らず、今後の積立配分（不足クラスを厚めに買う）での調整がおすすめです。")
        if under and any_units:
            add_names = "、".join(f"{icon_of.get(c['name'],'')}{c['name']}" for c in under)
            summary += f"（買い足すなら {add_names} が不足しています）"
    else:
        status = "none"
        summary = "✅ 大きな乖離はありません。リバランスの必要はありません。"

    return {"status": status, "summary": summary,
            "sells": sells, "buys": buys, "deferred": deferred,
            "excluded": excluded,
            "note": ("※ 取得単価が未登録のため、実際の損益ではなくテクニカルな高値圏/安値圏で"
                     "売り時・買い時を判断しています。「値上がり予測」は長期トレンドに基づく"
                     "機械的な判定で、将来を保証するものではありません。"
                     "税金・手数料・分配金は考慮していません。投資助言ではありません。")}


def _buy_candidate_for_class(summaries, cls_name):
    """不足クラスの購入候補：ウォッチリスト内 → 内蔵カタログの順で探す。"""
    in_watch = [s for s in summaries if s.get("ok")
                and (s.get("asset_class") or "") == cls_name]
    if in_watch:
        best = max(in_watch, key=_timing_score)
        timing, label = _buy_timing(_timing_score(best))
        return {"name": best["name"], "timing": timing, "timing_label": label,
                "in_watchlist": True}
    # ウォッチリストに無ければ内蔵カタログから提案（価格キャッシュがあれば買い時判定）
    rows = [r for r in db.search_catalog("", limit=500)
            if (r.get("asset_class") or "") == cls_name]
    for r in rows:
        cached = db.get_cached_series(r["isin"], r["assoc_code"], max_age_hours=24 * 7)
        if cached and len(cached.get("nav", [])) >= 90:
            hz = signal_mod.analyze_horizons(cached["dates"], cached["nav"])
            scores = [h["score"] for h in hz if h.get("ok") and h["key"] in ("short", "mid")]
            ts = sum(scores) / len(scores) if scores else 0
            timing, label = _buy_timing(ts)
            return {"name": r["name"], "timing": timing, "timing_label": label,
                    "in_watchlist": False}
    if rows:
        return {"name": rows[0]["name"], "timing": "unknown",
                "timing_label": "（一覧に追加すると買い時判定が出ます）",
                "in_watchlist": False}
    return {"name": f"{cls_name}クラスの投信（内蔵リストにありません）",
            "timing": "unknown", "timing_label": "", "in_watchlist": False}


@app.route("/api/targets", methods=["GET", "POST"])
def api_targets():
    """理想ポートフォリオ（クラス別目標%）の取得・保存。"""
    if request.method == "GET":
        t = db.get_setting("targets", None) or dict(seed_funds.DEFAULT_TARGETS)
        return jsonify({"ok": True, "targets": t,
                        "presets": seed_funds.TARGET_PRESETS})
    data = request.get_json(silent=True) or {}
    raw = data.get("targets") or {}
    targets = {}
    for name in seed_funds.ASSET_CLASS_NAMES:
        try:
            v = float(raw.get(name, 0))
        except (TypeError, ValueError):
            return jsonify({"ok": False, "error": f"{name} の値が数値ではありません。"}), 400
        if v < 0 or v > 100:
            return jsonify({"ok": False, "error": f"{name} は0〜100で入力してください。"}), 400
        targets[name] = v
    total = sum(targets.values())
    if abs(total - 100) > 0.5:
        return jsonify({"ok": False,
                        "error": f"合計が100%になるようにしてください（現在 {total:.0f}%）。"}), 400
    db.set_setting("targets", targets)
    return jsonify({"ok": True, "targets": targets})


@app.route("/api/catalog/class", methods=["POST"])
def api_catalog_class():
    """商品の資産クラス（分類）を手動で変更する。"""
    data = request.get_json(silent=True) or {}
    catalog_id = data.get("catalog_id")
    asset_class = data.get("asset_class")
    if catalog_id is None or not asset_class:
        return jsonify({"ok": False, "error": "catalog_id と asset_class が必要です。"}), 400
    try:
        db.set_asset_class(int(catalog_id), asset_class)
    except ValueError as e:
        return jsonify({"ok": False, "error": str(e)}), 400
    return jsonify({"ok": True, "asset_class": asset_class})


@app.route("/api/watchlist/broker", methods=["POST"])
def api_watchlist_broker():
    """保有先の証券会社を設定する（SBI証券 / 楽天証券 / 三菱UFJスマート証券 / 空=未設定）。
    watch_id は保有行（watchlist.id）。"""
    data = request.get_json(silent=True) or {}
    watch_id = data.get("watch_id")
    if watch_id is None:
        return jsonify({"ok": False, "error": "watch_id が必要です。"}), 400
    try:
        broker = db.set_broker(int(watch_id), data.get("broker") or "")
    except ValueError as e:
        return jsonify({"ok": False, "error": str(e)}), 400
    return jsonify({"ok": True, "broker": broker})


@app.route("/api/catalog/list")
def api_catalog_list():
    """内蔵＋登録済みの全商品を、資産クラス付き・追加済みフラグ付きで返す。
    ポートフォリオ画面の「プリセット商品を追加」一覧で使う。"""
    active, sold_only = _watched_catalog_ids()
    items = []
    for r in db.list_catalog():
        items.append({
            "id": r["id"], "name": r["name"], "isin": r["isin"],
            "category": r.get("category", ""),
            "asset_class": r.get("asset_class", "") or "",
            "kind": r.get("kind", "fund") or "fund",
            "watched": r["id"] in active,
            "sold_out": r["id"] in sold_only,
        })
    return jsonify({"ok": True, "items": items, "brokers": seed_funds.BROKERS})


@app.route("/api/watchlist/policy", methods=["POST"])
def api_watchlist_policy():
    """売却属性（full=売却可能 / partial=一部売却可能 / locked=売却不可）を設定する。"""
    data = request.get_json(silent=True) or {}
    watch_id = data.get("watch_id")
    policy = data.get("policy")
    if watch_id is None or policy not in db.SELL_POLICIES:
        return jsonify({"ok": False, "error": "watch_id と policy(full/partial/locked) が必要です。"}), 400
    db.set_sell_policy(int(watch_id), policy)
    return jsonify({"ok": True, "policy": policy})


@app.route("/api/watchlist/units", methods=["POST"])
def api_watchlist_units():
    """保有口数を登録する。

    record（日付・単価）が付いていれば、増減を「その日の売買」として記録する。
    口数の欄は日付を持たないため、そのまま変えると「昔からこの口数だった」ことに
    なり、金額の推移が過去に遡って書き換わる。売買として記録すると日付が入り、
    変更した日より前の評価額はそのまま残る。
    """
    data = request.get_json(silent=True) or {}
    watch_id = data.get("watch_id")
    if watch_id is None:
        return jsonify({"ok": False, "error": "watch_id が必要です。"}), 400
    try:
        units = float(data.get("units") or 0)
    except (TypeError, ValueError):
        return jsonify({"ok": False, "error": "口数は数値で入力してください。"}), 400
    if units < 0:
        return jsonify({"ok": False, "error": "口数は0以上で入力してください。"}), 400

    watch_id = int(watch_id)
    rec = data.get("record") or None
    it = db.get_watch(watch_id) or {}
    kind = it.get("kind") or "fund"
    try:
        prev = float(data.get("prev_units") if data.get("prev_units") is not None
                     else (it.get("units") or 0))
    except (TypeError, ValueError):
        prev = float(it.get("units") or 0)

    saved = db.set_units(watch_id, units)
    if not rec:
        return jsonify({"ok": True, "units": saved, "recorded": False})

    delta = units - prev
    if abs(delta) < 1e-9:
        return jsonify({"ok": True, "units": saved, "recorded": False,
                        "note": "口数が変わっていないため、売買は記録しませんでした。"})
    side = "buy" if delta > 0 else "sell"
    try:
        price = float(rec.get("price") or 0)
        fee = float(rec.get("fee") or 0)
    except (TypeError, ValueError):
        return jsonify({"ok": False, "error": "単価・手数料は数値で入力してください。"}), 400
    try:
        db.add_trade(watch_id, (rec.get("date") or "").strip(), side, abs(delta), price,
                     fee, (rec.get("note") or "口数の変更から記録").strip())
    except (ValueError, TypeError) as e:
        return jsonify({"ok": False, "error": str(e)}), 400

    # 売買の記録だけで今の口数を説明できるなら、平均取得単価・取得原価も記録から計算し直す。
    # 説明できない（昔の購入が未記録）なら、入力された口数を尊重し、投資金額は差分だけ動かす。
    trades = db.list_trades(watch_id)
    pos = db.trade_position(trades, kind)
    if abs(pos["units"] - units) <= max(1.0, abs(units) * 0.01):
        db.set_units(watch_id, pos["units"])
        db.set_invested(watch_id, pos["cost"])
        synced = True
    else:
        div = 1.0 if kind == "stock" else 10000.0
        inv = float(it.get("invested") or 0)
        if side == "buy":
            inv += abs(delta) * price / div + fee
        elif prev > 0:
            inv = max(0.0, inv * (1 - min(1.0, abs(delta) / prev)))
        db.set_invested(watch_id, inv)
        synced = False
    cur = db.get_watch(watch_id) or {}
    return jsonify({"ok": True, "units": cur.get("units", saved), "recorded": True,
                    "side": side, "trade_units": abs(delta),
                    "invested": cur.get("invested"), "synced": synced})


@app.route("/api/watchlist/invested", methods=["POST"])
def api_watchlist_invested():
    """投資金額（元本）を登録する。watch_id は保有行（watchlist.id）。"""
    data = request.get_json(silent=True) or {}
    watch_id = data.get("watch_id")
    if watch_id is None:
        return jsonify({"ok": False, "error": "watch_id が必要です。"}), 400
    try:
        invested = float(data.get("invested") or 0)
    except (TypeError, ValueError):
        return jsonify({"ok": False, "error": "投資金額は数値で入力してください。"}), 400
    if invested < 0:
        return jsonify({"ok": False, "error": "投資金額は0以上で入力してください。"}), 400
    saved = db.set_invested(int(watch_id), invested)
    return jsonify({"ok": True, "invested": saved})


@app.route("/api/watchlist/label", methods=["POST"])
def api_watchlist_label():
    """保有ごとの表示名（口座名）を設定する。
    同じ商品を複数の口座（NISA成長枠・つみたて枠・特定など）で持つときの区別に使う。"""
    data = request.get_json(silent=True) or {}
    watch_id = data.get("watch_id")
    if watch_id is None:
        return jsonify({"ok": False, "error": "watch_id が必要です。"}), 400
    saved = db.set_label(int(watch_id), data.get("label") or "")
    return jsonify({"ok": True, "label": saved})


@app.route("/api/watchlist/account", methods=["POST"])
def api_watchlist_account():
    """口座種別を設定する（nisa=非課税 / taxable=特定・課税）。"""
    data = request.get_json(silent=True) or {}
    watch_id = data.get("watch_id")
    if watch_id is None:
        return jsonify({"ok": False, "error": "watch_id が必要です。"}), 400
    saved = db.set_account_type(int(watch_id), data.get("account_type") or "taxable")
    return jsonify({"ok": True, "account_type": saved})


# ------------------------------------------------------------------ 売買の記録
def _watch_kind(watch_id):
    """保有が投信か株かを返す（金額換算の分母が違うため）。"""
    it = db.get_watch(int(watch_id))
    return (it.get("kind") or "fund") if it else "fund"


def _add_watch_returning_id(catalog_id, broker=""):
    """商品を一覧（ウォッチリスト）へ追加し、その保有IDを返す。
    すでに同じ商品×同じ証券会社で持っている場合は、その保有IDを返す。
    db.add_watch は追加できたかの真偽値を返す（画面が使っている）ので、
    IDが必要なここでは追加後に引き当てる。"""
    if not db.get_catalog(int(catalog_id)):
        return None
    db.add_watch(int(catalog_id), broker=broker)
    for it in db.list_watchlist():
        if it["id"] == int(catalog_id) and (it.get("broker") or "") == (broker or ""):
            return it["watch_id"]
    # 証券会社が一致する行が無ければ、同じ商品の保有から最も新しいものを使う
    same = [it for it in db.list_watchlist() if it["id"] == int(catalog_id)]
    return same[-1]["watch_id"] if same else None


def _sync_position_from_trades(watch_id, kind=None):
    """売買の記録から保有口数と投資金額（取得原価）を計算し、保有へ反映する。
    記録が1件も無い保有は手入力のままにする（自動で0にしない）。"""
    trades = db.list_trades(int(watch_id))
    if not trades:
        return None
    pos = db.trade_position(trades, kind or _watch_kind(watch_id))
    db.set_units(int(watch_id), pos["units"])
    db.set_invested(int(watch_id), pos["cost"])
    return pos


@app.route("/api/trades")
def api_trades():
    """ある保有の売買の記録と、そこから計算した平均取得単価・実現損益を返す。
    手数料の入力を省けるよう、既定の手数料率と直近の手数料も返す。"""
    watch_id = request.args.get("watch_id")
    if watch_id is None:
        return jsonify({"ok": False, "error": "watch_id が必要です。"}), 400
    it = db.get_watch(int(watch_id))
    kind = (it.get("kind") or "fund") if it else "fund"
    trades = db.list_trades(int(watch_id))
    last_fee = trades[-1].get("fee") if trades else 0
    return jsonify({"ok": True, "watch_id": int(watch_id), "kind": kind,
                    "fee_rate": (it.get("fee_rate") or 0) if it else 0,
                    "last_fee": round(float(last_fee or 0)),
                    "trades": trades, "position": db.trade_position(trades, kind)})


@app.route("/api/watchlist/fee-rate", methods=["POST"])
def api_watchlist_fee_rate():
    """売買手数料の既定値（率%）を設定する。0なら自動計算しない。"""
    data = request.get_json(silent=True) or {}
    watch_id = data.get("watch_id")
    if watch_id is None:
        return jsonify({"ok": False, "error": "watch_id が必要です。"}), 400
    try:
        saved = db.set_fee_rate(int(watch_id), data.get("fee_rate"))
    except (TypeError, ValueError):
        return jsonify({"ok": False, "error": "手数料率は数値で入力してください。"}), 400
    return jsonify({"ok": True, "fee_rate": saved})


@app.route("/api/trades", methods=["POST"])
def api_trades_add():
    """売買を1件記録し、保有の口数・投資金額へ反映する。"""
    data = request.get_json(silent=True) or {}
    watch_id = data.get("watch_id")
    if watch_id is None:
        return jsonify({"ok": False, "error": "watch_id が必要です。"}), 400
    try:
        db.add_trade(int(watch_id), data.get("date") or "", data.get("side") or "buy",
                     data.get("units"), data.get("price"),
                     data.get("fee") or 0, data.get("note") or "")
    except (ValueError, TypeError) as e:
        return jsonify({"ok": False, "error": str(e)}), 400
    pos = _sync_position_from_trades(watch_id)
    return jsonify({"ok": True, "position": pos})


@app.route("/api/trades/import-preview", methods=["POST"])
def api_trades_import_preview():
    """証券会社の取引履歴CSVを解析し、取り込む内容を確認用に返す。
    どの保有に結び付けるかは商品名で自動判定し、絞れないものは画面で選んでもらう。"""
    f = request.files.get("file")
    if f is None:
        return jsonify({"ok": False, "error": "CSVファイルを選択してください。"}), 400
    # 列の対応づけを画面で指定された場合はそれを使う（証券会社ごとの列名の違いに対応）
    mapping = None
    raw_map = request.form.get("mapping")
    if raw_map:
        try:
            mapping = json.loads(raw_map)
        except json.JSONDecodeError:
            mapping = None

    raw = f.read()
    parsed = broker_import.parse(raw, mapping)
    if not parsed.get("ok"):
        return jsonify(parsed), 400

    saved_maps = db.get_setting("csv_mappings", {}) or {}
    sig = broker_import.header_signature(parsed.get("header"))
    if parsed.get("needs_mapping"):
        # 以前に同じ形式のCSVで指定した対応づけがあれば、それを使って読み直す
        if not mapping and sig and sig in saved_maps:
            retry = broker_import.parse(raw, saved_maps[sig])
            if retry.get("ok") and not retry.get("needs_mapping"):
                parsed = retry
        if parsed.get("needs_mapping"):
            return jsonify(parsed)      # それでも決まらなければ画面で選んでもらう
    # 手動で指定して読めた場合は、その対応づけを覚えて次回から自動で使う
    if mapping and sig and parsed.get("rows"):
        saved_maps[sig] = {k: v for k, v in (parsed.get("columns") or {}).items()}
        db.set_setting("csv_mappings", saved_maps)
        parsed["mapping_saved"] = True

    holdings = db.list_watchlist()
    matches = broker_import.match_holdings(parsed["rows"], holdings, parsed.get("broker", ""))
    # 保有に無い商品は、登録済みカタログから「一覧に追加して取り込む」候補を出す
    catalog = db.list_catalog()
    watched_ids = {h["id"] for h in holdings}
    suggests = broker_import.suggest_catalog(parsed["rows"], catalog, watched_ids)
    existing = {(t["watch_id"], t["date"], t["side"], round(float(t["units"]), 4),
                 round(float(t["price"]), 4)) for t in db.list_trades()}

    # 商品ごとにまとめて返す（画面では商品単位で対応づけを確認・変更する）
    groups = {}
    for r in parsed["rows"]:
        # 同じ商品でも口座区分（特定/NISA）が違えば別の保有に取り込む
        key = broker_import.group_key(r)
        name_key = broker_import.normalize_name(r["name"])
        g = groups.setdefault(key, {
            "key": key, "name": r["name"], "count": 0, "buy": 0, "sell": 0,
            "first": r["date"], "last": r["date"], "duplicates": 0,
            "watch_id": matches.get(key, {}).get("watch_id"),
            "how": matches.get(key, {}).get("how"),
            # 保有に無い場合の「追加候補」（カタログのid）と、候補の並び順（似ている順）
            "catalog_id": (None if matches.get(key, {}).get("watch_id")
                           else suggests.get(name_key, {}).get("catalog_id")),
            "catalog_order": suggests.get(name_key, {}).get("order", []),
            "account_type": r["account_type"], "dividend_mode": r["dividend_mode"],
        })
        g["count"] += 1
        g[r["side"]] += 1
        g["first"] = min(g["first"], r["date"])
        g["last"] = max(g["last"], r["date"])
        if g["watch_id"] and (g["watch_id"], r["date"], r["side"],
                              round(r["units"], 4), round(r["price"], 4)) in existing:
            g["duplicates"] += 1

    return jsonify({
        "ok": True, "broker": parsed.get("broker", ""),
        "groups": sorted(groups.values(), key=lambda g: -g["count"]),
        "rows": parsed["rows"], "skipped": parsed.get("skipped", []),
        "mapping_saved": bool(parsed.get("mapping_saved")),
        "holdings": [{"watch_id": h["watch_id"], "name": h.get("name") or "",
                      "label": h.get("label") or "", "broker": h.get("broker") or "",
                      "account_type": h.get("account_type") or "taxable",
                      "kind": h.get("kind") or "fund"} for h in holdings],
        # 一覧に無い商品を、その場で追加して取り込むための候補
        "catalog": [{"catalog_id": c["id"], "name": c.get("name") or "",
                     "kind": c.get("kind") or "fund"}
                    for c in catalog if c["id"] not in watched_ids],
    })


@app.route("/api/trades/import", methods=["POST"])
def api_trades_import():
    """確認済みの対応づけで取引履歴を取り込む。同じ内容の記録は重複登録しない。"""
    data = request.get_json(force=True, silent=True) or {}
    rows = data.get("rows") or []
    mapping = data.get("mapping") or {}     # {正規化名: watch_id}
    if not rows:
        return jsonify({"ok": False, "error": "取り込む取引がありません。"}), 400

    existing = {(t["watch_id"], t["date"], t["side"], round(float(t["units"]), 4),
                 round(float(t["price"]), 4)) for t in db.list_trades()}
    broker = (data.get("broker") or "").strip()
    added = skipped = dup = 0
    created = 0
    touched = set()
    resolved = {}          # 対応づけの解決結果（"c:12" の追加は1回だけ行う）

    def resolve(value):
        """対応づけの値を watch_id に変換する。
        "c:<catalog_id>" は「一覧に追加してから取り込む」指定。"""
        if value in resolved:
            return resolved[value]
        wid = None
        s = str(value)
        if s.startswith("c:"):
            try:
                wid = _add_watch_returning_id(int(s[2:]), broker)
            except (ValueError, TypeError):
                wid = None
        else:
            try:
                wid = int(value)
            except (ValueError, TypeError):
                wid = None
        resolved[value] = wid
        return wid

    for r in rows:
        key = broker_import.group_key(r)
        raw_target = mapping.get(key)
        if not raw_target:
            skipped += 1
            continue
        wid = resolve(raw_target)
        if not wid:
            skipped += 1
            continue
        if str(raw_target).startswith("c:") and wid not in touched:
            created += 1
        sig = (wid, r.get("date"), r.get("side"),
               round(float(r.get("units") or 0), 4), round(float(r.get("price") or 0), 4))
        if sig in existing:
            dup += 1
            continue
        try:
            db.add_trade(wid, r.get("date"), r.get("side"), r.get("units"), r.get("price"),
                         r.get("fee") or 0, r.get("note") or "")
        except (ValueError, TypeError):
            skipped += 1
            continue
        existing.add(sig)
        touched.add(wid)
        added += 1
    # 取り込んだ保有の口数・投資金額を売買の記録から計算し直す
    for wid in touched:
        _sync_position_from_trades(wid)
    return jsonify({"ok": True, "added": added, "duplicates": dup, "skipped": skipped,
                    "holdings": len(touched), "created": created})


@app.route("/api/trades", methods=["DELETE"])
def api_trades_delete():
    """売買の記録を1件削除し、保有の口数・投資金額へ反映する。"""
    data = request.get_json(silent=True) or {}
    trade_id, watch_id = data.get("trade_id"), data.get("watch_id")
    if trade_id is None or watch_id is None:
        return jsonify({"ok": False, "error": "trade_id と watch_id が必要です。"}), 400
    db.delete_trade(int(trade_id))
    pos = _sync_position_from_trades(watch_id)
    return jsonify({"ok": True, "position": pos})


# 取引履歴（Excel実額）の最終日。これより後の日付だけ当日更新で追記する
_RECORDED_MAX_DATE = db.recorded_max_date()


def _persist_today_value(watch_id, date, value):
    """当日（記録期間より後）の評価額を amount_history に追記/更新する。
    記録済みの実額（〜7/22）は書き換えない。書き込んだら True を返す。"""
    if not date or value is None:
        return False
    if _RECORDED_MAX_DATE and date <= _RECORDED_MAX_DATE:
        return False
    try:
        db.upsert_amount(int(watch_id), date, float(value))
        return True
    except Exception:
        return False


def _latest_valid(dates, values):
    """末尾から見て最初の (日付, 値)（値がNoneでないもの）を返す。無ければ (None, None)。"""
    for d, v in zip(reversed(dates or []), reversed(values or [])):
        if v is not None:
            return d, v
    return None, None


def _startup_price_refresh():
    """起動時に保有投信・株の最新価格を一度だけ「強制取得」して内部DBのキャッシュを更新し、
    当日分（記録期間より後の最新基準価額×口数）を amount_history へ反映する。

    通常アクセスは12時間キャッシュを使うため、当日新しく公開された基準価額が
    取り込まれないことがある。起動時に force 取得することで、表・グラフ・評価額を
    最新の公開データに更新する。ネットワーク取得はバックグラウンドで行い、サーバ起動を
    ブロックしない（失敗しても既存キャッシュで動作を続ける）。"""
    updated = 0
    for it in db.list_watchlist():
        isin = (it.get("isin") or "").strip()
        assoc = (it.get("assoc_code") or "").strip()
        if not isin and not assoc:
            continue
        kind = it.get("kind", "fund") or "fund"
        try:
            series = load_series(isin, assoc, it.get("name", ""), force=True, kind=kind)
        except Exception:
            continue   # 取得失敗は既存キャッシュのまま（force取得でDBキャッシュを更新済み）
        units = float(it.get("units") or 0)
        if units <= 0:
            continue
        d, p = _latest_valid(series.get("dates"), series.get("nav"))
        if d is None:
            continue
        factor = units / (10000.0 if kind != "stock" else 1.0)
        if _persist_today_value(it["watch_id"], d, round(p * factor)):
            updated += 1
    if updated:
        print(f"起動時の価格更新: {updated} 件の当日評価額を反映しました。")


@app.route("/api/actual-history")
def api_actual_history():
    """取引履歴（実額）ポートフォリオの日次推移を返す。
    - holdings: 各保有の {name, broker, asset_class, invested, dates[], amount[], ratio[]}
      ratio = 評価額 ÷ 投資金額 ×100（投資金額0の保有は ratio=null）
    - dates: 全保有の日付の和集合（古い順）
    - totals: 日付ごとの合計評価額と、合計に対する比率
    - skipped: 評価額の履歴が無くグラフ・表に出せない保有と、その理由
    """
    range_key = request.args.get("range", "1y")
    force = request.args.get("force") in ("1", "true", "yes")
    watch = db.list_watchlist()
    histories = db.get_all_amount_histories()
    trades_by_watch = {}
    for t in db.list_trades():
        trades_by_watch.setdefault(t["watch_id"], []).append(t)
    # 全額売却済みの保有はグラフ・表から外す（もう持っていないため）。
    # 実現損益は残るので、件数と合計を別に返して画面で知らせる。
    sold_ids = _sold_out_ids()
    sold_out = []
    if sold_ids:
        by_watch = {}
        for t in db.list_trades():
            by_watch.setdefault(t["watch_id"], []).append(t)
        for it in watch:
            if it["watch_id"] not in sold_ids:
                continue
            pos = db.trade_position(by_watch.get(it["watch_id"]) or [],
                                    it.get("kind", "fund") or "fund")
            sold_out.append({"watch_id": it["watch_id"], "name": it.get("name") or "",
                             "broker": it.get("broker") or "",
                             "realized": pos["realized"], "sell_amount": pos["sell_amount"]})
        watch = [it for it in watch if it["watch_id"] not in sold_ids]

    # 評価額の履歴がある保有を対象にする
    holdings = [it for it in watch if histories.get(it["watch_id"])]
    # 履歴が無く表示できない保有は、理由を添えて画面に知らせる（黙って消さない）
    skipped = []
    for it in watch:
        if histories.get(it["watch_id"]):
            continue
        units = float(it.get("units") or 0)
        invested = float(it.get("invested") or 0)
        reasons = []
        if units <= 0:
            reasons.append("口数が未入力")
        if invested <= 0:
            reasons.append("投資金額が未入力")
        if not reasons:
            reasons.append("評価額の履歴がまだありません")
        skipped.append({"watch_id": it["watch_id"], "name": it.get("name") or "",
                        "broker": it.get("broker") or "", "reasons": reasons,
                        "need_units": units <= 0, "need_invested": invested <= 0})

    excel_dates = set()          # 実額の記録がある日付（表・合計に使う）
    result = []
    mismatch = []                # 口数から計算した評価額と、記録されている実額が食い違う保有
    for it in holdings:
        excel = histories[it["watch_id"]]
        excel_dates.update(excel.keys())
        inv = float(it.get("invested") or 0)
        units = float(it.get("units") or 0)
        merged = {d: round(a) for d, a in excel.items()}   # 実額を優先
        checks = []                                        # (日付, 実額, 口数から計算した額)
        kind = it.get("kind", "fund") or "fund"
        # 日付ごとの口数・取得原価（売買の記録をいまの値からさかのぼって復元）。
        # 記録が無い期間はその時点のままとみなす。
        tl = _holding_timeline(trades_by_watch.get(it["watch_id"]) or [], units, inv, kind)
        (tl_base_u, _), tl_items = tl
        # いまは0口でも、売る前の期間は持っていたので描く
        had_units = units > 0 or tl_base_u > 0 or any(u > 0 for _, u, _c in tl_items)
        # 口数が入っていれば、実際の基準価額×口数で「過去の価格データ」を反映（実額の無い日を補完）
        if had_units and (it.get("isin") or it.get("assoc_code")):
            try:
                series = load_series(it["isin"], it["assoc_code"], it["name"], force=force, kind=kind)
                dts, prs, _ = _apply_range(series, range_key)
                div = 10000.0 if kind != "stock" else 1.0
                unit_at = (lambda d: _units_at(tl, d))
                # 取り込んだ実額（記録期間内）と「基準価額×口数」を突き合わせる（取り込みミスの検知用）。
                # 記録期間より後の実額はアプリが口数から保存した値なので、比べても意味がない。
                for d, p in zip(dts, prs):
                    if (p is not None and d in excel and unit_at(d) > 0
                            and _RECORDED_MAX_DATE and d <= _RECORDED_MAX_DATE):
                        checks.append((d, float(excel[d]), round(p * unit_at(d) / div)))
                for d, p in zip(dts, prs):
                    if p is not None and d not in merged:
                        u = unit_at(d)
                        if u > 0:            # まだ持っていない日は空欄にする（0を書かない）
                            merged[d] = round(p * u / div)
                # 記録期間より後の営業日はすべて表・合計に反映＆保存する。
                # （単に最新日だけでなく、昨日など直近の営業日や、アプリを起動しなかった
                #   日も基準価額の履歴からさかのぼって補完する）
                for d, p in zip(dts, prs):
                    if p is None:
                        continue
                    if _RECORDED_MAX_DATE and d <= _RECORDED_MAX_DATE:
                        continue
                    u = unit_at(d)
                    if u <= 0:
                        # 売り切ったあとの日。以前に自動保存した評価額が残っていると
                        # 売ったのに資産が残って見えるので、その保存分を消す
                        # （売買の記録がある場合だけ。口数未入力と区別するため）
                        if tl_items and d in merged:
                            db.upsert_amount(it["watch_id"], d, 0)
                            merged.pop(d, None)
                        continue
                    val = round(p * u / div)
                    _persist_today_value(it["watch_id"], d, val)
                    merged[d] = val
                    excel_dates.add(d)
            except Exception:
                pass
        # 記録されている実額と、口数・売買の記録から計算した評価額が大きく食い違う場合に知らせる。
        # 取引CSVを別口座の保有に取り込んでしまった場合など、口数が実際と数倍ずれていても
        # 画面上は数字が並ぶだけで気づけないため（例: 実額68万円 vs 計算616万円）。
        # しきい値は「1.8倍以上・0.55倍以下、かつ差が20万円以上」。口数を後から手で変えた
        # 場合の多少のずれで警告が出ると、本当の取り込みミスが埋もれてしまうため。
        if checks:
            d0, real, calc = checks[-1]
            r0 = (calc / real) if real > 0 else 0
            if real > 0 and (r0 >= 1.8 or r0 <= 0.55) and abs(calc - real) >= 200000:
                mismatch.append({
                    "watch_id": it["watch_id"], "name": it.get("name") or "",
                    "broker": it.get("broker") or "",
                    "account_type": it.get("account_type") or "taxable",
                    "date": d0, "recorded": round(real), "calculated": round(calc),
                    "units": round(units), "ratio": round(calc / real, 2),
                })

        dates = sorted(merged.keys())
        amounts = [merged[d] for d in dates]
        # 比率は「その日の評価額 ÷ その日の投資金額」。いまの投資金額で過去まで割ると、
        # 売る前で口数が多かった期間の比率が跳ね上がる（数百%の山になる）。
        basis = []
        for d in dates:
            b = _basis_at(tl, d)
            if b <= 0 and inv > 0 and units > 0:
                # 記録が足りず原価を戻しきれない日は、口数に比例させる（線を切らさない）
                b = inv * _units_at(tl, d) / units
            basis.append(b)
        ratio = ([round(a / b * 100, 2) if b > 0 else None for a, b in zip(amounts, basis)]
                 if inv > 0 else None)
        official = it.get("name") or it.get("label") or ""   # catalog（正式なファンド名）
        result.append({
            "id": it["watch_id"], "name": official,
            "account": it.get("label") or "",                # 口座ニックネーム（成長/積立/旧NISA 等）
            "fund_name": official,
            "broker": it.get("broker", "") or "",
            "asset_class": it.get("asset_class", "") or "",
            "kind": it.get("kind", "fund") or "fund",
            "sell_policy": it.get("sell_policy", "full"),
            "invested": round(inv), "dates": dates, "amount": amounts, "ratio": ratio,
            "basis": [round(b) for b in basis],   # その日の投資金額（比率の分母）
            "latest": amounts[-1] if amounts else None,
            "latest_ratio": ratio[-1] if ratio else None,
        })

    # グラフのX軸（全保有の日付の和集合）
    graph_dates = sorted(set().union(*[set(h["dates"]) for h in result])) if result else []
    excel_dates = sorted(excel_dates)

    # 更新が止まっている保有を知らせる（黙って「—」にしない）。
    # 口数が未入力だと株価から評価額を計算できず、その銘柄だけ更新が止まる。
    #
    # 「止まっている」の基準は表の最終列ではなく、商品の種類ごとの目標日にする。
    # 投信の基準価額は当日中には公表されないため、株が当日分を持っていて表の右端が
    # 当日になっても、投信が前営業日どまりなのは正常（表の最終列と比べると全件が
    # 「止まっている」と出てしまう）。さらに、どの保有も持っていない日付は要求しない
    # ようにして、祝日などで目標日だけが先に進むのを防ぐ。
    all_last = max((h["dates"][-1] for h in result if h["dates"]), default=None)
    if all_last:
        by_id = {it["watch_id"]: it for it in holdings}
        for h in result:
            own_last = h["dates"][-1] if h["dates"] else None
            table_last = min(_fresh_target(h["kind"]).isoformat(), all_last)
            if own_last and own_last >= table_last:
                continue
            it = by_id.get(h["id"], {})
            units = float(it.get("units") or 0)
            reasons = []
            if units <= 0:
                reasons.append("口数が未入力のため、最新の評価額を計算できません")
            else:
                reasons.append("価格を取得できず、最新の評価額を計算できません")
            skipped.append({"watch_id": h["id"], "name": h["name"], "broker": h["broker"],
                            "reasons": reasons + [f"最終 {own_last or 'なし'}（本来は {table_last} まで）"],
                            "need_units": units <= 0,
                            "need_invested": float(it.get("invested") or 0) <= 0,
                            "stale": True})

    total_inv = sum(float(it.get("invested") or 0) for it in holdings)
    # 合計は各保有の「その日以前の最新値」を積み上げる（当日更新で一部だけ更新されても
    # 合計が欠けないようにする＝キャリーフォワード）
    hmaps = []
    for h in result:
        hmaps.append(sorted((d, a) for d, a in zip(h["dates"], h["amount"])))

    def _carry(series, d):
        v = 0
        for dd, aa in series:
            if dd <= d:
                v = aa
            else:
                break
        return v

    # 合計の比率も分母を日付ごとにする（その日までに持ち始めた保有の投資金額の合計）。
    # まだ持っていない保有の投資金額まで足すと、過去の比率が実際より低く出る。
    bmaps = []
    for h in result:
        bmaps.append((h["dates"][0] if h["dates"] else None,
                      sorted((d, b) for d, b in zip(h["dates"], h["basis"]))))

    def _basis_sum(d):
        tot = 0.0
        for first, series in bmaps:
            if first is None or first > d:
                continue
            tot += _carry(series, d)
        return tot

    totals = []
    for d in excel_dates:
        ssum = round(sum(_carry(s, d) for s in hmaps))
        binv = _basis_sum(d)
        totals.append({"date": d, "amount": ssum, "invested": round(binv),
                       "ratio": round(ssum / binv * 100, 2) if binv > 0 else None})
    # 期間(range)に応じた評価額合計の推移（全保有の日付＝graph_dates で積み上げ）。
    # excel_dates 基準の totals と違い、選択期間に合わせて長さが変わる（資産プランの推移グラフ用）。
    totals_full = []
    for d in graph_dates:
        ssum = round(sum(_carry(s, d) for s in hmaps))
        binv = _basis_sum(d)
        totals_full.append({"date": d, "amount": ssum, "invested": round(binv),
                            "ratio": round(ssum / binv * 100, 2) if binv > 0 else None})
    return jsonify({"ok": True, "holdings": result, "dates": graph_dates,
                    "excel_dates": excel_dates, "range": range_key,
                    "total_invested": round(total_inv), "skipped": skipped,
                    "sold_out": sold_out, "mismatch": mismatch,
                    "totals": totals, "totals_full": totals_full})


def _monthly_returns(dates, values):
    """日次の価格系列から、月末値どうしの月次リターン（単純収益率）を作る。"""
    month_end = {}
    for d, v in zip(dates or [], values or []):
        if v is None or (isinstance(v, float) and (math.isnan(v) or math.isinf(v))):
            continue
        month_end[str(d)[:7]] = (d, float(v))     # 同じ月は後の日付で上書き＝月末値
    keys = sorted(month_end)
    out = []
    for i in range(1, len(keys)):
        prev = month_end[keys[i - 1]][1]
        cur = month_end[keys[i]][1]
        if prev > 0:
            out.append((keys[i], cur / prev - 1.0))
    return out


@app.route("/api/portfolio-risk")
def api_portfolio_risk():
    """保有銘柄の価格履歴から、ポートフォリオ全体の年率リターンと変動率を推定する。

    将来予測の「ブレ幅」を、想定値ではなく実際の保有商品の値動きから求めるために使う。
    各銘柄の月次リターンを現在の評価額で加重して合成し、その標準偏差を年率換算する。
    """
    years = max(1.0, min(20.0, float(request.args.get("years", 5) or 5)))
    per_fund, weights, series = [], {}, {}
    items = {}
    for it in db.list_watchlist():
        units = float(it.get("units") or 0)
        if units <= 0:
            continue
        kind = it.get("kind", "fund") or "fund"
        try:
            s = load_series(it["isin"], it["assoc_code"], it["name"], kind=kind)
        except Exception:
            continue
        rets = _monthly_returns(s.get("dates"), s.get("nav"))
        if len(rets) < 13:                     # 1年分に満たない銘柄は推定に使わない
            continue
        rets = rets[-int(years * 12):]
        d, p = _latest_valid(s.get("dates"), s.get("nav"))
        if p is None:
            continue
        value = p * units / (1.0 if kind == "stock" else 10000.0)
        weights[it["watch_id"]] = value
        series[it["watch_id"]] = dict(rets)
        items[it["watch_id"]] = it
        sd = _stdev([r for _, r in rets])
        per_fund.append({"name": it.get("name"), "value": round(value),
                         "months": len(rets),
                         "annual_return": round((_mean([r for _, r in rets])) * 12 * 100, 2),
                         "annual_vol": round(sd * math.sqrt(12) * 100, 2)})

    total = sum(weights.values())
    if not total or not series:
        return jsonify({"ok": False, "error": "変動率を推定できる保有商品がありません"
                                              "（口数の入力と価格の取得が必要です）。"})
    # 各月について、保有比率で加重した合成リターンを作る
    months = sorted(set().union(*[set(v.keys()) for v in series.values()]))
    port = []
    for m in months:
        num = wsum = 0.0
        for wid, w in weights.items():
            r = series[wid].get(m)
            if r is not None:
                num += w * r
                wsum += w
        if wsum > 0:
            port.append(num / wsum)
    if len(port) < 13:
        return jsonify({"ok": False, "error": "共通する期間の価格データが不足しています。"})
    mu = _mean(port)
    sd = _stdev(port)
    return jsonify({
        "ok": True, "months": len(port),
        "annual_return": round(mu * 12 * 100, 2),
        "annual_vol": round(sd * math.sqrt(12) * 100, 2),
        "monthly_vol": round(sd * 100, 3),
        "total_value": round(total),
        "funds": sorted(per_fund, key=lambda x: -x["value"]),
        "concentration": _concentration(weights, series, items, months, total),
    })


def _concentration(weights, series, items, months, total):
    """一番大きい保有と、それ以外に分けて変動率を推定する。

    1銘柄に偏っているとき、「持ち続ける」と「売って分散する」で将来のブレ幅が
    どれだけ変わるかを試算するために使う。合成の分散を出すには、集中している銘柄の
    変動率・それ以外の変動率に加えて、両者の相関が要る。
    """
    if len(weights) < 2:
        return None
    top = max(weights, key=lambda w: weights[w])
    rest_w = {k: v for k, v in weights.items() if k != top}
    a, b = [], []
    for m in months:
        tr = series[top].get(m)
        if tr is None:
            continue
        num = wsum = 0.0
        for wid, w in rest_w.items():
            r = series[wid].get(m)
            if r is not None:
                num += w * r
                wsum += w
        if wsum > 0:
            a.append(tr)
            b.append(num / wsum)
    if len(a) < 13:
        return None
    it = items.get(top) or {}
    invested = float(it.get("invested") or 0)
    value = weights[top]
    return {
        "watch_id": top,
        "name": it.get("name") or "",
        "kind": it.get("kind") or "fund",
        "account_type": it.get("account_type") or "taxable",
        "value": round(value),
        "invested": round(invested),
        "share": round(value / total * 100, 1) if total else 0,
        "gain_frac": round(max(0.0, (value - invested) / value), 4) if value > 0 else 0,
        "vol": round(_stdev(a) * math.sqrt(12) * 100, 2),
        "rest_vol": round(_stdev(b) * math.sqrt(12) * 100, 2),
        "corr": round(_corr(a, b), 3),
        "months": len(a),
    }


def _corr(xs, ys):
    """2系列の相関係数。片方が動かない場合は0を返す。"""
    n = min(len(xs), len(ys))
    if n < 2:
        return 0.0
    mx, my = _mean(xs[:n]), _mean(ys[:n])
    sxy = sum((xs[i] - mx) * (ys[i] - my) for i in range(n))
    sxx = sum((xs[i] - mx) ** 2 for i in range(n))
    syy = sum((ys[i] - my) ** 2 for i in range(n))
    if sxx <= 0 or syy <= 0:
        return 0.0
    return sxy / math.sqrt(sxx * syy)


def _mean(xs):
    return sum(xs) / len(xs) if xs else 0.0


def _stdev(xs):
    if len(xs) < 2:
        return 0.0
    m = _mean(xs)
    return math.sqrt(sum((x - m) ** 2 for x in xs) / (len(xs) - 1))


@app.route("/api/ranking")
def api_ranking():
    """内蔵カタログ全体をテクニカル勢い（スコア）で順位付けして返す。

    「今後利益が出る保証」ではなく、あくまで過去データに基づくテクニカル指標の
    順位付け。ウォッチリスト外の“注目候補”を見つける用途。
    """
    range_key = request.args.get("range", "1y")
    force = request.args.get("force") in ("1", "true", "yes")
    # 全額売却済みの保有しか無い商品は「追加済み」にせず、また追加できるようにする
    active, sold_only = _watched_catalog_ids()
    rows = db.search_catalog("", limit=500)
    summaries = []
    for row in rows:
        s = _summarize_fund(row, range_key, force)
        s["in_watchlist"] = row["id"] in active
        s["sold_out_only"] = row["id"] in sold_only
        summaries.append(s)
    ok = [s for s in summaries if s.get("ok")]
    ok.sort(key=lambda x: (x.get("score") or -999), reverse=True)
    failed = [s for s in summaries if not s.get("ok")]
    return jsonify({"ok": True, "range": range_key, "items": ok + failed,
                    "count": len(ok)})


# ------------------------------------------------------------------ 詳細分析
@app.route("/api/analyze")
def api_analyze():
    range_key = request.args.get("range", "3y")
    force = request.args.get("force") in ("1", "true", "yes")
    name = request.args.get("name", "")

    kind = "fund"
    catalog_id = request.args.get("catalog_id")
    if catalog_id:
        row = db.get_catalog(int(catalog_id))
        if not row:
            return jsonify({"ok": False, "error": "指定の投信が見つかりません。"}), 404
        isin, assoc, name = row["isin"], row["assoc_code"], row["name"]
        kind = row.get("kind", "fund") or "fund"
    else:
        isin, assoc = parse_identifier(request.args.get("q", ""))

    if not isin and not assoc:
        return jsonify({"ok": False, "error":
                        "協会コードまたはISINコードを読み取れませんでした。"}), 400

    try:
        series = load_series(isin, assoc, name, force=force, kind=kind)
    except fund_data.FundDataError as e:
        return jsonify({"ok": False, "error": str(e)}), 502

    dates, prices, assets = _apply_range(series, range_key)
    if len(prices) < 5:
        return jsonify({"ok": False, "error": "分析に十分な期間のデータがありません。"}), 400

    analysis = signal_mod.analyze(dates, prices)
    stats = dict(analysis.stats)
    stats["latest_date"] = dates[-1]

    # 時間軸別の保有者向け目安は、表示期間に関係なく全履歴で判定する
    # （長期判定には200日以上の履歴が必要なため）
    horizons = signal_mod.analyze_horizons(series["dates"], series["nav"])

    return jsonify({
        "ok": True,
        "horizons": horizons,
        "fund": {"name": series["name"], "isin": series["isin"],
                 "assoc_code": series["assoc_code"], "catalog_id": int(catalog_id) if catalog_id else None},
        "indicators": analysis.indicators.__dict__,
        "net_assets": _nan_clean(assets),
        "signals": [s.__dict__ for s in analysis.signals],
        "verdict": analysis.verdict,
        "verdict_label": analysis.verdict_label,
        "score": analysis.score,
        "reasons": analysis.reasons,
        "stats": stats,
    })


# ================================================================== 設定 / AIアドバイス
# クラウドのAI（Claude）に保有状況とテクニカル指標を渡して、総合コメントを1回で生成する。
# 完全に任意の機能で、既定は "off"（AIには一切送信しない）。
try:
    import anthropic  # type: ignore
    _HAS_ANTHROPIC = True
except Exception:
    _HAS_ANTHROPIC = False

# 画面の選択肢 → 実際のモデルID
_AI_MODELS = {
    "haiku": "claude-haiku-4-5",
    "sonnet": "claude-sonnet-5",
    "opus": "claude-opus-5",
}
_AI_MODEL_KEYS = ("off",) + tuple(_AI_MODELS.keys())   # 設定で許可するキー


def _ai_api_key():
    """APIキーを取得（環境変数 ANTHROPIC_API_KEY を優先、無ければ設定に保存された値）。"""
    return (os.environ.get("ANTHROPIC_API_KEY") or db.get_setting("ai_api_key", "") or "").strip()


def _settings_state():
    model = db.get_setting("ai_model", "off") or "off"
    if model not in _AI_MODEL_KEYS:
        model = "off"
    return {
        "ai_model": model,
        "ai_available": _HAS_ANTHROPIC,            # anthropic パッケージが入っているか
        "ai_key_set": bool(_ai_api_key()),         # キーが使える状態か（値は返さない）
        "ai_key_from_env": bool(os.environ.get("ANTHROPIC_API_KEY")),
    }


@app.route("/api/settings", methods=["GET", "POST"])
def api_settings():
    if request.method == "POST":
        data = request.get_json(force=True, silent=True) or {}
        if "ai_model" in data:
            m = str(data.get("ai_model") or "off")
            db.set_setting("ai_model", m if m in _AI_MODEL_KEYS else "off")
        # APIキーは「値が来たときだけ」更新。空文字クリアも受け付ける。
        if "ai_api_key" in data:
            key = str(data.get("ai_api_key") or "").strip()
            db.set_setting("ai_api_key", key)
    return jsonify({"ok": True, **_settings_state()})


def _ai_error_message(e) -> str:
    """AI呼び出しの失敗を、原因と対処が分かる日本語にする。
    APIの生のエラー文（英語＋JSON）をそのまま出すと何をすればよいか伝わらないため。"""
    text = str(e)
    low = text.lower()
    status = getattr(e, "status_code", None)
    if "credit balance is too low" in low or "insufficient" in low:
        return ("AnthropicのAPIクレジット残高が不足しています。"
                "https://console.anthropic.com/settings/billing で"
                "クレジットを購入するか、プランをご確認ください。"
                "（アプリの設定やAPIキーの問題ではありません。AIをオフにすれば、"
                "AIコメント以外の機能はこれまでどおり使えます）")
    if status == 401 or "authentication" in low or "invalid x-api-key" in low:
        return ("APIキーが正しくないため認証できませんでした。"
                "設定画面でキーを入れ直してください（sk-ant- で始まる文字列です）。")
    if status == 403 or "permission" in low:
        return "このAPIキーには利用権限がありません。キーの発行元・権限をご確認ください。"
    if status == 404 or "not_found" in low or "model" in low and "not" in low and "found" in low:
        return ("指定のAIモデルを利用できませんでした。"
                "設定画面で別のモデル（Haiku など）に切り替えてお試しください。")
    if status == 429 or "rate limit" in low:
        return "呼び出しの回数制限に達しました。少し時間をおいてから再度お試しください。"
    if status in (500, 502, 503, 529) or "overloaded" in low:
        return "Anthropic側が混雑しています。少し時間をおいてから再度お試しください。"
    if "connection" in low or "timeout" in low or "network" in low:
        return ("Anthropicに接続できませんでした。インターネット接続をご確認のうえ、"
                "再度お試しください。")
    return f"AI呼び出しに失敗しました: {text}"


def _short_term_signal(s):
    """短期ホライズンのスコアから buy/sell/neutral を返す（±30が閾値）。"""
    for h in (s.get("hz") or []):
        if h.get("key") == "short" and h.get("ok") and h.get("score") is not None:
            sc = h["score"]
            if sc >= 30:
                return "buy", sc
            if sc <= -30:
                return "sell", sc
            return "neutral", sc
    return "neutral", None


_RANGE_LABELS = {"3m": "3ヶ月", "6m": "6ヶ月", "1y": "1年", "3y": "3年",
                 "5y": "5年", "all": "全期間"}


def _range_label(range_key):
    return _RANGE_LABELS.get(range_key or "1y", "1年")


def _build_ai_context(summaries, allocation, range_key="1y"):
    """AIに渡すコンパクトな保有状況（銘柄・指標・リバランス）を組み立てる。"""
    funds = []
    for s in summaries:
        # 売却済みは渡さない。渡すと「もう持っていないものを売れ」と言われてしまう
        if not s.get("ok") or s.get("sold_out"):
            continue
        st, st_score = _short_term_signal(s)
        funds.append({
            "watch_id": s.get("watch_id"),
            "name": s.get("name"),
            "account": s.get("account") or "",
            "asset_class": s.get("asset_class") or "",
            "verdict": s.get("verdict"),
            "score": s.get("score"),
            "short_term": st,
            "short_score": st_score,
            "value": s.get("value"),
            "invested": s.get("invested"),
            "pl_pct": s.get("pl_pct"),
            "sell_policy": s.get("sell_policy"),
            # 「変化率」は前日比と期間騰落率で桁が全く違う。名前で取り違えられないよう分ける
            "前日比_パーセント": s.get("prev_change_pct"),
            "期間騰落率_パーセント": s.get("change_pct"),
        })
    ctx = {"funds": funds, "騰落率の期間": _range_label(range_key)}
    _plan = db.get_setting("plan", {}) or {}
    _cash, _bonds = _plan.get("cash", 0) or 0, _plan.get("bonds", 0) or 0
    if _cash or _bonds:
        ctx["other_assets"] = {
            "cash": round(_cash), "bonds": round(_bonds),
            "note": "投信以外の保有資産。現金・債券は値上がりを見込まない安定資産として総資産に含めている。",
        }
    if allocation:
        ctx["allocation"] = {
            "classes": [
                {"name": c.get("name"), "current_pct": c.get("share"),
                 "target_pct": c.get("target"), "diff": c.get("diff")}
                for c in (allocation.get("classes") or [])
            ],
            "rebalance_summary": (allocation.get("plan") or {}).get("summary"),
        }
    return ctx


_AI_SYSTEM_PROMPT = (
    "あなたは日本の個人投資家の投資信託ポートフォリオを見て、保有者向けのコメントを書くアシスタントです。"
    "入力はテクニカル指標（スコアや判定）・短期シグナル・損益・前日比・期間騰落率・資産配分・リバランス計算の結果です。"
    "「前日比_パーセント」は直近2営業日の変化率、"
    "「期間騰落率_パーセント」は表示期間（騰落率の期間）ぜんぶの変化率です。"
    "桁が大きく違うので取り違えないこと。前日比として期間騰落率の数字を使ってはいけません。"
    "これらを横断的に解釈し、次のコメントをJSONで返してください。\n"
    "- trade_overall: 「売買」に絞ったポートフォリオ全体の見立て（3〜4文・220字以内）。"
    "いまの相場位置（高値圏か割安圏か・過熱感）、買い増し／利益確定／一部売却／ホールドの方針、"
    "注目すべき銘柄（過熱・割安・損益が大きい等）を具体的に述べる。リバランスや資産配分比率の話は含めない。\n"
    "- funds: 各商品の『売買』コメント（1商品につき2文・90字以内）。watch_id で必ず対応づける。"
    "スコア・判定・短期シグナル・前日比・期間騰落率・損益率・売却方針をふまえ、"
    "『買い増しを検討できる／一部利益確定を検討できる／ホールドが無難／売り時に近い』などの具体的な行動と、"
    "その根拠（価格位置・トレンド・過熱/割安・含み損益）を簡潔に述べる。銘柄ごとに内容を変え、使い回さない。\n"
    "- overall: ポートフォリオ全体の総合コメント（3文以内・150字以内）。偏り・過熱/割安・損益の傾向に触れる。"
    "other_assets（現金・債券）がある場合は、投信とのバランス（現金比率が高すぎ/低すぎ等）にも触れる。\n"
    "- rebalance: リバランスや資産配分の観点での提案（2文以内・120字以内）。現金・債券を含めた安全資産と投信の比率も考慮する。\n"
    "制約: 断定を避け『〜を検討できる水準』等の表現にする。売買を強制しない。"
    "税・手数料・分配金は考慮していない旨は trade_overall か overall で1度触れれば十分。"
    "これは機械的な参考情報であり投資助言ではありません。"
)

_AI_SCHEMA = {
    "type": "object",
    "properties": {
        "trade_overall": {"type": "string"},
        "overall": {"type": "string"},
        "rebalance": {"type": "string"},
        "funds": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "watch_id": {"type": "integer"},
                    "advice": {"type": "string"},
                },
                "required": ["watch_id", "advice"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["trade_overall", "overall", "rebalance", "funds"],
    "additionalProperties": False,
}


@app.route("/api/ai-advice")
def api_ai_advice():
    """保有状況をClaudeに1回で問い合わせ、総合・リバランス・銘柄別コメントを返す。"""
    state = _settings_state()
    model_key = state["ai_model"]
    if model_key == "off":
        return jsonify({"ok": False, "disabled": True,
                        "error": "AIアドバイスはオフです（設定画面で有効化できます）。"})
    if not _HAS_ANTHROPIC:
        return jsonify({"ok": False, "error":
                        "anthropic パッケージが未インストールです。`pip install anthropic` を実行してください。"})
    key = _ai_api_key()
    if not key:
        return jsonify({"ok": False, "error":
                        "APIキーが未設定です。設定画面で入力するか、環境変数 ANTHROPIC_API_KEY を設定してください。"})

    range_key = request.args.get("range", "1y")
    summaries = _build_summaries(range_key, force=False)
    allocation = _build_allocation(summaries)
    ctx = _build_ai_context(summaries, allocation, range_key)
    if not ctx["funds"]:
        return jsonify({"ok": False, "error": "分析できる保有商品がありません。"})

    model_id = _AI_MODELS[model_key]
    try:
        client = anthropic.Anthropic(api_key=key)
        resp = client.messages.create(
            model=model_id,
            max_tokens=12000,   # 日本語＋多数の銘柄でも途中で切れないよう十分な上限
            system=[{"type": "text", "text": _AI_SYSTEM_PROMPT,
                     "cache_control": {"type": "ephemeral"}}],
            messages=[{"role": "user", "content":
                       "次の保有状況にコメントしてください。\n" + json.dumps(ctx, ensure_ascii=False)}],
            output_config={"format": {"type": "json_schema", "schema": _AI_SCHEMA}},
        )
        text = next((b.text for b in resp.content if getattr(b, "type", None) == "text"), "")
        stop = getattr(resp, "stop_reason", None)
        try:
            data = json.loads(text) if text else {}
        except json.JSONDecodeError:
            if stop == "max_tokens":
                return jsonify({"ok": False, "error":
                                "AIの応答が長すぎて途中で切れました。もう一度お試しください"
                                "（改善しない場合はHaikuモデルでお試しください）。"}), 502
            return jsonify({"ok": False, "error":
                            "AIの応答を解釈できませんでした。もう一度お試しください。"}), 502
    except Exception as e:
        return jsonify({"ok": False, "error": _ai_error_message(e)}), 502

    return jsonify({"ok": True, "model": model_key, "advice": data})


_AI_STRATEGY_PROMPT = (
    "あなたは日本の個人投資家の「退職後の取り崩し計画」を見て、方針を助言するアシスタントです。\n"
    "入力は、その人の前提（年齢・退職・年金・生活費・インフレ・想定年利）と、"
    "アプリが計算した試算結果です。試算は月次のシミュレーションで、"
    "取り崩し方法（定額／定率／ガードレール）ごとの資産寿命と、"
    "値動きのブレを乱数で入れたモンテカルロの結果（100歳まで尽きない確率・"
    "100歳時点の中央値と下位10%）、決め打ちの暴落シナリオを含みます。\n"
    "1銘柄に集中している場合は、その銘柄を売って分散資産に買い替える案も含まれます"
    "（売ると譲渡益に約20.315%課税されるため、ブレの無い計算では必ず持ち続けたほうが有利になります。"
    "差が出るのは値動きのブレを入れたときです）。\n\n"
    "重要：methods と 残す割合ごとの結果 には、選べる案が横並びで入っています。"
    "「いまの設定」「設定中」のフラグは、どれが現在の設定かを示すだけの情報です。"
    "現在の設定だからという理由でそれを勧めてはいけません。"
    "必ず全部の案の数字を見比べ、最も良いと判断した案を選んでください"
    "（結果として現在の設定と同じになるのは構いません）。"
    "利用者が設定を変えても、同じ数字を見ているかぎり結論は同じになるはずです。\n"
    "判断の軸：資産が尽きない確率を最優先し、次に下振れたとき（下位10%）の資産、"
    "次に生活費の下限が落ちないこと。100歳時点の中央値の大きさは最後に見ます"
    "（使い切れずに残す額を増やすことが目的ではないため）。\n\n"
    "次をJSONで返してください。\n"
    "- recommendation: 一番よいと思う方針を、取り崩し方法と集中銘柄の扱いの両方について"
    "言い切る（2〜3文・180字以内）。数字の根拠を1つは入れる。"
    "現在の設定と違う場合は、どこをどう変えるかを明示する。\n"
    "- why: そう考える理由（3〜4項目・各60字以内）。試算の数字を引用する。\n"
    "- tradeoff: 逆の選択をした場合に何を得て何を失うかを説明する（2〜3文・160字以内）。\n"
    "- watch: 見落としやすい注意点（2〜3項目・各60字以内）。"
    "勤務先の株なら給与・退職金も同じ会社に依存する点、"
    "モンテカルロは正規分布なので現実の暴落を過小評価しがちな点など。\n\n"
    "守ること：断定的な将来予測をしない。"
    "特定の銘柄の買い推奨をしない。数字はすべて入力にあるものだけを使い、自分で作らない。"
    "「投資助言ではない」と毎項目に書く必要はない（画面に注記がある）。"
    "日本語で、専門用語には短い言い換えを添える。"
)

_AI_STRATEGY_SCHEMA = {
    "type": "object",
    "properties": {
        "recommendation": {"type": "string"},
        "why": {"type": "array", "items": {"type": "string"}},
        "tradeoff": {"type": "string"},
        "watch": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["recommendation", "why", "tradeoff", "watch"],
    "additionalProperties": False,
}


@app.route("/api/ai-strategy", methods=["POST"])
def api_ai_strategy():
    """画面で計算した取り崩しの試算結果をClaudeに渡し、方針の助言を返す。

    試算そのものはブラウザ側（同じ月次シミュレーション）で行い、ここは要約を渡すだけ。
    サーバで計算し直すと画面の数字とずれるため、あえて受け取る形にしている。
    """
    state = _settings_state()
    model_key = state["ai_model"]
    if model_key == "off":
        return jsonify({"ok": False, "disabled": True,
                        "error": "AIアドバイスはオフです（設定画面で有効化できます）。"})
    if not _HAS_ANTHROPIC:
        return jsonify({"ok": False, "error":
                        "anthropic パッケージが未インストールです。`pip install anthropic` を実行してください。"})
    key = _ai_api_key()
    if not key:
        return jsonify({"ok": False, "error":
                        "APIキーが未設定です。設定画面で入力するか、環境変数 ANTHROPIC_API_KEY を設定してください。"})

    ctx = request.get_json(force=True, silent=True) or {}
    if not ctx.get("methods"):
        return jsonify({"ok": False, "error": "試算結果がありません。先に「再計算」を実行してください。"})

    try:
        client = anthropic.Anthropic(api_key=key)
        resp = client.messages.create(
            model=_AI_MODELS[model_key],
            max_tokens=4000,
            system=[{"type": "text", "text": _AI_STRATEGY_PROMPT,
                     "cache_control": {"type": "ephemeral"}}],
            messages=[{"role": "user", "content":
                       "次の取り崩し計画の試算結果をもとに助言してください。\n"
                       + json.dumps(ctx, ensure_ascii=False)}],
            output_config={"format": {"type": "json_schema", "schema": _AI_STRATEGY_SCHEMA}},
        )
        text = next((b.text for b in resp.content if getattr(b, "type", None) == "text"), "")
        data = json.loads(text) if text else {}
    except json.JSONDecodeError:
        return jsonify({"ok": False, "error":
                        "AIの応答を解釈できませんでした。もう一度お試しください。"}), 502
    except Exception as e:
        return jsonify({"ok": False, "error": _ai_error_message(e)}), 502

    return jsonify({"ok": True, "model": model_key, "advice": data})


# ================================================================== 資産プラン
def _dividend_effective_mode(s, annual):
    """分配金の受け取り方を確定する。手動設定が無ければ自動判定：
    特定口座で分配実績があれば「受取」、それ以外（NISA・無分配）は「再投資」。
    （NISAは自動再投資、無分配インデックスは分配自体が無いため）。"""
    raw = s.get("dividend_mode") or ""
    if raw in ("receive", "reinvest"):
        return raw
    is_taxable = (s.get("account_type") != "nisa")
    return "receive" if (is_taxable and annual > 0) else "reinvest"


def _build_dividends(summaries, base_tax):
    """保有中の分配金/配当（現在保有ベース・年額）を集計する。
    base_tax は利益への税率（小数）。受取分の税引後額と、グラフ用の利回りを返す。"""
    items = []
    total_value = sum((s.get("value") or 0) for s in summaries if s.get("ok"))
    recv_gross = recv_net = reinvest_total = tax_total = 0.0
    recv_value = 0.0     # 「受取」に設定した分配金あり商品の評価額（取り崩さずに維持する）
    for s in summaries:
        # 売却済みはもう受け取らないので、分配金の一覧にも載せない
        if not s.get("ok") or s.get("sold_out"):
            continue
        val = s.get("value") or 0
        dy = s.get("div_yield") or 0
        annual = round(dy * val)
        eff = _dividend_effective_mode(s, annual)
        is_taxable = (s.get("account_type") != "nisa")
        # 分配金への課税：特定口座の普通分配金は税率どおり、NISAは非課税
        after_tax = round(annual * (1 - base_tax)) if is_taxable else annual
        if annual > 0 and eff == "receive":
            recv_gross += annual
            recv_net += after_tax
            tax_total += (annual - after_tax)
            recv_value += val
        elif annual > 0:
            reinvest_total += annual
        items.append({
            "watch_id": s.get("watch_id"), "name": s.get("name"),
            "broker": s.get("broker") or "", "account": s.get("account") or "",
            "kind": s.get("kind") or "fund",
            "account_type": s.get("account_type") or "taxable",
            "value": round(val), "div_ttm": s.get("div_ttm") or 0,
            "latest_price": s.get("latest_price"),
            "yield": round(dy * 100, 2), "annual": annual,
            "after_tax": after_tax if annual > 0 else 0,
            "mode_raw": s.get("dividend_mode") or "",
            "mode": eff, "taxable": is_taxable,
        })
    # 資産推移グラフ用の利回り（運用資産全体に対する年率）。分配金あり/なしを区別せず
    # 全体を取り崩し対象とするため、全体の評価額に対する率で返す。
    gy = (recv_gross / total_value) if total_value > 0 else 0.0
    ny = (recv_net / total_value) if total_value > 0 else 0.0
    return {
        "items": items,
        "receive_gross": round(recv_gross), "receive_net": round(recv_net),
        "reinvest_total": round(reinvest_total), "tax": round(tax_total),
        "receive_value": round(recv_value),   # 分配金を生む商品の評価額（参考）
        "receive_gross_yield": round(gy, 6), "receive_net_yield": round(ny, 6),
        "base_tax": round(base_tax, 5),
    }


@app.route("/api/watchlist/dividend-mode", methods=["POST"])
def api_watchlist_dividend_mode():
    """分配金の受け取り方を設定する（receive=受取 / reinvest=再投資 / 空=自動判定）。"""
    data = request.get_json(silent=True) or {}
    watch_id = data.get("watch_id")
    if watch_id is None:
        return jsonify({"ok": False, "error": "watch_id が必要です。"}), 400
    saved = db.set_dividend_mode(int(watch_id), data.get("mode") or "")
    return jsonify({"ok": True, "mode": saved})


# 積立シミュレーション・分配金・目標(FIRE)進捗のための設定と現況を返す。
@app.route("/api/withdraw-plan", methods=["POST"])
def api_withdraw_plan():
    """「今年の取り崩し指示書」：売る必要のある金額を、どの保有からいくら売るかに割り当てる。

    試算（取り崩し戦略）は資産をひとかたまりで扱うが、実際に売るときは
    「どの口座のどの商品を、いくら」まで決める必要がある。同じ画面の中で
    迷わないよう、リバランスと同じ売却ルールで割り当てる：

      1. NISAは温存し、課税される特定口座から先に売る
      2. 「売却不可」の保有は売らない。「一部売却可」は評価額の50%まで
      3. 同じ口座の中では 売り時（高値圏）→ 中立 → 安値圏 の順に売る
      4. 譲渡益税は「売却額 × 含み益の割合 × 税率」で概算する（特定口座のみ）
    """
    data = request.get_json(silent=True) or {}
    try:
        amount = max(0.0, float(data.get("amount") or 0))
    except (TypeError, ValueError):
        return jsonify({"ok": False, "error": "金額は数値で指定してください。"}), 400

    plan = db.get_setting("plan", {}) or {}
    t_rate = (plan.get("tax") if plan.get("tax") is not None else 20.315) / 100.0
    summaries = [s for s in _build_summaries("1y", force=False)
                 if s.get("ok") and not s.get("sold_out") and (s.get("value") or 0) > 0]

    excluded, cands = [], []
    for s in summaries:
        policy = s.get("sell_policy") or "full"
        val = float(s.get("value") or 0)
        if policy == "locked":
            excluded.append({"watch_id": s["watch_id"], "name": s.get("name") or "",
                             "broker": s.get("broker") or "", "value": round(val),
                             "reason": "🔒 売却不可に設定されています"})
            continue
        cap = PARTIAL_SELL_RATIO if policy == "partial" else 1.0
        ts = _timing_score(s)
        timing, timing_label = _sell_timing(ts)
        inv = float(s.get("invested") or 0)
        gain_ratio = max(0.0, min(1.0, (val - inv) / val)) if val > 0 else 0.0
        cands.append({
            "watch_id": s["watch_id"], "name": s.get("name") or "",
            "broker": s.get("broker") or "", "account_type": s.get("account_type") or "taxable",
            "kind": s.get("kind") or "fund", "value": val, "invested": inv,
            "sellable": val * cap, "policy": policy,
            "gain_ratio": gain_ratio, "timing": timing, "timing_label": timing_label,
            "ts": ts,
        })

    # NISA温存：特定口座を先に、同じ口座では売り時（tsが小さい＝過熱）から売る
    order = {"good": 0, "neutral": 1, "bad": 2}
    cands.sort(key=lambda c: (0 if c["account_type"] != "nisa" else 1,
                              order.get(c["timing"], 1), -c["value"]))

    left = amount
    rows = []
    for c in cands:
        if left <= 0:
            break
        take = min(c["sellable"], left)
        if take <= 0:
            continue
        left -= take
        gain = take * c["gain_ratio"]
        tax = 0.0 if c["account_type"] == "nisa" else gain * t_rate
        rows.append({
            "watch_id": c["watch_id"], "name": c["name"], "broker": c["broker"],
            "account_type": c["account_type"], "kind": c["kind"],
            "sell": round(take), "value": round(c["value"]), "invested": round(c["invested"]),
            "gain": round(gain), "tax": round(tax), "net": round(take - tax),
            "after": round(c["value"] - take), "policy": c["policy"],
            "timing": c["timing"], "timing_label": c["timing_label"],
            "gain_pct": round(c["gain_ratio"] * 100, 1),
        })

    tax_total = sum(r["tax"] for r in rows)
    return jsonify({"ok": True, "amount": round(amount),
                    "rows": rows, "excluded": excluded,
                    "sell_total": round(sum(r["sell"] for r in rows)),
                    "tax_total": round(tax_total),
                    "net_total": round(sum(r["net"] for r in rows)),
                    "short": round(max(0.0, left)),
                    "tax_rate": round(t_rate * 100, 3),
                    "nisa_used": round(sum(r["sell"] for r in rows
                                           if r["account_type"] == "nisa"))})


@app.route("/api/plan", methods=["GET", "POST"])
def api_plan():
    if request.method == "POST":
        data = request.get_json(force=True, silent=True) or {}
        plan = db.get_setting("plan", {}) or {}
        for k in ("goal", "monthly", "return_rate",
                  "current_age", "retire_age", "pension_age",
                  "pension_monthly", "spend_monthly", "inflation",
                  "cash", "bonds", "tax", "emergency_months", "near_term",
                  "draw_rate", "conc_keep",
                  # ガードレール運用の記録：基準の引出率(%)と、いま採用している生活費(月額)
                  "guard_base_rate", "guard_spend",
                  # 年金の改定はインフレより抑えられる（マクロ経済スライド）
                  "pension_slide",
                  # 退職一時金（受け取る年齢・金額）と企業年金（開始年齢・月額・受給年数）
                  "lump_age", "lump_amount",
                  "corp_pension_age", "corp_pension_monthly", "corp_pension_years"):
            if k in data:
                try:
                    plan[k] = float(data.get(k) or 0)
                except (TypeError, ValueError):
                    plan[k] = 0
        # 取り崩し方法は数値ではなく種別（定額／定率／ガードレール）
        if "draw_method" in data:
            m = str(data.get("draw_method") or "fixed")
            plan["draw_method"] = m if m in ("fixed", "percent", "guardrail") else "fixed"
        # 前回いつ見直したか（YYYY-MM）。年1回の見直しを促すために持つ
        if "guard_checked" in data:
            plan["guard_checked"] = str(data.get("guard_checked") or "")[:7]
        db.set_setting("plan", plan)
        return jsonify({"ok": True})

    summaries = _build_summaries(request.args.get("range", "1y"), force=False)
    holdings, total_value, total_invested = [], 0, 0
    nisa_value, nisa_invested, taxable_value, taxable_invested = 0, 0, 0, 0
    for s in summaries:
        if not s.get("ok"):
            continue
        val = s.get("value") or 0
        inv = s.get("invested") or 0
        is_nisa = (s.get("account_type") == "nisa")
        holdings.append({
            "watch_id": s["watch_id"], "name": s.get("name"),
            "account": s.get("account") or "", "broker": s.get("broker") or "",
            "value": round(val), "account_type": s.get("account_type") or "taxable",
            # 「今年の取り崩し指示書」で、どれをいくら売るか・概算税を出すために使う
            "invested": round(inv), "sell_policy": s.get("sell_policy") or "full",
            "kind": s.get("kind") or "fund", "score": s.get("score"),
            "verdict": s.get("verdict") or "",
        })
        total_value += val
        total_invested += inv
        if is_nisa:
            nisa_value += val; nisa_invested += inv
        else:
            taxable_value += val; taxable_invested += inv
    plan = db.get_setting("plan", {}) or {}
    base_tax = (plan.get("tax") if plan.get("tax") is not None else 20.315) / 100.0
    dividends = _build_dividends(summaries, base_tax)
    return jsonify({"ok": True, "total_value": round(total_value),
                    "total_invested": round(total_invested),
                    "nisa_value": round(nisa_value), "nisa_invested": round(nisa_invested),
                    "taxable_value": round(taxable_value), "taxable_invested": round(taxable_invested),
                    "holdings": holdings, "plan": plan, "dividends": dividends})


_AI_PLAN_PROMPT = (
    "あなたは投資信託ポートフォリオの資産形成と、リタイア後の取り崩し（資産寿命）を見立てるアシスタントです。"
    "入力の資産配分・保有商品・ライフプラン前提（年齢・退職・年金・生活費・インフレ率・資産寿命の試算結果）を踏まえ、"
    "次をJSONで返してください。\n"
    "- base_return / optimistic_return / pessimistic_return: 長期(10年以上)の現実的な年率リターン%（標準/楽観/悲観、数値）。"
    "過度に楽観的にせず、株式インデックスの長期実績（年率おおむね数%〜7%程度）や分散状況を踏まえる。\n"
    "- comment_growth: 資産形成・目標達成の見通しコメント（日本語2〜3文）。\n"
    "- comment_drawdown: リタイア後の取り崩し戦略のコメント（資産寿命・年金とのバランス・インフレ・注意点や工夫）を日本語2〜3文。"
    "前提が未設定なら、設定を促す一言でよい。\n"
    "現金(cash)・債券(bonds)がある場合は、それらを含めた総資産(current_total)で見立て、"
    "退職〜年金開始までの取り崩しに現金・債券のクッションをどう使うか等にも触れてください。"
    "現金・債券は値上がりを見込まない安定資産である点に留意する。\n"
    "年金は pension_growth_pct（＝インフレ率−マクロ経済スライド）の率でしか増えません。"
    "物価上昇に追いつかず実質的に目減りする点を踏まえてください。\n"
    "dividend_income_after_tax_yearly（受取に設定した分配金・配当の税引後の年間キャッシュ収入）が"
    "ある場合は、取り崩し期にこのインカムが売却額を軽減する点に comment_drawdown で触れてください。\n"
    "これは機械的な参考情報であり、将来を保証する投資助言ではありません。"
)

_AI_PLAN_SCHEMA = {
    "type": "object",
    "properties": {
        "base_return": {"type": "number"},
        "optimistic_return": {"type": "number"},
        "pessimistic_return": {"type": "number"},
        "comment_growth": {"type": "string"},
        "comment_drawdown": {"type": "string"},
    },
    "required": ["base_return", "optimistic_return", "pessimistic_return",
                 "comment_growth", "comment_drawdown"],
    "additionalProperties": False,
}


@app.route("/api/ai-plan")
def api_ai_plan():
    """AIにポートフォリオの長期期待リターン（標準/楽観/悲観）を見積もらせる。"""
    state = _settings_state()
    if state["ai_model"] == "off":
        return jsonify({"ok": False, "disabled": True,
                        "error": "AIはオフです（設定画面で有効化できます）。"})
    if not _HAS_ANTHROPIC:
        return jsonify({"ok": False, "error":
                        "anthropic パッケージが未インストールです。`pip install anthropic` を実行してください。"})
    key = _ai_api_key()
    if not key:
        return jsonify({"ok": False, "error": "APIキーが未設定です。設定画面で入力してください。"})

    summaries = _build_summaries(request.args.get("range", "1y"), force=False)
    allocation = _build_allocation(summaries)
    plan = db.get_setting("plan", {}) or {}
    _fund_total = round(sum((s.get("value") or 0) for s in summaries if s.get("ok")))
    _cash, _bonds = round(plan.get("cash", 0) or 0), round(plan.get("bonds", 0) or 0)
    _base_tax = (plan.get("tax") if plan.get("tax") is not None else 20.315) / 100.0
    _div = _build_dividends(summaries, _base_tax)
    ctx = {
        "current_fund_value": _fund_total,
        "cash": _cash,
        "bonds": _bonds,
        "current_total": _fund_total + _cash + _bonds,   # 投信＋現金＋債券
        # 「受取」に設定した分配金・配当の税引後キャッシュ収入（年・現在保有ベース）。
        # 取り崩し期に売却額を軽減する。再投資分は運用資産に留まる想定。
        "dividend_income_after_tax_yearly": _div.get("receive_net", 0),
        "dividend_reinvested_yearly": _div.get("reinvest_total", 0),
        "goal": plan.get("goal", 0),
        "monthly_contribution": plan.get("monthly", 0),
        "life_plan": {
            "current_age": plan.get("current_age", 0),
            "retire_age": plan.get("retire_age", 0),
            "pension_start_age": plan.get("pension_age", 0),
            "pension_monthly": plan.get("pension_monthly", 0),
            "spend_monthly": plan.get("spend_monthly", 0),
            "inflation_pct": plan.get("inflation", 0),
            # 年金はマクロ経済スライドで物価上昇をそのまま反映しない。
            # 渡さないと「年金は物価どおり増える」前提でコメントされてしまう。
            "pension_slide_pct": (plan.get("pension_slide")
                                  if plan.get("pension_slide") is not None else 0.4),
            "pension_growth_pct": round(max(0.0, (plan.get("inflation") or 0)
                                            - (plan.get("pension_slide")
                                               if plan.get("pension_slide") is not None
                                               else 0.4)), 2),
        },
        "allocation": [{"name": c.get("name"), "current_pct": c.get("share")}
                       for c in ((allocation or {}).get("classes") or []) if c.get("share")],
    }
    model_id = _AI_MODELS[state["ai_model"]]
    try:
        client = anthropic.Anthropic(api_key=key)
        resp = client.messages.create(
            model=model_id, max_tokens=1500,
            system=[{"type": "text", "text": _AI_PLAN_PROMPT,
                     "cache_control": {"type": "ephemeral"}}],
            messages=[{"role": "user", "content":
                       "次のポートフォリオの長期期待リターンを見積もってください。\n"
                       + json.dumps(ctx, ensure_ascii=False)}],
            output_config={"format": {"type": "json_schema", "schema": _AI_PLAN_SCHEMA}},
        )
        text = next((b.text for b in resp.content if getattr(b, "type", None) == "text"), "")
        data = json.loads(text) if text else {}
    except Exception as e:
        return jsonify({"ok": False, "error": _ai_error_message(e)}), 502
    return jsonify({"ok": True, "model": state["ai_model"], "prediction": data})


# ================================================================== バックアップ
@app.route("/api/export")
def api_export():
    """登録内容（商品・保有・評価額履歴・設定）をJSONファイルとしてダウンロードさせる。
    価格キャッシュは再取得できるので含めない。設定はAPIキーも含めてそのまま復元できる
    ようにしているため、書き出したファイルの取り扱いには注意が必要（画面にも明記）。"""
    data = db.export_data()
    body = json.dumps(data, ensure_ascii=False, indent=1)
    fname = "fund-timing-backup-" + dt.date.today().strftime("%Y%m%d") + ".json"
    return Response(body, mimetype="application/json; charset=utf-8",
                    headers={"Content-Disposition": f'attachment; filename="{fname}"'})


@app.route("/api/import", methods=["POST"])
def api_import():
    """バックアップJSONから復元する（保有・評価額履歴は全置き換え）。"""
    data = request.get_json(force=True, silent=True)
    if data is None:
        return jsonify({"ok": False, "error": "JSONを読み取れませんでした。"}), 400
    try:
        counts = db.import_data(data)
    except ValueError as e:
        return jsonify({"ok": False, "error": str(e)}), 400
    return jsonify({"ok": True, "counts": counts,
                    "exported_at": data.get("exported_at", "")})


# ------------------------------------------------------------------ 起動
def _port_is_free(port, host="127.0.0.1"):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            s.bind((host, port))
            return True
        except OSError:
            return False


def _find_free_port(preferred, host="127.0.0.1"):
    """preferred が空いていればそれを、ダメなら別の空きポートを返す。

    macOSでは 5000 を AirPlay 受信機能が使うため、既定は 8765 にしている。
    """
    if _port_is_free(preferred, host):
        return preferred
    # 近くの候補をいくつか試す
    for p in (preferred + 1, preferred + 2, 8000, 8080, 8888, 3000):
        if _port_is_free(p, host):
            return p
    # 最後はOSに空きポートを割り当ててもらう
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind((host, 0))
        return s.getsockname()[1]


def _lan_ip():
    """このMacのLAN内IPアドレスを推定する（外部へは通信しない）。"""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except Exception:
        return None
    finally:
        s.close()


def _open_when_ready(url, host, port, timeout=20.0):
    """サーバが接続を受け付けられるようになってからブラウザを開く。"""
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with socket.create_connection((host, port), timeout=1.0):
                break
        except OSError:
            time.sleep(0.3)
    try:
        webbrowser.open(url)
    except Exception:
        pass


def _run_check(codes):
    """指定コードで実際にデータ取得を試し、サイトの応答内容を表示する診断ツール。"""
    import requests

    # 個別株ティッカー（例: 6501.JP / 6501.T）なら株価の診断
    m = re.fullmatch(r"(\d{4})\.(JP|T)", codes.strip().upper())
    if m:
        ticker = m.group(1) + ".JP"
        print("=" * 56)
        print(f"診断: 個別株の株価取得テスト（{ticker}）")
        print("=" * 56)
        for label, fetcher in (("Stooq", fund_data._fetch_stock_stooq),
                               ("yfinance", fund_data._fetch_stock_yfinance),
                               ("Yahoo", fund_data._fetch_stock_yahoo)):
            try:
                rows = fetcher(ticker)
                print(f"[{label}] OK: {len(rows)}件（{rows[0][0]} 〜 {rows[-1][0]}） "
                      f"最新終値 {rows[-1][1]}")
            except Exception as e:
                print(f"[{label}] エラー: {e}")
        print("=" * 56)
        print("この出力をそのままコピーして共有してください。")
        return

    isin, assoc = parse_identifier(codes)
    print("=" * 56)
    print("診断: データ取得テスト")
    print(f"  入力: {codes}")
    print(f"  ISIN     : {isin}")
    print(f"  協会コード : {assoc}")
    print("=" * 56)
    params = {}
    if isin:
        params["isinCd"] = isin
    if assoc:
        params["associFundCd"] = assoc

    sess = requests.Session()
    sess.headers.update(fund_data._BROWSER_HEADERS)
    try:
        d = sess.get(fund_data.DETAIL_URL, params=params, timeout=30)
        print(f"[1] 詳細ページ: HTTP {d.status_code}  {d.headers.get('content-type','')}"
              f"  {len(d.content)} bytes")
    except Exception as e:
        print(f"[1] 詳細ページ: 例外 {e}")

    try:
        r = sess.get(fund_data.CSV_URL, params=params, timeout=30,
                     headers={"Referer": fund_data.DETAIL_URL,
                              "Accept": "text/csv,application/csv,text/plain,*/*"})
        print(f"[2] CSV取得  : HTTP {r.status_code}  {r.headers.get('content-type','')}"
              f"  {len(r.content)} bytes")
        r.encoding = "cp932"
        text = r.text or ""
        print("---- 応答の先頭400文字 ----")
        print(text[:400])
        print("---------------------------")
        if "," in text and not text.lstrip()[:1] == "<":
            try:
                series = fund_data.parse_csv(text, isin or "", assoc or "", "")
                print(f"[3] 解析OK: {len(series.dates)}件 "
                      f"（{series.dates[0]} 〜 {series.dates[-1]}）")
            except Exception as e:
                print(f"[3] 解析エラー: {e}")
        else:
            print("[3] CSVらしいデータではありません（上の先頭400文字を確認してください）。")
    except Exception as e:
        print(f"[2] CSV取得: 例外 {e}")
    print("=" * 56)
    print("この出力をそのままコピーして共有してください。")


def main():
    global DEMO_MODE
    parser = argparse.ArgumentParser(description="投資信託 売り時・買い時サイン アプリ")
    parser.add_argument("--demo", action="store_true", help="ダミーデータで起動（ネット不要）")
    parser.add_argument("--port", type=int, default=8765,
                        help="ポート番号（既定: 8765。使用中なら自動で別のポートを探します）")
    parser.add_argument("--no-browser", action="store_true", help="ブラウザを自動で開かない")
    parser.add_argument("--db", default=None, help="内部DBファイルのパス（既定: funds.db）")
    parser.add_argument("--lan", action="store_true",
                        help="同じWi-Fi内の他端末（スマホ等）からもアクセスできるようにする")
    parser.add_argument("--check", metavar="ISIN,協会コード",
                        help="診断: 指定コードで実際の取得を試し、サイトの応答を表示する")
    args = parser.parse_args()

    if args.check:
        _run_check(args.check)
        return

    if args.db:
        db.DB_PATH = args.db
    if args.demo:
        DEMO_MODE = True
        import demo_data
        fund_data.set_fetch_override(demo_data.demo_csv)
        fund_data.set_stock_override(demo_data.demo_stock_csv)
        fund_data.set_stock_dividend_override(demo_data.demo_stock_dividends)
        if not args.db:
            db.DB_PATH = db.os.path.join(db.os.path.dirname(db.DB_PATH), "funds.demo.db")

    db.init_db()

    if args.demo:
        db.clear_cache()  # デモは毎回新しいダミーで（テーブル作成後に実行）
        print(f"[demo] ダミーデータで起動します（DB: {db.DB_PATH}）")
    else:
        print(f"設定・登録の保存先（内部DB）: {db.DB_PATH}")
        print("　※ この場所に保存されるため、アプリのフォルダを入れ替えても引き継がれます。")

    # --lan 指定時は全インターフェイスで待ち受け、他端末からアクセス可能にする
    bind_host = "0.0.0.0" if args.lan else "127.0.0.1"
    port = _find_free_port(args.port, bind_host)
    local_url = f"http://127.0.0.1:{port}"

    if port != args.port:
        print(f"ポート {args.port} は使用中のため、{port} で起動します"
              "（macOSではポート5000はAirPlayが使用します）。")
    print(f"投資信託サインアプリを起動しました → {local_url}")
    if args.lan:
        ip = _lan_ip()
        if ip:
            print("─" * 48)
            print("📱 他の端末（同じWi-Fi）からは次のURLを開いてください：")
            print(f"    http://{ip}:{port}")
            print("─" * 48)
            print("※ 同じWi-Fi/LANに接続している必要があります。")
            print("※ このURLを知っている同一ネットワーク内の端末は誰でも閲覧できます。")
        else:
            print("LAN内のIPアドレスを取得できませんでした。ネットワーク接続を確認してください。")
    else:
        print("（他の端末からアクセスするには、いったん終了して `--lan` を付けて起動してください）")
    print("ブラウザが自動で開かない場合は、上のURLをブラウザに貼り付けてください。")
    print("終了するには Ctrl+C を押してください。")
    if not args.no_browser:
        threading.Thread(target=_open_when_ready, args=(local_url, "127.0.0.1", port), daemon=True).start()
    # 起動時に最新の基準価額を強制取得し、当日分を表・グラフ・評価額へ反映（非ブロッキング）
    threading.Thread(target=_startup_price_refresh, daemon=True).start()
    # threaded=True: AIアドバイスや価格取得など時間のかかる処理の実行中でも
    # 他の操作（画面遷移・更新）をブロックしないよう複数リクエストを並行処理する
    app.run(host=bind_host, port=port, debug=False, threaded=True)


if __name__ == "__main__":
    main()
