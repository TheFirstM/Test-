# TREJDINGHUB — Projekt Algorytmu Tradingowego
## Instrukcje dla Claude Code | v2.0 | Czerwiec 2026

---

## 🎯 Cel projektu

Kompletny system algorytmiczny oparty na metodologii **TrejdingHub (Rafał Ławniczak)** — polskiego tradera i edukatora. System analizuje rynki przez pryzmat Market Profile (TPO), Orderflow (CVD + OI), wstęg HTS i MACD z dywergencjami, generując mechaniczne sygnały w prostym języku: **KUP / SPRZEDAJ / CZEKAJ**.

**Nie jest to system sygnałów inwestycyjnych. Jest to projekt edukacyjny.**

---

## 📁 Struktura projektu

```
trejdinghub/
├── CLAUDE.md                    ← ten plik — kontekst dla Claude Code
├── trejdinghub_algo.py          ← algorytm Python CLI (v2.0, ~1400 linii)
├── trejdinghub_agent_v2.jsx     ← agent AI React (v2.0, ~850 linii)
├── requirements.txt
├── tests/
│   ├── test_profile.py          ← testy MarketProfileEngine
│   ├── test_signals.py          ← testy SignalScanner + simple_decision
│   ├── test_hts.py              ← testy HTSIndicator
│   └── test_macd.py             ← testy MACDDivergence
├── data/
│   └── cache/                   ← cache klines z Binance (JSON)
└── exports/
    └── signals_SYMBOL_DATE.csv  ← eksportowane sygnały
```

---

## 🧠 Metodologia TrejdingHub — pełny opis

### Filar 1: Market Profile (TPO)

**Kluczowe zmienne per sesja (obliczane ze świec 30m):**

| Zmienna | Opis |
|---------|------|
| `POC` | Point of Control — cena z najwyższym wolumenem (magnes rynkowy) |
| `VAH` | Value Area High — górna granica 70% wolumenu |
| `VAL` | Value Area Low — dolna granica 70% wolumenu |
| `IB_High` | Szczyt Initial Balance (pierwsza godzina = 2 świece 30m) |
| `IB_Low` | Dołek Initial Balance |
| `Single Prints` | Strefy przełeciane zbyt szybko — wolumen < 3% max → podatne na wypełnienie |
| `Poor Low/High` | Wiele świec na ekstremum bez ostrego ogona → cel dla ceny |
| `Buying Tail` | Cienki ogon na dole — gwałtowne odrzucenie przez instytucje |
| `Selling Tail` | Cienki ogon na górze — gwałtowne odrzucenie przez instytucje |

**Algorytm Value Area (standard CME):**
1. Znajdź POC (bucket z max wolumenem)
2. Ekspanduj od POC — dodaj zawsze stronę z wyższym wolumenem
3. Zatrzymaj gdy skumulowany wolumen >= 70% całości
4. VAH = najwyższy bucket, VAL = najniższy bucket w VA

**5 typów sesji:**
- `non-trend` — IB > 80% zasięgu, brak kapitału długoterminowego
- `normal` — szeroki IB, handel band-to-band
- `normal-variation` — wybicie jednej strony IB + Range Extension
- `trend` — wąskie IB (< 25%) + potężne wybicie + zamknięcie blisko ekstremum
- `neutral` — wybicie obu stron, zamknięcie w środku

**Siła trendu (skala 1-6), kierunek bycze:**
1. Aktywność w IB, ale powyżej PDVA
2. Powyżej IB, w dzisiejszym VA, powyżej PDVA
3. Powyżej dzisiejszego VA i powyżej PDVA
4. W IB, ale powyżej całego Previous Day Range
5. Powyżej IB, w VA, powyżej PDRange
6. Powyżej VA i całkowicie powyżej PDRange ← **najsilniejszy**

Dla niedźwiedzia — logika odwrotna.

---

### Filar 2: Orderflow (CVD + OI)

