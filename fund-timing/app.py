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


def load_series(isin: str, assoc: str, name: str = "", force: bool = False,
                kind: str = "fund") -> dict:
    """価格シリーズをdictで返す。内部DBのキャッシュを使い、無ければ取得して保存。

    kind="fund" は投信協会CSV（基準価額）、kind="stock" は株価（Stooq→Yahoo）。
    取得失敗は10分間キャッシュし、画面更新のたびに再アクセスして
    データ源の回数制限を消費しないようにする（「最新に更新」なら再試行）。
    """
    isin = (isin or "").strip().upper()
    assoc = (assoc or "").strip()
    key = (isin, assoc)
    if not force:
        cached = db.get_cached_series(isin, assoc)
        if cached:
            if name and not cached.get("name"):
                cached["name"] = name
            return cached
        failed = _fail_cache.get(key)
        if failed and (time.time() - failed[0]) < _FAIL_TTL_SEC:
            raise fund_data.FundDataError(failed[1])
    try:
        if kind == "stock":
            series = fund_data.get_stock_series(isin, name)
        else:
            series = fund_data.get_fund_series(isin, assoc, name)
    except fund_data.FundDataError as e:
        _fail_cache[key] = (time.time(), str(e))
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
    watched = {w["id"] for w in db.list_watchlist()}
    for r in results:
        r["watched"] = r["id"] in watched
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
    added = db.add_watch(int(catalog_id), broker=(data.get("broker") or ""))
    return jsonify({"ok": True, "added": added})


