"""
╔══════════════════════════════════════════════════════════════════════════════╗
║           TREJDINGHUB — Market Profile Trading Algorithm v1.0              ║
║         TPO · Volume Profile · CVD · 4 Setupy · Reguły Decyzyjne          ║
╚══════════════════════════════════════════════════════════════════════════════╝

Strategia oparta na metodologii TrejdingHub:
  - Oblicza POC / Value Area (VAH/VAL) / Initial Balance per sesja
  - Wykrywa Single Prints i Poor Lows/Highs
  - Skanuje 4 mechaniczne setupy
  - Generuje sygnały z Entry / SL / TP / R:R

Wymagania:
    pip install requests pandas numpy colorama tabulate

Uruchomienie:
    python trejdinghub_algo.py --symbol BTCUSDT --days 30
    python trejdinghub_algo.py --symbol ETHUSDT --days 14 --export csv
    python trejdinghub_algo.py --symbol SOLUSDT --days 7  --live

"""

import argparse
import json
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone, timedelta
from typing import Optional

import numpy as np
import pandas as pd
import requests
from colorama import Fore, Style, init as colorama_init
from tabulate import tabulate

colorama_init(autoreset=True)

# ─── CONFIG ───────────────────────────────────────────────────────────────────

BINANCE_SPOT   = "https://api.binance.com/api/v3"
BINANCE_FUTURES = "https://fapi.binance.com/fapi/v1"
BINANCE_FDATA  = "https://fapi.binance.com/futures/data"

VA_TARGET      = 0.70   # Value Area = 70% of volume
IB_HOURS       = 1      # Initial Balance = first N hours
TICK_DIVIDER   = 200    # number of price buckets for volume profile
MIN_TAIL_RATIO = 0.15   # minimum fraction of range to qualify as Buying/Selling Tail
POOR_LH_BARS   = 2      # min TPO blocks at extreme to flag as Poor Low/High
S1_ACCEPT_BARS = 2      # 80% Rule: need N 30-min bars inside PDVA

# HTS (Harmonious Trend System) — wstęgi trendowe TrejdingHub
HTS_SLOW_PERIOD = 55    # EMA wolnej wstęgi (czerwona) — "ostatni bastion byków"
HTS_SLOW_MULT   = 2.0   # mnożnik odchylenia std
HTS_FAST_PERIOD = 21    # EMA szybkiej wstęgi (niebieska) — sygnały wejść
HTS_FAST_MULT   = 1.5

# MACD z dywergencjami (własna wersja TrejdingHub)
MACD_FAST        = 12
MACD_SLOW        = 26
MACD_SIGNAL      = 9
MACD_DIV_LOOKBACK = 20  # okno do wykrywania dywergencji

# ─── DATA CLASSES ─────────────────────────────────────────────────────────────

@dataclass
class MarketProfile:
    date:        str
    poc:         float
    vah:         float
    val:         float
    high:        float
    low:         float
    open:        float
    close:       float
    volume:      float
    ib_high:     float
    ib_low:      float
    single_prints: list   = field(default_factory=list)  # list of (low, high) tuples
    poor_lows:   list     = field(default_factory=list)  # price levels
    poor_highs:  list     = field(default_factory=list)
    buying_tails:  list   = field(default_factory=list)  # (low, high) extent of tail
    selling_tails: list   = field(default_factory=list)
    profile_df:  Optional[pd.DataFrame] = field(default=None, repr=False)

    @property
    def va_range(self):   return self.vah - self.val
    @property
    def ib_range(self):   return self.ib_high - self.ib_low
    @property
    def day_range(self):  return self.high - self.low
    @property
    def is_trend_day(self):
        return (self.ib_range / self.day_range < 0.30) if self.day_range > 0 else False
    @property
    def is_non_trend_day(self):
        return (self.ib_range / self.day_range > 0.85) if self.day_range > 0 else False


@dataclass
class Signal:
    timestamp:   str
    symbol:      str
    setup:       str
    direction:   str   # LONG / SHORT
    entry:       float
    stop_loss:   float
    take_profit: float
    rr:          float
    confidence:  str   # HIGH / MEDIUM / LOW
    checklist:   dict
    notes:       str   = ""

    def passed_checklist(self) -> bool:
        return sum(self.checklist.values()) >= 4  # min 4/6 punktów

    def to_dict(self) -> dict:
        return {
            "timestamp":   self.timestamp,
            "symbol":      self.symbol,
            "setup":       self.setup,
            "direction":   self.direction,
            "entry":       round(self.entry, 4),
            "stop_loss":   round(self.stop_loss, 4),
            "take_profit": round(self.take_profit, 4),
            "rr":          round(self.rr, 2),
            "confidence":  self.confidence,
            "checklist_ok": self.passed_checklist(),
            "notes":       self.notes,
        }


# ─── BINANCE DATA FETCHER ─────────────────────────────────────────────────────

class BinanceFetcher:
    def __init__(self, symbol: str):
        self.symbol = symbol.upper().replace("/", "")

    def _get(self, base: str, endpoint: str, params: dict) -> list | dict:
        url = f"{base}/{endpoint}"
        for attempt in range(3):
            try:
                r = requests.get(url, params=params, timeout=10)
                r.raise_for_status()
                return r.json()
            except requests.exceptions.RequestException as e:
                if attempt == 2:
                    raise ConnectionError(f"Binance API error ({url}): {e}")
                time.sleep(1.5)

    def fetch_klines(self, interval: str = "30m", days: int = 30,
                     start_ms: int = None, end_ms: int = None) -> pd.DataFrame:
        """Pobiera OHLCV ze Spot Binance."""
        params = {"symbol": self.symbol, "interval": interval,
                  "limit": min(days * 48 + 2, 1500)}
        if start_ms: params["startTime"] = start_ms
        if end_ms:   params["endTime"]   = end_ms
        raw = self._get(BINANCE_SPOT, "klines", params)
        df = pd.DataFrame(raw, columns=[
            "open_time","open","high","low","close","volume",
            "close_time","quote_vol","trades","taker_buy_vol","taker_buy_quote","ignore"
        ])
        for c in ["open","high","low","close","volume","taker_buy_vol"]:
            df[c] = df[c].astype(float)
        df["open_time"] = pd.to_datetime(df["open_time"], unit="ms", utc=True)
        df["date"] = df["open_time"].dt.date.astype(str)
        df["hour"] = df["open_time"].dt.hour
        return df.reset_index(drop=True)

    def fetch_ticker(self) -> dict:
        """Bieżąca cena i 24h stats."""
        return self._get(BINANCE_SPOT, "ticker/24hr", {"symbol": self.symbol})

    def fetch_oi_history(self) -> list:
        """Open Interest z ostatnich 3 godzin (Futures)."""
        try:
            return self._get(BINANCE_FDATA, "openInterestHist",
                             {"symbol": self.symbol, "period": "1h", "limit": 3})
        except Exception:
            return []

    def fetch_perp_klines(self, interval: str = "30m", limit: int = 48) -> pd.DataFrame:
        """Kontrakty perpetual — do CVD."""
        try:
            raw = self._get(BINANCE_FUTURES, "klines",
                            {"symbol": self.symbol, "interval": interval, "limit": limit})
            df = pd.DataFrame(raw, columns=[
                "open_time","open","high","low","close","volume",
                "close_time","quote_vol","trades","taker_buy_vol","taker_buy_quote","ignore"
            ])
            for c in ["volume","taker_buy_vol"]:
                df[c] = df[c].astype(float)
            return df
        except Exception:
            return pd.DataFrame()


# ─── MARKET PROFILE ENGINE ────────────────────────────────────────────────────

