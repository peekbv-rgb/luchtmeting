// Toren-debiet: statische app + ThingsEye-proxy (ThingsBoard REST).
// Inloggegevens komen uit environment-variabelen, niet uit de browser.
const express = require("express");
const path = require("path");
const app = express();

const {
  TE_URL, TE_USER, TE_PASS, TE_DEVICE,
  TE_KEY_T = "temperature",
  TE_KEY_H = "humidity",
} = process.env;

let token = null;
let cache = { at: 0, data: null };
const CACHE_MS = 15000; // hooguit elke 15 s echt ophalen

function base() { return (TE_URL || "").replace(/\/+$/, ""); }

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
    if (req.query.debug) return res.json({ raw: d, keys: { T: TE_KEY_T, H: TE_KEY_H } });
    const t = d[TE_KEY_T] && d[TE_KEY_T][0];
    const h = d[TE_KEY_H] && d[TE_KEY_H][0];
    const out = {
      temp: t ? toNum(t.value) : null,
      rv: h ? toNum(h.value) : null,
      ts: (t && t.ts) || (h && h.ts) || null,
    };
    cache = { at: now, data: out };
    res.json(out);
  } catch (e) {
    token = null;
    res.status(502).json({ error: String(e.message || e) });
  }
});

app.use(express.static(path.join(__dirname)));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Toren-debiet draait op poort " + PORT));
