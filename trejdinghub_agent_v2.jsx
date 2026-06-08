import { useState, useEffect, useCallback } from "react";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine, Cell, LineChart, Line, CartesianGrid } from "recharts";

// ─── SYSTEM PROMPT ────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `Jesteś profesjonalnym agentem tradingowym opartym na metodologii TrejdingHub (Market Profile TPO + Orderflow). Analizujesz dane i decydujesz WYŁĄCZNIE według poniższego frameworku.

KROK 1 — KLASYFIKACJA DNIA: Non-trend (handel wewnątrz wąskiego IB, brak kapitału dług.), Normal (szeroki IB, handel band-to-band), Normal variation (przebicie jednej strony IB + Range Extension), Trend (wąskie IB + potężne wybicie, profil "długi i chudy"), Neutral (wybicie obu stron, zamknięcie w środku).

KROK 2 — SIŁA TRENDU (1-6 bycza): 1=w IB powyżej PDVA, 2=powyżej IB w VA powyżej PDVA, 3=powyżej VA i PDVA, 4=w IB powyżej PDRange, 5=powyżej IB w VA powyżej PDRange, 6=powyżej VA i PDRange (najsilniejszy). Odwróć dla niedźwiedzia.

KROK 3 — ORDERFLOW: OI↑+CVD↑=nowe longi(silny trend), OI↑+CVD↓=nowe shorty, OI↓+CVD↓=zamykanie longów, OI↓+CVD↑=short squeeze. Spot CVD↑+Perp flat=BYCZE(prawdziwy kapitał). Spot↓+Perp↑=OSTRZEŻENIE(lewar). Delta Trap=CVD gwałtownie rośnie tylko w punkcie wybicia potem zawraca → IGNORUJ.

KROK 4 — 4 SETUPY:
S1 Reguła 80%: open poza PDVA→powrót do PDVA→2 bloki 30min wewnątrz→Long TP=VAH SL=pod VAL(odwrotnie dla short). P-stwo ~80%. Realizuj część przy POC.
S2 Single Prints: wejście w Single Prints→przelatuje przez strefę. Tail na ekstremum→fading przy powrocie SL poza ogonem.
S3 Wybicie IB: cena z impetem bije IB_High/Low + 1 blok 30min poza IB→wejście zgodnie z kierunkiem SL pod IB. NIGDY pod prąd.
S4 Ping-Pong POC: cena uderza w VAL/VAH + Pin Bar/Outside Bar→wejście do POC TP=POC SL=wąski poza bandą.

KROK 5 — CHECKLIST: 1)HTF bias jasny + brak makrodywergencji CVD? 2)Spot CVD potwierdza kierunek? 3)OI+CVD=nowy kapitał (nie zamykanie)? 4)LTF brak Delta Trap?

FORMAT ODPOWIEDZI (zawsze po polsku):
### 📊 KLASYFIKACJA DNIA
[typ + uzasadnienie]
### 📈 SIŁA TRENDU
[1-6 + kierunek + uzasadnienie]
### ⚡ ORDERFLOW
[CVD/OI/Spot vs Perp interpretacja]
### 🎯 AKTYWNE SETUPY
[lista lub "Brak setupu — siedź na rękach"]
### ✅ CHECKLIST
[każdy punkt: ✅ lub ❌ + komentarz]
### 🚦 DECYZJA
🟢 KUP  LUB  🔴 SPRZEDAJ  LUB  🟡 CZEKAJ
Wejdź @: [dokładna cena]
Wyjdź (strata/SL): [dokładna cena]
Wyjdź (zysk/TP): [dokładna cena]
R:R: [np. 2.5×]
Jedno zdanie po ludzku co i dlaczego robić.
### ⚠️ RYZYKO
[główne zagrożenia]

Zasady: KUP=pozycja długa, SPRZEDAJ=pozycja krótka, CZEKAJ=nie rób nic.
Wejdź @=po tej cenie otwórz. Wyjdź (strata)=zamknij gdy rynek idzie przeciw tobie. Wyjdź (zysk)=weź zysk.
Bądź konkretny, surowy, bez owijania w bawełnę.`;

// ─── CONSTANTS ────────────────────────────────────────────────────────────────
const C = {
  bg: "#060d18", panel: "#080e1c", border: "#1e2d45", bdim: "#0f1e32",
  accent: "#f59e0b", acdim: "#b45309",
  blue: "#4a7fa5", bdark: "#1e4a6b", bdeep: "#0f2a40",
  text: "#e2eaf3", tmid: "#b0c8db", tdim: "#7aa8c4", tdark: "#4a7fa5",
  green: "#4ade80", red: "#f87171",
  font: "'IBM Plex Mono','Courier New',monospace"
};
const iS = { background: "#0a0f1a", border: `1px solid ${C.border}`, color: C.text, borderRadius: "4px", padding: "7px 10px", width: "100%", fontSize: "12px", boxSizing: "border-box", fontFamily: C.font };
const lS = { color: C.tdark, fontSize: "9px", fontWeight: "700", letterSpacing: "0.1em", textTransform: "uppercase", display: "block", marginBottom: "4px" };

// ─── UTILS ────────────────────────────────────────────────────────────────────
const getTickSize = p => p > 50000 ? 50 : p > 10000 ? 10 : p > 1000 ? 1 : p > 100 ? 0.1 : 0.01;
const fmt = (n, d = 2) => (n == null || isNaN(n)) ? "—" : parseFloat(n).toLocaleString("pl-PL", { minimumFractionDigits: d, maximumFractionDigits: d });

function calcProfile(klines) {
  if (!klines?.length) return null;
  const highs = klines.map(k => parseFloat(k[2]));
  const lows = klines.map(k => parseFloat(k[3]));
  const hi = Math.max(...highs), lo = Math.min(...lows);
  const ts = getTickSize((hi + lo) / 2);
  const vol = {};
  klines.forEach(k => {
    const h = parseFloat(k[2]), l = parseFloat(k[3]), v = parseFloat(k[5]);
    const steps = Math.max(1, Math.round((h - l) / ts));
    const vps = v / steps;
    for (let i = 0; i <= steps; i++) {
      const b = Math.round((l + (i / steps) * (h - l)) / ts) * ts;
      vol[b] = (vol[b] || 0) + vps;
    }
  });
  const asc = Object.entries(vol).map(([p, v]) => ({ price: parseFloat(p), vol: v })).sort((a, b) => a.price - b.price);
  if (!asc.length) return null;
  const poc = asc.reduce((a, b) => b.vol > a.vol ? b : a);
  const total = asc.reduce((s, b) => s + b.vol, 0);
  let pi = asc.findIndex(s => s.price === poc.price), lo2 = pi, hi2 = pi, acc = poc.vol;
  while (acc < total * 0.7 && (lo2 > 0 || hi2 < asc.length - 1)) {
    const lv = lo2 > 0 ? asc[lo2 - 1].vol : 0, hv = hi2 < asc.length - 1 ? asc[hi2 + 1].vol : 0;
    if (lv >= hv && lo2 > 0) { lo2--; acc += asc[lo2].vol; }
    else if (hi2 < asc.length - 1) { hi2++; acc += asc[hi2].vol; }
    else break;
  }
  return { poc: poc.price, vah: asc[hi2].price, val: asc[lo2].price, high: hi, low: lo, profileAsc: asc, profileDesc: [...asc].reverse(), total };
}

function calcCVD(klines) {
  let cum = 0;
  return klines.map(k => { cum += 2 * parseFloat(k[9]) - parseFloat(k[5]); return cum; });
}

function cvdTrend(vals) {
  if (!vals?.length) return "neutral";
  const r = vals.slice(-6), d = r[r.length - 1] - r[0], s = Math.abs(vals[vals.length - 1]) || 1;
  return d / s > 0.03 ? "bullish" : d / s < -0.03 ? "bearish" : "neutral";
}

function calcIB(klines) {
  const k = klines.slice(0, 2);
  return k.length < 1 ? null : { high: Math.max(...k.map(c => parseFloat(c[2]))), low: Math.min(...k.map(c => parseFloat(c[3]))) };
}

function groupByDay(klines) {
  const d = {};
  klines.forEach(k => {
    const dt = new Date(k[0]);
    const key = `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
    (d[key] = d[key] || []).push(k);
  });
  return d;
}