class MarketProfileEngine:
    def __init__(self, tick_divider: int = TICK_DIVIDER, va_target: float = VA_TARGET):
        self.tick_divider = tick_divider
        self.va_target    = va_target

    def compute_volume_profile(self, df_day: pd.DataFrame) -> pd.DataFrame:
        """
        Buduje Volume Profile dla jednej sesji z klines 30m.
        Każda świeca rozdziela wolumen równomiernie na bucket między jej H i L.
        """
        hi = df_day["high"].max()
        lo = df_day["low"].min()
        if hi == lo:
            return pd.DataFrame({"price": [hi], "volume": [df_day["volume"].sum()]})

        tick = (hi - lo) / self.tick_divider
        buckets = np.arange(lo, hi + tick, tick)
        vol_profile = np.zeros(len(buckets))

        for _, row in df_day.iterrows():
            row_lo, row_hi, row_vol = row["low"], row["high"], row["volume"]
            in_range = (buckets >= row_lo) & (buckets <= row_hi)
            n = in_range.sum()
            if n > 0:
                vol_profile[in_range] += row_vol / n

        return pd.DataFrame({"price": buckets, "volume": vol_profile})

    def compute_poc_and_va(self, vp: pd.DataFrame) -> tuple[float, float, float]:
        """Zwraca (POC, VAH, VAL) z Volume Profile."""
        poc_idx = vp["volume"].idxmax()
        poc     = vp.loc[poc_idx, "price"]
        total   = vp["volume"].sum()
        target  = total * self.va_target

        lo_idx = hi_idx = poc_idx
        acc    = vp.loc[poc_idx, "volume"]

        while acc < target:
            lo_vol = vp.loc[lo_idx - 1, "volume"] if lo_idx > 0              else 0
            hi_vol = vp.loc[hi_idx + 1, "volume"] if hi_idx < len(vp) - 1   else 0
            if lo_vol >= hi_vol and lo_idx > 0:
                lo_idx -= 1; acc += lo_vol
            elif hi_idx < len(vp) - 1:
                hi_idx += 1; acc += hi_vol
            else:
                break

        return float(poc), float(vp.loc[hi_idx, "price"]), float(vp.loc[lo_idx, "price"])

    def detect_single_prints(self, vp: pd.DataFrame, threshold_pct: float = 0.03) -> list:
        """
        Single Prints: Cena przeleciała tak szybko, że wolumen < threshold * max_vol.
        Zwraca listę (low, high) stref.
        """
        max_vol   = vp["volume"].max()
        threshold = max_vol * threshold_pct
        sparse    = vp[vp["volume"] < threshold].copy()
        if sparse.empty:
            return []
        gaps = []
        g_start = None
        prev_idx = None
        for idx in sparse.index:
            if prev_idx is None or idx != prev_idx + 1:
                if g_start is not None:
                    gaps.append((float(vp.loc[g_start, "price"]),
                                 float(vp.loc[prev_idx, "price"])))
                g_start = idx
            prev_idx = idx
        if g_start is not None and prev_idx is not None:
            gaps.append((float(vp.loc[g_start, "price"]),
                         float(vp.loc[prev_idx, "price"])))
        return gaps

    def detect_poor_extremes(self, df_day: pd.DataFrame, vp: pd.DataFrame) -> tuple[list, list]:
        """
        Poor Lows/Highs: Wiele 30-min świec handluje blisko ekstremum (brak ostrego ogona).
        Buying/Selling Tail: Jeden lub dwa agresywne bloki odrzucające cenę.
        """
        day_hi = df_day["high"].max()
        day_lo = df_day["low"].min()
        day_rng = day_hi - day_lo
        if day_rng == 0:
            return [], []

        tick = (day_hi - day_lo) / self.tick_divider
        tail_zone = day_rng * MIN_TAIL_RATIO

        # Dolny ekstrem
        lo_zone_mask = vp["price"] <= day_lo + tail_zone
        lo_zone_vol  = vp[lo_zone_mask]["volume"].sum()
        lo_bars_at_extreme = (df_day["low"] <= day_lo + tick * 3).sum()

        # Górny ekstrem
        hi_zone_mask = vp["price"] >= day_hi - tail_zone
        hi_zone_vol  = vp[hi_zone_mask]["volume"].sum()
        hi_bars_at_extreme = (df_day["high"] >= day_hi - tick * 3).sum()

        poor_lows  = [round(day_lo, 4)] if lo_bars_at_extreme >= POOR_LH_BARS else []
        poor_highs = [round(day_hi, 4)] if hi_bars_at_extreme >= POOR_LH_BARS else []

        return poor_lows, poor_highs

    def build_profile(self, df_day: pd.DataFrame, date_str: str) -> MarketProfile:
        """Buduje pełny MarketProfile dla jednej sesji."""
        if df_day.empty or len(df_day) < 2:
            return None

        vp = self.compute_volume_profile(df_day)
        poc, vah, val = self.compute_poc_and_va(vp)

        # Initial Balance = pierwsza godzina (pierwsze 2 świece 30m)
        ib_df   = df_day[df_day["hour"] < (df_day["hour"].iloc[0] + IB_HOURS)]
        ib_high = ib_df["high"].max() if not ib_df.empty else df_day["high"].max()
        ib_low  = ib_df["low"].min()  if not ib_df.empty else df_day["low"].min()

        single_prints          = self.detect_single_prints(vp)
        poor_lows, poor_highs  = self.detect_poor_extremes(df_day, vp)

        return MarketProfile(
            date=date_str,
            poc=round(poc, 4), vah=round(vah, 4), val=round(val, 4),
            high=round(df_day["high"].max(), 4),
            low=round(df_day["low"].min(), 4),
            open=round(df_day["open"].iloc[0], 4),
            close=round(df_day["close"].iloc[-1], 4),
            volume=round(df_day["volume"].sum(), 2),
            ib_high=round(ib_high, 4), ib_low=round(ib_low, 4),
            single_prints=single_prints,
            poor_lows=poor_lows, poor_highs=poor_highs,
            profile_df=vp,
        )

    def build_all(self, df: pd.DataFrame) -> dict[str, MarketProfile]:
        """Buduje profile dla wszystkich sesji w DataFrame."""
        profiles = {}
        for date_str, group in df.groupby("date"):
            p = self.build_profile(group.reset_index(drop=True), date_str)
            if p:
                profiles[date_str] = p
        return dict(sorted(profiles.items()))


# ─── CVD CALCULATOR ───────────────────────────────────────────────────────────

def calc_cvd(df: pd.DataFrame) -> pd.Series:
    """Cumulative Volume Delta: taker_buy_vol * 2 - total_volume (przybliżenie)."""
    delta = df["taker_buy_vol"] * 2 - df["volume"]
    return delta.cumsum()


def cvd_trend(cvd_series: pd.Series, lookback: int = 6) -> str:
    if cvd_series.empty or len(cvd_series) < 2:
        return "neutral"
    recent = cvd_series.iloc[-lookback:]
    change = recent.iloc[-1] - recent.iloc[0]
    scale  = abs(cvd_series.iloc[-1]) or 1
    ratio  = change / scale
    if ratio > 0.03:  return "bullish"
    if ratio < -0.03: return "bearish"
    return "neutral"


def oi_trend(oi_history: list) -> str:
    if len(oi_history) < 2:
        return "neutral"
    try:
        delta = float(oi_history[-1]["sumOpenInterest"]) - float(oi_history[0]["sumOpenInterest"])
        return "rising" if delta > 0 else "falling" if delta < 0 else "neutral"
    except Exception:
        return "neutral"


# ─── HTS INDICATOR ────────────────────────────────────────────────────────────