**CVD (Cumulative Volume Delta):**
```python
# Przybliżenie z klines Binance (pole [9] = taker_buy_vol)
delta = taker_buy_vol * 2 - total_volume
cvd   = delta.cumsum()
```

**Macierz OI + CVD:**
| OI | CVD | Interpretacja |
|----|-----|---------------|
| rośnie | rośnie | Nowe longi → silny trend wzrostowy |
| rośnie | spada | Nowe shorty → budujący się trend spadkowy |
| spada | spada | Zamykanie longów → kapitulacja byków |
| spada | rośnie | Short Squeeze → gwałtowny ale krótki ruch |

**Spot vs Perp CVD:**
- Spot CVD rośnie, Perp flat/spada → **BYCZE** (prawdziwy kapitał, nie lewar)
- Spot CVD spada, Perp rośnie → **OSTRZEŻENIE** (lewarowana spekulacja, ryzyko fakeout)

**Delta Trap (sygnał do zignorowania):**
- CVD wystrzeluje TYLKO przy przebiciu poziomu → cena natychmiast zawraca → fałszywy breakout

---

### Filar 3: Wstęgi HTS (Harmonious Trend System)

Własny wskaźnik Rafała Ławniczaka. Dwie pary wstęg EMA + kanał odchylenia std.

```python
# Parametry (zaimplementowane w HTSIndicator)
HTS_SLOW_PERIOD = 55    # EMA wolna (czerwona) — "ostatni bastion byków"
HTS_SLOW_MULT   = 2.0
HTS_FAST_PERIOD = 21    # EMA szybka (niebieska) — sygnały wejść
HTS_FAST_MULT   = 1.5
```

**Kolumny dodawane przez `HTSIndicator.calculate(df)`:**
- `hts_slow_mid / upper / lower` — wstęga wolna (czerwona)
- `hts_fast_mid / upper / lower` — wstęga szybka (niebieska)
- `hts_bias` — `"bullish"` / `"bearish"` / `"neutral"` (cena vs wstęga wolna)
- `hts_cross` — `"bullish"` / `"bearish"` / `"none"` (przecięcie wstęg)
- `hts_bounce_bull` — `True` gdy cena dotknęła dolnej wstęgi wolnej i zamknęła się powyżej
- `hts_bounce_bear` — `True` gdy cena dotknęła górnej wstęgi wolnej i zamknęła się poniżej
- `hts_squeeze` — `True` gdy wstęgi się zwężają (wybicie w przygotowaniu)

**Interpretacja:**
- Cena > `hts_slow_mid` → bullish bias — preferuj LONG setupy
- Cena < `hts_slow_mid` → bearish bias — preferuj SHORT setupy
- `hts_bounce_bull = True` → high-probability long setup (odbicie od "ostatniego bastionu")
- `hts_cross = "bullish"` → szybka przecięła wolną od dołu → zmiana trendu

---

### Filar 4: MACD z dywergencjami

```python
# Parametry (zaimplementowane w MACDDivergence)
MACD_FAST        = 12
MACD_SLOW        = 26
MACD_SIGNAL      = 9
MACD_DIV_LOOKBACK = 20   # okno do wykrywania dywergencji
```

**Kolumny dodawane przez `MACDDivergence.calculate(df)`:**
- `macd`, `macd_signal`, `macd_hist`

**Dywergencje wykrywane przez `find_divergences(df)`:**
- **Bycza**: cena robi niższy dołek, MACD wyższy dołek → potencjalne odwrócenie
- **Niedźwiedzia**: cena robi wyższy szczyt, MACD niższy szczyt → słabnący impet

*Przykład z GE Aerospace (kwi 2026 Rafał Ławniczak): "cena robi niższy dołek a MACD wyższy" → sygnał odwrócenia trendu*

---

### Filar 5: Analiza Fundamentalna (dla akcji)

Rafał łączy tech z fundamentami przy trade ideach średnio/długoterminowych:
- Pricing Power, Free Cash Flow, Backlog zamówień
- Pozycja monopolistyczna w branży
- Wyniki kwartalne vs oczekiwania

