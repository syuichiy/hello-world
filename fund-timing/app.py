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
def load_series(isin: str, assoc: str, name: str = "", force: bool = False) -> dict:
    """基準価額シリーズをdictで返す。内部DBのキャッシュを使い、無ければ取得して保存。"""
    isin = (isin or "").strip().upper()
    assoc = (assoc or "").strip()
    if not force:
        cached = db.get_cached_series(isin, assoc)
        if cached:
            if name and not cached.get("name"):
                cached["name"] = name
            return cached
    series = fund_data.get_fund_series(isin, assoc, name)
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
    watched = {w["catalog_id"] if "catalog_id" in w else w["id"] for w in db.list_watchlist()}
    for r in results:
        r["watched"] = r["id"] in watched
    return jsonify({"ok": True, "results": results})


@app.route("/api/catalog", methods=["POST"])
def api_catalog_add():
    data = request.get_json(silent=True) or {}
    name = (data.get("name") or "").strip()
    query = (data.get("query") or "").strip()
    isin, assoc = parse_identifier(query)
    if not isin or not assoc:
        return jsonify({"ok": False, "error":
                        "ISINコードと協会コードを読み取れませんでした。"
                        "投信ライブラリーのURL、または「ISIN,協会コード」を入力してください。"}), 400
    try:
        row = db.add_catalog(name, isin, assoc, data.get("category", ""))
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


@app.route("/api/watchlist/analyze")
def api_watchlist_analyze():
    """ウォッチリスト各投信の現在の判定サマリを返す（一覧比較用）。"""
    range_key = request.args.get("range", "1y")
    force = request.args.get("force") in ("1", "true", "yes")
    items = db.list_watchlist()
    summaries = []
    for it in items:
        summary = {
            "catalog_id": it["id"],
            "name": it["name"],
            "isin": it["isin"],
            "category": it.get("category", ""),
        }
        try:
            series = load_series(it["isin"], it["assoc_code"], it["name"], force=force)
            dates, prices, _ = _apply_range(series, range_key)
            if len(prices) < 5:
                raise fund_data.FundDataError("データが不足しています")
            a = signal_mod.analyze(dates, prices)
            change = None
            if prices[0]:
                change = round((prices[-1] - prices[0]) / prices[0] * 100, 2)
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
            })
        except fund_data.FundDataError as e:
            summary.update({"ok": False, "error": str(e)})
        summaries.append(summary)
    return jsonify({"ok": True, "range": range_key, "items": summaries})


# ------------------------------------------------------------------ 詳細分析
@app.route("/api/analyze")
def api_analyze():
    range_key = request.args.get("range", "3y")
    force = request.args.get("force") in ("1", "true", "yes")
    name = request.args.get("name", "")

    catalog_id = request.args.get("catalog_id")
    if catalog_id:
        row = db.get_catalog(int(catalog_id))
        if not row:
            return jsonify({"ok": False, "error": "指定の投信が見つかりません。"}), 404
        isin, assoc, name = row["isin"], row["assoc_code"], row["name"]
    else:
        isin, assoc = parse_identifier(request.args.get("q", ""))

    if not isin or not assoc:
        return jsonify({"ok": False, "error":
                        "ISINコードと協会コードを読み取れませんでした。"}), 400

    try:
        series = load_series(isin, assoc, name, force=force)
    except fund_data.FundDataError as e:
        return jsonify({"ok": False, "error": str(e)}), 502

    dates, prices, assets = _apply_range(series, range_key)
    if len(prices) < 5:
        return jsonify({"ok": False, "error": "分析に十分な期間のデータがありません。"}), 400

    analysis = signal_mod.analyze(dates, prices)
    stats = dict(analysis.stats)
    stats["latest_date"] = dates[-1]

    return jsonify({
        "ok": True,
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


def main():
    global DEMO_MODE
    parser = argparse.ArgumentParser(description="投資信託 売り時・買い時サイン アプリ")
    parser.add_argument("--demo", action="store_true", help="ダミーデータで起動（ネット不要）")
    parser.add_argument("--port", type=int, default=8765,
                        help="ポート番号（既定: 8765。使用中なら自動で別のポートを探します）")
    parser.add_argument("--no-browser", action="store_true", help="ブラウザを自動で開かない")
    parser.add_argument("--db", default=None, help="内部DBファイルのパス（既定: funds.db）")
    args = parser.parse_args()

    if args.db:
        db.DB_PATH = args.db
    if args.demo:
        DEMO_MODE = True
        import demo_data
        fund_data.set_fetch_override(demo_data.demo_csv)
        if not args.db:
            db.DB_PATH = db.os.path.join(db.os.path.dirname(db.DB_PATH), "funds.demo.db")

    db.init_db()

    if args.demo:
        db.clear_cache()  # デモは毎回新しいダミーで（テーブル作成後に実行）
        print(f"[demo] ダミーデータで起動します（DB: {db.DB_PATH}）")

    host = "127.0.0.1"
    port = _find_free_port(args.port, host)
    url = f"http://{host}:{port}"
    if port != args.port:
        print(f"ポート {args.port} は使用中のため、{port} で起動します"
              "（macOSではポート5000はAirPlayが使用します）。")
    print(f"投資信託サインアプリを起動しました → {url}")
    print("ブラウザが自動で開かない場合は、上のURLをブラウザに貼り付けてください。")
    print("終了するには Ctrl+C を押してください。")
    if not args.no_browser:
        threading.Thread(target=_open_when_ready, args=(url, host, port), daemon=True).start()
    app.run(host=host, port=port, debug=False)


if __name__ == "__main__":
    main()