class HTSIndicator:
    """
    Harmonious Trend System — własny wskaźnik trendowy TrejdingHub (Rafał Ławniczak).

    Dwie pary wstęg opartych na EMA + kanale odchylenia standardowego:
      - Wstęga wolna (czerwona): EMA(55) ± 2.0 * std  → "ostatni bastion byków"
      - Wstęga szybka (niebieska): EMA(21) ± 1.5 * std → sygnały wejść

    Interpretacja:
      - cena > wstęga wolna   → bullish bias
      - cena < wstęga wolna   → bearish bias
      - cena wraca do wstęgi wolnej i odbija → high-probability setup
      - cross szybkiej nad wolną → zmiana trendu (bycza)
      - cross szybkiej pod wolną → zmiana trendu (niedźwiedzia)
    """

    def __init__(self, slow_period: int = HTS_SLOW_PERIOD, slow_mult: float = HTS_SLOW_MULT,
                 fast_period: int = HTS_FAST_PERIOD, fast_mult: float = HTS_FAST_MULT):
        self.slow_p    = slow_period
        self.slow_mult = slow_mult
        self.fast_p    = fast_period
        self.fast_mult = fast_mult

    def _ema_band(self, series: pd.Series, period: int, mult: float) -> tuple:
        """Oblicza EMA + kanał odchylenia standardowego."""
        ema  = series.ewm(span=period, adjust=False).mean()
        std  = series.rolling(period).std()
        upper = ema + mult * std
        lower = ema - mult * std
        return ema, upper, lower

    def calculate(self, df: pd.DataFrame) -> pd.DataFrame:
        """
        Dodaje kolumny HTS do DataFrame.
        Wejście: df z kolumną 'close'.
        Wyjście: df z kolumnami HTS.
        """
        close = df["close"]

        # Wstęgi
        slow_mid, slow_hi, slow_lo = self._ema_band(close, self.slow_p, self.slow_mult)
        fast_mid, fast_hi, fast_lo = self._ema_band(close, self.fast_p, self.fast_mult)

        df = df.copy()
        df["hts_slow_mid"]   = slow_mid
        df["hts_slow_upper"] = slow_hi
        df["hts_slow_lower"] = slow_lo
        df["hts_fast_mid"]   = fast_mid
        df["hts_fast_upper"] = fast_hi
        df["hts_fast_lower"] = fast_lo

        # Bias: cena vs wolna wstęga (ostatni bastion)
        df["hts_bias"] = np.where(close > slow_mid, "bullish",
                         np.where(close < slow_mid, "bearish", "neutral"))

        # Cross szybkiej nad/pod wolną
        fast_above_slow = fast_mid > slow_mid
        prev_fast_above = fast_above_slow.shift(1).fillna(False)
        df["hts_cross"] = np.where(fast_above_slow & ~prev_fast_above, "bullish",
                          np.where(~fast_above_slow & prev_fast_above, "bearish", "none"))

        # Bounce: cena dotknęła wolnej wstęgi i zamknęła się powyżej niej w tej samej świecy
        touched_slow_lo = df["low"] <= slow_lo * 1.002  # 0.2% tolerancja
        closed_above    = close > slow_lo
        df["hts_bounce_bull"] = touched_slow_lo & closed_above & (df["hts_bias"] == "bullish")

        touched_slow_hi = df["high"] >= slow_hi * 0.998
        closed_below    = close < slow_hi
        df["hts_bounce_bear"] = touched_slow_hi & closed_below & (df["hts_bias"] == "bearish")

        # Squeeze: wstęgi się zwężają → wybicie w przygotowaniu
        band_width_slow = (slow_hi - slow_lo) / slow_mid
        df["hts_squeeze"] = band_width_slow < band_width_slow.rolling(20).mean() * 0.8

        return df

    def latest_signal(self, df: pd.DataFrame) -> dict:
        """Zwraca aktualny sygnał HTS (ostatni wiersz)."""
        if df.empty or "hts_bias" not in df.columns:
            return {"bias": "neutral", "cross": "none", "bounce": False, "squeeze": False}
        last = df.iloc[-1]
        return {
            "bias":         last.get("hts_bias", "neutral"),
            "cross":        last.get("hts_cross", "none"),
            "bounce_bull":  bool(last.get("hts_bounce_bull", False)),
            "bounce_bear":  bool(last.get("hts_bounce_bear", False)),
            "squeeze":      bool(last.get("hts_squeeze", False)),
            "slow_mid":     round(float(last.get("hts_slow_mid", 0)), 4),
            "fast_mid":     round(float(last.get("hts_fast_mid", 0)), 4),
            "slow_upper":   round(float(last.get("hts_slow_upper", 0)), 4),
            "slow_lower":   round(float(last.get("hts_slow_lower", 0)), 4),
        }


# ─── MACD Z DYWERGENCJAMI ─────────────────────────────────────────────────────

class MACDDivergence:
    """
    MACD z wykrywaniem dywergencji — metodologia TrejdingHub.

    Dywergencja bycza: cena robi niższy dołek, MACD robi wyższy dołek
    Dywergencja niedźwiedzia: cena robi wyższy szczyt, MACD robi niższy szczyt

    Przykład z GE Aerospace (kwi 2026): "cena robi niższy dołek a MACD wyższy"
    → sygnał odwrócenia trendu
    """

    def __init__(self, fast: int = MACD_FAST, slow: int = MACD_SLOW,
                 signal: int = MACD_SIGNAL, lookback: int = MACD_DIV_LOOKBACK):
        self.fast     = fast
        self.slow     = slow
        self.signal   = signal
        self.lookback = lookback

    def calculate(self, df: pd.DataFrame) -> pd.DataFrame:
        """Dodaje kolumny MACD do DataFrame."""
        close   = df["close"]
        ema_f   = close.ewm(span=self.fast,   adjust=False).mean()
        ema_s   = close.ewm(span=self.slow,   adjust=False).mean()
        macd    = ema_f - ema_s
        sig_    = macd.ewm(span=self.signal,  adjust=False).mean()
        hist    = macd - sig_

        df = df.copy()
        df["macd"]        = macd
        df["macd_signal"] = sig_
        df["macd_hist"]   = hist
        return df

    def _find_pivots(self, series: pd.Series, window: int = 5) -> tuple[list, list]:
        """Znajduje lokalne szczyty i dołki w serii."""
        highs, lows = [], []
        for i in range(window, len(series) - window):
            sl = series.iloc[i - window: i + window + 1]
            if series.iloc[i] == sl.max():
                highs.append(i)
            if series.iloc[i] == sl.min():
                lows.append(i)
        return highs, lows

    def find_divergences(self, df: pd.DataFrame) -> list:
        """
        Wykrywa dywergencje bycze i niedźwiedzie.
        Zwraca listę słowników z opisem każdej dywergencji.
        """
        if "macd" not in df.columns:
            df = self.calculate(df)

        if len(df) < self.lookback * 2:
            return []

        window = df.iloc[-self.lookback * 2:]
        close  = window["close"].reset_index(drop=True)
        macd   = window["macd"].reset_index(drop=True)
        dates  = window.index.tolist() if hasattr(window.index, "tolist") else list(range(len(window)))

        price_highs, price_lows = self._find_pivots(close)
        macd_highs,  macd_lows  = self._find_pivots(macd)
        divergences = []

        # Dywergencja niedźwiedzia: wyższy szczyt ceny + niższy szczyt MACD
        if len(price_highs) >= 2 and len(macd_highs) >= 2:
            ph1, ph2 = price_highs[-2], price_highs[-1]
            mh_near  = [h for h in macd_highs if abs(h - ph2) <= 5]
            mh_prev  = [h for h in macd_highs if abs(h - ph1) <= 5]
            if mh_near and mh_prev:
                price_rising = close.iloc[ph2] > close.iloc[ph1]
                macd_falling = macd.iloc[mh_near[-1]] < macd.iloc[mh_prev[-1]]
                if price_rising and macd_falling:
                    strength = abs(macd.iloc[mh_near[-1]] - macd.iloc[mh_prev[-1]])
                    divergences.append({
                        "type":        "bearish",
                        "price_level": round(float(close.iloc[ph2]), 4),
                        "macd_level":  round(float(macd.iloc[mh_near[-1]]), 6),
                        "strength":    round(float(strength), 6),
                        "bar_ago":     len(window) - ph2 - 1,
                        "description": f"Wyższy szczyt ceny ({close.iloc[ph2]:.2f} vs {close.iloc[ph1]:.2f}) "
                                       f"+ niższy MACD → słabnący impet wzrostowy"
                    })

        # Dywergencja bycza: niższy dołek ceny + wyższy dołek MACD
        if len(price_lows) >= 2 and len(macd_lows) >= 2:
            pl1, pl2 = price_lows[-2], price_lows[-1]
            ml_near  = [l for l in macd_lows if abs(l - pl2) <= 5]
            ml_prev  = [l for l in macd_lows if abs(l - pl1) <= 5]
            if ml_near and ml_prev:
                price_falling = close.iloc[pl2] < close.iloc[pl1]
                macd_rising   = macd.iloc[ml_near[-1]] > macd.iloc[ml_prev[-1]]
                if price_falling and macd_rising:
                    strength = abs(macd.iloc[ml_near[-1]] - macd.iloc[ml_prev[-1]])
                    divergences.append({
                        "type":        "bullish",
                        "price_level": round(float(close.iloc[pl2]), 4),
                        "macd_level":  round(float(macd.iloc[ml_near[-1]]), 6),
                        "strength":    round(float(strength), 6),
                        "bar_ago":     len(window) - pl2 - 1,
                        "description": f"Niższy dołek ceny ({close.iloc[pl2]:.2f} vs {close.iloc[pl1]:.2f}) "
                                       f"+ wyższy MACD → potencjalne odwrócenie"
                    })

        return divergences

    def latest_state(self, df: pd.DataFrame) -> dict:
        """Zwraca aktualny stan MACD (ostatni wiersz) + dywergencje."""
        if "macd" not in df.columns:
            df = self.calculate(df)
        last = df.iloc[-1]
        divs = self.find_divergences(df)
        active_div = "none"
        if divs:
            active_div = divs[-1]["type"]
        return {
            "macd":       round(float(last["macd"]),        6),
            "signal":     round(float(last["macd_signal"]), 6),
            "histogram":  round(float(last["macd_hist"]),   6),
            "above_zero": bool(last["macd"] > 0),
            "divergence": active_div,
            "div_details": divs[-1] if divs else None,
        }


