/**
 * GMGN API client — meme token analytics
 * Base: https://openapi.gmgn.ai
 * Auth: X-APIKEY header (read-only)
 * Rate limit: leaky-bucket 20 req/s
 */
import { log } from "../logger.js";

const BASE = "https://openapi.gmgn.ai";
const API_KEY = process.env.GMGN_API_KEY || "your_gmgn_api_key_here";

async function gmgnFetch(path) {
  const url = `${BASE}${path}`;
  try {
    const res = await fetch(url, {
      headers: { "X-APIKEY": API_KEY, "Accept": "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const json = await res.json();
    if (json.code !== 0) return null;
    return json.data ?? null;
  } catch {
    return null;
  }
}

/**
 * Get token info with price change percentages.
 * Weight: 1. Returns: { price, price_change_1m, 5m, 1h, 6h, 24h, ... }
 */
export async function getTokenInfo(mint) {
  if (!mint) return null;
  return gmgnFetch(`/v1/token/info?contract_address=${encodeURIComponent(mint)}`);
}

/**
 * Fetch OHLCV kline/candles data.
 * Weight: 2. Params: resolution (1m/5m/15m/1h/4h/1d), count (max 200).
 * Returns: array of { time, open, high, low, close, volume }
 */
export async function getTokenKline(mint, { resolution = "15m", count = 20 } = {}) {
  if (!mint) return null;
  return gmgnFetch(`/v1/token/kline?contract_address=${encodeURIComponent(mint)}&resolution=${resolution}&count=${count}`);
}

/**
 * Security / rug check.
 * Weight: 1. Returns: { rugged, honeypot, ... }
 */
export async function getTokenSecurity(mint) {
  if (!mint) return null;
  return gmgnFetch(`/v1/token/security?contract_address=${encodeURIComponent(mint)}`);
}

/**
 * Pump check: reject pool if token pumped > maxPumpPct in last hour.
 * Returns true if the pool should be filtered (pumped too much).
 */
export async function isPumped(mint, maxPumpPct1h) {
  if (!mint || maxPumpPct1h == null) return false;
  const info = await getTokenInfo(mint);
  if (!info) return false; // no data — don't block
  const pct = Number(info.price_change_1h);
  if (!Number.isFinite(pct)) return false;
  return pct > maxPumpPct1h;
}

/**
 * Bulk pump check for a list of candidates.
 * Filters pools in-place and populates filtered_examples.
 */
export async function pumpCheckFilter(candidates, filteredOut, maxPumpPct1h) {
  if (!candidates.length || maxPumpPct1h == null) return;

  log("gmgn", `Pump check: scanning ${candidates.length} candidates (threshold: ${maxPumpPct1h}%)`);

  const results = await Promise.all(
    candidates.map(async (p) => {
      if (!p.base?.mint) return { pool: p, mint: null, pumped: false };
      const info = await getTokenInfo(p.base.mint);
      if (!info) return { pool: p, mint: p.base.mint, pumped: false, pct: null };
      const pct = Number(info.price_change_1h);
      const pumped = Number.isFinite(pct) && pct > maxPumpPct1h;
      return { pool: p, mint: p.base.mint, pumped, pct: Number.isFinite(pct) ? pct : null };
    })
  );

  const kept = [];
  for (const r of results) {
    if (r.pumped) {
      log("gmgn", `Pump filter: dropped ${r.pool.name || r.mint?.slice(0, 8)} — ${r.pct}% 1h pump (>${maxPumpPct1h}%)`);
      if (Array.isArray(filteredOut)) {
        filteredOut.push({ pool: r.pool.name, reason: `pumped ${r.pct}% in 1h (>${maxPumpPct1h}% limit)` });
      }
    } else {
      kept.push(r.pool);
    }
  }

  const removed = candidates.length - kept.length;
  if (removed > 0) log("gmgn", `Pump filter removed ${removed}/${candidates.length} candidates`);
  candidates.splice(0, candidates.length, ...kept);
}
