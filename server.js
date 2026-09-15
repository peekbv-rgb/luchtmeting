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
  OUT_JSON_URL = "",   // optioneel: lichte JSON-bron per sensor; indien gezet, gebruikt i.p.v. Excel
  OUT_SENSOR_URL = "https://water-tech.cboost.nl/sensors/A8404193CF590F43",  // sensorpagina (HTML), snelst
  OUT_TIMEOUT = "25000",
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

function pick(obj, keys){ for(const k of keys){ if(obj && obj[k]!==undefined && obj[k]!==null) return obj[k]; } return null; }

async function readOut(){
  const now = Date.now();
  if (outCache.data && now - outCache.at < OUT_MS) return outCache.data;
  const timeout = parseInt(OUT_TIMEOUT, 10) || 25000;

  let out;
  if (OUT_JSON_URL){
    // lichte JSON-bron (in te stellen zodra beschikbaar)
    const r = await nodeFetch(OUT_JSON_URL, { headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json,*/*" }, redirect: "follow", timeout });
    if (!r.ok) throw new Error("json " + r.status);
    const j = await r.json();
    const node = j.data || j.latest || j;   // flexibel: pak het datablok
    out = {
      tOut: toNum2(pick(node, ["temperature","temp","t","tOut"])),
      rvOut: toNum2(pick(node, ["humidity","rv","rh","h","rvOut"])),
      ts: cellToTs(pick(node, ["timestamp","ts","time","datetime"])),
      sheet: OUT_SHEET, src: "json",
    };
  } else if (OUT_SENSOR_URL){
    // sensorpagina (HTML) — snelst en betrouwbaarst; nieuwste meting staat bovenaan
    const r = await nodeFetch(OUT_SENSOR_URL, { headers: { "User-Agent": "Mozilla/5.0", "Accept": "text/html,*/*" }, redirect: "follow", timeout });
    if (!r.ok) throw new Error("sensor " + r.status);
    const html = await r.text();
    const text = html.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ");
    const mMeas = text.match(/(-?\d+[.,]\d+)\s*°?\s*C\s+(\d+[.,]\d+)\s*%/i);
    const mSeen = text.match(/Last seen:?\s*(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2})/i)
              || text.match(/(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2})/);
    let ts = null;
    if (mSeen){ const t = Date.parse(mSeen[1].replace(" ", "T")); ts = isNaN(t) ? null : t; }
    if (!mMeas) throw new Error("meting niet gevonden op sensorpagina");
    out = { tOut: toNum2(mMeas[1]), rvOut: toNum2(mMeas[2]), ts, sheet: OUT_SHEET, src: "sensor" };
  } else {
    // Watertech-Excel (volledige export) — traag, laatste keus
    const r = await nodeFetch(OUT_EXCEL_URL, { headers: { "User-Agent": "Mozilla/5.0", "Accept": "*/*" }, redirect: "follow", timeout });
    if (!r.ok) throw new Error("excel " + r.status);
    const buf = await r.buffer();
    const wb = XLSX.read(buf, { type: "buffer", cellDates: false, cellNF: false, cellStyles: false, cellHTML: false });
    const ws = wb.Sheets[OUT_SHEET];
    if (!ws) throw new Error("tabblad '" + OUT_SHEET + "' niet gevonden");
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true });
    const row = rows[1] || [];
    out = { tOut: toNum2(row[2]), rvOut: toNum2(row[1]), ts: cellToTs(row[0]), sheet: OUT_SHEET, src: "excel" };
  }
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

// --- historie: intree (ThingsEye) + uittree (VDB14-sensorpagina) ---
async function historyTE(hours){
  if (!token) await login();
  const end = Date.now(), start = end - hours * 3600000;
  const keys = [TE_KEY_T, TE_KEY_H].filter(Boolean).join(",");
  let url = base() + "/api/plugins/telemetry/DEVICE/" + TE_DEVICE +
    "/values/timeseries?keys=" + encodeURIComponent(keys) +
    "&startTs=" + start + "&endTs=" + end + "&orderBy=ASC";
  if (hours > 48) url += "&interval=3600000&agg=AVG&limit=5000";   // uurgemiddelde bij lange periodes
  else url += "&limit=50000";
  let r = await fetch(url, { headers: { "X-Authorization": "Bearer " + token } });
  if (r.status === 401) { await login(); r = await fetch(url, { headers: { "X-Authorization": "Bearer " + token } }); }
  if (!r.ok) throw new Error("te-history " + r.status);
  return r.json();   // { <TE_KEY_T>:[{ts,value}], <TE_KEY_H>:[...] }
}

let outHistCache = { at: 0, data: null };
const OUT_HIST_MS = 600000; // volledige Excel-historie 10 min cachen