@app.route("/api/watchlist", methods=["DELETE"])
def api_watchlist_remove():
    data = request.get_json(silent=True) or {}
    watch_id = data.get("watch_id")
    if watch_id is None:
        return jsonify({"ok": False, "error": "watch_id が必要です。"}), 400
    db.remove_watch(int(watch_id))
    return jsonify({"ok": True})


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
        # 時間軸別スコア（ポートフォリオ全体判定用・全履歴で計算）
        hz_full = signal_mod.analyze_horizons(series["dates"], series["nav"])
        hz = [{"key": h["key"], "ok": h["ok"], "score": h.get("score")} for h in hz_full]
        summary.update({
            "ok": True,
            "verdict": a.verdict,
            "verdict_label": a.verdict_label,
            "score": a.score,
            "latest_price": a.stats.get("latest_price"),
            "latest_date": dates[-1],
            "rsi": a.stats.get("rsi"),
            "deviation_pct": a.stats.get("deviation_pct"),
            "uptrend": (a.stats.get("sma_short") or 0) >= (a.stats.get("sma_long") or 0),
            "change_pct": change,
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
    import seed_funds
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
    import seed_funds
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
    import seed_funds
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
    watched = {w["id"] for w in db.list_watchlist()}
    items = []
    for r in db.list_catalog():
        items.append({
            "id": r["id"], "name": r["name"], "isin": r["isin"],
            "category": r.get("category", ""),
            "asset_class": r.get("asset_class", "") or "",
            "kind": r.get("kind", "fund") or "fund",
            "watched": r["id"] in watched,
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
    """保有口数を登録する。"""
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
    saved = db.set_units(int(watch_id), units)
    return jsonify({"ok": True, "units": saved})


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


# 起動時の価格スナップショット（このセッション中は固定）。(isin, assoc) -> series dict
_price_snapshot: dict = {}


def _snapshot_series(isin, assoc, name, kind):
    """価格シリーズを取得し、セッション内で固定（起動タイミングの価格を保持）。"""
    key = (isin, assoc)
    if key in _price_snapshot:
        return _price_snapshot[key]
    series = load_series(isin, assoc, name, kind=kind)   # DBキャッシュ経由
    _price_snapshot[key] = series
    return series


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
            continue   # 取得失敗は既存キャッシュのまま
        _price_snapshot[(isin, assoc)] = series   # セッション固定値も最新に
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


@app.route("/api/price-history")
def api_price_history():
    """各保有について、時系列の「評価額 ÷ 投資金額」比率(％)を返す。
    価格の水準差を吸収して比較しやすいよう、投資金額を基準(100%)に正規化する。
    価格は起動時（初回取得時）のスナップショットを保持する。"""
    range_key = request.args.get("range", "1y")
    holdings, skipped = [], []
    for it in db.list_watchlist():
        name = it["name"]
        units = float(it.get("units") or 0)
        invested = float(it.get("invested") or 0)
        broker = it.get("broker") or ""
        label = name + (f"（{broker}）" if broker else "")
        if units <= 0 or invested <= 0:
            skipped.append({"name": name, "broker": broker,
                            "need_units": units <= 0, "need_invested": invested <= 0})
            continue
        kind = it.get("kind", "fund") or "fund"
        try:
            series = _snapshot_series(it["isin"], it["assoc_code"], name, kind)
            dates, prices, _ = _apply_range(series, range_key)
            pts = [(d, p) for d, p in zip(dates, prices) if p is not None]
            if len(pts) < 2:
                raise fund_data.FundDataError("データが不足しています")
            # 評価額(t) = 投信: 基準価額×口数÷10000 / 株: 株価×株数
            div = 10000.0 if kind != "stock" else 1.0
            out_dates = [d for d, _ in pts]
            ratio = [round((p * units / div) / invested * 100, 2) for _, p in pts]
            value_now = round(pts[-1][1] * units / div)
            holdings.append({
                "watch_id": it["watch_id"], "name": name, "label": label,
                "broker": broker, "asset_class": it.get("asset_class", "") or "",
                "kind": kind, "invested": invested, "units": units,
                "value_now": value_now, "ratio_now": ratio[-1],
                "dates": out_dates, "ratio": ratio,
            })
        except Exception as e:
            skipped.append({"name": name, "broker": broker, "error": str(e)})
    return jsonify({"ok": True, "range": range_key,
                    "holdings": holdings, "skipped": skipped})


@app.route("/api/actual-history")
def api_actual_history():
    """取引履歴（実額）ポートフォリオの日次推移を返す。
    - holdings: 各保有の {name, broker, asset_class, invested, dates[], amount[], ratio[]}
      ratio = 評価額 ÷ 投資金額 ×100（投資金額0の保有は ratio=null）
    - dates: 全保有の日付の和集合（古い順）
    - totals: 日付ごとの合計評価額と、合計に対する比率
    """
    range_key = request.args.get("range", "1y")
    watch = db.list_watchlist()
    histories = db.get_all_amount_histories()
    # 取引履歴（実額）がある保有を対象にする
    holdings = [it for it in watch if histories.get(it["watch_id"])]

    excel_dates = set()          # 実額の記録がある日付（表・合計に使う）
    result = []
    for it in holdings:
        excel = histories[it["watch_id"]]
        excel_dates.update(excel.keys())
        inv = float(it.get("invested") or 0)
        units = float(it.get("units") or 0)
        merged = {d: round(a) for d, a in excel.items()}   # 実額を優先
        # 口数が入っていれば、実際の基準価額×口数で「過去の価格データ」を反映（実額の無い日を補完）
        if units > 0 and (it.get("isin") or it.get("assoc_code")):
            try:
                kind = it.get("kind", "fund") or "fund"
                series = _snapshot_series(it["isin"], it["assoc_code"], it["name"], kind)
                dts, prs, _ = _apply_range(series, range_key)
                div = 1.0 if kind != "stock" else 10000.0  # 投信:price×units/10000, 株:price×units
                factor = units / (10000.0 if kind != "stock" else 1.0)
                for d, p in zip(dts, prs):
                    if p is not None and d not in merged:
                        merged[d] = round(p * factor)
                # 当日（記録期間より後）の評価額をDBへ反映
                if dts and prs and prs[-1] is not None:
                    today_val = round(prs[-1] * factor)
                    _persist_today_value(it["watch_id"], dts[-1], today_val)
                    merged[dts[-1]] = today_val
                    excel_dates.add(dts[-1])
            except Exception:
                pass
        dates = sorted(merged.keys())
        amounts = [merged[d] for d in dates]
        ratio = [round(a / inv * 100, 2) for a in amounts] if inv > 0 else None
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
            "latest": amounts[-1] if amounts else None,
            "latest_ratio": ratio[-1] if ratio else None,
        })

    # グラフのX軸（全保有の日付の和集合）
    graph_dates = sorted(set().union(*[set(h["dates"]) for h in result])) if result else []
    excel_dates = sorted(excel_dates)

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

    totals = []
    for d in excel_dates:
        ssum = round(sum(_carry(s, d) for s in hmaps))
        totals.append({"date": d, "amount": ssum,
                       "ratio": round(ssum / total_inv * 100, 2) if total_inv > 0 else None})
    return jsonify({"ok": True, "holdings": result, "dates": graph_dates,
                    "excel_dates": excel_dates, "range": range_key,
                    "total_invested": round(total_inv), "totals": totals})


@app.route("/api/ranking")
def api_ranking():
    """内蔵カタログ全体をテクニカル勢い（スコア）で順位付けして返す。

    「今後利益が出る保証」ではなく、あくまで過去データに基づくテクニカル指標の
    順位付け。ウォッチリスト外の“注目候補”を見つける用途。
    """
    range_key = request.args.get("range", "1y")
    force = request.args.get("force") in ("1", "true", "yes")
    watched = {w["id"] for w in db.list_watchlist()}
    rows = db.search_catalog("", limit=500)
    summaries = []
    for row in rows:
        s = _summarize_fund(row, range_key, force)
        s["in_watchlist"] = row["id"] in watched
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
}


def _ai_api_key():
    """APIキーを取得（環境変数 ANTHROPIC_API_KEY を優先、無ければ設定に保存された値）。"""
    return (os.environ.get("ANTHROPIC_API_KEY") or db.get_setting("ai_api_key", "") or "").strip()


def _settings_state():
    model = db.get_setting("ai_model", "off") or "off"
    if model not in ("off", "haiku", "sonnet"):
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
            db.set_setting("ai_model", m if m in ("off", "haiku", "sonnet") else "off")
        # APIキーは「値が来たときだけ」更新。空文字クリアも受け付ける。
        if "ai_api_key" in data:
            key = str(data.get("ai_api_key") or "").strip()
            db.set_setting("ai_api_key", key)
    return jsonify({"ok": True, **_settings_state()})


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


def _build_ai_context(summaries, allocation):
    """AIに渡すコンパクトな保有状況（銘柄・指標・リバランス）を組み立てる。"""
    funds = []
    for s in summaries:
        if not s.get("ok"):
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
            "change_pct": s.get("change_pct"),
        })
    ctx = {"funds": funds}
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
    "入力はテクニカル指標（スコアや判定）・損益・資産配分・リバランス計算の結果です。"
    "これらを横断的に解釈し、次の3種類の日本語コメントをJSONで返してください。\n"
    "- overall: ポートフォリオ全体の総合コメント（3〜5文）。偏り・過熱/割安・損益の傾向に触れる。\n"
    "- rebalance: リバランスや資産配分の観点での提案（2〜4文）。\n"
    "- funds: 各商品の短いコメント（1商品につき1〜2文）。watch_id で必ず対応づける。\n"
    "制約: 断定を避け『〜を検討できる水準』等の表現にする。売買を強制しない。"
    "税・手数料・分配金は考慮していない旨は全体で1度触れれば十分。"
    "これは機械的な参考情報であり投資助言ではありません。"
)