**Zastosowanie:** filtr setupów akcyjnych — setup techniczny jest mocniejszy gdy fundamenty potwierdzają.

---

## 🎯 4 Mechaniczne Setupy

### S1: Reguła 80% (Mean Reversion w Value Area)
```
Warunek:  open poza PDVA (poniżej VAL lub powyżej VAH)
          → cena wchodzi z powrotem do PDVA
          → 2 bloki 30min zamknięte wewnątrz PDVA (akceptacja)
Wejście:  przy PDVAL (long) lub PDVAH (short)
TP:       przeciwna banda PDVA | Częściowy TP przy PDPOC
SL:       15-20% VA range poza wejściem
P-stwo:   ~80% historycznie
Filtr HTS: hts_bias musi zgadzać się z kierunkiem
```

### S2: Single Prints (Wypełnianie luki)
```
Wariant A: cena wchodzi w Single Prints → TP drugi koniec strefy
Wariant B: Tail na ekstremum → fade przy powrocie → SL poza ogonem
Warunek:   wolumen w strefie < 3% max_vol poprzedniej sesji
```

### S3: Wybicie Initial Balance (Trend Following)
```
Warunek:  przebicie IB_High lub IB_Low
          + 1 pełny blok 30min zamknięty poza IB (potwierdzenie)
Wejście:  na poziomie IB boundary
TP:       IB_High + IB_range (lub IB_Low - IB_range)
SL:       przeciwna granica IB
Reguła:   NIGDY nie gramy pod prąd Range Extension
HTS:      kierunek musi zgadzać się z hts_bias
```

### S4: Ping-Pong do POC (Mean Reversion wewnątrz VA)
```
Warunek:  cena uderza w VAL lub VAH
          + Pin Bar lub Outside Bar (body_ratio < 0.35)
Wejście:  po zamknięciu świecy odwrócenia
TP:       POC (magnes rynkowy)
SL:       10% VA range poza bandą wejścia
Filtr:    R:R minimum 1.5, w przeciwnym razie pomijamy
```

---

## ✅ 6-punktowa Checklist przed wejściem (v2.0)

```
1. HTF_bias_jasny       — HTF bias (1H/4H/D) zgodny z kierunkiem lub neutral
2. Spot_CVD_potwierdza  — Spot CVD potwierdza kierunek (nie perp/futures)
3. Nowy_kapital_OI      — OI + CVD = nowy kapitał (nie zamykanie starych pozycji)
4. Brak_Delta_Trap      — LTF brak Delta Trap (CVD nie wystrzeluje tylko na przebiciu)
5. HTS_bias_zgodny      — hts_bias zgadza się z kierunkiem setupu
6. MACD_brak_sprzecznosci — MACD dywergencja nie przeczy kierunkowi
```

**Progi pewności:**
- `>= 6/6` → HIGH confidence — pełna pozycja
- `>= 4/6` → MEDIUM confidence — mniejsza pozycja
- `< 4/6` → LOW / CZEKAJ — nie wchodź

---

## 🚦 Warstwa decyzyjna (simple_decision)

Każdy sygnał `Signal` tłumaczony jest na prostą decyzję przez `simple_decision(sig)`:

```python
def simple_decision(sig: Signal) -> dict:
    """
    Zwraca:
      action : "KUP" | "SPRZEDAJ" | "CZEKAJ"
      emoji  : "🟢" | "🔴" | "🟡"
      reason : czytelny opis po polsku
      entry  : float | None
      sl     : float | None  (wyjdź gdy strata)
      tp     : float | None  (wyjdź gdy zysk)
    """
```

**Słownik pojęć dla tradera:**
| Termin techniczny | Prostym językiem |
|------------------|-----------------|
| LONG | KUP — otwórz pozycję, cena ma rosnąć |
| SHORT | SPRZEDAJ — otwórz pozycję krótką, cena ma spadać |
| NO TRADE / LOW conf | CZEKAJ — siedź na rękach, warunki niespełnione |
| Entry | Wejdź @ — po tej cenie otwórz transakcję |
| Stop Loss | Wyjdź (strata) — zamknij jeśli cena dotrze tutaj |
| Take Profit | Wyjdź (zysk) — zamknij i weź zysk gdy cena dotrze tutaj |