async function historyOutExcel(){
  const now = Date.now();
  if (outHistCache.data && now - outHistCache.at < OUT_HIST_MS) return outHistCache.data;
  const r = await nodeFetch(OUT_EXCEL_URL, { headers: { "User-Agent": "Mozilla/5.0", "Accept": "*/*" }, redirect: "follow", timeout: 60000 });
  if (!r.ok) throw new Error("excel " + r.status);
  const buf = await r.buffer();
  const wb = XLSX.read(buf, { type: "buffer", cellDates: false, cellNF: false, cellStyles: false, cellHTML: false });
  const ws = wb.Sheets[OUT_SHEET];
  if (!ws) throw new Error("tabblad '" + OUT_SHEET + "' niet gevonden");
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true });
  const arr = [];
  for (let i = 1; i < rows.length; i++){   // rij 0 = koppen
    const row = rows[i] || [];
    const ts = cellToTs(row[0]), t = toNum2(row[2]), rv = toNum2(row[1]);
    if (ts != null && (t != null || rv != null)) arr.push({ ts, t, rv });
  }
  arr.sort((a, b) => a.ts - b.ts);
  outHistCache = { at: now, data: arr };
  return arr;
}

async function historyOut(){
  if (!OUT_SENSOR_URL) return [];
  const timeout = parseInt(OUT_TIMEOUT, 10) || 25000;
  const r = await nodeFetch(OUT_SENSOR_URL, { headers: { "User-Agent": "Mozilla/5.0", "Accept": "text/html,*/*" }, redirect: "follow", timeout });
  if (!r.ok) throw new Error("sensor " + r.status);
  const html = await r.text();
  const text = html.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ");
  // tijdstempels en metingen apart oppikken (volgorde onafhankelijk van welke eerst staat)
  const stamps = [...text.matchAll(/(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/g)].map(m => {
    const t = Date.parse(m[1] + "T" + m[2]); return isNaN(t) ? null : t;
  }).filter(x => x !== null);
  const meas = [...text.matchAll(/(-?\d+[.,]\d+)\s*°?\s*C\s+(\d+[.,]\d+)\s*%/g)].map(m => ({ t: toNum2(m[1]), rv: toNum2(m[2]) }));
  // "Graph" toont de nieuwste meting los bovenaan -> 1 meting extra zonder eigen rij; align op de kortste
  let ms = meas, ss = stamps;
  if (ms.length === ss.length + 1) ms = ms.slice(1);        // laat de losse Graph-waarde vallen
  const n = Math.min(ms.length, ss.length);
  const arr = [];
  for (let i = 0; i < n; i++) arr.push({ ts: ss[i], t: ms[i].t, rv: ms[i].rv });
  // ontdubbelen op ts en oplopend sorteren
  const seen = new Set();
  const out = arr.filter(p => (seen.has(p.ts) ? false : (seen.add(p.ts), true))).sort((a, b) => a.ts - b.ts);
  return out;
}

app.get("/api/history", async (req, res) => {
  const hours = Math.min(Math.max(parseInt(req.query.hours, 10) || 24, 1), 1560);  // tot ~65 dagen
  const result = { intree: null, uittree: null, errors: {} };
  try { result.intree = await historyTE(hours); } catch (e) { result.errors.intree = String(e.message || e); }
  let outAll = [];
  try {
    // >24 u: volledige historie uit de Excel; anders de snelle sensorpagina (laatste ~50)
    outAll = hours > 24 ? await historyOutExcel() : await historyOut();
  } catch (e) {
    result.errors.uittree = String(e.message || e);
    try { outAll = await historyOut(); } catch (_) { outAll = []; }   // val terug op sensorpagina
  }
  const since = Date.now() - hours * 3600000;
  const filtered = outAll.filter(p => p.ts >= since);
  result.uittree = filtered.length ? filtered : outAll;
  if (req.query.debug) {
    return res.json({ hours, since, uittree_total: outAll.length, uittree_in_window: filtered.length,
      uittree_sample: outAll.slice(-5), keys: { T: TE_KEY_T, H: TE_KEY_H } });
  }
  res.json({ hours, keys: { T: TE_KEY_T, H: TE_KEY_H }, ...result });
});

// --- statische app serveren (stond eerder per ongeluk uit) ---
const fs = require("fs");
app.get("/", (req, res) => {
  const idx = path.join(__dirname, "index.html");
  fs.access(idx, fs.constants.R_OK, (err) => {
    if (err) return res.status(500).send("index.html niet gevonden: " + idx + " — map bevat: " + fs.readdirSync(__dirname).join(", "));
    res.sendFile(idx);
  });
});
app.use(express.static(path.join(__dirname)));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Toren-debiet draait op poort " + PORT));