# ─── SIGNAL SCANNER ───────────────────────────────────────────────────────────

class SignalScanner:
    """
    Skanuje 4 setupy TrejdingHub dla bieżącej sesji vs poprzedni dzień.
    Uwzględnia HTS bias i dywergencje MACD jako dodatkowe filtry (2026).
    """

    def __init__(self, symbol: str, spot_cvd: str = "neutral",
                 perp_cvd: str = "neutral", oi: str = "neutral",
                 hts_bias: str = "neutral", macd_divergence: str = "none"):
        self.symbol         = symbol
        self.spot_cvd       = spot_cvd
        self.perp_cvd       = perp_cvd
        self.oi             = oi
        self.hts_bias       = hts_bias        # z HTSIndicator.latest_signal()
        self.macd_div       = macd_divergence  # "bullish"/"bearish"/"none"

    # ── Checklist (6 punktów — rozszerzona o HTS) ────────────────────────────

    def _build_checklist(self, htf_bias: str, direction: str,
                         delta_trap: bool = False) -> dict:
        """Zwraca słownik warunków checklisty (6 punktów wg TrejdingHub 2026)."""
        dir_bias = direction.lower()
        spot_ok  = (self.spot_cvd == dir_bias or
                    (dir_bias == "long"  and self.spot_cvd in ["bullish", "divergence_bull"]) or
                    (dir_bias == "short" and self.spot_cvd in ["bearish", "divergence_bear"]))
        new_cap  = (
            (self.oi == "rising" and self.spot_cvd == "bullish" and dir_bias == "long") or
            (self.oi == "rising" and self.spot_cvd == "bearish" and dir_bias == "short") or
            self.oi == "neutral"
        )
        perp_warn = (
            (dir_bias == "long"  and self.perp_cvd == "bullish" and self.spot_cvd != "bullish") or
            (dir_bias == "short" and self.perp_cvd == "bearish" and self.spot_cvd != "bearish")
        )
        # HTS: wstęga wolna (czerwona) jako filtr trendu
        hts_ok = (
            (dir_bias == "long"  and self.hts_bias in ["bullish", "neutral"]) or
            (dir_bias == "short" and self.hts_bias in ["bearish", "neutral"])
        )
        # MACD dywergencja potwierdza kierunek
        macd_ok = (
            self.macd_div == "none" or
            (dir_bias == "long"  and self.macd_div == "bullish") or
            (dir_bias == "short" and self.macd_div == "bearish")
        )

        return {
            "HTF_bias_jasny":      htf_bias in [dir_bias, "neutral"],
            "Spot_CVD_potwierdza": spot_ok,
            "Nowy_kapital_OI":     new_cap,
            "Brak_Delta_Trap":     not delta_trap,
            "HTS_bias_zgodny":     hts_ok,
            "MACD_brak_sprzecznosci": macd_ok,
        }

    def _confidence(self, checklist: dict) -> str:
        score = sum(checklist.values())
        if score >= 6: return "HIGH"
        if score >= 4: return "MEDIUM"
        return "LOW"

    def _rr(self, entry: float, sl: float, tp: float) -> float:
        risk   = abs(entry - sl)
        reward = abs(tp - entry)
        return round(reward / risk, 2) if risk > 0 else 0

    # ── Setup 1: Reguła 80% ───────────────────────────────────────────────────

    def setup_80_rule(self, today: pd.DataFrame, prev: MarketProfile,
                      today_p: MarketProfile, htf_bias: str) -> Optional[Signal]:
        """
        Warunek: open poza PDVA → powrót do PDVA → 2 x 30m bloki wewnątrz VA.
        Cel: przeciwna banda VA. SL: poza bandą wejścia.
        P-stwo: ~80%.
        """
        if today.empty or len(today) < S1_ACCEPT_BARS + 1:
            return None

        open_price = today["open"].iloc[0]
        opened_below = open_price < prev.val
        opened_above = open_price > prev.vah

        if not (opened_below or opened_above):
            return None

        direction = "LONG" if opened_below else "SHORT"
        reentry   = prev.val if opened_below else prev.vah

        # Sprawdź czy cena wróciła do VA i utrzymała się 2 bloki
        accepted_bars = 0
        for _, row in today.iterrows():
            inside = (row["low"] >= prev.val - prev.va_range * 0.02 and
                      row["high"] <= prev.vah + prev.va_range * 0.02)
            if inside:
                accepted_bars += 1
            if accepted_bars >= S1_ACCEPT_BARS:
                break

        if accepted_bars < S1_ACCEPT_BARS:
            return None

        # Sprawdź czy cena faktycznie wróciła przez PDVAL/PDVAH
        if direction == "LONG":
            if today["high"].max() < prev.val:
                return None
            entry = prev.val
            tp    = prev.vah
            sl    = prev.val - prev.va_range * 0.20
        else:
            if today["low"].min() > prev.vah:
                return None
            entry = prev.vah
            tp    = prev.val
            sl    = prev.vah + prev.va_range * 0.20

        cl = self._build_checklist(htf_bias, direction)
        return Signal(
            timestamp=today_p.date,
            symbol=self.symbol,
            setup="S1: Reguła 80%",
            direction=direction,
            entry=round(entry, 4),
            stop_loss=round(sl, 4),
            take_profit=round(tp, 4),
            rr=self._rr(entry, sl, tp),
            confidence=self._confidence(cl),
            checklist=cl,
            notes=f"Open {open_price:.2f} poza PDVA ({prev.val:.2f}-{prev.vah:.2f}). "
                  f"Akceptacja: {accepted_bars} bloków wewnątrz VA. POC={prev.poc:.2f}",
        )

    # ── Setup 2: Single Prints ────────────────────────────────────────────────

    def setup_single_prints(self, today: pd.DataFrame, prev: MarketProfile,
                            today_p: MarketProfile, htf_bias: str) -> Optional[Signal]:
        """
        Warunek: cena powraca do strefy Single Prints z poprzedniej sesji.
        Scenariusz A: przelatuje przez strefę → wejście przy przełamaniu.
        Scenariusz B: Tail na ekstremum → fading przy powrocie.
        """
        if not prev.single_prints:
            return None
        if today.empty:
            return None

        current_price = today["close"].iloc[-1]
        signals = []

        for (sp_low, sp_high) in prev.single_prints:
            zone_mid  = (sp_low + sp_high) / 2
            zone_size = sp_high - sp_low

            # Sprawdź czy cena jest blisko strefy
            if abs(current_price - zone_mid) > zone_size * 3:
                continue

            approaching_from_below = current_price < sp_low and current_price > sp_low - zone_size * 2
            approaching_from_above = current_price > sp_high and current_price < sp_high + zone_size * 2

            if approaching_from_below:
                direction = "LONG"
                entry = sp_low
                tp    = sp_high
                sl    = sp_low - zone_size * 0.5
            elif approaching_from_above:
                direction = "SHORT"
                entry = sp_high
                tp    = sp_low
                sl    = sp_high + zone_size * 0.5
            else:
                continue

            cl = self._build_checklist(htf_bias, direction)
            signals.append(Signal(
                timestamp=today_p.date,
                symbol=self.symbol,
                setup="S2: Single Prints",
                direction=direction,
                entry=round(entry, 4),
                stop_loss=round(sl, 4),
                take_profit=round(tp, 4),
                rr=self._rr(entry, sl, tp),
                confidence=self._confidence(cl),
                checklist=cl,
                notes=f"Strefa Single Prints: {sp_low:.2f}-{sp_high:.2f}. "
                      f"Cena zbliża się {'od dołu' if approaching_from_below else 'od góry'}.",
            ))

        return signals[0] if signals else None

    # ── Setup 3: Wybicie Initial Balance ─────────────────────────────────────

    def setup_ib_breakout(self, today: pd.DataFrame, today_p: MarketProfile,
                          htf_bias: str) -> Optional[Signal]:
        """
        Warunek: cena z impetem przebija IB_High lub IB_Low.
        Potwierdzone przez 1 zamknięty blok 30m POZA IB.
        Nigdy nie gramy pod prąd Range Extension.
        """
        if today.empty or today_p is None:
            return None

        ib_high = today_p.ib_high
        ib_low  = today_p.ib_low
        ib_rng  = today_p.ib_range
        if ib_rng <= 0:
            return None

        # Szukamy pierwszego bloku który zamknął się poza IB
        broke_up   = None
        broke_down = None

        for _, row in today.iterrows():
            if broke_up is None and row["close"] > ib_high:
                broke_up = row
            if broke_down is None and row["close"] < ib_low:
                broke_down = row

        if broke_up is None and broke_down is None:
            return None

        # Wybierz wcześniejsze wybicie
        if broke_up is not None and broke_down is not None:
            up_move   = float(broke_up["close"])   - ib_high
            down_move = ib_low - float(broke_down["close"])
            if up_move >= down_move:
                broke_down = None
            else:
                broke_up = None

        if broke_up is not None:
            direction = "LONG"
            entry     = ib_high
            tp        = ib_high + ib_rng * 1.0   # projected move = IB range
            sl        = ib_low
        else:
            direction = "SHORT"
            entry     = ib_low
            tp        = ib_low - ib_rng * 1.0
            sl        = ib_high

        # Filtr: nie wchodzimy jeśli cena już uleciała za daleko od IB
        current = today["close"].iloc[-1]
        if direction == "LONG"  and current > entry + ib_rng * 1.5:
            return None
        if direction == "SHORT" and current < entry - ib_rng * 1.5:
            return None

        cl = self._build_checklist(htf_bias, direction)
        return Signal(
            timestamp=today_p.date,
            symbol=self.symbol,
            setup="S3: Wybicie IB",
            direction=direction,
            entry=round(entry, 4),
            stop_loss=round(sl, 4),
            take_profit=round(tp, 4),
            rr=self._rr(entry, sl, tp),
            confidence=self._confidence(cl),
            checklist=cl,
            notes=f"IB: {ib_low:.2f}-{ib_high:.2f} (range={ib_rng:.2f}). "
                  f"Range Extension {'w górę' if direction == 'LONG' else 'w dół'}.",
        )

    # ── Setup 4: Ping-Pong do POC ─────────────────────────────────────────────

    def setup_poc_reversion(self, today: pd.DataFrame, today_p: MarketProfile,
                            htf_bias: str) -> Optional[Signal]:
        """
        Warunek: cena uderza w VAL lub VAH + sygnał odwrócenia (Pin Bar / duży knot).
        Cel: POC (magnes rynkowy). SL: wąski poza bandą.
        """
        if today.empty or today_p is None:
            return None

        vah = today_p.vah
        val = today_p.val
        poc = today_p.poc
        va_rng = today_p.va_range
        if va_rng <= 0:
            return None

        # Sprawdzamy ostatnią świecę pod kątem Pin Bar / odrzucenia
        last = today.iloc[-1]
        body = abs(last["close"] - last["open"])
        rng  = last["high"] - last["low"]
        if rng == 0:
            return None
        body_ratio = body / rng

        # Zidentyfikuj pin bar (małe body, długi knot)
        is_pin = body_ratio < 0.35

        # Test: cena blisko VAL (bullish setup)
        near_val = last["low"] <= val + va_rng * 0.05
        # Test: cena blisko VAH (bearish setup)
        near_vah = last["high"] >= vah - va_rng * 0.05

        if near_val and is_pin and last["close"] > last["open"]:
            direction = "LONG"
            entry     = last["close"]
            tp        = poc
            sl        = val - va_rng * 0.10
        elif near_vah and is_pin and last["close"] < last["open"]:
            direction = "SHORT"
            entry     = last["close"]
            tp        = poc
            sl        = vah + va_rng * 0.10
        else:
            return None

        if abs(tp - entry) < abs(entry - sl) * 0.5:
            return None  # Słabe R:R — pomijamy

        cl = self._build_checklist(htf_bias, direction)
        return Signal(
            timestamp=today_p.date,
            symbol=self.symbol,
            setup="S4: Ping-Pong POC",
            direction=direction,
            entry=round(entry, 4),
            stop_loss=round(sl, 4),
            take_profit=round(poc, 4),
            rr=self._rr(entry, sl, poc),
            confidence=self._confidence(cl),
            checklist=cl,
            notes=f"{'Odbicie od VAL' if direction == 'LONG' else 'Odrzucenie od VAH'} "
                  f"({val:.2f}/{vah:.2f}). Body ratio={body_ratio:.2f}. TP=POC={poc:.2f}.",
        )

    # ── Główny skaner ─────────────────────────────────────────────────────────

    def scan(self, profiles: dict[str, MarketProfile],
             df_full: pd.DataFrame, htf_bias: str = "neutral") -> list[Signal]:
        """Skanuje wszystkie sesje i zwraca listę sygnałów."""
        dates   = sorted(profiles.keys())
        signals = []

        for i in range(1, len(dates)):
            prev_date  = dates[i - 1]
            today_date = dates[i]
            prev       = profiles[prev_date]
            today_p    = profiles[today_date]

            # Klines dzisiejszej sesji
            today_df = df_full[df_full["date"] == today_date].reset_index(drop=True)
            if today_df.empty:
                continue

            # Skanuj 4 setupy
            for scanner_fn in [
                lambda: self.setup_80_rule(today_df, prev, today_p, htf_bias),
                lambda: self.setup_single_prints(today_df, prev, today_p, htf_bias),
                lambda: self.setup_ib_breakout(today_df, today_p, htf_bias),
                lambda: self.setup_poc_reversion(today_df, today_p, htf_bias),
            ]:
                sig = scanner_fn()
                if sig:
                    signals.append(sig)

        return signals


