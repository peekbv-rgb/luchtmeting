// Toren-debiet: statische app + ThingsEye-proxy (ThingsBoard REST).
// Inloggegevens komen uit environment-variabelen, niet uit de browser.
const express = require("express");
const path = require("path");
const XLSX = require("xlsx");
const nodeFetch = require("node-fetch");   // v2 — zelfde als de werkende data-app
const app = express();

const {
  TE_URL, TE_USER, TE_PASS, TE_DEVICE,
  TE_KEY_T = "temperature",
  TE_KEY_H = "humidity",
  TE_LAT = "51.6606",
  TE_LON = "5.6172",
  OUT_EXCEL_URL = "https://water-tech.cboost.nl/excel",
  OUT_SHEET = "VDB14",
} = process.env;

let token = null;
let cache = { at: 0, data: null };
const CACHE_MS = 15000; // hooguit elke 15 s echt ophalen
let baroCache = { at: 0, val: null };
const BARO_MS = 900000;      // luchtdruk elke 15 min verversen
const BARO_RETRY_MS = 180000; // na een fout minstens 3 min wachten
let baroNextTry = 0;

function base() { return (TE_URL || "").replace(/\/+$/, ""); }

async function pressure() {
  const now = Date.now();
  if (baroCache.val != null && now - baroCache.at < BARO_MS) return baroCache.val;
  if (now < baroNextTry) return baroCache.val;   // backoff: gebruik laatst bekende (of null)
  try {
    const url = "https://api.open-meteo.com/v1/forecast?latitude=" + TE_LAT +
      "&longitude=" + TE_LON + "&current=surface_pressure";
    const r = await fetch(url);
    if (!r.ok) throw new Error("openmeteo " + r.status);
    const j = await r.json();
    const p = j.current && j.current.surface_pressure;
    if (p != null) { baroCache = { at: now, val: p }; return p; }
    throw new Error("openmeteo geen waarde");
  } catch (e) {
    baroNextTry = now + BARO_RETRY_MS;   // niet blijven hameren
    throw e;
  }
}

async function login() {
  const r = await fetch(base() + "/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: TE_USER, password: TE_PASS }),
  });
  if (!r.ok) throw new Error("login " + r.status);
  token = (await r.json()).token;
}

async function timeseries() {
  const keys = [TE_KEY_T, TE_KEY_H].filter(Boolean).join(",");
  const url = base() + "/api/plugins/telemetry/DEVICE/" + TE_DEVICE +
    "/values/timeseries?keys=" + encodeURIComponent(keys);
  let r = await fetch(url, { headers: { "X-Authorization": "Bearer " + token } });
  if (r.status === 401) { await login(); r = await fetch(url, { headers: { "X-Authorization": "Bearer " + token } }); }
  if (!r.ok) throw new Error("telemetrie " + r.status);
  return r.json();
}

async function timeseriesAll() {
  const url = base() + "/api/plugins/telemetry/DEVICE/" + TE_DEVICE + "/values/timeseries";
  let r = await fetch(url, { headers: { "X-Authorization": "Bearer " + token } });
  if (r.status === 401) { await login(); r = await fetch(url, { headers: { "X-Authorization": "Bearer " + token } }); }
  if (!r.ok) throw new Error("telemetrie-all " + r.status);
  return r.json();
}

// --- API-route staat vóór express.static ---
function toNum(v){
  if (v === null || v === undefined) return null;
  const n = parseFloat(String(v).replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

app.get("/api/te", async (req, res) => {
  try {
    if (!TE_URL || !TE_USER || !TE_PASS || !TE_DEVICE)
      return res.status(500).json({ error: "TE_URL/TE_USER/TE_PASS/TE_DEVICE ontbreken in env." });
    const now = Date.now();
    if (!req.query.debug && cache.data && now - cache.at < CACHE_MS) return res.json(cache.data);
    if (!token) await login();
    const d = await timeseries();
    const t = d[TE_KEY_T] && d[TE_KEY_T][0];
    const h = d[TE_KEY_H] && d[TE_KEY_H][0];
    let baro = null, baroErr = null;
    try { baro = await pressure(); } catch (e) { baroErr = String(e.message || e); console.error("baro:", baroErr); }
    if (req.query.debug) {
      let all = null; try { all = await timeseriesAll(); } catch (e) { all = { error: String(e.message||e) }; }
      return res.json({ gekozen: { T: TE_KEY_T, H: TE_KEY_H }, raw: d, alle_sleutels: all });
    }
    const out = {
      temp: t ? toNum(t.value) : null,
      rv: h ? toNum(h.value) : null,
      baro: baro,
      ts: (t && t.ts) || (h && h.ts) || null,
    };
    cache = { at: now, data: out };
    res.json(out);
  } catch (e) {
    token = null;
    res.status(502).json({ error: String(e.message || e) });
  }
});

// --- uittree-condities uit Excel (tabblad per sensor) ---
let outCache = { at: 0, data: null };
const OUT_MS = 30000; // Excel elke 30 s verversen

function toNum2(v){
  if (v === null || v === undefined || v === "") return null;
  const n = parseFloat(String(v).replace(",", "."));
  return Number.isFinite(n) ? n : null;
}
function cellToTs(v){
  // Excel-datum (getal) of tekst -> ms sinds epoch, of null
  if (typeof v === "number"){
    const d = XLSX.SSF.parse_date_code(v);
    if (d) return new Date(d.y, d.m - 1, d.d, d.H || 0, d.M || 0, Math.floor(d.S || 0)).getTime();
  }
  const s = String(v).trim();
  const m = s.match(/^(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})/);   // "MM-DD HH:MM" zonder jaar
  if (m){ const now = new Date(); return new Date(now.getFullYear(), +m[1]-1, +m[2], +m[3], +m[4]).getTime(); }
  const t = Date.parse(s);
  return isNaN(t) ? null : t;
}

async function readOut(){
  const now = Date.now();
  if (outCache.data && now - outCache.at < OUT_MS) return outCache.data;
  const r = await nodeFetch(OUT_EXCEL_URL, {
    headers: { "User-Agent": "Mozilla/5.0", "Accept": "*/*" },
    redirect: "follow",
    timeout: 90000,
  });
  if (!r.ok) throw new Error("excel " + r.status);
  const buf = await r.buffer();
  const wb = XLSX.read(buf, { type: "buffer", cellDates: false, cellNF: false, cellStyles: false, cellHTML: false });
  const ws = wb.Sheets[OUT_SHEET];
  if (!ws) throw new Error("tabblad '" + OUT_SHEET + "' niet gevonden");
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true });
  const row = rows[1] || [];   // rij 0 = koppen; rij 1 = nieuwste meting
  const out = {
    tOut: toNum2(row[2]),   // C = temperature
    rvOut: toNum2(row[1]),  // B = humidity
    ts: cellToTs(row[0]),   // A = timestamp
    sheet: OUT_SHEET,
  };
  outCache = { at: now, data: out };
  return out;
}

app.get("/api/out", async (req, res) => {
  try {
    const o = await readOut();
    res.json(o);
  } catch (e) {
    const cause = e && e.cause ? (e.cause.code || e.cause.message || String(e.cause)) : null;
    res.status(502).json({ error: String(e.message || e), cause });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Toren-debiet draait op poort " + PORT));