**Output CLI — dwie warstwy:**
```
┌──────────────────────────────────────────────────────────────┐
│  🟢  KUP         [S1: Reguła 80%]  2025-04-05               │
│  Wejdź LONG @ 83200. Wyjdź (strata) jeśli cena spadnie      │
│  do 82900. Wyjdź (zysk) jeśli wzrośnie do 84100. R:R=3x.   │
└──────────────────────────────────────────────────────────────┘
  Wejdź: 83200  Stop Loss: 82900  TP: 84100  [HIGH 5/6]
  ✅ HTF bias  ✅ CVD  ✅ OI  ✅ DeltaTrap  ✅ HTS  ✅ MACD
```

---

## 🔧 Specyfikacja techniczna

### Źródła danych
```python
# Krypto — Binance REST API (publiczne, bez auth)
BINANCE_SPOT    = "https://api.binance.com/api/v3"
BINANCE_FUTURES = "https://fapi.binance.com/fapi/v1"
BINANCE_FDATA   = "https://fapi.binance.com/futures/data"

# Akcje US — Yahoo Finance (TODO)
import yfinance as yf
df = yf.Ticker("GE").history(period="60d", interval="30m")
```

### Interwały
- `30m` — główny interwał do Market Profile per sesja
- `1D` — kontekst HTF i dywergencje MACD
- `1H`, `4H` — HTF bias i siła trendu

### Symbole
- **Krypto (Binance):** `BTCUSDT`, `ETHUSDT`, `SOLUSDT`, `BNBUSDT`, `XRPUSDT`
- **Akcje (Yahoo, TODO):** `GE`, `NVDA`, `AAPL`, `SPY`, `QQQ`

### Sesje tradingowe
- **Krypto:** UTC midnight → UTC midnight (48 świec 30m)
- **Akcje US:** 9:30–16:00 ET (NYSE/NASDAQ) = 13 świec 30m
- **Futures CME:** Session High/Low (oddzielna logika)

---

## 📋 Co zostało zbudowane (v2.0)

### `trejdinghub_algo.py` — Python CLI (~1400 linii)

| Klasa / Funkcja | Status | Opis |
|-----------------|--------|------|
| `MarketProfile` | ✅ | Dataclass: POC, VAH, VAL, IB, Single Prints, Poor L/H |
| `Signal` | ✅ | Dataclass: entry, SL, TP, R:R, checklist 6-pkt, confidence |
| `BinanceFetcher` | ✅ | Spot klines, Perp klines, OI history, ticker |
| `MarketProfileEngine` | ✅ | Volume Profile, POC/VA, IB, Single Prints, Poor Extremes |
| `calc_cvd` / `cvd_trend` | ✅ | CVD z taker_buy_vol + klasyfikacja trendu |
| `oi_trend` | ✅ | Trend OI z historii 1h |
| `HTSIndicator` | ✅ | EMA wstęgi slow/fast, bias, bounce, cross, squeeze |
| `MACDDivergence` | ✅ | MACD 12/26/9 + wykrywanie dywergencji byczych/niedźwiedzich |
| `SignalScanner` | ✅ | 4 setupy (S1-S4) + 6-pkt checklist + HTS + MACD |
| `classify_day_type` | ✅ | 5 typów sesji |
| `trend_strength` | ✅ | Siła trendu 1-6 |
| `Backtester` | ✅ | Symulacja WIN/LOSS, Win Rate, Profit Factor, krzywa equity |
| `simple_decision` | ✅ | Tłumaczenie sygnału → KUP / SPRZEDAJ / CZEKAJ |
| `print_signal` | ✅ | Dwuwarstwowy output: prosta decyzja + szczegóły techniczne |
| `main()` CLI | ✅ | `--symbol --days --htf --export --live --profiles --no-backtest` |

