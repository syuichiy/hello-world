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
import math
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

app = Flask(__name__)

DEMO_MODE = False


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
    days = {"6m": 182, "1y": 365, "3y": 365 * 3, "5y": 365 * 5}.get(range_key, 365 * 3)
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
        db.add_watch(row["id"])
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
    db.add_watch(int(catalog_id))
    return jsonify({"ok": True})


@app.route("/api/watchlist", methods=["DELETE"])
def api_watchlist_remove():
    data = request.get_json(silent=True) or {}
    catalog_id = data.get("catalog_id")
    if catalog_id is None:
        return jsonify({"ok": False, "error": "catalog_id が必要です。"}), 400
    db.remove_watch(int(catalog_id))
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
    return summary


@app.route("/api/watchlist/analyze")
def api_watchlist_analyze():
    """ウォッチリスト各投信の判定サマリ＋保有全体（ポートフォリオ）の目安を返す。"""
    range_key = request.args.get("range", "1y")
    force = request.args.get("force") in ("1", "true", "yes")
    summaries = []
    for it in db.list_watchlist():
        s = _summarize_fund(it, range_key, force)
        units = float(it.get("units") or 0)
        s["units"] = units
        if s.get("ok") and units > 0 and s.get("latest_price"):
            if s.get("kind") == "stock":
                # 個別株: 評価額 = 株価 × 株数
                s["value"] = round(s["latest_price"] * units)
            else:
                # 投信の慣例: 評価額 = 基準価額 × 口数 ÷ 10,000
                s["value"] = round(s["latest_price"] * units / 10000)
        else:
            s["value"] = None
        summaries.append(s)
    portfolio = signal_mod.portfolio_advice(summaries)
    for s in summaries:
        s.pop("_w", None)  # portfolio_adviceが付ける内部ウェイトは返さない
    allocation = _build_allocation(summaries)
    return jsonify({"ok": True, "range": range_key, "items": summaries,
                    "portfolio": portfolio, "allocation": allocation})


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
    return {"ok": True, "weights_mode": "value" if any_units else "equal",
            "total_value": round(total) if any_units else None,
            "classes": classes, "targets": targets}


@app.route("/api/targets", methods=["GET", "POST"])
def api_targets():
    """理想ポートフォリオ（クラス別目標%）の取得・保存。"""
    import seed_funds
    if request.method == "GET":
        t = db.get_setting("targets", None) or dict(seed_funds.DEFAULT_TARGETS)
        return jsonify({"ok": True, "targets": t})
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


@app.route("/api/watchlist/units", methods=["POST"])
def api_watchlist_units():
    """保有口数を登録する。"""
    data = request.get_json(silent=True) or {}
    catalog_id = data.get("catalog_id")
    if catalog_id is None:
        return jsonify({"ok": False, "error": "catalog_id が必要です。"}), 400
    try:
        units = float(data.get("units") or 0)
    except (TypeError, ValueError):
        return jsonify({"ok": False, "error": "口数は数値で入力してください。"}), 400
    if units < 0:
        return jsonify({"ok": False, "error": "口数は0以上で入力してください。"}), 400
    saved = db.set_units(int(catalog_id), units)
    return jsonify({"ok": True, "units": saved})


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
    app.run(host=bind_host, port=port, debug=False)


if __name__ == "__main__":
    main()
