"""投資信託の基準価額の履歴を取得・整形するモジュール。

データ源：投資信託協会「投信総合検索ライブラリー」の公式CSVダウンロード。
    https://toushin-lib.fwg.ne.jp/FdsWeb/FDST030000/csv-file-download?isinCd=...&associFundCd=...
CSVはShift-JIS(cp932)で、日次の基準価額・純資産総額・分配金を含む。
"""
from __future__ import annotations

import io
import re
import datetime as dt
from dataclasses import dataclass, asdict
from typing import Optional

import pandas as pd
import requests

CSV_URL = "https://toushin-lib.fwg.ne.jp/FdsWeb/FDST030000/csv-file-download"

# ネットワークが無い環境でもUIを試せるよう、外部から差し替え可能にしておく
# （app.py の DEMO モードでダミーデータ生成に使う）
_fetch_override = None


@dataclass
class FundSeries:
    isin: str
    assoc_code: str
    name: str
    dates: list          # "YYYY-MM-DD" の文字列
    nav: list            # 基準価額(円) float
    net_assets: list     # 純資産総額(百万円) float

    def to_dict(self):
        return asdict(self)


class FundDataError(Exception):
    pass


def set_fetch_override(func):
    """テスト/デモ用に、生CSVテキストを返す関数へ差し替える。"""
    global _fetch_override
    _fetch_override = func


DETAIL_URL = "https://toushin-lib.fwg.ne.jp/FdsWeb/FDST030000"

_BROWSER_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                  "AppleWebKit/537.36 (KHTML, like Gecko) "
                  "Chrome/125.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,text/csv,*/*",
    "Accept-Language": "ja,en-US;q=0.9,en;q=0.8",
}


def _download_csv(isin: str, assoc_code: str, timeout: int = 30) -> str:
    if _fetch_override is not None:
        return _fetch_override(isin, assoc_code)

    params = {}
    if isin:
        params["isinCd"] = isin
    if assoc_code:
        params["associFundCd"] = assoc_code

    sess = requests.Session()
    sess.headers.update(_BROWSER_HEADERS)

    # まずファンド詳細ページを開いてセッション（Cookie）を確立してからCSVを取得する。
    # このサイトは詳細ページを経ないとCSVを返さないことがあるため。
    referer = DETAIL_URL
    try:
        d = sess.get(DETAIL_URL, params=params, timeout=timeout)
        referer = d.url or DETAIL_URL
    except requests.RequestException:
        pass  # 事前アクセスが失敗しても本取得を試みる

    try:
        resp = sess.get(CSV_URL, params=params, timeout=timeout,
                        headers={"Referer": referer,
                                 "Accept": "text/csv,application/csv,text/plain,*/*"})
    except requests.RequestException as e:
        raise FundDataError(
            "ネットワークに接続できませんでした。インターネット接続を確認してください。\n"
            f"詳細: {e}"
        )
    if resp.status_code != 200:
        raise FundDataError(
            f"データ取得に失敗しました（HTTP {resp.status_code}）。"
            "しばらく時間をおいて再度お試しください。"
        )

    resp.encoding = "cp932"  # Shift-JIS
    text = resp.text or ""
    stripped = text.lstrip()

    # HTMLが返ってきた場合（アクセス制限ページ等）
    if stripped[:1] == "<" or "<html" in stripped[:2000].lower():
        raise FundDataError(
            "サイトからデータ（CSV）ではなくWebページが返りました。"
            "アクセスが一時的に制限された可能性があります。少し時間をおいて再度お試しください。"
        )

    if "," not in text:
        both = isin and assoc_code
        if not both:
            hint = ("この投信は「ISIN」と「協会コード」の両方が必要です。"
                    "『ISIN,協会コード』の形式で入力してください（例：JP90C0006G52,01313098）。")
        else:
            hint = "ISIN・協会コードの組み合わせが正しいか確認してください。"
        raise FundDataError("データが空でした。" + hint)
    return text


def _parse_date(value: str) -> Optional[dt.date]:
    value = str(value).strip()
    if not value:
        return None
    # 想定フォーマット: 2024/01/04, 2024-01-04, 20240104, 2024年1月4日
    m = re.match(r"^(\d{4})\D+(\d{1,2})\D+(\d{1,2})", value)
    if m:
        y, mo, d = map(int, m.groups())
        try:
            return dt.date(y, mo, d)
        except ValueError:
            return None
    if re.fullmatch(r"\d{8}", value):
        try:
            return dt.datetime.strptime(value, "%Y%m%d").date()
        except ValueError:
            return None
    return None