# ─── TREND CLASSIFIER ─────────────────────────────────────────────────────────

def classify_day_type(p: MarketProfile, prev: MarketProfile) -> str:
    """5 typów sesji wg TrejdingHub."""
    if prev is None:
        return "unknown"
    ib_rng = p.ib_range
    day_rng = p.day_range
    if day_rng == 0:
        return "non-trend"
    ib_pct = ib_rng / day_rng
    close_pct = (p.close - p.low) / day_rng  # 0=dół, 1=góra

    if ib_pct > 0.80:
        return "non-trend"
    elif ib_pct < 0.25 and (close_pct > 0.75 or close_pct < 0.25):
        return "trend"
    elif ib_pct < 0.50 and (close_pct > 0.60 or close_pct < 0.40):
        return "normal-variation"
    elif close_pct > 0.45 and close_pct < 0.55:
        return "neutral"
    else:
        return "normal"


def trend_strength(price: float, today_p: MarketProfile, prev: MarketProfile) -> tuple[int, str]:
    """
    Siła trendu na skali 1-6 wg TrejdingHub.
    Zwraca (level, direction).
    """
    if prev is None or today_p is None:
        return 0, "neutral"

    above_pdva  = price > prev.vah
    below_pdva  = price < prev.val
    above_pdhi  = price > prev.high
    below_pdlo  = price < prev.low
    above_tvah  = price > today_p.vah
    below_tval  = price < today_p.val
    in_tib      = today_p.ib_low <= price <= today_p.ib_high
    above_tib   = price > today_p.ib_high
    below_tib   = price < today_p.ib_low

    if above_pdva:
        if above_tvah and above_pdhi:   return 6, "bullish"
        if above_tib and above_pdhi:    return 5, "bullish"
        if in_tib and above_pdhi:       return 4, "bullish"
        if above_tvah:                  return 3, "bullish"
        if above_tib:                   return 2, "bullish"
        return 1, "bullish"
    elif below_pdva:
        if below_tval and below_pdlo:   return 6, "bearish"
        if below_tib and below_pdlo:    return 5, "bearish"
        if in_tib and below_pdlo:       return 4, "bearish"
        if below_tval:                  return 3, "bearish"
        if below_tib:                   return 2, "bearish"
        return 1, "bearish"
    return 0, "neutral"