_AI_SCHEMA = {
    "type": "object",
    "properties": {
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
    "required": ["overall", "rebalance", "funds"],
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
    ctx = _build_ai_context(summaries, allocation)
    if not ctx["funds"]:
        return jsonify({"ok": False, "error": "分析できる保有商品がありません。"})

    model_id = _AI_MODELS[model_key]
    try:
        client = anthropic.Anthropic(api_key=key)
        resp = client.messages.create(
            model=model_id,
            max_tokens=4000,
            system=[{"type": "text", "text": _AI_SYSTEM_PROMPT,
                     "cache_control": {"type": "ephemeral"}}],
            messages=[{"role": "user", "content":
                       "次の保有状況にコメントしてください。\n" + json.dumps(ctx, ensure_ascii=False)}],
            output_config={"format": {"type": "json_schema", "schema": _AI_SCHEMA}},
        )
        text = next((b.text for b in resp.content if getattr(b, "type", None) == "text"), "")
        data = json.loads(text) if text else {}
    except Exception as e:
        return jsonify({"ok": False, "error": f"AI呼び出しに失敗しました: {e}"}), 502

    return jsonify({"ok": True, "model": model_key, "advice": data})


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
    app.run(host=bind_host, port=port, debug=False)


if __name__ == "__main__":
    main()