def _to_float(value) -> Optional[float]:
    if value is None:
        return None
    s = str(value).strip().replace(",", "")
    if s in ("", "-", "－", "―"):
        return None
    try:
        return float(s)
    except ValueError:
        return None


def _find_column(columns, keywords):
    for col in columns:
        name = str(col)
        if any(k in name for k in keywords):
            return col
    return None


def parse_csv(text: str, isin: str, assoc_code: str, name: str = "") -> FundSeries:
    """投信協会CSVテキストを FundSeries に整形する。列名の揺れに強い実装。"""
    df = pd.read_csv(io.StringIO(text), dtype=str)
    df.columns = [str(c).strip() for c in df.columns]

    date_col = _find_column(df.columns, ["年月日", "日付", "基準日"])
    nav_col = _find_column(df.columns, ["基準価額"])
    asset_col = _find_column(df.columns, ["純資産"])

    if date_col is None or nav_col is None:
        raise FundDataError(
            "CSVの形式が想定と異なります（日付・基準価額の列が見つかりません）。"
        )

    rows = []
    for _, r in df.iterrows():
        d = _parse_date(r[date_col])
        nav = _to_float(r[nav_col])
        if d is None or nav is None:
            continue
        assets = _to_float(r[asset_col]) if asset_col else None
        rows.append((d, nav, assets))

    if not rows:
        raise FundDataError("有効な価格データが1件もありませんでした。")

    rows.sort(key=lambda x: x[0])  # 日付昇順
    dates = [r[0].isoformat() for r in rows]
    nav_list = [r[1] for r in rows]
    assets_list = [r[2] if r[2] is not None else float("nan") for r in rows]

    return FundSeries(
        isin=isin,
        assoc_code=assoc_code,
        name=name or isin,
        dates=dates,
        nav=nav_list,
        net_assets=assets_list,
    )


def get_fund_series(isin: str, assoc_code: str, name: str = "") -> FundSeries:
    """協会コードまたはISINから基準価額の履歴を取得する（両方あればなお確実）。"""
    isin = (isin or "").strip().upper()
    assoc_code = (assoc_code or "").strip()
    if not isin and not assoc_code:
        raise FundDataError("協会コード（8桁）またはISINコードを指定してください。")
    text = _download_csv(isin, assoc_code)
    return parse_csv(text, isin, assoc_code, name)


# ===========================================================================
# 個別株の株価取得（Stooqの公開CSV: https://stooq.com/q/d/l/?s=6501.jp&i=d）
# 形式: Date,Open,High,Low,Close,Volume
# ===========================================================================

STOCK_CSV_URL = "https://stooq.com/q/d/l/"

_stock_fetch_override = None


def set_stock_override(func):
    """デモ/テスト用に、株価CSVテキストを返す関数へ差し替える。"""
    global _stock_fetch_override
    _stock_fetch_override = func


YAHOO_CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart/{symbol}"


def _parse_stock_csv(text: str):
    """Stooq形式CSV（Date,Open,High,Low,Close,Volume）を (date, close) のリストに。"""
    lines = [l.strip() for l in (text or "").splitlines() if l.strip()]
    if not lines or "," not in lines[0]:
        return []
    rows = []
    for line in lines[1:]:
        parts = line.split(",")
        if len(parts) < 5:
            continue
        d = _parse_date(parts[0])
        close = _to_float(parts[4])
        if d is None or close is None:
            continue
        rows.append((d, close))
    return rows


def _fetch_stock_stooq(ticker: str):
    try:
        resp = requests.get(STOCK_CSV_URL,
                            params={"s": ticker.lower(), "i": "d"},
                            headers=_BROWSER_HEADERS, timeout=30)
    except requests.RequestException as e:
        raise FundDataError(f"Stooqに接続できませんでした（{e}）")
    if resp.status_code != 200:
        raise FundDataError(f"Stooq: HTTP {resp.status_code}")
    rows = _parse_stock_csv(resp.text)
    if not rows:
        raise FundDataError("Stooq: データが空（回数制限の可能性）")
    return rows


_yahoo_session = None
_yahoo_crumb = None


def _get_yahoo_session():
    """Yahoo用セッション（Cookie＋crumbを取得して使い回す）。

    Yahooのチャート取得は、Cookieとcrumbトークンなしだと429で拒否されるため、
    yfinanceライブラリと同じ手順（fc.yahoo.comでCookie→getcrumbでトークン）を踏む。
    """
    global _yahoo_session, _yahoo_crumb
    if _yahoo_session is not None:
        return _yahoo_session, _yahoo_crumb
    sess = requests.Session()
    sess.headers.update({
        "User-Agent": _BROWSER_HEADERS["User-Agent"],
        "Accept": "application/json,text/plain,*/*",
        "Accept-Language": "ja,en-US;q=0.9,en;q=0.8",
    })
    try:
        sess.get("https://fc.yahoo.com", timeout=15)  # Cookie取得（404が返るが正常）
    except requests.RequestException:
        pass
    crumb = None
    try:
        r = sess.get("https://query1.finance.yahoo.com/v1/test/getcrumb", timeout=15)
        if r.status_code == 200 and r.text and "<" not in r.text:
            crumb = r.text.strip()
    except requests.RequestException:
        pass
    _yahoo_session, _yahoo_crumb = sess, crumb
    return sess, crumb