# ─── BACKTESTER ───────────────────────────────────────────────────────────────

class Backtester:
    """Symuluje P&L na historycznych sygnałach."""

    def __init__(self, signals: list[Signal], profiles: dict[str, MarketProfile],
                 df: pd.DataFrame):
        self.signals  = signals
        self.profiles = profiles
        self.df       = df

    def run(self) -> pd.DataFrame:
        results = []
        for sig in self.signals:
            # Znajdź świece po sygnale
            future = self.df[self.df["date"] > sig.timestamp].head(48)
            if future.empty:
                result, exit_price = "OPEN", sig.entry
            else:
                result, exit_price = self._simulate(sig, future)

            pnl_r = (self._rr_pnl(sig, result))
            results.append({**sig.to_dict(), "result": result,
                             "exit_price": round(exit_price, 4), "pnl_r": pnl_r})

        return pd.DataFrame(results)

    def _simulate(self, sig: Signal, future: pd.DataFrame) -> tuple[str, float]:
        for _, row in future.iterrows():
            if sig.direction == "LONG":
                if row["low"]  <= sig.stop_loss:   return "LOSS", sig.stop_loss
                if row["high"] >= sig.take_profit: return "WIN",  sig.take_profit
            else:
                if row["high"] >= sig.stop_loss:   return "LOSS", sig.stop_loss
                if row["low"]  <= sig.take_profit: return "WIN",  sig.take_profit
        return "OPEN", future["close"].iloc[-1]

    def _rr_pnl(self, sig: Signal, result: str) -> float:
        if result == "WIN":   return round(sig.rr, 2)
        if result == "LOSS":  return -1.0
        return 0.0

    def summary(self, df: pd.DataFrame) -> dict:
        closed  = df[df["result"].isin(["WIN", "LOSS"])]
        wins    = closed[closed["result"] == "WIN"]
        losses  = closed[closed["result"] == "LOSS"]
        total_r = df["pnl_r"].sum()
        wr      = len(wins) / len(closed) * 100 if len(closed) else 0
        pf      = (wins["pnl_r"].sum() / abs(losses["pnl_r"].sum())
                   if losses["pnl_r"].sum() != 0 else float("inf"))
        return {
            "total_signals": len(df),
            "wins":   len(wins),
            "losses": len(losses),
            "open":   len(df[df["result"] == "OPEN"]),
            "win_rate": round(wr, 1),
            "profit_factor": round(pf, 2),
            "total_R": round(total_r, 2),
            "avg_rr_wins": round(wins["rr"].mean(), 2) if len(wins) else 0,
        }


# ─── PRINTER / LOGGER ─────────────────────────────────────────────────────────

G = Fore.GREEN; R = Fore.RED; Y = Fore.YELLOW; C = Fore.CYAN
B = Fore.BLUE; M = Fore.MAGENTA; W = Fore.WHITE; DIM = Style.DIM; RST = Style.RESET_ALL

def hdr(text: str):
    w = 74
    print(f"\n{C}{'═'*w}{RST}")
    print(f"{C}  {text}{RST}")
    print(f"{C}{'═'*w}{RST}")

def print_profile(p: MarketProfile, prev: MarketProfile = None):
    day_type = classify_day_type(p, prev)
    color    = {
        "trend": G, "normal-variation": Y, "normal": C,
        "neutral": M, "non-trend": DIM, "unknown": W
    }.get(day_type, W)

    print(f"\n{B}┌─ {p.date} ─────────────────────────────────────────────────┐{RST}")
    print(f"{B}│{RST}  POC: {Y}{p.poc:>12.4f}{RST}  │  VAH: {G}{p.vah:>12.4f}{RST}  │  VAL: {R}{p.val:>12.4f}{RST}")
    print(f"{B}│{RST}  IB:  {W}{p.ib_low:>12.4f}{RST} — {W}{p.ib_high:<12.4f}{RST}  │  Typ: {color}{day_type:<18}{RST}")
    print(f"{B}│{RST}  H/L: {p.high:>12.4f} / {p.low:<12.4f}  │  Vol: {p.volume:>14,.2f}")
    if p.single_prints:
        sp_str = ", ".join(f"{lo:.4f}-{hi:.4f}" for lo, hi in p.single_prints[:3])
        print(f"{B}│{RST}  {M}Single Prints:{RST} {sp_str}")
    if p.poor_lows:
        print(f"{B}│{RST}  {R}Poor Lows:{RST}     {', '.join(str(x) for x in p.poor_lows[:3])}")
    if p.poor_highs:
        print(f"{B}│{RST}  {R}Poor Highs:{RST}    {', '.join(str(x) for x in p.poor_highs[:3])}")
    print(f"{B}└{'─'*64}┘{RST}")

