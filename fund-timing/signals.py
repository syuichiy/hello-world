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
    reasons = []
    last = len(s) - 1
    price = float(s.iloc[last])

    ss, sl = sma_short.iloc[last], sma_long.iloc[last]
    r = rsi.iloc[last]
    up, lo = bb_upper.iloc[last], bb_lower.iloc[last]

    terms = {}

    # トレンド：短期線と長期線の乖離（連続）。上向きほど＋。
    if not (pd.isna(ss) or pd.isna(sl)) and sl:
        gap = (ss - sl) / sl
        terms["trend"] = float(np.tanh(gap * 25))
        if ss > sl:
            reasons.append("短期移動平均が長期移動平均を上回る（上昇トレンド寄り）")
        else:
            reasons.append("短期移動平均が長期移動平均を下回る（下降トレンド寄り）")
    else:
        terms["trend"] = 0.0

    # モメンタム：直近約60営業日の騰落率（連続）。勢いが強いほど＋。
    look = min(60, last)
    base = float(s.iloc[last - look]) if look > 0 else 0.0
    if base:
        ret = price / base - 1.0
        terms["mom"] = float(np.tanh(ret * 5))
    else:
        terms["mom"] = 0.0

    # RSI：50からの距離で連続評価（売られすぎ＝＋、買われすぎ＝−、逆張り寄り）
    if not pd.isna(r):
        terms["rsi"] = _clamp((50.0 - float(r)) / 25.0)
        if r <= RSI_OVERSOLD:
            reasons.append(f"RSIが{r:.0f}で売られすぎ圏（反発期待＝買い寄り）")
        elif r >= RSI_OVERBOUGHT:
            reasons.append(f"RSIが{r:.0f}で買われすぎ圏（過熱＝売り寄り）")
        else:
            reasons.append(f"RSIは{r:.0f}")
    else:
        terms["rsi"] = 0.0

    # ボリンジャーバンド内の位置（連続）。下限寄り＝割安＝＋、上限寄り＝割高＝−
    if not (pd.isna(up) or pd.isna(lo)) and up != lo:
        pos = (price - lo) / (up - lo)   # 0=下限, 1=上限
        terms["bb"] = _clamp((0.5 - pos) * 2.0)
        if pos <= 0.15:
            reasons.append("価格がボリンジャーバンド下限付近（割安圏＝買い寄り）")
        elif pos >= 0.85:
            reasons.append("価格がボリンジャーバンド上限付近（割高圏＝売り寄り）")
    else:
        terms["bb"] = 0.0

    # 長期線からの乖離率（連続）。上に離れすぎ＝過熱＝−、下に離れすぎ＝割安＝＋
    dev = None
    if not pd.isna(sl) and sl != 0:
        dev = (price - sl) / sl * 100.0
        terms["dev"] = float(-np.tanh(dev / 12.0))
        if dev <= -8:
            reasons.append(f"長期線から{dev:.1f}%下方乖離（売られすぎ気味）")
        elif dev >= 8:
            reasons.append(f"長期線から+{dev:.1f}%上方乖離（買われすぎ気味）")
    else:
        terms["dev"] = 0.0

    weights = {"trend": 28, "mom": 22, "rsi": 22, "bb": 16, "dev": 12}
    raw = sum(weights[k] * terms[k] for k in weights)
    score = int(round(_clamp(raw, -100, 100)))

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
