"""基準価額の履歴から、買い時・売り時のサインを算出するモジュール。

投資信託は日次の基準価額のみ（出来高なし）なので、価格ベースの
テクニカル指標で判定する。

算出する指標:
  - 短期/長期の移動平均（SMA）とゴールデンクロス/デッドクロス
  - RSI(14) の買われすぎ/売られすぎ
  - ボリンジャーバンド(20, ±2σ) のバンド上限/下限タッチ
  - 移動平均からの乖離率

これらを合成した総合スコアで、現在の「買い/売り/中立」を提示する。

注意: これはテクニカル指標に基づく機械的な目安であり、
将来の値上がり・値下がりや投資成果を保証するものではありません。
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

import numpy as np
import pandas as pd


# --- パラメータ（好みに応じて調整可能） -------------------------------------
SHORT_WINDOW = 25      # 短期移動平均（営業日）
LONG_WINDOW = 75       # 長期移動平均（営業日）
RSI_PERIOD = 14
RSI_OVERSOLD = 30
RSI_OVERBOUGHT = 70
BB_WINDOW = 20
BB_SIGMA = 2.0
# ---------------------------------------------------------------------------


@dataclass
class SignalPoint:
    date: str
    price: float
    kind: str      # "buy" or "sell"
    reason: str


@dataclass
class Indicators:
    dates: list
    price: list
    sma_short: list
    sma_long: list
    rsi: list
    bb_upper: list
    bb_lower: list
    bb_mid: list


@dataclass
class Analysis:
    indicators: Indicators
    signals: list                      # SignalPoint のリスト
    verdict: str                       # "buy" / "sell" / "neutral"
    verdict_label: str                 # 日本語ラベル
    score: int                         # -100..100（+が買い寄り）
    reasons: list = field(default_factory=list)  # 現時点の判断理由（文字列）
    stats: dict = field(default_factory=dict)


def _rsi(series: pd.Series, period: int) -> pd.Series:
    delta = series.diff()
    gain = delta.clip(lower=0.0)
    loss = -delta.clip(upper=0.0)
    # Wilderの平滑化（EMA相当）
    avg_gain = gain.ewm(alpha=1 / period, min_periods=period, adjust=False).mean()
    avg_loss = loss.ewm(alpha=1 / period, min_periods=period, adjust=False).mean()
    rs = avg_gain / avg_loss.replace(0, np.nan)
    rsi = 100 - (100 / (1 + rs))
    # avg_loss==0（下落なし）のときはRSI=100
    rsi = rsi.where(avg_loss != 0, 100.0)
    return rsi


def _nan_to_none(seq):
    return [None if (v is None or (isinstance(v, float) and np.isnan(v))) else round(float(v), 4)
            for v in seq]


def analyze(dates: list, prices: list) -> Analysis:
    s = pd.Series(prices, dtype="float64")

    sma_short = s.rolling(SHORT_WINDOW, min_periods=1).mean()
    sma_long = s.rolling(LONG_WINDOW, min_periods=1).mean()
    rsi = _rsi(s, RSI_PERIOD)
    bb_mid = s.rolling(BB_WINDOW, min_periods=1).mean()
    bb_std = s.rolling(BB_WINDOW, min_periods=1).std(ddof=0)
    bb_upper = bb_mid + BB_SIGMA * bb_std
    bb_lower = bb_mid - BB_SIGMA * bb_std

    signals: list[SignalPoint] = []

    # --- 移動平均クロス（十分なデータがある区間のみ判定） ---
    cross_valid = LONG_WINDOW
    diff = sma_short - sma_long
    for i in range(1, len(s)):
        if i < cross_valid:
            continue
        prev, cur = diff.iloc[i - 1], diff.iloc[i]
        if pd.isna(prev) or pd.isna(cur):
            continue
        if prev <= 0 and cur > 0:
            signals.append(SignalPoint(dates[i], float(s.iloc[i]), "buy",
                                       "ゴールデンクロス（短期線が長期線を上抜け）"))
        elif prev >= 0 and cur < 0:
            signals.append(SignalPoint(dates[i], float(s.iloc[i]), "sell",
                                       "デッドクロス（短期線が長期線を下抜け）"))

    # --- RSIの反転（売られすぎ→回復 / 買われすぎ→反落） ---
    for i in range(1, len(s)):
        prev, cur = rsi.iloc[i - 1], rsi.iloc[i]
        if pd.isna(prev) or pd.isna(cur):
            continue
        if prev < RSI_OVERSOLD and cur >= RSI_OVERSOLD:
            signals.append(SignalPoint(dates[i], float(s.iloc[i]), "buy",
                                       f"RSIが売られすぎ({RSI_OVERSOLD})から回復"))
        elif prev > RSI_OVERBOUGHT and cur <= RSI_OVERBOUGHT:
            signals.append(SignalPoint(dates[i], float(s.iloc[i]), "sell",
                                       f"RSIが買われすぎ({RSI_OVERBOUGHT})から反落"))

    # --- ボリンジャーバンド（下限割れ=買い / 上限超え=売り） ---
    # バンドに入り込んだ「その日」だけをサインにする（連続日を除外してノイズを減らす）
    for i in range(1, len(s)):
        if pd.isna(bb_lower.iloc[i]) or bb_std.iloc[i] == 0:
            continue
        prev_below = s.iloc[i - 1] <= bb_lower.iloc[i - 1] if not pd.isna(bb_lower.iloc[i - 1]) else False
        prev_above = s.iloc[i - 1] >= bb_upper.iloc[i - 1] if not pd.isna(bb_upper.iloc[i - 1]) else False
        if s.iloc[i] <= bb_lower.iloc[i] and not prev_below:
            signals.append(SignalPoint(dates[i], float(s.iloc[i]), "buy",
                                       "ボリンジャーバンド -2σ に到達（割安圏）"))
        elif s.iloc[i] >= bb_upper.iloc[i] and not prev_above:
            signals.append(SignalPoint(dates[i], float(s.iloc[i]), "sell",
                                       "ボリンジャーバンド +2σ に到達（割高圏）"))

    # 同一日・同一種別の重複サインは1つにまとめる
    signals = _dedupe_signals(signals)

    verdict, verdict_label, score, reasons, stats = _current_verdict(
        s, sma_short, sma_long, rsi, bb_upper, bb_lower, bb_mid
    )

    indicators = Indicators(
        dates=dates,
        price=_nan_to_none(prices),
        sma_short=_nan_to_none(sma_short.tolist()),
        sma_long=_nan_to_none(sma_long.tolist()),
        rsi=_nan_to_none(rsi.tolist()),
        bb_upper=_nan_to_none(bb_upper.tolist()),
        bb_lower=_nan_to_none(bb_lower.tolist()),
        bb_mid=_nan_to_none(bb_mid.tolist()),
    )

    return Analysis(
        indicators=indicators,
        signals=signals,
        verdict=verdict,
        verdict_label=verdict_label,
        score=score,
        reasons=reasons,
        stats=stats,
    )


def _dedupe_signals(signals):
    seen = set()
    out = []
    for sig in signals:
        key = (sig.date, sig.kind)
        if key in seen:
            continue
        seen.add(key)
        out.append(sig)
    out.sort(key=lambda x: x.date)
    return out


def _clamp(x, lo=-1.0, hi=1.0):
    return max(lo, min(hi, x))


def _current_verdict(s, sma_short, sma_long, rsi, bb_upper, bb_lower, bb_mid):
    """最新時点の総合判断。各指標を「連続値」で評価して合算する。

    以前は各指標を段階的（±25/±30…）に加点していたため、似た値動きの投信が
    同じスコアに張り付いていた。ここでは各指標を滑らかな連続値[-1,1]に変換し、
    重み付けして -100〜+100 の連続スコアにする（投信ごとに差が出るように）。
    """
    last = len(s) - 1
    price = float(s.iloc[last])

    ss, sl = sma_short.iloc[last], sma_long.iloc[last]
    r = rsi.iloc[last]
    up, lo = bb_upper.iloc[last], bb_lower.iloc[last]

    weights = {"trend": 28, "mom": 22, "rsi": 22, "bb": 16, "dev": 12}
    terms = {}
    texts = {}

    # トレンド：短期線と長期線の乖離（連続）。上向きほど＋（買い材料）。
    if not (pd.isna(ss) or pd.isna(sl)) and sl:
        gap = (ss - sl) / sl
        terms["trend"] = float(np.tanh(gap * 25))
        texts["trend"] = ("上昇トレンド（短期線が長期線を上回る）" if ss > sl
                          else "下降トレンド（短期線が長期線を下回る）")
    else:
        terms["trend"] = 0.0

    # モメンタム：直近約60営業日の騰落率（連続）。勢いが強いほど＋（買い材料）。
    look = min(60, last)
    base = float(s.iloc[last - look]) if look > 0 else 0.0
    if base:
        ret = price / base - 1.0
        terms["mom"] = float(np.tanh(ret * 5))
        texts["mom"] = f"直近約3ヶ月の勢い（騰落率 {ret * 100:+.1f}%）"
    else:
        terms["mom"] = 0.0

    # RSI：50からの距離で連続評価（売られすぎ＝＋の買い材料、買われすぎ＝−の売り材料）
    if not pd.isna(r):
        terms["rsi"] = _clamp((50.0 - float(r)) / 25.0)
        if r >= RSI_OVERBOUGHT:
            rlabel = "買われすぎ"
        elif r <= RSI_OVERSOLD:
            rlabel = "売られすぎ"
        elif r >= 60:
            rlabel = "やや過熱"
        elif r <= 40:
            rlabel = "やや軟調"
        else:
            rlabel = "中立圏"
        texts["rsi"] = f"RSI {r:.0f}（{rlabel}）"
    else:
        terms["rsi"] = 0.0

    # ボリンジャーバンド内の位置（連続）。下限寄り＝割安＝＋、上限寄り＝割高＝−
    if not (pd.isna(up) or pd.isna(lo)) and up != lo:
        pos = (price - lo) / (up - lo)   # 0=下限, 1=上限
        terms["bb"] = _clamp((0.5 - pos) * 2.0)
        if pos >= 0.85:
            texts["bb"] = "ボリンジャーバンド上限付近（割高圏）"
        elif pos >= 0.6:
            texts["bb"] = "ボリンジャーバンドやや上寄り（やや割高）"
        elif pos <= 0.15:
            texts["bb"] = "ボリンジャーバンド下限付近（割安圏）"
        elif pos <= 0.4:
            texts["bb"] = "ボリンジャーバンドやや下寄り（やや割安）"
        else:
            texts["bb"] = "ボリンジャーバンド中位"
    else:
        terms["bb"] = 0.0

    # 長期線からの乖離率（連続）。上に離れすぎ＝過熱＝−、下に離れすぎ＝割安＝＋
    if not pd.isna(sl) and sl != 0:
        dev = (price - sl) / sl * 100.0
        terms["dev"] = float(-np.tanh(dev / 12.0))
        texts["dev"] = f"長期線からの乖離 {dev:+.1f}%"
    else:
        terms["dev"] = 0.0

    raw = sum(weights[k] * terms[k] for k in weights)
    score = int(round(_clamp(raw, -100, 100)))

    # 各要因を「買い材料／売り材料」に方向付けして根拠リストにする
    reasons = []
    for k in weights:
        if k not in texts:
            continue
        pts = int(round(weights[k] * terms[k]))
        direction = "buy" if pts >= 1 else "sell" if pts <= -1 else "neutral"
        reasons.append({"text": texts[k], "dir": direction, "points": pts})
    # 寄与の大きい順（買い材料・売り材料が分かるように）
    reasons.sort(key=lambda x: abs(x["points"]), reverse=True)

    if score >= 30:
        verdict, label = "buy", "買い時サイン"
    elif score <= -30:
        verdict, label = "sell", "売り時サイン"
    else:
        verdict, label = "neutral", "中立（様子見）"

    stats = {
        "latest_price": round(price, 2),
        "latest_date": None,
        "rsi": None if pd.isna(r) else round(float(r), 1),
        "sma_short": None if pd.isna(ss) else round(float(ss), 2),
        "sma_long": None if pd.isna(sl) else round(float(sl), 2),
        "deviation_pct": None if pd.isna(sl) or sl == 0 else round(float((price - sl) / sl * 100), 2),
    }
    return verdict, label, score, reasons, stats


# ===========================================================================
# 保有者向け：短期・中期・長期の時間軸別アドバイス（テクニカル目安）
# ===========================================================================

def analyze_horizons(dates: list, prices: list) -> list:
    """保有している前提で、短期・中期・長期それぞれの状況とスタンスの目安を返す。

    返り値: [{key, label, ok, score, stance, stance_label, comment, factors[]}, ...]
    stance: "add"（買い増し検討）/ "hold"（ホールド）/ "trim"（一部売却検討）

    ※ テクニカル指標による機械的な目安であり、投資助言・利益の保証ではない。
    """
    s = pd.Series(prices, dtype="float64")
    return [
        _horizon(s, "short", "短期（〜1ヶ月）", sw=5, lw=25, mom_days=20, need=30,
                 weights={"trend": 20, "mom": 20, "rsi": 32, "bb": 28, "dev": 0}),
        _horizon(s, "mid", "中期（3ヶ月〜1年）", sw=25, lw=75, mom_days=60, need=90,
                 weights={"trend": 32, "mom": 26, "rsi": 16, "bb": 8, "dev": 18}),
        _horizon(s, "long", "長期（1年〜）", sw=75, lw=200, mom_days=250, need=220,
                 weights={"trend": 34, "mom": 30, "rsi": 8, "bb": 0, "dev": 28}),
    ]


def _horizon(s, key, label, sw, lw, mom_days, need, weights):
    n = len(s)
    if n < need:
        return {"key": key, "label": label, "ok": False,
                "comment": f"判定に必要なデータ（約{need}営業日）がありません。"
                           "設定から日が浅いファンドでは長期判定はできません。",
                "factors": []}

    price = float(s.iloc[-1])
    sma_s = float(s.rolling(sw).mean().iloc[-1])
    sma_l = float(s.rolling(lw).mean().iloc[-1])
    r = float(_rsi(s, RSI_PERIOD).iloc[-1])

    bb_mid = s.rolling(BB_WINDOW).mean().iloc[-1]
    bb_std = s.rolling(BB_WINDOW).std(ddof=0).iloc[-1]
    bb_pos = None
    if not pd.isna(bb_std) and bb_std:
        upv = bb_mid + BB_SIGMA * bb_std
        lov = bb_mid - BB_SIGMA * bb_std
        bb_pos = (price - lov) / (upv - lov)

    base = float(s.iloc[-min(mom_days, n - 1) - 1])
    ret = price / base - 1.0 if base else 0.0
    dev = (price - sma_l) / sma_l * 100.0 if sma_l else 0.0

    # 高値からの下落率（長期の判断材料）
    peak = float(s.max())
    drawdown = (price / peak - 1.0) * 100.0 if peak else 0.0

    terms = {
        "trend": float(np.tanh((sma_s - sma_l) / sma_l * 25)) if sma_l else 0.0,
        "mom": float(np.tanh(ret * (5 if mom_days <= 60 else 2.5))),
        "rsi": _clamp((50.0 - r) / 25.0),
        "bb": _clamp((0.5 - bb_pos) * 2.0) if bb_pos is not None else 0.0,
        "dev": float(-np.tanh(dev / 12.0)),
    }
    raw = sum(weights[k] * terms[k] for k in weights)
    total_w = sum(abs(v) for v in weights.values()) or 1
    score = int(round(_clamp(raw / total_w * 100, -100, 100)))

    factors = _horizon_factors(key, sw, lw, mom_days, price, sma_s, sma_l, r,
                               bb_pos, ret, dev, drawdown)
    stance, stance_label, comment = _horizon_advice(key, score, r, ret, dev, drawdown)

    return {"key": key, "label": label, "ok": True, "score": score,
            "stance": stance, "stance_label": stance_label,
            "comment": comment, "factors": factors}


def _horizon_factors(key, sw, lw, mom_days, price, sma_s, sma_l, r, bb_pos, ret, dev, drawdown):
    f = []
    f.append(f"{sw}日線が{lw}日線を{'上回る（上向き）' if sma_s >= sma_l else '下回る（下向き）'}")
    f.append(f"直近{mom_days}営業日の騰落率 {ret*100:+.1f}%")
    f.append(f"RSI {r:.0f}")
    if key == "short" and bb_pos is not None:
        f.append(f"ボリンジャーバンド内位置 {bb_pos*100:.0f}%（0%=下限,100%=上限）")
    if key != "short":
        f.append(f"{lw}日線からの乖離 {dev:+.1f}%")
    if key == "long":
        f.append(f"期間高値からの位置 {drawdown:+.1f}%")
    return f


def _horizon_advice(key, score, r, ret, dev, drawdown):
    """スタンス（add/hold/trim）と保有者向けコメントを生成する。"""
    if score >= 30:
        stance, stance_label = "add", "買い増し検討の水準"
    elif score <= -30:
        stance, stance_label = "trim", "一部売却検討の水準"
    else:
        stance, stance_label = "hold", "ホールド（様子見）"

    if key == "short":
        if stance == "add":
            c = ("短期指標は買い寄りです。押し目と見て買い増し・積立継続を検討できる水準です。"
                 "ただし短期の反発狙いはブレも大きい点に注意してください。")
        elif stance == "trim":
            c = ("短期的に過熱気味です。急いで買い増す局面ではなく、"
                 "利益が乗っている場合は一部利益確定も選択肢に入る水準です。")
        else:
            c = "短期は方向感が乏しく、慌てて売買せず様子見が無難な水準です。"
        if r >= RSI_OVERBOUGHT:
            c += f"（RSI {r:.0f} と買われすぎ圏です）"
        elif r <= RSI_OVERSOLD:
            c += f"（RSI {r:.0f} と売られすぎ圏で、反発が起きやすい状態です）"
    elif key == "mid":
        if stance == "add":
            c = ("中期トレンドは上向きです。トレンドに沿った買い増し・積立継続を"
                 "検討できる水準です。")
        elif stance == "trim":
            c = ("中期トレンドが下向きです。ナンピン（下がるたびの買い増し）は慎重に。"
                 "含み益がある場合は一部利益確定、含み損の場合は保有継続の是非を"
                 "検討する水準です。")
        else:
            c = "中期はトレンド転換の見極め局面です。積立は継続しつつ、追加の一括買いは急がない水準です。"
        if dev >= 10:
            c += f"（{'75' if key=='mid' else ''}日線から+{dev:.1f}%と上振れしており、押し目を待つ選択肢もあります）"
    else:  # long
        if stance == "add":
            c = ("長期トレンドは上向きです。長期保有・積立継続に追い風の状態です。"
                 "高値圏でも時間分散（積立）を保てば大きな問題になりにくい水準です。")
        elif stance == "trim":
            c = ("長期トレンドが崩れています。保有目的（老後資金など）と照らして、"
                 "配分の見直しや一部売却を検討する水準です。積立自体は下落局面の"
                 "取得単価を下げる効果もあるため、目的次第で継続も選択肢です。")
        else:
            c = "長期は横ばい圏です。積立は継続し、大きな配分変更は急がない水準です。"
        if drawdown <= -20:
            c += f"（期間高値から{drawdown:.1f}%の調整局面にあります）"
    return stance, stance_label, c


# ===========================================================================
# 保有全体（ポートフォリオ）の時間軸別アドバイス
# ===========================================================================

def portfolio_advice(funds: list):
    """ウォッチリスト全体を「保有している」前提で、期間ごとの全体アドバイスを返す。

    funds: [{name, ok, value(評価額・None可), hz:[{key,ok,score},...]}, ...]
    評価額があれば評価額加重、無ければ等ウェイトで全体スコアを合成する。

    ※ テクニカル指標による機械的な目安であり、投資助言ではない。
    """
    ok_funds = [f for f in funds if f.get("ok") and f.get("hz")]
    if not ok_funds:
        return None

    any_units = any((f.get("value") or 0) > 0 for f in ok_funds)
    total_value = round(sum(f.get("value") or 0 for f in ok_funds)) if any_units else None
    for f in ok_funds:
        f["_w"] = float(f.get("value") or 0) if any_units else 1.0
    wsum = sum(f["_w"] for f in ok_funds) or 1.0

    labels = {"short": "短期（〜1ヶ月）", "mid": "中期（3ヶ月〜1年）", "long": "長期（1年〜）"}
    horizons = []
    for key in ("short", "mid", "long"):
        entries = []
        for f in ok_funds:
            h = next((x for x in f["hz"] if x.get("key") == key and x.get("ok")), None)
            if h is not None and f["_w"] > 0:
                entries.append((f, int(h["score"])))
        if not entries:
            horizons.append({"key": key, "label": labels[key], "ok": False,
                             "comment": "判定に必要な履歴（または保有口数）のある銘柄がありません。"})
            continue
        ew = sum(f["_w"] for f, _ in entries) or 1.0
        score = int(round(sum(f["_w"] * sc for f, sc in entries) / ew))
        if score >= 30:
            stance, stance_label = "add", "買い増し検討の水準"
        elif score <= -30:
            stance, stance_label = "trim", "一部売却検討の水準"
        else:
            stance, stance_label = "hold", "ホールド（様子見）"

        buys = sorted([(f, sc) for f, sc in entries if sc >= 30], key=lambda x: -x[1])
        sells = sorted([(f, sc) for f, sc in entries if sc <= -30], key=lambda x: x[1])
        buy_share = sum(f["_w"] for f, _ in buys) / ew * 100
        sell_share = sum(f["_w"] for f, _ in sells) / ew * 100
        comment = _pf_comment(key, stance, buys, sells, buy_share, sell_share)
        horizons.append({"key": key, "label": labels[key], "ok": True, "score": score,
                         "stance": stance, "stance_label": stance_label,
                         "comment": comment})

    # 集中リスクの注意（評価額ベースのときのみ）
    note = None
    if any_units:
        top = max(ok_funds, key=lambda f: f["_w"])
        share = top["_w"] / wsum * 100
        if share >= 40:
            note = (f"「{_short_name(top['name'])}」が評価額全体の{share:.0f}%を占めています。"
                    "全体の値動きがこの1本に大きく左右されるため、分散の観点では"
                    "配分の見直しも検討材料です。")
    else:
        note = ("保有口数が未登録のため、全銘柄を同じ比率とみなして評価しています。"
                "一覧の「保有口数」を入力すると、評価額に応じた判定になります。")

    return {"ok": True, "total_value": total_value,
            "weights_mode": "value" if any_units else "equal",
            "horizons": horizons, "note": note}


def _short_name(name, limit=20):
    return name if len(name) <= limit else name[:limit] + "…"


def _names(pairs, n=2):
    return "、".join(_short_name(f["name"], 16) for f, _ in pairs[:n])


def _pf_comment(key, stance, buys, sells, buy_share, sell_share):
    if key == "short":
        if stance == "add":
            c = (f"保有全体では短期的に買い寄りです。{_names(buys)}（全体の{buy_share:.0f}%）に"
                 "押し目・反発のサインが出ており、積立の継続やスポットの買い増しを検討できる水準です。")
        elif stance == "trim":
            c = (f"保有全体では短期的に過熱寄りです。特に{_names(sells)}（全体の{sell_share:.0f}%）が"
                 "過熱圏にあります。利益確定を検討するなら、比率の高いこれらの銘柄からが目安です。")
        else:
            c = "保有全体では短期は中立で、急いで売買する必要のない水準です。"
            if buys and sells:
                c += (f"（買い寄り：{_names(buys)}／売り寄り：{_names(sells)}と強弱が混在しています）")
    elif key == "mid":
        if stance == "add":
            c = (f"中期トレンドが上向きの銘柄が中心です（{_names(buys)}など全体の{buy_share:.0f}%）。"
                 "トレンドに沿った積立継続・買い増しを検討できる水準です。")
        elif stance == "trim":
            c = (f"中期トレンドが下向きの銘柄が全体の{sell_share:.0f}%を占めます（{_names(sells)}など）。"
                 "ナンピンは慎重に。含み益のある銘柄は一部利益確定、含み損の銘柄は保有継続の是非を検討する水準です。")
        else:
            c = "中期は全体として見極め局面です。積立は継続しつつ、大きな追加投資や売却は急がない水準です。"
    else:  # long
        if stance == "add":
            c = (f"長期では上昇トレンドの銘柄が大半です（全体の{buy_share:.0f}%）。"
                 "長期保有・積立継続に追い風の状態で、配分を大きく崩す必要のない水準です。")
        elif stance == "trim":
            c = (f"長期トレンドが崩れている銘柄が全体の{sell_share:.0f}%を占めます（{_names(sells)}など）。"
                 "保有目的（老後資金・教育資金など）に照らして、資産配分の見直しを検討する水準です。")
        else:
            c = "長期では強弱が混在または横ばいで、大きな配分変更を急ぐ状況ではありません。積立の継続が基本の水準です。"
    return c