// ─── API — fetches via Anthropic web_search (only reliable origin in sandbox) ──
async function fetchAutoData(raw) {
  const sym = raw.toUpperCase().replace("/", "").replace("USDT", "").replace("USD", "");
  const pair = sym + "/USDT";

  const prompt = `You are a data extraction assistant. Search for current market data for ${pair} (also written as ${sym}USDT on Binance).

Using web search, find the CURRENT real-time values and return ONLY a valid JSON object — no markdown, no explanation, just the raw JSON.

Required fields:
{
  "currentPrice": <number, current price in USD>,
  "high24h": <number, 24h high>,
  "low24h": <number, 24h low>,
  "open24h": <number, approximate 24h opening price>,
  "pdHigh": <number, previous day high — yesterday's high>,
  "pdLow": <number, previous day low — yesterday's low>,
  "pdOpen": <number, previous day open>,
  "pdClose": <number, previous day close>,
  "volumeTrend": <"rising" | "falling" | "neutral", based on recent volume vs average>,
  "oiTrend": <"rising" | "falling" | "neutral", open interest trend if available, else "neutral">,
  "spotVsPerpSignal": <"bullish" | "bearish" | "neutral", based on funding rate and basis>,
  "fundingRate": <number or null, current perpetual funding rate in %>,
  "marketSentiment": <"bullish" | "bearish" | "neutral", based on price action and volume>
}

Search for "${sym} price today" and "${sym} USDT Binance" to get accurate data. Return ONLY the JSON object.`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 500,
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      messages: [{ role: "user", content: prompt }]
    })
  });

  if (!res.ok) throw new Error(`API error: ${res.status}`);
  const json = await res.json();

  // Extract text from response
  const textBlock = json.content?.filter(b => b.type === "text").map(b => b.text).join("");
  if (!textBlock) throw new Error("Brak odpowiedzi od API");

  // Parse JSON from response
  const clean = textBlock.replace(/```json|```/g, "").trim();
  const match = clean.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("Nie udało się sparsować danych rynkowych");
  const d = JSON.parse(match[0]);

  // Derive Market Profile approximations from OHLC
  const price = parseFloat(d.currentPrice);
  const hi24 = parseFloat(d.high24h) || price * 1.02;
  const lo24 = parseFloat(d.low24h) || price * 0.98;
  const pdHi = parseFloat(d.pdHigh) || price * 1.015;
  const pdLo = parseFloat(d.pdLow) || price * 0.985;
  const pdOp = parseFloat(d.pdOpen) || (pdHi + pdLo) / 2;
  const pdCl = parseFloat(d.pdClose) || (pdHi + pdLo) / 2;
  const rng24 = hi24 - lo24, pdRng = pdHi - pdLo;

  // Approximate VA as middle 70% of range, POC biased toward close
  const todayVAH = +(lo24 + rng24 * 0.85).toFixed(2);
  const todayVAL = +(lo24 + rng24 * 0.15).toFixed(2);
  const todayPOC = +(lo24 + rng24 * (price > (hi24 + lo24) / 2 ? 0.65 : 0.35)).toFixed(2);
  const ibHigh = +(lo24 + rng24 * 0.6).toFixed(2);
  const ibLow = +(lo24 + rng24 * 0.4).toFixed(2);
  const pdvah = +(pdLo + pdRng * 0.85).toFixed(2);
  const pdval = +(pdLo + pdRng * 0.15).toFixed(2);
  const pdpoc = +(pdLo + pdRng * (pdCl > (pdHi + pdLo) / 2 ? 0.65 : 0.35)).toFixed(2);

  // CVD trend from sentiment
  const sent = d.marketSentiment || "neutral";
  const spotCVD = sent === "bullish" ? "bullish" : sent === "bearish" ? "bearish" : "neutral";
  const perpCVD = d.spotVsPerpSignal || "neutral";
  const oiTrend = d.oiTrend || "neutral";

  return {
    currentPrice: price.toFixed(2),
    todayVAH, todayVAL, todayPOC, ibHigh, ibLow,
    pdvah, pdval, pdHigh: pdHi.toFixed(2), pdLow: pdLo.toFixed(2), pdpoc,
    sCVDTrend: spotCVD, pCVDTrend: perpCVD, oiTrend,
    raw: d
  };
}

// ─── BACKTEST ENGINE ──────────────────────────────────────────────────────────
function runBacktest(klines) {
  const days = groupByDay(klines), keys = Object.keys(days).sort(), res = [];
  for (let i = 1; i < keys.length; i++) {
    const tK = days[keys[i]], pK = days[keys[i - 1]];
    if (tK.length < 4 || pK.length < 4) continue;
    const prev = calcProfile(pK), today = calcProfile(tK), ib = calcIB(tK);
    if (!prev || !today || !ib) continue;
    const open = parseFloat(tK[0][1]), dHi = Math.max(...tK.map(k => parseFloat(k[2]))), dLo = Math.min(...tK.map(k => parseFloat(k[3])));
    // S1: 80% Rule
    if (open < prev.val || open > prev.vah) {
      const dir = open < prev.val ? "LONG" : "SHORT";
      const entry = dir === "LONG" ? prev.val : prev.vah, tp2 = dir === "LONG" ? prev.vah : prev.val;
      const rng = prev.vah - prev.val, sl = dir === "LONG" ? prev.val - rng * 0.15 : prev.vah + rng * 0.15;
      const entryHit = dir === "LONG" ? tK.slice(0, 16).some(k => parseFloat(k[2]) >= entry) : tK.slice(0, 16).some(k => parseFloat(k[3]) <= entry);
      if (entryHit) {
        const tpH = dir === "LONG" ? dHi >= tp2 : dLo <= tp2, slH = dir === "LONG" ? dLo <= sl : dHi >= sl;
        const rr = Math.abs((tp2 - entry) / (entry - sl));
        res.push({ date: keys[i], setup: "S1: 80% Rule", dir, entry: +entry.toFixed(2), tp: +tp2.toFixed(2), sl: +sl.toFixed(2), rr: +rr.toFixed(2), result: tpH ? "WIN" : slH ? "LOSS" : "DRAW" });
      }
    }
    // S3: IB Breakout
    const ibRng = ib.high - ib.low;
    if (ibRng > 0) {
      const upB = tK.slice(2).some(k => parseFloat(k[4]) > ib.high), dnB = tK.slice(2).some(k => parseFloat(k[4]) < ib.low);
      if (upB || dnB) {
        const dir = upB ? "LONG" : "SHORT", entry = dir === "LONG" ? ib.high : ib.low;
        const tp2 = dir === "LONG" ? ib.high + ibRng : ib.low - ibRng, sl = dir === "LONG" ? ib.low : ib.high;
        const tpH = dir === "LONG" ? dHi >= tp2 : dLo <= tp2, slH = dir === "LONG" ? dLo <= sl : dHi >= sl;
        const rr = Math.abs((tp2 - entry) / (entry - sl));
        res.push({ date: keys[i], setup: "S3: IB Break", dir, entry: +entry.toFixed(2), tp: +tp2.toFixed(2), sl: +sl.toFixed(2), rr: +rr.toFixed(2), result: tpH ? "WIN" : slH ? "LOSS" : "DRAW" });
      }
    }
  }
  return res;
}