### `trejdinghub_agent_v2.jsx` — React Frontend (~850 linii)

| Moduł | Status | Opis |
|-------|--------|------|
| Zakładka Agent AI | ✅ | Formularz Market Profile + Orderflow + przycisk Auto-Fetch |
| Auto-Fetch | ✅ | Pobiera dane przez Anthropic API + web_search (CORS-safe) |
| System Prompt | ✅ | Metodologia TrejdingHub + format KUP/SPRZEDAJ/CZEKAJ |
| formatOutput | ✅ | KUP/SPRZEDAJ/CZEKAJ wyróżnione wielką kolorową ramką |
| Zakładka Profil Rynku | ✅ | Volume Profile + CVD + Price chart (recharts) |
| Zakładka Dziennik | ✅ | Persistent storage, auto-zapis z agenta, edycja wyników |
| Zakładka Backtest | ✅ | AI-powered backtest przez Claude API z web_search |

---

## 🚀 TODO — Co zbudować dalej

### Priorytet 1 — Obsługa akcji US (Yahoo Finance)
```python
class YahooFetcher:
    """Ten sam interfejs co BinanceFetcher — zamienne użycie."""
    def fetch_klines(self, ticker: str, period: str = "60d",
                     interval: str = "30m") -> pd.DataFrame:
        # Zwróć df z kolumnami: open_time, open, high, low, close, volume
        # taker_buy_vol: przybliż jako volume * 0.5 (brak danych dla akcji)
        import yfinance as yf
        raw = yf.Ticker(ticker).history(period=period, interval=interval)
        # ... normalizacja kolumn do standardu projektu
        pass

    def fetch_fundamentals(self, ticker: str) -> dict:
        # pe_ratio, free_cash_flow, revenue_growth, profit_margins
        pass
```

Dodać do CLI: `--source yahoo` i `--symbol GE`

### Priorytet 2 — Dashboard webowy (Streamlit)
```bash
pip install streamlit plotly
# streamlit run dashboard.py
```
Dashboard powinien pokazywać:
- Live Market Profile (odświeżany co 30m)
- CVD chart z kolorami HTS
- Tabela aktywnych sygnałów z KUP/SPRZEDAJ/CZEKAJ
- Dziennik transakcji z win rate

### Priorytet 3 — Alerty live (Telegram / email)
```python
class LiveMonitor:
    def watch(self, symbols: list, interval_sec: int = 1800):
        """Co 30 minut: pobierz → skanuj → wyślij alert jeśli HIGH/MEDIUM confidence."""
        pass

    def send_telegram(self, message: str, bot_token: str, chat_id: str):
        pass
```

### Priorytet 4 — Testy jednostkowe
```bash
tests/
  test_profile.py    # test obliczania POC/VA na znanych danych
  test_signals.py    # test każdego z 4 setupów + simple_decision
  test_hts.py        # test HTSIndicator.calculate() i latest_signal()
  test_macd.py       # test find_divergences() na syntetycznych danych
```

### Priorytet 5 — Cache danych
```python
# Zapisuj pobrane klines do data/cache/SYMBOL_INTERVAL_DATE.json
# Przy kolejnym uruchomieniu w tym samym dniu — wczytaj z cache
# Oszczędza API calls przy developmencie i testach
```

---

## 🛠️ Komendy uruchomienia

```bash
# Instalacja
pip install requests pandas numpy colorama tabulate

# Podstawowe
python trejdinghub_algo.py --symbol BTCUSDT --days 30

# Z bieżącą ceną i wszystkimi profilami
python trejdinghub_algo.py --symbol BTCUSDT --days 14 --live --profiles

# Z HTF bias (nastawienie makro)
python trejdinghub_algo.py --symbol ETHUSDT --days 30 --htf bullish

# Eksport sygnałów do CSV
python trejdinghub_algo.py --symbol SOLUSDT --days 30 --export csv

# Bez backtestów (szybciej)
python trejdinghub_algo.py --symbol BTCUSDT --days 7 --no-backtest

# Eksport JSON
python trejdinghub_algo.py --symbol BTCUSDT --days 30 --export json
```