def simple_decision(sig: Signal) -> dict:
    """Tlumaczy sygnal na proste polecenia: KUP / SPRZEDAJ / CZEKAJ."""
    passed  = sig.passed_checklist()
    score   = sum(sig.checklist.values())
    max_pts = len(sig.checklist)
    if not passed:
        return {"action": "CZEKAJ", "emoji": "🟡", "color": Y,
                "reason": f"Warunki niespelnione ({score}/{max_pts} pkt). Nie wchodz.",
                "entry": None, "sl": None, "tp": None}
    if sig.direction == "LONG":
        action, emoji, color = "KUP", "🟢", G
        reason = (f"Wejdz LONG @ {sig.entry:,.4f}. "
                  f"Wyjdz (strata) jesli cena spadnie do {sig.stop_loss:,.4f}. "
                  f"Wyjdz (zysk) jesli wzrosnie do {sig.take_profit:,.4f}. R:R={sig.rr}x.")
    else:
        action, emoji, color = "SPRZEDAJ", "🔴", R
        reason = (f"Wejdz SHORT @ {sig.entry:,.4f}. "
                  f"Wyjdz (strata) jesli cena wzrosnie do {sig.stop_loss:,.4f}. "
                  f"Wyjdz (zysk) jesli spadnie do {sig.take_profit:,.4f}. R:R={sig.rr}x.")
    return {"action": action, "emoji": emoji, "color": color, "reason": reason,
            "entry": sig.entry, "sl": sig.stop_loss, "tp": sig.take_profit}


def print_signal(sig: Signal):
    dec       = simple_decision(sig)
    dir_color = G if sig.direction == "LONG" else R
    conf_color = {"HIGH": G, "MEDIUM": Y, "LOW": R}.get(sig.confidence, W)
    passed    = sig.passed_checklist()
    score     = sum(sig.checklist.values())
    width     = 62

    # ── Prosta decyzja (duza, czytelna) ──────────────────────────────────────
    print(f"\n  {dec['color']}{'┌' + '─'*width + '┐'}{RST}")
    label = f"  {dec['emoji']}  {dec['action']:<10}  [{sig.setup}]  {sig.timestamp}"
    print(f"  {dec['color']}│{label:<{width}}│{RST}")
    reason_lines = [dec['reason'][i:i+width-3] for i in range(0, len(dec['reason']), width-3)]
    for rl in reason_lines[:2]:
        print(f"  {dec['color']}│  {rl:<{width-3}}│{RST}")
    print(f"  {dec['color']}└{'─'*width}┘{RST}")

    # ── Szczegoly techniczne ──────────────────────────────────────────────────
    print(f"    {DIM}Wejdz:{RST}  {Y}{sig.entry:>12.4f}{RST}  "
          f"{DIM}Stop Loss:{RST} {R}{sig.stop_loss:>12.4f}{RST}  "
          f"{DIM}Take Profit:{RST} {G}{sig.take_profit:>12.4f}{RST}  "
          f"R:R={sig.rr}  [{conf_color}{sig.confidence} {score}/{len(sig.checklist)}{RST}]")
    print(f"    {DIM}{sig.notes}{RST}")
    cl_str = "  ".join(f"{'✅' if v else '❌'} {k.replace('_',' ')}" for k, v in sig.checklist.items())
    print(f"    {DIM}{cl_str}{RST}")

def print_backtest(summary: dict, bt_df: pd.DataFrame):
    hdr("📈 WYNIKI BACKTESTÓW")

    stats_table = [
        ["Łącznie sygnałów", summary["total_signals"]],
        ["WIN",              f"{G}{summary['wins']}{RST}"],
        ["LOSS",             f"{R}{summary['losses']}{RST}"],
        ["OPEN",             summary["open"]],
        ["Win Rate",         f"{summary['win_rate']}%"],
        ["Profit Factor",    summary["profit_factor"]],
        ["Łączny wynik (R)", f"{G if summary['total_R'] > 0 else R}{summary['total_R']}R{RST}"],
        ["Avg R:R (wins)",   f"{summary['avg_rr_wins']}R"],
    ]
    print(tabulate(stats_table, tablefmt="simple"))

    print(f"\n{C}Per setup:{RST}")
    if not bt_df.empty:
        per_setup = bt_df.groupby("setup").agg(
            signals=("result", "count"),
            wins=("result", lambda x: (x == "WIN").sum()),
            losses=("result", lambda x: (x == "LOSS").sum()),
            total_R=("pnl_r", "sum"),
            avg_rr=("rr", "mean"),
        ).reset_index()
        per_setup["wr%"] = (per_setup["wins"] / per_setup["signals"] * 100).round(1)
        per_setup["total_R"] = per_setup["total_R"].round(2)
        per_setup["avg_rr"]  = per_setup["avg_rr"].round(2)
        print(tabulate(per_setup.values.tolist(),
                       headers=["Setup","Sygn.","WIN","LOSS","R total","Avg R:R","WR%"],
                       tablefmt="simple"))