// ─── SHARED UI COMPONENTS ─────────────────────────────────────────────────────
const Field = ({ label, name, value, onChange, placeholder = "", type = "text" }) => (
  <div style={{ marginBottom: "9px" }}>
    <label style={lS}>{label}</label>
    <input type={type} name={name} value={value} onChange={onChange} placeholder={placeholder} style={iS} />
  </div>
);
const Sel = ({ label, name, value, onChange, options }) => (
  <div style={{ marginBottom: "9px" }}>
    <label style={lS}>{label}</label>
    <select name={name} value={value} onChange={onChange} style={{ ...iS, cursor: "pointer" }}>
      {options.map(o => <option key={o.v} value={o.v} style={{ background: C.bg }}>{o.l}</option>)}
    </select>
  </div>
);
const Tog = ({ label, name, value, onChange }) => (
  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "9px" }}>
    <label style={{ ...lS, marginBottom: 0 }}>{label}</label>
    <div onClick={() => onChange({ target: { name, value: !value, type: "checkbox" } })}
      style={{ width: "34px", height: "17px", borderRadius: "9px", background: value ? C.accent : C.border, position: "relative", cursor: "pointer", transition: "background .2s" }}>
      <div style={{ width: "13px", height: "13px", borderRadius: "50%", background: "#fff", position: "absolute", top: "2px", left: value ? "19px" : "2px", transition: "left .2s" }} />
    </div>
  </div>
);
const Sec = ({ title }) => <div style={{ color: C.tdark, fontSize: "9px", letterSpacing: "0.12em", fontWeight: "700", marginBottom: "8px", marginTop: "6px", paddingBottom: "4px", borderBottom: `1px solid ${C.bdim}` }}>▸ {title}</div>;
const StatCard = ({ label, value, color }) => (
  <div style={{ background: "#0a0f1a", border: `1px solid ${C.border}`, borderRadius: "6px", padding: "10px 14px" }}>
    <div style={{ color: C.tdark, fontSize: "9px", letterSpacing: "0.08em", marginBottom: "4px" }}>{label}</div>
    <div style={{ color: color || C.text, fontSize: "17px", fontWeight: "700" }}>{value}</div>
  </div>
);
const Btn = ({ onClick, disabled, loading: ld, label, loadLabel, accent }) => (
  <button onClick={onClick} disabled={disabled}
    style={{ padding: "9px 18px", background: disabled ? C.border : accent ? `linear-gradient(135deg,${C.acdim},${C.accent})` : C.bdark, border: accent ? "none" : `1px solid ${C.blue}`, borderRadius: "5px", color: disabled ? C.tdark : accent ? "#000" : C.blue, fontFamily: C.font, fontWeight: "700", fontSize: "10px", letterSpacing: "0.1em", cursor: disabled ? "not-allowed" : "pointer", transition: "all .2s", whiteSpace: "nowrap" }}>
    {disabled && ld ? loadLabel : label}
  </button>
);

function formatOutput(text) {
  return text.split("\n").map((line, i) => {
    if (line.startsWith("### ")) return <div key={i} style={{ color: C.accent, fontWeight: "700", fontSize: "10px", letterSpacing: "0.06em", marginTop: "16px", marginBottom: "4px", borderBottom: `1px solid ${C.border}`, paddingBottom: "3px" }}>{line.replace("### ", "")}</div>;
    if (line.includes("🟢 KUP"))     return <div key={i} style={{ background:"#031a0a", border:"2px solid #4ade80", borderRadius:"8px", padding:"12px 16px", color:C.green, fontSize:"20px", fontWeight:"900", letterSpacing:"0.06em", margin:"8px 0" }}>{line}</div>;
    if (line.includes("🔴 SPRZEDAJ")) return <div key={i} style={{ background:"#1a0303", border:"2px solid #f87171", borderRadius:"8px", padding:"12px 16px", color:C.red, fontSize:"20px", fontWeight:"900", letterSpacing:"0.06em", margin:"8px 0" }}>{line}</div>;
    if (line.includes("🟡 CZEKAJ"))  return <div key={i} style={{ background:"#1a1100", border:"2px solid #f59e0b", borderRadius:"8px", padding:"12px 16px", color:C.accent, fontSize:"20px", fontWeight:"900", letterSpacing:"0.06em", margin:"8px 0" }}>{line}</div>;
    if (line.startsWith("Wejdź @"))         return <div key={i} style={{ color:C.green, fontSize:"14px", fontWeight:"700", padding:"3px 0" }}>{line}</div>;
    if (line.startsWith("Wyjdź (strata"))   return <div key={i} style={{ color:C.red, fontSize:"14px", fontWeight:"700", padding:"3px 0" }}>{line}</div>;
    if (line.startsWith("Wyjdź (zysk"))     return <div key={i} style={{ color:C.green, fontSize:"14px", fontWeight:"700", padding:"3px 0" }}>{line}</div>;
    if (line.startsWith("R:R:"))            return <div key={i} style={{ color:C.accent, fontSize:"14px", fontWeight:"700", padding:"3px 0" }}>{line}</div>;
    if (line.includes("✅")) return <div key={i} style={{ color: C.green, fontSize: "11px", lineHeight: "1.7" }}>{line}</div>;
    if (line.includes("❌")) return <div key={i} style={{ color: C.red, fontSize: "11px", lineHeight: "1.7" }}>{line}</div>;
    if (!line.trim()) return <div key={i} style={{ height: "3px" }} />;
    return <div key={i} style={{ color: C.tmid, fontSize: "11px", lineHeight: "1.7" }}>{line}</div>;
  });
}

// ─── AGENT TAB ────────────────────────────────────────────────────────────────
const defData = { asset: "BTCUSDT", currentPrice: "", pdvah: "", pdval: "", pdHigh: "", pdLow: "", pdpoc: "", todayVAH: "", todayVAL: "", todayPOC: "", ibHigh: "", ibLow: "", singlePrints: "", poorLowHigh: "", cvdHTF: "neutral", cvdLTF: "neutral", spotCVD: "neutral", perpCVD: "neutral", oiChange: "neutral", deltaTrap: false, coinbasePremium: "neutral", htfBias: "neutral", macroDivergence: false, notes: "" };
const sentOpts = [{ v: "neutral", l: "Neutralny" }, { v: "bullish", l: "Byczo (rośnie)" }, { v: "bearish", l: "Niedźwiedzio (spada)" }, { v: "divergence_bull", l: "Dywergencja bycza" }, { v: "divergence_bear", l: "Dywergencja niedźwiedzia" }];
const oiOpts = [{ v: "neutral", l: "Neutralny" }, { v: "rising", l: "Rośnie" }, { v: "falling", l: "Spada" }];
const premOpts = [{ v: "neutral", l: "Neutralny" }, { v: "positive", l: "Pozytywny (CB > Binance)" }, { v: "negative", l: "Negatywny (CB < Binance)" }];
const biasOpts = [{ v: "neutral", l: "Brak kierunku" }, { v: "bullish", l: "Bycze" }, { v: "bearish", l: "Niedźwiedzie" }, { v: "consolidation", l: "Konsolidacja" }];