---

## ⚠️ Zasady rozwoju projektu

1. **Testy przed merge** — każda nowa klasa musi mieć test w `tests/`
2. **Jednolity format danych** — `YahooFetcher` musi zwracać identyczne kolumny co `BinanceFetcher`
3. **Backwards compatibility** — nie zmieniaj sygnatur `MarketProfile`, `Signal`, `Backtester`
4. **Parametry w CONFIG** — wszystkie progi (HTS_SLOW_PERIOD, MACD_FAST itd.) na górze pliku
5. **Cache danych** — przy testach używaj `data/cache/` żeby nie bić w API
6. **Język** — komentarze i output po polsku, kod (nazwy zmiennych/funkcji) po angielsku
7. **Dwuwarstwowy output** — zawsze: prosta decyzja (KUP/SPRZEDAJ/CZEKAJ) + szczegóły techniczne

---

## 📚 Słownik pojęć

| Termin | Definicja |
|--------|-----------|
| POC | Point of Control — cena z maksymalnym wolumenem (magnes rynku) |
| VA | Value Area — zakres 70% wolumenu wokół POC |
| VAH / VAL | Value Area High / Low — granice Value Area |
| IB | Initial Balance — zasięg ceny w pierwszej godzinie sesji |
| PDVA | Previous Day Value Area (VAH/VAL poprzedniej sesji) |
| Range Extension | Wybicie poza IB przez kapitał długoterminowy |
| CVD | Cumulative Volume Delta — skumulowana różnica buy/sell pressure |
| OI | Open Interest — liczba otwartych kontraktów futures |
| Delta Trap | Fałszywy CVD spike tylko przy przebiciu poziomu → ignoruj |
| HTS | Harmonious Trend System — dwie EMA wstęgi (własny wskaźnik Rafała) |
| HTS Slow | Wstęga wolna (czerwona, EMA55) — "ostatni bastion byków" |
| HTS Fast | Wstęga szybka (niebieska, EMA21) — sygnały wejść |
| Single Prints | Strefa min. wolumenu — podatna na wypełnienie przez cenę |
| Poor Low/High | Ekstremum bez wyraźnego ogona — nierozliczone, cel dla ceny |
| Buying/Selling Tail | Ostre odrzucenie na ekstremach profilu przez instytucje |
| S1 | Reguła 80% — open poza PDVA → powrót → 2 bloki wewnątrz |
| S2 | Single Prints — wypełnianie stref minimalnego wolumenu |
| S3 | Wybicie IB — trend following po potwierdzonym przebiciu IB |
| S4 | Ping-Pong POC — mean reversion od VAL/VAH do POC |
| KUP | Otwórz pozycję długą — cena ma rosnąć |
| SPRZEDAJ | Otwórz pozycję krótką — cena ma spadać |
| CZEKAJ | Nie rób nic — warunki niespełnione (checklist < 4/6) |
| Wyjdź (strata) | Zamknij pozycję gdy cena osiągnie Stop Loss |
| Wyjdź (zysk) | Zamknij pozycję gdy cena osiągnie Take Profit |
| R:R | Risk:Reward — ile zarabiasz na każdą złotówkę ryzyka |

---

## 🔗 Źródła

- Blog: https://trejdinghub.pl
- Substack: https://trejdinghub.substack.com
- YouTube: https://www.youtube.com/@TrejdingHub
- Darmowy kurs PDF: https://trejdinghub.pl (100 stron "Od Zera do Tradera")
- Binance API: https://binance-docs.github.io/apidocs/spot/en/
- yfinance: https://pypi.org/project/yfinance/

---

*Projekt edukacyjny. Nie jest poradą inwestycyjną.*  
*Wyniki backtestów nie gwarantują przyszłych zysków.*  
*Ostatnia aktualizacja: czerwiec 2026*
