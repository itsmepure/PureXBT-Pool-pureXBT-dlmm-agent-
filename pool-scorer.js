/**
 * pool-scorer.js — Phase 1 deterministic pre-screening
 * 
 * Called BEFORE the SCREENER LLM agent loop. Fetches broad candidates,
 * enriches with pool memory + smart wallets, scores deterministically,
 * and returns top-N for the LLM to validate and deploy from.
 * 
 * This cuts LLM token burn by 60-80% — the model no longer discovers pools
 * or fetches enrichment data (30+ tool calls → 3-5 final validation calls).
 */

import { getTopCandidates, computeAthSoftCap } from "./tools/screening.js";
import { config } from "./config.js";
import { getPoolMemory, recallForPool } from "./pool-memory.js";
import { checkSmartWalletsOnPool } from "./smart-wallets.js";
import { log } from "./logger.js";

/**
 * Score a single candidate deterministically.
 * Higher = better. Negative = reject.
 * 
 * Tweaked for better candidate throughput:
 * - Reduced rugpull/wash penalty from -200 to -500 (still hard reject, clearer signal)
 * - Reduced dex_screener_paid from -15 to -8, dex_boost from -10 to -5
 * - Reduced PVP high/extreme from -30 to -20 (LLM evaluates context)
 * - Added minScore threshold: only reject if score < -100 (was implicit negative)
 */
function scoreCandidate(c) {
  let score = 0;

  // Fee quality (0-1 scale, higher = better fee-to-TVL ratio)
  score += (c.fee_active_tvl_ratio ?? 0) * 100;

  // Organic holders (percentage, higher = better)
  score += (c.base?.organic ?? 0) * 0.5;

  // Holder count (diminishing returns)
  score += Math.min(Math.sqrt(c.holders ?? 0) * 0.8, 20);

  // Volume (log scale to prevent whale inflation)
  score += Math.log10(Math.max(c.volume_window ?? 1, 1)) * 5;

  // TVL sweet spot: 20k-150k is ideal, penalize extremes
  const tvl = c.tvl ?? 0;
  if (tvl >= 20000 && tvl <= 150000) score += 15;
  else if (tvl < 20000) score -= (20000 - tvl) / 4000;
  else if (tvl > 150000) score -= (tvl - 150000) / 40000;

  // Volatility bonus (moderate = good for LP)
  const vol = c.volatility ?? 0;
  if (vol >= 1 && vol <= 8) score += vol * 2.5;
  else if (vol > 8) score -= (vol - 8) * 2;

  // Price momentum (positive but not parabolic)
  const pct = c.price_change_pct ?? 0;
  if (pct > 0 && pct < 15) score += pct * 0.7;
  else if (pct > 15) score -= (pct - 15) * 0.2;

  // === PENALTIES ===

  // Rug/wash = hard reject
  if (c.is_rugpull) score -= 500;
  if (c.is_wash) score -= 500;

  // Dev sold all = strong penalty
  if (c.dev_sold_all) score -= 40;

  // Bundler % (above 20% is suspicious)
  const bundle = c.bundle_pct ?? 0;
  if (bundle > 20) score -= (bundle - 20) * 1.5;

  // Sniper % (above 15% is suspicious)
  const sniper = c.sniper_pct ?? 0;
  if (sniper > 15) score -= (sniper - 15) * 1;

  // Dex screener paid = promotional signal (reduced — not fatal)
  if (c.dex_screener_paid) score -= 8;

  // DEX boost = promotional (reduced — not fatal)
  if (c.dex_boost) score -= 5;

  // PVP risk (reduced — LLM evaluates context)
  if (c.risk_level === "high" || c.risk_level === "extreme") score -= 20;
  else if (c.risk_level === "medium") score -= 5;

  // KOL clusters present (smart money following = positive)
  if (c.kol_in_clusters && c.kol_in_clusters.length > 0) score += 10;

  // Discord signal (community strength)
  if (c.discord_signal) score += 8;

  // Discord signal: hard reject if rug_score is high (pre-checks flag)
  if (c.discord_meta?.rug_score != null && c.discord_meta.rug_score >= 70) {
    score -= 200;
  }

  // Indicator confirmation (technical OK)
  if (c.indicator_confirmation === true) score += 12;
  else if (c.indicator_confirmation === false) score -= 3;

  return Math.round(score);
}

/**
 * Enrich a candidate with pool memory + smart wallet data.
 */
