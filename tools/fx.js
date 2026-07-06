// tools/fx.js — kurs USD->IDR, cache memory+file TTL 6 jam, null-safe. __IDR__
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_FILE = path.join(__dirname, "..", "fx-cache.json");
const TTL_MS = 6 * 60 * 60 * 1000;
let _mem = null; // { rate, at }

function readCacheFile() {
  try {
    const j = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
    if (Number.isFinite(j?.rate) && j.rate > 0) return j;
  } catch { /* no cache */ }
  return null;
}
function writeCacheFile(rate) {
  try { fs.writeFileSync(CACHE_FILE, JSON.stringify({ rate, at: Date.now() })); } catch { /* best-effort */ }
}
function fetchTimeout(url, ms = 8000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  return fetch(url, { signal: c.signal }).finally(() => clearTimeout(t));
}

export async function getUsdIdrRate() {
  const now = Date.now();
  if (_mem && now - _mem.at < TTL_MS) return _mem.rate;
  const fileC = readCacheFile();
  if (fileC && now - fileC.at < TTL_MS) { _mem = fileC; return fileC.rate; }
  try {
    const r = await fetchTimeout("https://open.er-api.com/v6/latest/USD");
    const j = await r.json();
    const rate = Number(j?.rates?.IDR);
    if (Number.isFinite(rate) && rate > 0) { _mem = { rate, at: now }; writeCacheFile(rate); return rate; }
  } catch { /* next source */ }
  try {
    const r = await fetchTimeout("https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=idr");
    const j = await r.json();
    const rate = Number(j?.tether?.idr);
    if (Number.isFinite(rate) && rate > 0) { _mem = { rate, at: now }; writeCacheFile(rate); return rate; }
  } catch { /* stale fallback */ }
  if (fileC) { _mem = { rate: fileC.rate, at: now - TTL_MS + 10 * 60 * 1000 }; return fileC.rate; } // basi: coba lagi ~10m
  return null;
}

export function formatIdr(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return null;
  const s = Math.round(Math.abs(v)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${v < 0 ? "-" : ""}Rp ${s}`;
}
