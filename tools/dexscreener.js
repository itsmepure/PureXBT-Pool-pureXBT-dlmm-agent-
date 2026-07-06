// DexScreener m5 client — free, no API key. Rate ~300 req/min public.
const BASE = "https://api.dexscreener.com/latest/dex/tokens";
const CACHE_TTL_MS = 15_000;
const _cache = new Map(); // mint -> { at, metrics }

export function pickBestPair(pairs) {
  if (!Array.isArray(pairs)) return null;
  const sol = pairs.filter((p) => p?.chainId === "solana");
  if (sol.length === 0) return null;
  return sol.reduce((best, p) => {
    const l = Number(p?.liquidity?.usd) || 0;
    const bl = Number(best?.liquidity?.usd) || 0;
    return l > bl ? p : best;
  }, sol[0]);
}

export function mapMetrics5m(pair) {
  const volume_5m = Number(pair?.volume?.m5) || 0;
  const buys = Number(pair?.txns?.m5?.buys) || 0;
  const sells = Number(pair?.txns?.m5?.sells) || 0;
  const tx_count_5m = buys + sells;
  const buys_vs_sells_5m = buys === 0 && sells === 0 ? 0 : buys / Math.max(1, sells);
  const price_change_5m = Number(pair?.priceChange?.m5) || 0;
  return { volume_5m, tx_count_5m, buys_vs_sells_5m, price_change_5m, lp_usd: Number(pair?.liquidity?.usd) || 0, market_cap: Number(pair?.marketCap ?? pair?.fdv) || 0 };
}

async function _fetchJson(url) {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (res.status === 429) {
    const e = new Error("dexscreener 429");
    e.code = 429;
    throw e;
  }
  if (!res.ok) return null;
  return res.json();
}

export async function getMetrics5m(mint) {
  const now = Date.now();
  const hit = _cache.get(mint);
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.metrics;
  let json = null;
  try {
    json = await _fetchJson(`${BASE}/${mint}`);
  } catch (err) {
    if (err.code === 429) {
      // brief backoff, return stale if any
      await new Promise((r) => setTimeout(r, 500));
      return hit ? hit.metrics : null;
    }
    return hit ? hit.metrics : null;
  }
  const pair = pickBestPair(json?.pairs);
  if (!pair) {
    _cache.set(mint, { at: now, metrics: null });
    return null;
  }
  const metrics = mapMetrics5m(pair);
  _cache.set(mint, { at: now, metrics });
  return metrics;
}

export function _clearCache() {
  _cache.clear();
}