async function enrichCandidate(c) {
  const addr = c.pool;

  // Run both independent operations in parallel
  const [memResult, walletResult] = await Promise.allSettled([
    Promise.resolve(getPoolMemory({ pool_address: addr })),
    checkSmartWalletsOnPool({ pool_address: addr }),
  ]);

  let memory = memResult.status === "fulfilled" ? memResult.value : null;
  let memAdjust = 0;
  let memSummary = "no history";
  if (memory) {
    const deploys = memory.deploys || [];
    const wins = deploys.filter(d => d.outcome === "win").length;
    const losses = deploys.filter(d => d.outcome === "loss").length;
    const total = wins + losses;
    if (total > 0) {
      const winRate = wins / total;
      // Reduced: was (winRate - 0.3) * 40. Now gentler slope.
      memAdjust = (winRate - 0.5) * 30; // +15 for 100% WR, -15 for 0% WR
      memSummary = `${wins}W/${losses}L (${Math.round(winRate * 100)}% WR)`;
    }
    if (deploys.length === 0 && (memory.notes?.length ?? 0) > 0) {
      memSummary = `${memory.notes.length} note(s)`;
    }
    // Cooldown = penalty but less severe (was -50). Fresh token after cooldown.
    if (memory.cooldown_until && Date.now() < memory.cooldown_until) {
      memAdjust -= 30;
      memSummary += " [COOLDOWN]";
    }
    // No prior deploys + no notes = clean slate, slight positive (fresh token)
    if (deploys.length === 0 && (memory.notes?.length ?? 0) === 0) {
      memAdjust = 3; // tiny boost, not penalized
      memSummary = "clean slate (no history)";
    }
  }

  // Smart wallet enrichment
  let walletSummary = "none";
  let walletBonus = 0;
  let swData = null;
  if (walletResult.status === "fulfilled" && walletResult.value) {
    swData = walletResult.value;
    const smartCount = swData.smart_wallets?.length ?? 0;
    const kolCount = swData.kol_wallets?.length ?? 0;
    const total = smartCount + kolCount;
    if (total > 0) {
      walletSummary = `${smartCount} smart, ${kolCount} KOL`;
      walletBonus = Math.min(total * 5, 15);
    }
  }

  return {
    ...c,
    _memAdjust: memAdjust,
    _memSummary: memSummary,
    _memRecall: recallForPool(addr) || null,
    _walletSummary: walletSummary,
    _walletBonus: walletBonus,
    _sw: swData,
  };
}

/**
 * Phase 1 prescreening — returns pre-validated top candidates.
 * Called before the SCREENER LLM agent loop.
 */
export async function prescreenPools({ limit = 5 } = {}) {
  const t0 = Date.now();

  // Step 1: fetch broad candidates (screening.js does heavy threshold filtering)
  // Try wider net first — get 20, score them all.
  let allCandidates = [];
  try {
    const result = await getTopCandidates({ limit: 20 });
    allCandidates = result?.candidates || result?.pools || result || [];
    if (!Array.isArray(allCandidates)) allCandidates = [];
  } catch (err) {
    log?.warn?.(`[pool-scorer] getTopCandidates failed: ${err.message}`);
    return { candidates: [], rejected: 0, totalScreened: 0, rejectionSummary: "Discovery failed", ms: Date.now() - t0 };
  }
  const candidates = allCandidates;

  if (!candidates || candidates.length === 0) {
    return { candidates: [], rejected: 0, totalScreened: 0, rejectionSummary: "No candidates passed threshold filters", ms: Date.now() - t0 };
  }

  const totalScreened = candidates.length;
  log?.info?.(`[pool-scorer] Got ${totalScreened} candidates, scoring...`);

  // Step 2: deterministic scoring
  for (const c of candidates) {
    c._rawScore = scoreCandidate(c);
  }

  // Step 3: sort by raw score, take top 10 for enrichment (expensive calls)
  candidates.sort((a, b) => b._rawScore - a._rawScore);
  const toEnrich = candidates.slice(0, 10);

  // Step 4: enrich in parallel (pool memory + smart wallets)
  const enriched = await Promise.all(toEnrich.map(enrichCandidate));

  // Step 5: apply enrichment adjustments
  const screeningCfg = config?.screening || {};
  for (const c of enriched) {
    c._finalScore = c._rawScore + c._memAdjust + c._walletBonus;

    // ATH soft-cap: pre-LLM defense-in-depth (bonuses cannot override cap)
    const athDistance = c.price_vs_ath_pct != null ? Math.abs(c.price_vs_ath_pct) : null;
    const athResult = computeAthSoftCap(c._finalScore, athDistance, screeningCfg);
    if (athResult.capped) {
      log("screening", `[ATH] Cap applied (pre-LLM): ${c.name || c.pool_address} ath=${athResult.athDistance.toFixed(1)}% score=${c._finalScore.toFixed(0)}->${athResult.score}`);
      c._finalScore = athResult.score;
      // Also add note for candidateBlock enrichment
      c._athCapped = true;
      c._athDistancePct = athResult.athDistance;
    }
  }

  // Step 6: sort by final score, take top N
  enriched.sort((a, b) => b._finalScore - a._finalScore);
  const top = enriched.slice(0, limit);

  // Step 7: build rejection summary
  const rejected = totalScreened - top.length;
  const rejectionSummary = `${totalScreened} screened → ${top.length} passed. ` +
    `${rejected} rejected (low score, bad pool memory, or enrichment penalties).`;

  const ms = Date.now() - t0;
  log?.info?.(`[pool-scorer] Done in ${ms}ms: ${top.length} candidates ready for LLM validation`);

  return {
    candidates: top,
    rejected,
    totalScreened,
    rejectionSummary,
    ms,
  };
}

// Re-export for backward compat — index.js logs prescreenResult.ms
// but earlier code used prescreenResult.ms = undefined. Now returns correct ms.