def _fetch_stock_yahoo(ticker: str):
    """Yahoo!ファイナンスのチャートAPI（例: 6501.JP → 6501.T）。"""
    global _yahoo_session, _yahoo_crumb
    symbol = ticker.upper()
    if symbol.endswith(".JP"):
        symbol = symbol[:-3] + ".T"

    sess, crumb = _get_yahoo_session()
    params = {"range": "10y", "interval": "1d"}
    if crumb:
        params["crumb"] = crumb

    resp = None
    last_err = None
    for host in ("query1", "query2"):
        url = f"https://{host}.finance.yahoo.com/v8/finance/chart/{symbol}"
        try:
            resp = sess.get(url, params=params, timeout=30)
        except requests.RequestException as e:
            last_err = f"Yahooに接続できませんでした（{e}）"
            continue
        if resp.status_code == 200:
            break
        last_err = f"Yahoo: HTTP {resp.status_code}"
        if resp.status_code in (401, 403, 429):
            # セッションを作り直して次のホストで再試行
            _yahoo_session = None
            sess, crumb = _get_yahoo_session()
            if crumb:
                params["crumb"] = crumb
        resp = None
    if resp is None:
        raise FundDataError(last_err or "Yahoo: 取得失敗")

    try:
        result = resp.json()["chart"]["result"][0]
        stamps = result["timestamp"]
        closes = result["indicators"]["quote"][0]["close"]
    except (KeyError, IndexError, TypeError, ValueError):
        raise FundDataError("Yahoo: 応答の形式が想定外")
    rows = []
    for ts, close in zip(stamps, closes):
        if ts is None or close is None:
            continue
        rows.append((dt.date.fromtimestamp(ts), float(close)))
    if not rows:
        raise FundDataError("Yahoo: データが空")
    return rows


def _fetch_stock_yfinance(ticker: str):
    """yfinanceライブラリ経由（ブラウザ偽装通信でYahooのbot判定を回避できる）。"""
    try:
        import yfinance as yf
    except ImportError:
        raise FundDataError("yfinance未導入（pip install yfinance）")
    symbol = ticker.upper()
    if symbol.endswith(".JP"):
        symbol = symbol[:-3] + ".T"
    try:
        hist = yf.Ticker(symbol).history(period="10y", interval="1d", auto_adjust=True)
    except Exception as e:
        raise FundDataError(f"yfinance: {e}")
    if hist is None or len(hist) == 0 or "Close" not in hist:
        raise FundDataError("yfinance: データが空")
    rows = []
    for idx, close in hist["Close"].items():
        if pd.isna(close):
            continue
        rows.append((idx.date(), float(close)))
    if not rows:
        raise FundDataError("yfinance: 有効なデータなし")
    return rows


def get_stock_series(ticker: str, name: str = "") -> FundSeries:
    """個別株の日次終値を取得する（ticker例: '6501.JP'）。

    Stooq → yfinance → Yahoo直接 の順に試す
    （Stooqは回数制限、Yahoo直接はTLS指紋によるbot判定で失敗することがあるため）。
    """
    ticker = (ticker or "").strip()
    if not ticker:
        raise FundDataError("ティッカー（例: 6501.JP）を指定してください。")

    if _stock_fetch_override is not None:
        rows = _parse_stock_csv(_stock_fetch_override(ticker))
        if not rows:
            raise FundDataError("有効な株価データが1件もありませんでした。")
    else:
        rows = None
        errors = []
        for fetcher in (_fetch_stock_stooq, _fetch_stock_yfinance, _fetch_stock_yahoo):
            try:
                rows = fetcher(ticker)
                break
            except FundDataError as e:
                errors.append(str(e))
        if not rows:
            raise FundDataError("株価データを取得できませんでした（" + " / ".join(errors) + "）。"
                                "時間をおいて「最新に更新」をお試しください。")

    rows.sort(key=lambda x: x[0])
    return FundSeries(
        isin=ticker.upper(), assoc_code="", name=name or ticker.upper(),
        dates=[r[0].isoformat() for r in rows],
        nav=[r[1] for r in rows],
        net_assets=[float("nan")] * len(rows),
    )