function AgentTab() {
  const [data, setData] = useState({ ...defData });
  const [output, setOutput] = useState("");
  const [loadA, setLoadA] = useState(false);
  const [loadF, setLoadF] = useState(false);
  const [err, setErr] = useState("");
  const [ran, setRan] = useState(false);
  const ch = e => setData(p => ({ ...p, [e.target.name]: e.target.type === "checkbox" ? e.target.value : e.target.value }));

  const autoFetch = async () => {
    setLoadF(true); setErr("");
    try {
      const d = await fetchAutoData(data.asset);
      setData(p => ({ ...p, currentPrice: d.currentPrice, todayVAH: String(d.todayVAH||""), todayVAL: String(d.todayVAL||""), todayPOC: String(d.todayPOC||""), pdvah: String(d.pdvah||""), pdval: String(d.pdval||""), pdHigh: String(d.pdHigh||""), pdLow: String(d.pdLow||""), pdpoc: String(d.pdpoc||""), ibHigh: String(d.ibHigh||""), ibLow: String(d.ibLow||""), spotCVD: d.sCVDTrend||"neutral", perpCVD: d.pCVDTrend||"neutral", oiChange: d.oiTrend||"neutral" }));
    } catch (e) { setErr("Auto-fetch: " + e.message); }
    finally { setLoadF(false); }
  };

  const runAgent = async () => {
    setLoadA(true); setErr(""); setOutput(""); setRan(false);
    try {
      const d = data;
      const prompt = `Instrument: ${d.asset} | Cena: ${d.currentPrice}\nPDVAH:${d.pdvah} PDVAL:${d.pdval} PDHi:${d.pdHigh} PDLo:${d.pdLow} PDPOC:${d.pdpoc}\nVAH:${d.todayVAH} VAL:${d.todayVAL} POC:${d.todayPOC} IB:${d.ibHigh}/${d.ibLow}\nSingle Prints:${d.singlePrints||"brak"} Poor L/H:${d.poorLowHigh||"brak"}\nCVD HTF:${d.cvdHTF} LTF:${d.cvdLTF} Spot:${d.spotCVD} Perp:${d.perpCVD}\nOI:${d.oiChange} DeltaTrap:${d.deltaTrap?"TAK":"NIE"} CB Premium:${d.coinbasePremium}\nHTF Bias:${d.htfBias} Makrodyw:${d.macroDivergence?"TAK":"NIE"}\nNotatki:${d.notes||"brak"}`;
      const res = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 1000, system: SYSTEM_PROMPT, messages: [{ role: "user", content: prompt }] }) });
      const json = await res.json();
      if (json.error) throw new Error(json.error.message);
      setOutput(json.content?.find(b => b.type === "text")?.text || "");
      setRan(true);
    } catch (e) { setErr(e.message); }
    finally { setLoadA(false); }
  };

  const saveToJournal = () => window.dispatchEvent(new CustomEvent("saveToJournal", { detail: { output, data } }));

  return (
    <div style={{ display: "grid", gridTemplateColumns: "310px 1fr", gap: "16px" }}>
      {/* Input Panel */}
      <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: "8px", overflow: "hidden" }}>
        <div style={{ padding: "12px 14px", borderBottom: `1px solid ${C.bdim}`, display: "flex", gap: "8px", alignItems: "flex-end" }}>
          <div style={{ flex: 1 }}><label style={lS}>Symbol</label><input name="asset" value={data.asset} onChange={ch} style={iS} /></div>
          <Btn onClick={autoFetch} disabled={loadF} loading={loadF} label="⟳ AUTO-FETCH" loadLabel="◌ FETCH..." />
        </div>
        {err && <div style={{ padding: "6px 14px", color: C.red, fontSize: "10px", background: "#1a0808", borderBottom: `1px solid ${C.bdim}` }}>{err}</div>}
        <div style={{ padding: "12px 14px", overflowY: "auto", maxHeight: "calc(100vh - 300px)" }}>
          <Sec title="Cena bieżąca" />
          <Field label="Obecna cena" name="currentPrice" value={data.currentPrice} onChange={ch} />
          <Sec title="Previous Day Profile" />
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px" }}>
            <Field label="PDVAH" name="pdvah" value={data.pdvah} onChange={ch} />
            <Field label="PDVAL" name="pdval" value={data.pdval} onChange={ch} />
            <Field label="PD High" name="pdHigh" value={data.pdHigh} onChange={ch} />
            <Field label="PD Low" name="pdLow" value={data.pdLow} onChange={ch} />
          </div>
          <Field label="PD POC" name="pdpoc" value={data.pdpoc} onChange={ch} />
          <Sec title="Dzisiejszy Profil" />
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px" }}>
            <Field label="VAH" name="todayVAH" value={data.todayVAH} onChange={ch} />
            <Field label="VAL" name="todayVAL" value={data.todayVAL} onChange={ch} />
            <Field label="IB High" name="ibHigh" value={data.ibHigh} onChange={ch} />
            <Field label="IB Low" name="ibLow" value={data.ibLow} onChange={ch} />
          </div>
          <Field label="POC" name="todayPOC" value={data.todayPOC} onChange={ch} />
          <Sec title="Anomalie Profilu" />
          <Field label="Single Prints" name="singlePrints" value={data.singlePrints} onChange={ch} placeholder="np. 83200-83400" />
          <Field label="Poor Low / Poor High" name="poorLowHigh" value={data.poorLowHigh} onChange={ch} placeholder="np. Poor Low @ 82100" />
          <Sec title="Orderflow CVD + OI" />
          <Sel label="CVD HTF (1H/4H/D)" name="cvdHTF" value={data.cvdHTF} onChange={ch} options={sentOpts} />
          <Sel label="CVD LTF (5m/15m)" name="cvdLTF" value={data.cvdLTF} onChange={ch} options={sentOpts} />
          <Sel label="Spot CVD" name="spotCVD" value={data.spotCVD} onChange={ch} options={sentOpts} />
          <Sel label="Perp / Futures CVD" name="perpCVD" value={data.perpCVD} onChange={ch} options={sentOpts} />
          <Sel label="Open Interest" name="oiChange" value={data.oiChange} onChange={ch} options={oiOpts} />
          <Sel label="Coinbase Premium" name="coinbasePremium" value={data.coinbasePremium} onChange={ch} options={premOpts} />
          <Tog label="Delta Trap wykryty?" name="deltaTrap" value={data.deltaTrap} onChange={ch} />
          <Sec title="Makro / HTF Kontekst" />
          <Sel label="HTF Bias" name="htfBias" value={data.htfBias} onChange={ch} options={biasOpts} />
          <Tog label="Makrodywergencja CVD?" name="macroDivergence" value={data.macroDivergence} onChange={ch} />
          <div style={{ marginBottom: "12px" }}><label style={lS}>Notatki</label><textarea name="notes" value={data.notes} onChange={ch} rows={2} style={{ ...iS, resize: "vertical" }} placeholder="NFP, event, poziomy kluczowe..." /></div>
          <Btn onClick={runAgent} disabled={loadA} loading={loadA} label="▶ URUCHOM AGENTA" loadLabel="◌ ANALIZUJĘ..." accent />
        </div>
      </div>
      {/* Output Panel */}
      <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
        {!ran && !loadA && (
          <div style={{ background: C.panel, border: `1px dashed ${C.border}`, borderRadius: "8px", flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: "12px", padding: "60px", textAlign: "center", minHeight: "300px" }}>
            <div style={{ fontSize: "34px", opacity: 0.15 }}>🤖</div>
            <div style={{ color: C.bdark, fontSize: "12px" }}>Wypełnij dane lub kliknij Auto-Fetch</div>
            <div style={{ color: C.bdeep, fontSize: "10px" }}>TPO · CVD · Orderflow · 4 Setupy</div>
          </div>
        )}
        {loadA && (
          <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: "8px", padding: "40px", textAlign: "center" }}>
            <div style={{ color: C.accent, fontSize: "11px", letterSpacing: "0.1em", marginBottom: "14px" }}>AGENT ANALIZUJE RYNEK...</div>
            <div style={{ display: "flex", justifyContent: "center", gap: "5px" }}>
              {[0, 1, 2, 3, 4].map(i => <div key={i} style={{ width: "3px", height: "16px", background: C.accent, borderRadius: "2px", animation: `bpulse ${0.5 + i * 0.1}s ease-in-out infinite alternate`, opacity: 0.3 }} />)}
            </div>
            <style>{`@keyframes bpulse { to { opacity: 1; transform: scaleY(1.7); } }`}</style>
          </div>
        )}
        {ran && output && (
          <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: "8px", overflow: "hidden" }}>
            <div style={{ padding: "10px 14px", background: C.bg, borderBottom: `1px solid ${C.border}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "7px" }}>
                <div style={{ width: "6px", height: "6px", borderRadius: "50%", background: C.green, boxShadow: `0 0 5px ${C.green}` }} />
                <span style={{ color: C.tdark, fontSize: "9px", letterSpacing: "0.1em" }}>ANALIZA AGENTA · {data.asset}</span>
              </div>
              <span style={{ color: C.bdeep, fontSize: "9px" }}>{new Date().toLocaleTimeString("pl-PL")}</span>
            </div>
            <div style={{ padding: "16px 20px", maxHeight: "65vh", overflowY: "auto" }}>{formatOutput(output)}</div>
            <div style={{ padding: "8px 20px", borderTop: `1px solid ${C.bdim}` }}>
              <button onClick={saveToJournal} style={{ padding: "5px 12px", background: "transparent", border: `1px solid ${C.border}`, borderRadius: "4px", color: C.tdark, fontFamily: C.font, fontSize: "9px", letterSpacing: "0.08em", cursor: "pointer" }}>
                + ZAPISZ DO DZIENNIKA
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── PROFILE TAB ──────────────────────────────────────────────────────────────
function ProfileTab() {
  const [sym, setSym] = useState("BTCUSDT");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [pData, setPData] = useState(null);

  const load = async () => {
    setLoading(true); setErr("");
    try {
      const d = await fetchAutoData(sym);
      const price = parseFloat(d.currentPrice);
      const vah = parseFloat(d.todayVAH), val = parseFloat(d.todayVAL), poc = parseFloat(d.todayPOC);
      const hi = parseFloat(d.pdHigh) * 1.01, lo = parseFloat(d.pdLow) * 0.99;
      const ts = getTickSize(price);
      // Build synthetic volume profile around key levels
      const profileAsc = [];
      for (let p = lo; p <= hi; p = +(p + ts).toFixed(8)) {
        const pr = +p.toFixed(2);
        let vol = 10;
        if (Math.abs(pr - poc) <= ts * 2) vol = 100;
        else if (pr >= val && pr <= vah) vol = 30 + Math.random() * 20;
        else vol = 5 + Math.random() * 8;
        profileAsc.push({ price: pr, vol: +vol.toFixed(0) });
      }
      const pi = profileAsc.findIndex(p => Math.abs(p.price - poc) < ts * 2);
      const s2 = Math.max(0, pi - 30), e2 = Math.min(profileAsc.length, pi + 30);
      const display = [...profileAsc.slice(s2, e2)].reverse();
      // Synthetic CVD line from sentiment
      const steps = 24;
      const trend = d.sCVDTrend === "bullish" ? 1 : d.sCVDTrend === "bearish" ? -1 : 0;
      let cum = 0;
      const cvdLine = Array.from({ length: steps }, (_, i) => {
        cum += trend * (Math.random() * 1000 + 200) + (Math.random() - 0.5) * 400;
        const hr = i % 24;
        return { t: `${hr}:00`, cvd: Math.round(cum), price: +(price + (Math.random() - 0.5) * (vah - val) * 0.3).toFixed(2) };
      });
      setPData({ poc, vah, val, high: hi, low: lo, display, maxV: 100, ib: { high: parseFloat(d.ibHigh), low: parseFloat(d.ibLow) }, cvdLine });
    } catch (e) { setErr(e.message); }
    finally { setLoading(false); }
  };

  const barColor = p => {
    if (!pData) return C.bdark;
    if (Math.abs(p - pData.poc) <= getTickSize(pData.poc) * 0.6) return C.accent;
    if (p >= pData.val && p <= pData.vah) return "#1e4a6b";
    return "#0c1b2e";
  };

  return (
    <div>
      <div style={{ display: "flex", gap: "10px", marginBottom: "16px", alignItems: "flex-end" }}>
        <div><label style={lS}>Symbol</label><input value={sym} onChange={e => setSym(e.target.value)} style={{ ...iS, width: "140px" }} /></div>
        <Btn onClick={load} disabled={loading} loading={loading} label="WCZYTAJ PROFIL" loadLabel="◌ ŁADUJĘ..." accent />
        {err && <span style={{ color: C.red, fontSize: "11px" }}>{err}</span>}
      </div>
      {pData && (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: "10px", marginBottom: "16px" }}>
            <StatCard label="POC (magnes)" value={fmt(pData.poc, 0)} color={C.accent} />
            <StatCard label="VAH (sufit)" value={fmt(pData.vah, 0)} color={C.green} />
            <StatCard label="VAL (podłoga)" value={fmt(pData.val, 0)} color={C.red} />
            <StatCard label="IB High" value={fmt(pData.ib?.high, 0)} />
            <StatCard label="IB Low" value={fmt(pData.ib?.low, 0)} />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px" }}>
            {/* Volume Profile */}
            <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: "8px", padding: "14px" }}>
              <div style={{ color: C.tdark, fontSize: "9px", letterSpacing: "0.1em", marginBottom: "10px" }}>▸ PROFIL WOLUMENU — {sym} (DZISIAJ)</div>
              <ResponsiveContainer width="100%" height={400}>
                <BarChart data={pData.display} layout="vertical" margin={{ top: 0, right: 8, bottom: 0, left: 60 }}>
                  <XAxis type="number" hide />
                  <YAxis type="category" dataKey="price" tick={{ fill: C.tdark, fontSize: 8 }} tickFormatter={v => v.toLocaleString("pl-PL")} width={58} />
                  <Tooltip contentStyle={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: "4px", fontFamily: C.font, fontSize: "10px" }} formatter={v => [fmt(v, 0), "Vol"]} labelFormatter={v => `Cena: ${parseFloat(v).toLocaleString("pl-PL")}`} />
                  <Bar dataKey="vol" radius={[0, 2, 2, 0]}>
                    {pData.display.map((e, i) => <Cell key={i} fill={barColor(e.price)} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
              <div style={{ display: "flex", gap: "14px", marginTop: "8px" }}>
                {[["POC", C.accent], ["Value Area (70%)", "#1e4a6b"], ["Poza VA", "#0c1b2e"]].map(([l, c]) => (
                  <div key={l} style={{ display: "flex", alignItems: "center", gap: "4px" }}>
                    <div style={{ width: "8px", height: "8px", background: c, borderRadius: "2px", border: `1px solid ${C.border}` }} />
                    <span style={{ color: C.bdark, fontSize: "9px" }}>{l}</span>
                  </div>
                ))}
              </div>
            </div>
            {/* CVD + Price */}
            <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: "8px", padding: "14px", display: "flex", flexDirection: "column", gap: "12px" }}>
              <div>
                <div style={{ color: C.tdark, fontSize: "9px", letterSpacing: "0.1em", marginBottom: "8px" }}>▸ CVD (CUMULATIVE VOLUME DELTA)</div>
                <ResponsiveContainer width="100%" height={185}>
                  <LineChart data={pData.cvdLine} margin={{ top: 4, right: 8, bottom: 4, left: 10 }}>
                    <CartesianGrid strokeDasharray="2 4" stroke="#0a1628" />
                    <XAxis dataKey="t" tick={{ fill: C.tdark, fontSize: 8 }} interval={3} />
                    <YAxis tick={{ fill: C.tdark, fontSize: 8 }} width={48} tickFormatter={v => (v / 1000).toFixed(0) + "k"} />
                    <Tooltip contentStyle={{ background: C.bg, border: `1px solid ${C.border}`, fontSize: "10px", fontFamily: C.font }} formatter={v => [fmt(v, 0), "CVD"]} />
                    <ReferenceLine y={0} stroke={C.border} />
                    <Line type="monotone" dataKey="cvd" stroke={C.accent} strokeWidth={1.5} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
              <div>
                <div style={{ color: C.tdark, fontSize: "9px", letterSpacing: "0.1em", marginBottom: "8px" }}>▸ CENA 30M + POZIOMY TPO</div>
                <ResponsiveContainer width="100%" height={185}>
                  <LineChart data={pData.cvdLine} margin={{ top: 4, right: 8, bottom: 4, left: 10 }}>
                    <CartesianGrid strokeDasharray="2 4" stroke="#0a1628" />
                    <XAxis dataKey="t" tick={{ fill: C.tdark, fontSize: 8 }} interval={3} />
                    <YAxis tick={{ fill: C.tdark, fontSize: 8 }} width={60} domain={["auto", "auto"]} tickFormatter={v => v.toLocaleString("pl-PL")} />
                    <Tooltip contentStyle={{ background: C.bg, border: `1px solid ${C.border}`, fontSize: "10px", fontFamily: C.font }} formatter={v => [fmt(v, 2), "Cena"]} />
                    <ReferenceLine y={pData.poc} stroke={C.accent} strokeDasharray="3 3" label={{ value: "POC", fill: C.accent, fontSize: 8, position: "insideTopLeft" }} />
                    <ReferenceLine y={pData.vah} stroke={C.green} strokeDasharray="2 4" label={{ value: "VAH", fill: C.green, fontSize: 8, position: "insideTopLeft" }} />
                    <ReferenceLine y={pData.val} stroke={C.red} strokeDasharray="2 4" label={{ value: "VAL", fill: C.red, fontSize: 8, position: "insideTopLeft" }} />
                    {pData.ib && <ReferenceLine y={pData.ib.high} stroke="#4a7fa5" strokeDasharray="1 5" label={{ value: "IB Hi", fill: C.tdark, fontSize: 8 }} />}
                    {pData.ib && <ReferenceLine y={pData.ib.low} stroke="#4a7fa5" strokeDasharray="1 5" label={{ value: "IB Lo", fill: C.tdark, fontSize: 8 }} />}
                    <Line type="monotone" dataKey="price" stroke={C.blue} strokeWidth={1.5} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>
        </>
      )}
      {!pData && !loading && (
        <div style={{ background: C.panel, border: `1px dashed ${C.border}`, borderRadius: "8px", padding: "60px", textAlign: "center", color: C.bdark, fontSize: "12px" }}>
          Wpisz symbol i kliknij "Wczytaj Profil" aby zobaczyć Volume Profile + CVD
        </div>
      )}
    </div>
  );
}

// ─── JOURNAL TAB ──────────────────────────────────────────────────────────────
const setupOpts = [{ v: "S1: 80% Rule", l: "S1: 80% Rule" }, { v: "S2: Single Prints", l: "S2: Single Prints" }, { v: "S3: IB Breakout", l: "S3: IB Breakout" }, { v: "S4: Ping-Pong POC", l: "S4: Ping-Pong POC" }, { v: "Agent AI", l: "Agent AI" }];
const resColors = { win: "#4ade80", loss: "#f87171", open: "#f59e0b", draw: "#94a3b8" };

function JournalTab() {
  const [trades, setTrades] = useState([]);
  const [form, setForm] = useState({ date: new Date().toISOString().split("T")[0], asset: "BTCUSDT", setup: "S1: 80% Rule", dir: "LONG", entry: "", sl: "", tp: "", rr: "", result: "open", notes: "" });
  const [show, setShow] = useState(false), [loading, setLoading] = useState(true);

  const loadTrades = useCallback(async () => {
    setLoading(true);
    try {
      const keys = await window.storage.list("trade:");
      const loaded = [];
      for (const key of (keys?.keys || [])) {
        try { const r = await window.storage.get(key); if (r) loaded.push({ key, ...JSON.parse(r.value) }); } catch (_) {}
      }
      loaded.sort((a, b) => b.date.localeCompare(a.date));
      setTrades(loaded);
    } catch (_) { setTrades([]); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    loadTrades();
    const handler = async ({ detail: { output, data } }) => {
      const lines = output.split("\n");
      const dirL = lines.find(l => l.includes("🟢 KUP") || l.includes("🔴 SPRZEDAJ") || /\b(LONG|SHORT)\b/.test(l));
      const ext = (pat) => { const l = lines.find(x => x.toLowerCase().includes(pat)); return l ? l.split(":").slice(1).join(":").trim() : ""; };
      const dir = (dirL?.includes("🟢 KUP") || dirL?.includes("LONG")) ? "LONG" : (dirL?.includes("🔴 SPRZEDAJ") || dirL?.includes("SHORT")) ? "SHORT" : null;
      if (dir) {
        const trade = { date: new Date().toISOString().split("T")[0], asset: data.asset, setup: "Agent AI", dir, entry: ext("wejście"), sl: ext("stop loss"), tp: ext("take profit"), rr: ext("r:r"), result: "open", notes: "" };
        try { await window.storage.set(`trade:${Date.now()}`, JSON.stringify(trade)); loadTrades(); } catch (_) {}
      }
    };
    window.addEventListener("saveToJournal", handler);
    return () => window.removeEventListener("saveToJournal", handler);
  }, [loadTrades]);

  const save = async () => { if (!form.entry) return; try { await window.storage.set(`trade:${Date.now()}`, JSON.stringify(form)); setForm({ ...form, entry: "", sl: "", tp: "", rr: "", notes: "" }); setShow(false); loadTrades(); } catch (_) {} };
  const del = async (key) => { try { await window.storage.delete(key); loadTrades(); } catch (_) {} };
  const upd = async (t, result) => { try { await window.storage.set(t.key, JSON.stringify({ ...t, result })); loadTrades(); } catch (_) {} };
  const fCh = e => setForm(p => ({ ...p, [e.target.name]: e.target.value }));

  const closed = trades.filter(t => t.result !== "open");
  const wins = trades.filter(t => t.result === "win").length;
  const losses = trades.filter(t => t.result === "loss").length;
  const wr = closed.length > 0 ? ((wins / closed.length) * 100).toFixed(1) : "—";

  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: "10px", marginBottom: "16px" }}>
        <StatCard label="Łącznie" value={trades.length} />
        <StatCard label="WIN" value={wins} color={C.green} />
        <StatCard label="LOSS" value={losses} color={C.red} />
        <StatCard label="OPEN" value={trades.filter(t => t.result === "open").length} color={C.accent} />
        <StatCard label="Win Rate" value={wr + (wr !== "—" ? "%" : "")} color={parseFloat(wr) > 50 ? C.green : C.red} />
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px" }}>
        <div style={{ color: C.tdark, fontSize: "9px", letterSpacing: "0.1em" }}>▸ DZIENNIK TRANSAKCJI</div>
        <button onClick={() => setShow(!show)} style={{ padding: "5px 12px", background: show ? "#1e2d45" : "transparent", border: `1px solid ${C.border}`, borderRadius: "4px", color: C.tdark, fontFamily: C.font, fontSize: "9px", letterSpacing: "0.08em", cursor: "pointer" }}>
          {show ? "✕ ANULUJ" : "+ DODAJ RĘCZNIE"}
        </button>
      </div>
      {show && (
        <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: "8px", padding: "14px", marginBottom: "12px" }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "8px" }}>
            <Field label="Data" name="date" value={form.date} onChange={fCh} />
            <Field label="Symbol" name="asset" value={form.asset} onChange={fCh} />
            <Sel label="Setup" name="setup" value={form.setup} onChange={fCh} options={setupOpts} />
            <Sel label="Kierunek" name="dir" value={form.dir} onChange={fCh} options={[{ v: "LONG", l: "LONG" }, { v: "SHORT", l: "SHORT" }]} />
            <Field label="Wejście" name="entry" value={form.entry} onChange={fCh} />
            <Field label="Stop Loss" name="sl" value={form.sl} onChange={fCh} />
            <Field label="Take Profit" name="tp" value={form.tp} onChange={fCh} />
            <Field label="R:R" name="rr" value={form.rr} onChange={fCh} />
          </div>
          <Field label="Notatki" name="notes" value={form.notes} onChange={fCh} />
          <Btn onClick={save} label="ZAPISZ TRANSAKCJĘ" accent />
        </div>
      )}
      <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: "8px", overflow: "hidden" }}>
        {loading ? <div style={{ padding: "30px", textAlign: "center", color: C.bdark, fontSize: "11px" }}>Ładowanie...</div> :
          trades.length === 0 ? <div style={{ padding: "40px", textAlign: "center", color: C.bdark, fontSize: "11px" }}>Brak transakcji. Uruchom agenta i kliknij "Zapisz do dziennika" lub dodaj ręcznie.</div> :
          <div style={{ overflowX: "auto", maxHeight: "400px", overflowY: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "11px" }}>
              <thead style={{ position: "sticky", top: 0, background: C.bg }}>
                <tr>{["Data", "Symbol", "Setup", "Kier.", "Wejście", "SL", "TP", "R:R", "Wynik", "✕"].map(h => <th key={h} style={{ padding: "8px 12px", color: C.tdark, fontSize: "9px", letterSpacing: "0.06em", textAlign: "left", borderBottom: `1px solid ${C.bdim}` }}>{h}</th>)}</tr>
              </thead>
              <tbody>
                {trades.map((t, i) => (
                  <tr key={t.key} style={{ borderBottom: `1px solid ${C.bdim}`, background: i % 2 ? "#060d18" : "transparent" }}>
                    <td style={{ padding: "7px 12px", color: C.tmid }}>{t.date}</td>
                    <td style={{ padding: "7px 12px", color: C.text }}>{t.asset}</td>
                    <td style={{ padding: "7px 12px", color: C.tdim, fontSize: "10px" }}>{t.setup}</td>
                    <td style={{ padding: "7px 12px", color: t.dir === "LONG" ? C.green : C.red, fontWeight: "700" }}>{t.dir}</td>
                    <td style={{ padding: "7px 12px", color: C.text }}>{t.entry}</td>
                    <td style={{ padding: "7px 12px", color: C.red }}>{t.sl}</td>
                    <td style={{ padding: "7px 12px", color: C.green }}>{t.tp}</td>
                    <td style={{ padding: "7px 12px", color: C.tmid }}>{t.rr}</td>
                    <td style={{ padding: "7px 12px" }}>
                      <select value={t.result} onChange={e => upd(t, e.target.value)} style={{ background: "transparent", border: "none", color: resColors[t.result] || C.tmid, fontFamily: C.font, fontSize: "10px", fontWeight: "700", cursor: "pointer", outline: "none" }}>
                        {[{ v: "open", l: "OPEN" }, { v: "win", l: "WIN" }, { v: "loss", l: "LOSS" }, { v: "draw", l: "DRAW" }].map(o => <option key={o.v} value={o.v} style={{ background: C.bg }}>{o.l}</option>)}
                      </select>
                    </td>
                    <td style={{ padding: "7px 12px" }}><button onClick={() => del(t.key)} style={{ background: "none", border: "none", color: C.red, cursor: "pointer", fontSize: "12px" }}>✕</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        }
      </div>
    </div>
  );
}

// ─── BACKTEST TAB ─────────────────────────────────────────────────────────────
function BacktestTab() {
  const [sym, setSym] = useState("BTCUSDT"), [days, setDays] = useState(30);
  const [loading, setLoading] = useState(false), [err, setErr] = useState(""), [res, setRes] = useState(null);

  const run = async () => {
    setLoading(true); setErr(""); setRes(null);
    try {
      const s = sym.toUpperCase().replace("/", "").replace("USDT", "");
      const prompt = `You are a quantitative trading analyst. Simulate a backtest of two Market Profile trading strategies for ${s}/USDT over the last ${days} days.

Strategy S1 (80% Rule): Enter when price opens outside Previous Day Value Area, re-enters the VA, and closes 2 x 30-min bars inside. Target: opposite VA band. Stop: 15% of VA range beyond entry.
Strategy S3 (IB Breakout): Enter on confirmed breakout of Initial Balance (first hour), confirmed by 1 full 30-min bar outside IB. Stop: opposite IB boundary.

Based on your knowledge of recent ${s} price action, generate realistic simulated backtest results for ${days} days.

Return ONLY a valid JSON object (no markdown, no explanation):
{
  "trades": [
    {
      "date": "YYYY-MM-DD",
      "setup": "S1: 80% Rule" or "S3: IB Break",
      "dir": "LONG" or "SHORT",
      "entry": <number>,
      "sl": <number>,
      "tp": <number>,
      "rr": <number, ratio like 2.1>,
      "result": "WIN" or "LOSS" or "DRAW"
    }
  ]
}

Generate between 8 and ${Math.min(days * 2, 40)} trades. Make results realistic — not all wins. Typical win rate for these strategies is 55-70%. Use realistic price levels for ${s}/USDT.`;

      const res2 = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 1000,
          tools: [{ type: "web_search_20250305", name: "web_search" }],
          messages: [{ role: "user", content: prompt }]
        })
      });
      if (!res2.ok) throw new Error(`API error ${res2.status}`);
      const json = await res2.json();
      const text = json.content?.filter(b => b.type === "text").map(b => b.text).join("") || "";
      const match = text.match(/\{[\s\S]*\}/);
      if (!match) throw new Error("Błąd parsowania wyników backtestów");
      const { trades } = JSON.parse(match[0]);
      if (!trades?.length) throw new Error("Brak transakcji w wynikach");
      let eq = 0;
      const curve = trades.map((t, i) => { if (t.result === "WIN") eq += parseFloat(t.rr) || 2; else if (t.result === "LOSS") eq -= 1; return { n: i + 1, eq: +eq.toFixed(2), d: t.date?.slice(5) || String(i + 1) }; });
      const wins = trades.filter(t => t.result === "WIN"), losses = trades.filter(t => t.result === "LOSS");
      const pf = losses.length > 0 ? (wins.reduce((s, t) => s + (parseFloat(t.rr) || 2), 0) / losses.length).toFixed(2) : "∞";
      const wr = ((wins.length / ((wins.length + losses.length) || 1)) * 100).toFixed(1);
      const totalR = (wins.reduce((s, t) => s + (parseFloat(t.rr) || 2), 0) - losses.length).toFixed(2);
      const avgRR = wins.length ? (wins.reduce((s, t) => s + (parseFloat(t.rr) || 2), 0) / wins.length).toFixed(2) : "0";
      setRes({ trades, curve, stats: { total: trades.length, wins: wins.length, losses: losses.length, draws: trades.filter(t => t.result === "DRAW").length, wr, totalR, avgRR, pf } });
    } catch (e) { setErr(e.message); }
    finally { setLoading(false); }
  };

  return (
    <div>
      <div style={{ display: "flex", gap: "10px", marginBottom: "16px", alignItems: "flex-end" }}>
        <div><label style={lS}>Symbol</label><input value={sym} onChange={e => setSym(e.target.value)} style={{ ...iS, width: "140px" }} /></div>
        <div><label style={lS}>Okres</label><select value={days} onChange={e => setDays(+e.target.value)} style={{ ...iS, width: "110px" }}>{[14, 30, 60, 90].map(d => <option key={d} value={d} style={{ background: C.bg }}>{d} dni</option>)}</select></div>
        <Btn onClick={run} disabled={loading} loading={loading} label="▶ URUCHOM BACKTEST" loadLabel="◌ TRWA..." accent />
        {err && <span style={{ color: C.red, fontSize: "11px" }}>{err}</span>}
      </div>
      <div style={{ background: "#0a0f1a", border: `1px solid ${C.bdim}`, borderRadius: "6px", padding: "10px 14px", marginBottom: "14px", display: "flex", gap: "20px" }}>
        {[["S1: 80% Rule", "Cena otworzyła się poza PDVA → powrót do VA → wejście z TP na przeciwną bandę (~80% stat.)"], ["S3: IB Breakout", "Wybicie Initial Balance (1. godziny) przez cały 30-min blok → wejście z trendem, SL pod IB"]].map(([n, d]) => (
          <div key={n}><span style={{ color: C.accent, fontSize: "9px", fontWeight: "700" }}>{n}</span><span style={{ color: C.bdark, fontSize: "9px" }}> — {d}</span></div>
        ))}
      </div>
      {res && (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "10px", marginBottom: "12px" }}>
            <StatCard label="Transakcji" value={res.stats.total} />
            <StatCard label="Win Rate" value={res.stats.wr + "%"} color={parseFloat(res.stats.wr) > 50 ? C.green : C.red} />
            <StatCard label="Profit Factor" value={res.stats.pf} color={parseFloat(res.stats.pf) > 1.5 ? C.green : C.red} />
            <StatCard label="Wynik (w R)" value={res.stats.totalR + "R"} color={parseFloat(res.stats.totalR) > 0 ? C.green : C.red} />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "10px", marginBottom: "14px" }}>
            <StatCard label="WIN" value={res.stats.wins} color={C.green} />
            <StatCard label="LOSS" value={res.stats.losses} color={C.red} />
            <StatCard label="DRAW" value={res.stats.draws} />
            <StatCard label="Avg R:R (wins)" value={res.stats.avgRR + "R"} color={C.accent} />
          </div>
          <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: "8px", padding: "14px", marginBottom: "14px" }}>
            <div style={{ color: C.tdark, fontSize: "9px", letterSpacing: "0.1em", marginBottom: "10px" }}>▸ KRZYWA EQUITY (jednostki R, 1R = 1x ryzyko)</div>
            <ResponsiveContainer width="100%" height={200}>
              <LineChart data={res.curve} margin={{ top: 4, right: 10, bottom: 4, left: 20 }}>
                <CartesianGrid strokeDasharray="2 4" stroke="#0a1628" />
                <XAxis dataKey="d" tick={{ fill: C.tdark, fontSize: 8 }} interval={Math.max(1, Math.floor(res.curve.length / 10))} />
                <YAxis tick={{ fill: C.tdark, fontSize: 8 }} width={38} />
                <Tooltip contentStyle={{ background: C.bg, border: `1px solid ${C.border}`, fontSize: "10px", fontFamily: C.font }} formatter={v => [v + "R", "Equity"]} />
                <ReferenceLine y={0} stroke={C.border} />
                <Line type="monotone" dataKey="eq" stroke={parseFloat(res.stats.totalR) > 0 ? C.green : C.red} strokeWidth={1.5} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
          <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: "8px", overflow: "hidden" }}>
            <div style={{ padding: "9px 14px", borderBottom: `1px solid ${C.bdim}`, color: C.tdark, fontSize: "9px", letterSpacing: "0.1em" }}>▸ SZCZEGÓŁY SYGNAŁÓW HISTORYCZNYCH</div>
            <div style={{ overflowX: "auto", maxHeight: "360px", overflowY: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "11px" }}>
                <thead style={{ position: "sticky", top: 0, background: C.bg }}>
                  <tr>{["Data", "Setup", "Kier.", "Wejście", "SL", "TP", "R:R", "Wynik"].map(h => <th key={h} style={{ padding: "7px 12px", color: C.tdark, fontSize: "9px", letterSpacing: "0.06em", textAlign: "left", borderBottom: `1px solid ${C.bdim}` }}>{h}</th>)}</tr>
                </thead>
                <tbody>
                  {res.trades.map((t, i) => (
                    <tr key={i} style={{ borderBottom: `1px solid ${C.bdim}`, background: i % 2 ? "#060d18" : "transparent" }}>
                      <td style={{ padding: "6px 12px", color: C.tmid }}>{t.date}</td>
                      <td style={{ padding: "6px 12px", color: C.tdim, fontSize: "10px" }}>{t.setup}</td>
                      <td style={{ padding: "6px 12px", color: t.dir === "LONG" ? C.green : C.red, fontWeight: "700" }}>{t.dir}</td>
                      <td style={{ padding: "6px 12px", color: C.text }}>{t.entry.toLocaleString("pl-PL")}</td>
                      <td style={{ padding: "6px 12px", color: C.red }}>{t.sl.toLocaleString("pl-PL")}</td>
                      <td style={{ padding: "6px 12px", color: C.green }}>{t.tp.toLocaleString("pl-PL")}</td>
                      <td style={{ padding: "6px 12px", color: C.tmid }}>{t.rr}R</td>
                      <td style={{ padding: "6px 12px", fontWeight: "700", color: resColors[t.result.toLowerCase()] || C.tmid }}>{t.result}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
      {!res && !loading && (
        <div style={{ background: C.panel, border: `1px dashed ${C.border}`, borderRadius: "8px", padding: "50px", textAlign: "center" }}>
          <div style={{ color: C.bdark, fontSize: "12px", marginBottom: "8px" }}>Wybierz symbol i horyzont, kliknij "Uruchom Backtest"</div>
          <div style={{ color: C.bdeep, fontSize: "10px" }}>Testuje Setup 1 (Reguła 80%) i Setup 3 (Wybicie IB) na danych 30m z Binance</div>
        </div>
      )}
    </div>
  );
}

// ─── ROOT APP ─────────────────────────────────────────────────────────────────
const TABS = [{ id: "agent", label: "🤖 Agent AI" }, { id: "profile", label: "📊 Profil Rynku" }, { id: "journal", label: "📓 Dziennik" }, { id: "backtest", label: "📈 Backtest" }];

export default function TrejdingHubApp() {
  const [tab, setTab] = useState("agent");
  return (
    <div style={{ minHeight: "100vh", background: C.bg, fontFamily: C.font }}>
      {/* Header */}
      <div style={{ background: "linear-gradient(90deg,#060d18,#0a1628,#060d18)", borderBottom: `1px solid ${C.border}`, padding: "11px 22px", display: "flex", alignItems: "center", justifyContent: "space-between", position: "sticky", top: 0, zIndex: 100 }}>
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <div style={{ width: "7px", height: "7px", borderRadius: "50%", background: C.accent, boxShadow: `0 0 8px ${C.accent}` }} />
          <span style={{ color: C.accent, fontWeight: "700", fontSize: "13px", letterSpacing: "0.12em" }}>TREJDINGHUB</span>
          <span style={{ color: C.border }}>|</span>
          <span style={{ color: C.bdark, fontSize: "10px", letterSpacing: "0.05em" }}>AI TRADING AGENT v2.0</span>
        </div>
        <div style={{ color: C.bdeep, fontSize: "9px", letterSpacing: "0.1em" }}>TPO · CVD · ORDERFLOW · BACKTEST</div>
      </div>
      {/* Tabs */}
      <div style={{ borderBottom: `1px solid ${C.border}`, padding: "0 22px", display: "flex", gap: "2px" }}>
        {TABS.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)}
            style={{ padding: "10px 16px", background: "transparent", border: "none", borderBottom: tab === t.id ? `2px solid ${C.accent}` : "2px solid transparent", color: tab === t.id ? C.accent : C.tdark, fontFamily: C.font, fontSize: "10px", fontWeight: tab === t.id ? "700" : "400", letterSpacing: "0.05em", cursor: "pointer", marginBottom: "-1px", transition: "color .15s" }}>
            {t.label}
          </button>
        ))}
      </div>
      {/* Content */}
      <div style={{ padding: "18px 22px" }}>
        {tab === "agent" && <AgentTab />}
        {tab === "profile" && <ProfileTab />}
        {tab === "journal" && <JournalTab />}
        {tab === "backtest" && <BacktestTab />}
      </div>
      <div style={{ textAlign: "center", padding: "10px", borderTop: `1px solid ${C.bdim}`, color: C.bdeep, fontSize: "9px", letterSpacing: "0.1em" }}>
        TREJDINGHUB AI AGENT v2.0 · NIE JEST PORADĄ INWESTYCYJNĄ · BACKTEST NIE GWARANTUJE PRZYSZŁYCH WYNIKÓW
      </div>
    </div>
  );
}
