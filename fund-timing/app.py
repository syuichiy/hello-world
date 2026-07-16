"""投資信託 売り時・買い時サイン アプリ（ローカルWebアプリ）。

起動:
    python3 app.py
ブラウザで http://127.0.0.1:5000 を開く（自動で開きます）。

デモ（ネット接続なしでUIを試す）:
    python3 app.py --demo
"""
from __future__ import annotations

import argparse
import re
import sys
import threading
import webbrowser
from urllib.parse import urlparse, parse_qs

from flask import Flask, jsonify, render_template, request, Response

import fund_data
import signals as signal_mod
from funds import PRESET_FUNDS

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

    # URLとして解釈できるならクエリから取得
    if "toushin-lib" in text or "isinCd=" in text or "associFundCd=" in text:
        try:
            q = parse_qs(urlparse(text).query)
            if "isinCd" in q:
                isin = q["isinCd"][0].strip().upper()
            if "associFundCd" in q:
                assoc = q["associFundCd"][0].strip()
        except Exception:
            pass

    # 区切り文字（カンマ/空白/タブ）で分割
    if isin is None or assoc is None:
        parts = re.split(r"[,\s]+", text)
        for p in parts:
            p = p.strip()
            if isin is None and re.fullmatch(r"[A-Za-z]{2}[A-Za-z0-9]{9}\d", p):
                isin = p.upper()
            elif assoc is None and re.fullmatch(r"[A-Za-z0-9]{6,12}", p) and p.upper() != isin:
                assoc = p

    # 最後の手段: ISINパターンを本文から拾う
    if isin is None:
        m = ISIN_RE.search(text.upper())
        if m:
            isin = m.group(1)
    if assoc is None:
        m = ASSOC_RE.search(text)
        if m:
            assoc = m.group(1)

    return isin, assoc


# ------------------------------------------------------------------ ルート
@app.route("/")
def index():
    return render_template("index.html", presets=PRESET_FUNDS, demo=DEMO_MODE)


@app.route("/vendor/plotly.min.js")
def plotly_js():
    """Plotly.js を pip パッケージ同梱の中身から配信（CDN不要・オフライン動作）。"""
    from plotly.offline import get_plotlyjs
    return Response(get_plotlyjs(), mimetype="application/javascript")


@app.route("/api/analyze")
def api_analyze():
    query = request.args.get("q", "")
    name = request.args.get("name", "")
    range_key = request.args.get("range", "3y")

    isin, assoc = parse_identifier(query)
    if not isin or not assoc:
        return jsonify({
            "ok": False,
            "error": "ISINコードと協会コードを読み取れませんでした。"
                     "投信ライブラリーのURL、または「ISIN,協会コード」の形式で入力してください。",
        }), 400

    try:
        series = fund_data.get_fund_series(isin, assoc, name)
    except fund_data.FundDataError as e:
        return jsonify({"ok": False, "error": str(e)}), 502

    # 期間で絞り込み
    dates, prices, assets = _apply_range(series, range_key)
    if len(prices) < 5:
        return jsonify({"ok": False, "error": "分析に十分な期間のデータがありません。"}), 400

    analysis = signal_mod.analyze(dates, prices)
    stats = dict(analysis.stats)
    stats["latest_date"] = dates[-1]

    return jsonify({
        "ok": True,
        "fund": {"name": series.name, "isin": series.isin, "assoc_code": series.assoc_code},
        "indicators": analysis.indicators.__dict__,
        "net_assets": _nan_clean(assets),
        "signals": [s.__dict__ for s in analysis.signals],
        "verdict": analysis.verdict,
        "verdict_label": analysis.verdict_label,
        "score": analysis.score,
        "reasons": analysis.reasons,
        "stats": stats,
    })


def _apply_range(series, range_key):
    import datetime as dt
    n = len(series.dates)
    if range_key == "all" or n == 0:
        return series.dates, series.nav, series.net_assets
    days = {"6m": 182, "1y": 365, "3y": 365 * 3, "5y": 365 * 5}.get(range_key, 365 * 3)
    last = dt.date.fromisoformat(series.dates[-1])
    cutoff = last - dt.timedelta(days=days)
    start = 0
    for i, d in enumerate(series.dates):
        if dt.date.fromisoformat(d) >= cutoff:
            start = i
            break
    return series.dates[start:], series.nav[start:], series.net_assets[start:]


def _nan_clean(seq):
    import math
    return [None if (v is None or (isinstance(v, float) and math.isnan(v))) else v for v in seq]


# ------------------------------------------------------------------ 起動
def _open_browser(url):
    try:
        webbrowser.open(url)
    except Exception:
        pass


def main():
    global DEMO_MODE
    parser = argparse.ArgumentParser(description="投資信託 売り時・買い時サイン アプリ")
    parser.add_argument("--demo", action="store_true",
                        help="ネット接続なしでUIを試す（ダミーデータ）")
    parser.add_argument("--port", type=int, default=5000)
    parser.add_argument("--no-browser", action="store_true", help="ブラウザを自動で開かない")
    args = parser.parse_args()

    if args.demo:
        DEMO_MODE = True
        import demo_data
        fund_data.set_fetch_override(demo_data.demo_csv)
        print("[demo] ダミーデータで起動します（ネット接続不要）")

    url = f"http://127.0.0.1:{args.port}"
    print(f"投資信託サインアプリを起動しました → {url}")
    print("終了するには Ctrl+C を押してください。")
    if not args.no_browser:
        threading.Timer(1.0, _open_browser, args=(url,)).start()
    app.run(host="127.0.0.1", port=args.port, debug=False)


if __name__ == "__main__":
    main()
