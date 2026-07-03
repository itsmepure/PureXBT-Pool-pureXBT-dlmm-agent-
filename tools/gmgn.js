/**
 * GMGN API client — meme token analytics
 * Base: https://openapi.gmgn.ai
 * Auth (2026 scheme): X-APIKEY header + per-request query params
 *   `timestamp` (unix seconds) and `client_id` (random UUID, anti-replay:
 *   a UUID cannot be reused within 7s per API key).
 * Key comes from env GMGN_API_KEY (.env) — never hardcode it here.
 * Rate limit: leaky-bucket 20 req/s
 */
import { randomUUID } from "node:crypto";
import { log } from "../logger.js";

const BASE = "https://openapi.gmgn.ai";
let _warnedNoKey = false;

async function gmgnFetch(path) {
  const apiKey = process.env.GMGN_API_KEY || "";
  if (!apiKey) {
    if (!_warnedNoKey) {
      _warnedNoKey = true;
      log("gmgn", "GMGN_API_KEY not set — all GMGN checks are no-ops (fail-open)");
    }
    return null;
  }
  const sep = path.includes("?") ? "&" : "?";
  const url = `${BASE}${path}${sep}timestamp=${Math.floor(Date.now() / 1000)}&client_id=${randomUUID()}`;
  try {
    const res = await fetch(url, {
      headers: { "X-APIKEY": apiKey, "Accept": "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const json = await res.json();
    if (json.code !== 0) return null;
    let data = json.data ?? null;
    // Some endpoints (e.g. market/rank) double-wrap the payload: {code,data:{code,data:{...}}}
    if (data && typeof data === "object" && "code" in data && "data" in data) {
      if (data.code !== 0) return null;
      data = data.data ?? null;
    }
    return data;
  } catch {
    return null;
  }
}

/**
 * Get token info. New shape nests prices under `data.price`:
 * { price: { price, price_1m, price_5m, price_1h, ... volume_1h, buys_1h, sells_1h }, holder_count, liquidity, ... }
 */
export async function getTokenInfo(mint) {
  if (!mint) return null;
  return gmgnFetch(`/v1/token/info?chain=sol&address=${encodeURIComponent(mint)}`);
}

/**
 * Fetch OHLCV kline/candles data.
 * Params: resolution (1m/5m/15m/1h/4h/1d). `count` is no longer supported by the API.
 * Returns: array of { time, open, high, low, close, volume }
 */
export async function getTokenKline(mint, { resolution = "15m" } = {}) {
  if (!mint) return null;
  return gmgnFetch(`/v1/market/token_kline?chain=sol&address=${encodeURIComponent(mint)}&resolution=${resolution}`);
}

/**
 * Security / rug check.
 * New shape: { honeypot: 0|1, is_honeypot, blacklist: 0|1, is_blacklist, flags: [], ... } — no `rugged` field.
 */
export async function getTokenSecurity(mint) {
  if (!mint) return null;
  return gmgnFetch(`/v1/token/security?chain=sol&address=${encodeURIComponent(mint)}`);
}

/**
 * 1h price change in percent, derived from token info (price vs price_1h).
 * Returns null when data is unavailable.
 */
function pctChange1h(info) {
  const now = Number(info?.price?.price);
  const ago = Number(info?.price?.price_1h);
  if (!Number.isFinite(now) || !Number.isFinite(ago) || ago <= 0) return null;
  return (now / ago - 1) * 100;
}

/**
 * Pump check: reject pool if token pumped > maxPumpPct in last hour.
 * Returns true if the pool should be filtered (pumped too much).
 */
export async function isPumped(mint, maxPumpPct1h) {
  if (!mint || maxPumpPct1h == null) return false;
  const info = await getTokenInfo(mint);
  if (!info) return false; // no data — don't block
  const pct = pctChange1h(info);
  if (pct == null) return false;
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
      const pct = pctChange1h(info);
      const pumped = pct != null && pct > maxPumpPct1h;
      return { pool: p, mint: p.base.mint, pumped, pct: pct != null ? parseFloat(pct.toFixed(2)) : null };
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

/**
 * Fetch top holders for a token.
 * New shape wraps the array in { list: [...] } — unwrapped here so callers keep getting an array.
 */
export async function getTokenTopHolders(mint, { limit = 50 } = {}) {
  if (!mint) return null;
  const data = await gmgnFetch(`/v1/market/token_top_holders?chain=sol&address=${encodeURIComponent(mint)}&limit=${limit}`);
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.list)) return data.list;
  return null;
}

/**
 * Fetch trending tokens by swap activity.
 * Returns { rank: [...] } (double-wrap unwrapped in gmgnFetch).
 */
export async function getMarketRanking({ interval = "1h", limit = 50 } = {}) {
  return gmgnFetch(`/v1/market/rank?chain=sol&interval=${interval}&limit=${limit}`);
}

/**
 * Security filter: rejects tokens flagged as honeypot / blacklisted / rug-flagged.
 * Uses existing getTokenSecurity() wrapper (new field names).
 */
export async function securityCheckFilter(candidates, filteredOut) {
  if (!candidates.length) return;

  log("gmgn", `Security check: scanning ${candidates.length} candidates`);

  const results = await Promise.all(
    candidates.map(async (p) => {
      if (!p.base?.mint) return { pool: p, pass: true };
      const sec = await getTokenSecurity(p.base.mint);
      if (!sec) return { pool: p, pass: true }; // no data — don't block
      const honeypot = sec.honeypot === 1 || sec.is_honeypot === true;
      const rugged =
        sec.blacklist === 1 ||
        sec.is_blacklist === true ||
        (Array.isArray(sec.flags) && sec.flags.some((f) => /rug/i.test(String(f))));
      const blocked = honeypot || rugged;
      return { pool: p, pass: !blocked, rugged, honeypot };
    })
  );

  const kept = [];
  for (const r of results) {
    if (!r.pass) {
      const reason = [r.rugged && "rugged/blacklist", r.honeypot && "honeypot"].filter(Boolean).join(" + ");
      log("gmgn", `Security filter: dropped ${r.pool.name || r.pool.base?.mint?.slice(0, 8)} — ${reason}`);
      if (Array.isArray(filteredOut)) filteredOut.push({ pool: r.pool.name, reason: `GMGN security: ${reason}` });
    } else {
      kept.push(r.pool);
    }
  }

  const removed = candidates.length - kept.length;
  if (removed > 0) log("gmgn", `Security filter removed ${removed}/${candidates.length} candidates`);
  candidates.splice(0, candidates.length, ...kept);
}

/**
 * Batch enrich candidates with top-holder analytics.
 * Attaches gmgn_holders: { top10HoldPct, insiderPct, smartMoneyCount, bundledPct }
 * without removing any candidates — enrichment only, no filtering.
 */
export async function enrichTopHolders(candidates) {
  if (!candidates.length) return;

  log("gmgn", `Holder enrichment: fetching top holders for ${candidates.length} candidates`);

  const results = await Promise.all(
    candidates.map(async (p) => {
      if (!p.base?.mint) return { pool: p, holders: null };
      const holders = await getTokenTopHolders(p.base.mint, { limit: 50 });
      return { pool: p, holders };
    })
  );

  for (const r of results) {
    if (!r.holders || !Array.isArray(r.holders) || r.holders.length === 0) {
      r.pool.gmgn_holders = null;
      continue;
    }

    const total = r.holders.length;
    let top10Pct = 0;
    let insiderCount = 0;
    let smartMoneyCount = 0;
    let bundledCount = 0;

    for (const h of r.holders) {
      const pct = Number(h.amount_percentage) || 0;
      if (h.wallet_tag_v2 && /^TOP(1[0-9]|[1-9])$/i.test(h.wallet_tag_v2)) {
        top10Pct += pct;
      }
      if (h.is_suspicious) insiderCount++;
      const tag = (h.wallet_tag_v2 || "").toLowerCase();
      if (tag.includes("smart_degen") || tag.includes("renowned")) smartMoneyCount++;
      if (tag.includes("bundler") || tag.includes("sniper")) bundledCount++;
    }

    r.pool.gmgn_holders = {
      total_holders_fetched: total,
      top10_hold_pct: parseFloat(top10Pct.toFixed(4)),
      insider_count: insiderCount,
      smart_money_count: smartMoneyCount,
      bundled_count: bundledCount,
    };
  }

  log("gmgn", `Holder enrichment complete for ${candidates.length} candidates`);
}

/**
 * Early Warning: discover trending tokens from GMGN market/rank,
 * then cross-reference with Meteora DLMM pools.
 * Returns candidates that have existing DLMM pools (ready for LP).
 */
export async function discoverTrendingPools({ interval = "1h", limit = 50, fetchPoolDetail } = {}) {
  log("gmgn", `Trending discovery: fetching top ${limit} trending tokens (${interval})`);

  const ranking = await getMarketRanking({ interval, limit });
  if (!ranking?.rank || !Array.isArray(ranking.rank)) {
    log("gmgn", "Trending discovery: no ranking data returned");
    return [];
  }

  log("gmgn", `Trending discovery: got ${ranking.rank.length} trending tokens`);

  // Filter out tokens with obvious red flags before Meteora lookup
  const preFiltered = ranking.rank.filter((t) => {
    if (t.is_wash_trading) return false;
    if (t.rug_ratio > 0.3) return false;
    if (t.is_honeypot) return false;
    return true;
  });

  if (preFiltered.length === 0) {
    log("gmgn", "Trending discovery: all tokens filtered by safety pre-check");
    return [];
  }

  log("gmgn", `Trending discovery: ${preFiltered.length} tokens passed safety pre-check`);

  // Check each trending token for Meteora DLMM pools using fetchPoolDetail
  // We only return tokens that have existing DLMM pools (ready for LP deployment)
  if (typeof fetchPoolDetail !== "function") {
    log("gmgn", "Trending discovery: no fetchPoolDetail provided, returning raw trending data");
    return preFiltered.map((t) => ({
      address: t.address,
      symbol: t.symbol || "?",
      name: t.name || "",
      trending_score: t.hot_level || 0,
      volume_usd: Number(t.volume) || 0,
      market_cap: Number(t.market_cap) || 0,
      smart_degen_count: t.smart_degen_count || 0,
      renowned_count: t.renowned_count || 0,
      price_change_1h: t.price_change_percent1h || 0,
      rug_ratio: t.rug_ratio || 0,
      creator_status: t.creator_token_status || "",
      source: "gmgn_trending",
    }));
  }

  // Cross-reference with Meteora DLMM pools
  const dlmmResults = await Promise.all(
    preFiltered.map(async (t) => {
      try {
        const pool = await fetchPoolDetail(t.address);
        if (!pool) return null;
        return {
          address: t.address,
          symbol: t.symbol || "?",
          name: t.name || "",
          pool_address: pool.address || pool.pool || t.address,
          trending_score: t.hot_level || 0,
          volume_usd: Number(t.volume) || 0,
          market_cap: Number(t.market_cap) || 0,
          smart_degen_count: t.smart_degen_count || 0,
          renowned_count: t.renowned_count || 0,
          price_change_1h: t.price_change_percent1h || 0,
          rug_ratio: t.rug_ratio || 0,
          creator_status: t.creator_token_status || "",
          source: "gmgn_trending",
          pool: pool, // raw Meteora pool detail
        };
      } catch {
        return null;
      }
    })
  );

  const valid = dlmmResults.filter(Boolean);
  log("gmgn", `Trending discovery: ${valid.length} tokens have DLMM pools (out of ${preFiltered.length})`);
  return valid;
}