# ─── MAIN ENTRYPOINT ──────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="TrejdingHub Market Profile Algorithm",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Przykłady:
  python trejdinghub_algo.py --symbol BTCUSDT --days 30
  python trejdinghub_algo.py --symbol ETHUSDT --days 14 --export csv
  python trejdinghub_algo.py --symbol SOLUSDT --days 7  --live
  python trejdinghub_algo.py --symbol BTCUSDT --days 30 --htf bullish --no-backtest
        """
    )
    parser.add_argument("--symbol",     default="BTCUSDT",   help="Symbol Binance (np. BTCUSDT)")
    parser.add_argument("--days",       default=30, type=int, help="Liczba dni historii")
    parser.add_argument("--htf",        default="neutral",
                        choices=["bullish","bearish","neutral","consolidation"],
                        help="HTF Bias (nastawienie makro)")
    parser.add_argument("--export",     default=None,
                        choices=["csv", "json"], help="Eksport sygnałów")
    parser.add_argument("--live",       action="store_true",  help="Pokaż bieżącą cenę i profile")
    parser.add_argument("--no-backtest",action="store_true",  help="Pomiń backtest")
    parser.add_argument("--profiles",   action="store_true",  help="Wypisz wszystkie profile")
    args = parser.parse_args()

    sym = args.symbol.upper().replace("/", "")

    # ── Banner ────────────────────────────────────────────────────────────────
    print(f"\n{Y}{'╔'+'═'*70+'╗'}")
    print(f"║{'  TREJDINGHUB — Market Profile Algorithm v2.0':^70}║")
    print(f"║{'  TPO · CVD · HTS Wstęgi · MACD Dywergencje · 4 Setupy':^70}║")
    print(f"{'╚'+'═'*70+'╝'}{RST}")

    # ── Fetch ─────────────────────────────────────────────────────────────────
    print(f"\n{C}▸ Pobieranie danych: {sym} | {args.days} dni | Binance Spot 30m{RST}")
    fetcher = BinanceFetcher(sym)

    print(f"{DIM}  Klines spot...{RST}", end=" ", flush=True)
    df = fetcher.fetch_klines(interval="30m", days=args.days)
    print(f"{G}OK{RST} ({len(df)} świec)")

    print(f"{DIM}  Open Interest...{RST}", end=" ", flush=True)
    oi_hist = fetcher.fetch_oi_history()
    oi = oi_trend(oi_hist)
    print(f"{G}OK{RST} → trend: {Y}{oi}{RST}")

    print(f"{DIM}  Perp klines (CVD)...{RST}", end=" ", flush=True)
    perp_df = fetcher.fetch_perp_klines(interval="30m", limit=96)
    if not perp_df.empty:
        perp_cvd_series = calc_cvd(perp_df)
        perp_cvd = cvd_trend(perp_cvd_series)
        print(f"{G}OK{RST} → CVD Perp: {Y}{perp_cvd}{RST}")
    else:
        perp_cvd = "neutral"
        print(f"{Y}brak (futures niedostępne){RST}")

    # Spot CVD z ostatnich 96 świec
    spot_cvd_series = calc_cvd(df.tail(96))
    spot_cvd = cvd_trend(spot_cvd_series)
    print(f"  CVD Spot → {Y}{spot_cvd}{RST}")

    # ── HTS (Harmonious Trend System) ────────────────────────────────────────
    print(f"\n{C}▸ Obliczanie HTS (Harmonious Trend System)...{RST}")
    hts_engine  = HTSIndicator()
    df_hts      = hts_engine.calculate(df)
    hts_signal  = hts_engine.latest_signal(df_hts)
    hts_color   = G if hts_signal["bias"] == "bullish" else R if hts_signal["bias"] == "bearish" else W
    print(f"  Bias (vs wstęga wolna):  {hts_color}{hts_signal['bias'].upper()}{RST}")
    print(f"  Cross wstęg:             {Y}{hts_signal['cross']}{RST}")
    print(f"  Odbicie od wstęgi:       {'🟢 BOUNCE BULL' if hts_signal['bounce_bull'] else '🔴 BOUNCE BEAR' if hts_signal['bounce_bear'] else DIM+'brak'+RST}")
    print(f"  Squeeze (wybicie blisko):{Y}{' TAK ⚡' if hts_signal['squeeze'] else ' nie'}{RST}")
    print(f"  Slow EMA (czerwona):     {Y}{hts_signal['slow_mid']:,.4f}{RST}  "
          f"Kanał: {hts_signal['slow_lower']:,.4f} – {hts_signal['slow_upper']:,.4f}")

    # ── MACD z dywergencjami ─────────────────────────────────────────────────
    print(f"\n{C}▸ Obliczanie MACD + dywergencje...{RST}")
    macd_engine = MACDDivergence()
    df_macd     = macd_engine.calculate(df)
    macd_state  = macd_engine.latest_state(df_macd)
    macd_color  = G if macd_state["above_zero"] else R
    div_color   = G if macd_state["divergence"] == "bullish" else R if macd_state["divergence"] == "bearish" else DIM
    print(f"  MACD: {macd_color}{macd_state['macd']:+.6f}{RST}  "
          f"Signal: {macd_state['signal']:+.6f}  "
          f"Hist: {macd_state['histogram']:+.6f}")
    print(f"  Dywergencja: {div_color}{macd_state['divergence'].upper()}{RST}", end="")
    if macd_state["div_details"]:
        print(f"  → {DIM}{macd_state['div_details']['description']}{RST}")
    else:
        print()

    # ── Bieżąca cena ─────────────────────────────────────────────────────────
    if args.live:
        print(f"\n{DIM}  Bieżąca cena...{RST}", end=" ", flush=True)
        ticker = fetcher.fetch_ticker()
        price  = float(ticker.get("lastPrice", 0))
        ch24   = float(ticker.get("priceChangePercent", 0))
        color  = G if ch24 >= 0 else R
        print(f"{color}{price:,.4f} ({ch24:+.2f}%){RST}")

    # ── Build Profiles ────────────────────────────────────────────────────────
    print(f"\n{C}▸ Budowanie Market Profiles...{RST}")
    engine   = MarketProfileEngine()
    profiles = engine.build_all(df)
    print(f"  {G}Profili: {len(profiles)}{RST}")

    if args.profiles:
        hdr("📊 MARKET PROFILES")
        dates = sorted(profiles.keys())
        for i, d in enumerate(dates):
            prev = profiles[dates[i-1]] if i > 0 else None
            print_profile(profiles[d], prev)

    # ── Trend Strength (ostatni dzień) ────────────────────────────────────────
    if args.live and profiles:
        last_date  = sorted(profiles.keys())[-1]
        prev_date  = sorted(profiles.keys())[-2] if len(profiles) > 1 else None
        last_p     = profiles[last_date]
        prev_p     = profiles[prev_date] if prev_date else None
        cur_price  = float(ticker.get("lastPrice", last_p.close))
        lvl, direc = trend_strength(cur_price, last_p, prev_p)
        color      = G if direc == "bullish" else R if direc == "bearish" else W
        hdr("🔢 SIŁA TRENDU")
        print(f"  Poziom: {color}{lvl}/6{RST}  Kierunek: {color}{direc.upper()}{RST}")
        print(f"  Cena {cur_price:,.4f} vs PDVAH {prev_p.vah if prev_p else '—'} / PDVAL {prev_p.val if prev_p else '—'}")

    # ── Scan Signals ──────────────────────────────────────────────────────────
    hdr("🎯 SKANOWANIE SETUPÓW")
    print(f"  HTF Bias: {Y}{args.htf}{RST}  |  Spot CVD: {Y}{spot_cvd}{RST}  |  Perp CVD: {Y}{perp_cvd}{RST}  |  OI: {Y}{oi}{RST}")
    print(f"  HTS Bias: {Y}{hts_signal['bias']}{RST}  |  MACD Dyw: {Y}{macd_state['divergence']}{RST}")

    scanner = SignalScanner(
        sym,
        spot_cvd=spot_cvd,
        perp_cvd=perp_cvd,
        oi=oi,
        hts_bias=hts_signal["bias"],
        macd_divergence=macd_state["divergence"]
    )
    signals = scanner.scan(profiles, df, htf_bias=args.htf)

    if not signals:
        print(f"\n  {Y}⚠ Brak sygnałów w tym okresie.{RST}")
    else:
        print(f"\n  {G}Znaleziono sygnałów: {len(signals)}{RST}\n")
        for sig in signals:
            print_signal(sig)

        # ── Podsumowanie — tabela prostych polecen ────────────────────────────
        hdr("📋 PODSUMOWANIE — PROSTE POLECENIA")
        rows = []
        for sig in signals:
            dec = simple_decision(sig)
            rows.append([dec["emoji"]+" "+dec["action"], sig.timestamp, sig.setup,
                         f"{sig.entry:,.2f}", f"{sig.stop_loss:,.2f}", f"{sig.take_profit:,.2f}",
                         f"{sig.rr}x", sig.confidence])
        print(tabulate(rows, headers=["Decyzja","Data","Setup","Wejdź @","Wyjdź (SL)","Wyjdź (TP)","R:R","Pewność"], tablefmt="simple"))
        print(f"\n  {G}🟢 KUP{RST}       — otwórz pozycje dluga (kupuj, cena ma rosnac)")
        print(f"  {R}🔴 SPRZEDAJ{RST}  — otwórz pozycje krótka (sprzedaj/shortuj)")
        print(f"  {Y}🟡 CZEKAJ{RST}    — warunki niespelnione, siedz na rekach")
        print(f"  {DIM}Wyjdź (SL){RST}  — zamknij ze strata jesli cena dotrze do tego poziomu")
        print(f"  {DIM}Wyjdź (TP){RST}  — zamknij z zyskiem jesli cena dotrze do tego poziomu")

    # ── Backtest ──────────────────────────────────────────────────────────────
    if not args.no_backtest and signals:
        bt = Backtester(signals, profiles, df)
        bt_df = bt.run()
        summary = bt.summary(bt_df)
        print_backtest(summary, bt_df)

        # ── Export ────────────────────────────────────────────────────────────
        if args.export == "csv":
            fname = f"signals_{sym}_{datetime.now().strftime('%Y%m%d_%H%M%S')}.csv"
            bt_df.to_csv(fname, index=False)
            print(f"\n{G}  ✅ Eksport CSV: {fname}{RST}")
        elif args.export == "json":
            fname = f"signals_{sym}_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
            bt_df.to_json(fname, orient="records", indent=2)
            print(f"\n{G}  ✅ Eksport JSON: {fname}{RST}")

    # ── Ostatni profil + sygnał live ─────────────────────────────────────────
    if args.live and profiles:
        hdr("⚡ AKTUALNY PROFIL (LIVE)")
        last_date = sorted(profiles.keys())[-1]
        prev_date = sorted(profiles.keys())[-2] if len(profiles) > 1 else None
        print_profile(profiles[last_date], profiles.get(prev_date))

        live_sigs = [s for s in signals if s.timestamp == last_date]
        if live_sigs:
            print(f"\n  {G}Aktywne sygnały na dziś:{RST}")
            for s in live_sigs:
                print_signal(s)
        else:
            print(f"\n  {DIM}Brak aktywnych sygnałów na dzisiaj.{RST}")

    print(f"\n{Y}{'═'*74}{RST}\n")


if __name__ == "__main__":
    main()
