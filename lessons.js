/**
 * Agent learning system.
 *
 * After each position closes, performance is analyzed and lessons are
 * derived. These lessons are injected into the system prompt so the
 * agent avoids repeating mistakes and doubles down on what works.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { log } from "./logger.js";
import { getSharedLessonsForPrompt, pushHiveLesson, pushHivePerformanceEvent } from "./hivemind.js";
import { blockDev } from "./dev-blocklist.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USER_CONFIG_PATH = path.join(__dirname, "user-config.json");

const LESSONS_FILE = "./lessons.json";
const MIN_EVOLVE_POSITIONS = 5;   // don't evolve until we have real data
const MAX_CHANGE_PER_STEP  = 0.20; // never shift a threshold more than 20% at once
const PERFORMANCE_SIGNAL_FIELDS = [
  "organic_score",
  "fee_tvl_ratio",
  "volume",
  "mcap",
  "holder_count",
  "smart_wallets_present",
  "narrative_quality",
  "study_win_rate",
  "hive_consensus",
  "volatility",
  "discord_author",
  "discord_channel",
  "discord_signal_count",
];
const DISCORD_SIGNALS_FILE = path.resolve("discord-signals.json");
const MAX_MANUAL_LESSON_LENGTH = 400;
const LESSON_DECAY_HALF_LIFE_HOURS = 168;   // lessons lose 50% influence after 7 days
const LESSON_PRUNE_AFTER_HOURS = 720;        // prune unpinned lessons after 30 days
const LESSON_CONFIDENCE_FLOOR = 0.15;        // below this, lesson is hidden from prompt
const LESSON_DEDUP_SIMILARITY = 0.75;        // similarity threshold for dedup merge

function sanitizeLessonText(text, maxLen = MAX_MANUAL_LESSON_LENGTH) {
  if (text == null) return null;
  const cleaned = String(text)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[<>`]/g, "")
    .trim()
    .slice(0, maxLen);
  return cleaned || null;
}

function load() {
  if (!fs.existsSync(LESSONS_FILE)) {
    return { lessons: [], performance: [] };
  }
  try {
    return JSON.parse(fs.readFileSync(LESSONS_FILE, "utf8"));
  } catch {
    return { lessons: [], performance: [] };
  }
}

function save(data) {
  fs.writeFileSync(LESSONS_FILE, JSON.stringify(data, null, 2));
}

function buildSignalSnapshot(perf) {
  const snapshot = { ...(perf.signal_snapshot || {}) };
  if (perf.base_mint && snapshot.base_mint == null) snapshot.base_mint = perf.base_mint;
  for (const field of PERFORMANCE_SIGNAL_FIELDS) {
    if (snapshot[field] == null && perf[field] != null) {
      snapshot[field] = perf[field];
    }
  }
  return Object.values(snapshot).some((value) => value != null) ? snapshot : null;
}

// ─── Record Position Performance ──────────────────────────────

/**
 * Call this when a position closes. Captures performance data and
 * derives a lesson if the outcome was notably good or bad.
 *
 * @param {Object} perf
 * @param {string} perf.position       - Position address
 * @param {string} perf.pool           - Pool address
 * @param {string} perf.pool_name      - Pool name (e.g. "Mustard-SOL")
 * @param {string} perf.strategy       - "spot" | "curve" | "bid_ask"
 * @param {number} perf.bin_range      - Bin range used
 * @param {number} perf.bin_step       - Pool bin step
 * @param {number} perf.volatility     - Pool volatility at deploy time
 * @param {number} perf.fee_tvl_ratio  - fee/TVL ratio at deploy time
 * @param {number} perf.organic_score  - Token organic score at deploy time
 * @param {number} perf.amount_sol     - Amount deployed
 * @param {number} perf.fees_earned_usd - Total fees earned
 * @param {number} perf.final_value_usd - Value when closed
 * @param {number} perf.initial_value_usd - Value when opened
 * @param {number} perf.minutes_in_range  - Total minutes position was in range
 * @param {number} perf.minutes_held      - Total minutes position was held
 * @param {string} perf.close_reason   - Why it was closed
 */
/**
 * Look up Discord signal metadata by base_mint from the local signals file.
 * Returns {discord_author, discord_channel, discord_signal_count} or null.
 */
function lookupDiscordSignal(baseMint) {
  if (!baseMint || !fs.existsSync(DISCORD_SIGNALS_FILE)) return null;
  try {
    const signals = JSON.parse(fs.readFileSync(DISCORD_SIGNALS_FILE, "utf8"));
    if (!Array.isArray(signals)) return null;
    const matches = signals.filter((s) => s.base_mint === baseMint);
    if (matches.length === 0) return null;
    const latest = matches[matches.length - 1];
    return {
      discord_author: latest.discord_author || null,
      discord_channel: latest.discord_channel || null,
      discord_signal_count: matches.length,
    };
  } catch { return null; }
}

/**
 * Fetch on-chain deployer (dev) wallet for a token from Jupiter API.
 */
async function fetchDeployer(baseMint) {
  try {
    const res = await fetch(`https://api.jup.ag/tokens/v1/${baseMint}`);
    if (!res.ok) return null;
    const data = await res.json();
    return data?.mintAuthority || data?.deployer || null;
  } catch { return null; }
}

export async function recordPerformance(perf) {
  const data = load();

  // Guard against unit-mixed records where a SOL-sized final value is
  // accidentally written into a USD field (e.g. final_value_usd = 2 for a 2 SOL close).
  const suspiciousUnitMix =
    Number.isFinite(perf.initial_value_usd) &&
    Number.isFinite(perf.final_value_usd) &&
    Number.isFinite(perf.amount_sol) &&
    perf.initial_value_usd >= 20 &&
    perf.amount_sol >= 0.25 &&
    perf.final_value_usd > 0 &&
    perf.final_value_usd <= perf.amount_sol * 2;

  if (suspiciousUnitMix) {
    log("lessons_warn", `Skipped suspicious performance record for ${perf.pool_name || perf.pool}: initial=${perf.initial_value_usd}, final=${perf.final_value_usd}, amount_sol=${perf.amount_sol}`);
    return;
  }

  const pnl_usd = (perf.final_value_usd + perf.fees_earned_usd) - perf.initial_value_usd;
  const pnl_pct = perf.initial_value_usd > 0
    ? (pnl_usd / perf.initial_value_usd) * 100
    : 0;
  const range_efficiency = perf.minutes_held > 0
    ? (perf.minutes_in_range / perf.minutes_held) * 100
    : 0;

  const closeReasonText = String(perf.close_reason || "").toLowerCase();
  const suspiciousAbsurdClosedPnl =
    Number.isFinite(pnl_pct) &&
    perf.initial_value_usd >= 20 &&
    pnl_pct <= -90 &&
    !closeReasonText.includes("stop loss");

  if (suspiciousAbsurdClosedPnl) {
    log("lessons_warn", `Skipped absurd closed PnL record for ${perf.pool_name || perf.pool}: pnl_pct=${pnl_pct.toFixed(2)} reason=${perf.close_reason}`);
    return;
  }

  const signalSnapshot = buildSignalSnapshot(perf);
  const entry = {
    ...perf,
    signal_snapshot: signalSnapshot,
    pnl_usd: Math.round(pnl_usd * 100) / 100,
    pnl_pct: Math.round(pnl_pct * 100) / 100,
    range_efficiency: Math.round(range_efficiency * 10) / 10,
    recorded_at: new Date().toISOString(),
  };

  // Enrich with Discord signal metadata if not already present
  if (!entry.discord_author && entry.base_mint) {
    const discordMeta = lookupDiscordSignal(entry.base_mint);
    if (discordMeta) {
      entry.discord_author = discordMeta.discord_author;
      entry.discord_channel = discordMeta.discord_channel;
      entry.discord_signal_count = discordMeta.discord_signal_count;
      if (entry.signal_snapshot) {
        entry.signal_snapshot.discord_author = discordMeta.discord_author;
        entry.signal_snapshot.discord_channel = discordMeta.discord_channel;
        entry.signal_snapshot.discord_signal_count = discordMeta.discord_signal_count;
      }
    }
  }

  // Auto-block deployer on severe loss
  if (entry.pnl_pct < -15 && perf.base_mint) {
    try {
      const dev = await fetchDeployer(perf.base_mint);
      if (dev) {
        blockDev({
          wallet: dev,
          reason: `Bad position: ${entry.pnl_pct}% PnL on ${perf.pool_name || perf.pool}`,
          label: perf.pool_name || perf.base_mint?.slice(0, 8),
        });
        entry.blocked_dev = dev;
        log("lessons", `Auto-blocked deployer ${dev.slice(0, 8)}... for ${perf.pool_name}: ${entry.pnl_pct}% loss`);
      }
    } catch (e) {
      log("lessons_warn", `Failed to fetch deployer for auto-block: ${e.message}`);
    }
  }

  data.performance.push(entry);

  // Derive and store a lesson
  const lesson = derivLesson(entry);
  if (lesson) {
    upsertLesson(data, lesson);
    log("lessons", `New lesson: ${lesson.rule}`);
  }

  save(data);
  // Push disabled — pull-only mode
  // if (lesson) {
  //   void pushHiveLesson(lesson);
  // }

  // Update pool-level memory
  if (perf.pool) {
    const { recordPoolDeploy } = await import("./pool-memory.js");
    recordPoolDeploy(perf.pool, {
      pool_name: perf.pool_name,
      base_mint: perf.base_mint,
      deployed_at: perf.deployed_at,
      closed_at: entry.recorded_at,
      pnl_pct: entry.pnl_pct,
      pnl_usd: entry.pnl_usd,
      range_efficiency: entry.range_efficiency,
      minutes_held: perf.minutes_held,
      fees_earned_usd: perf.fees_earned_usd,
      fees_earned_sol: perf.fees_earned_sol,
      fee_earned_pct: perf.initial_value_usd > 0 ? ((perf.fees_earned_usd || 0) / perf.initial_value_usd) * 100 : null,
      close_reason: perf.close_reason,
      strategy: perf.strategy,
      volatility: perf.volatility,
    });
  }

  // Evolve thresholds every 5 closed positions
  if (data.performance.length % MIN_EVOLVE_POSITIONS === 0) {
    const { config, reloadScreeningThresholds } = await import("./config.js");
    const result = evolveThresholds(data.performance, config);
    if (result?.changes && Object.keys(result.changes).length > 0) {
      reloadScreeningThresholds();
      log("evolve", `Auto-evolved thresholds: ${JSON.stringify(result.changes)}`);
    }

    // Darwinian signal weight recalculation
    if (config.darwin?.enabled) {
      const { recalculateWeights } = await import("./signal-weights.js");
      const wResult = recalculateWeights(data.performance, config);
      if (wResult.changes.length > 0) {
        log("evolve", `Darwin: adjusted ${wResult.changes.length} signal weight(s)`);
      }
    }
  }

  // Push disabled — pull-only mode
  // void pushHivePerformanceEvent({
  //   ...entry,
  //   base_mint: perf.base_mint || null,
  //   fees_earned_sol: perf.fees_earned_sol || 0,
  //   eventId: `close:${perf.position}:${entry.recorded_at}`,
  // });

}

/**
 * Derive a lesson from a closed position's performance.
 * Only generates a lesson if the outcome was clearly good or bad.
 */
function derivLesson(perf) {
  const tags = [];
  const feeYieldPct = perf.initial_value_usd > 0
    ? ((perf.fees_earned_usd || 0) / perf.initial_value_usd) * 100
    : 0;

  // Categorize outcome
  const outcome = perf.pnl_pct >= 5 ? "good"
    : (perf.pnl_pct >= 0 && feeYieldPct >= 2) ? "good"
    : perf.pnl_pct >= 0 ? "neutral"
    : perf.pnl_pct >= -5 ? "poor"
    : "bad";

  if (outcome === "neutral") return null; // nothing interesting to learn

  // Build context description
  const context = [
    `${perf.pool_name}`,
    `strategy=${perf.strategy}`,
    `bin_step=${perf.bin_step}`,
    `volatility=${perf.volatility}`,
    `fee_tvl_ratio=${perf.fee_tvl_ratio}`,
    `organic=${perf.organic_score}`,
    `bin_range=${typeof perf.bin_range === 'object' ? JSON.stringify(perf.bin_range) : perf.bin_range}`,
  ].join(", ");

  let rule = "";

  if (outcome === "good" || outcome === "bad") {
    if (perf.range_efficiency < 30 && outcome === "bad") {
      rule = `AVOID: ${perf.pool_name}-type pools (volatility=${perf.volatility}, bin_step=${perf.bin_step}) with strategy="${perf.strategy}" — went OOR ${100 - perf.range_efficiency}% of the time. Consider wider bin_range or bid_ask strategy.`;
      tags.push("oor", perf.strategy, `volatility_${Math.round(perf.volatility)}`);
    } else if (perf.range_efficiency > 80 && outcome === "good") {
      rule = `PREFER: ${perf.pool_name}-type pools (volatility=${perf.volatility}, bin_step=${perf.bin_step}) with strategy="${perf.strategy}" — ${perf.range_efficiency}% in-range efficiency, PnL +${perf.pnl_pct}%.`;
      tags.push("efficient", perf.strategy);
    } else if (outcome === "bad" && perf.close_reason?.includes("volume")) {
      rule = `AVOID: Pools with fee_tvl_ratio=${perf.fee_tvl_ratio} that showed volume collapse — fees evaporated quickly. Minimum sustained volume check needed before deploying.`;
      tags.push("volume_collapse");
    } else if (outcome === "good") {
      rule = `WORKED: ${context} → PnL +${perf.pnl_pct}%, range efficiency ${perf.range_efficiency}%.`;
      tags.push("worked");
    } else {
      rule = `FAILED: ${context} → PnL ${perf.pnl_pct}%, range efficiency ${perf.range_efficiency}%. Reason: ${perf.close_reason}.`;
      tags.push("failed");
    }
  }

  if (!rule) return null;

  const closeReasonText = String(perf.close_reason || "").toLowerCase();
  const positiveEvidence =
    feeYieldPct >= 1 ||
    (perf.fees_earned_usd || 0) >= 3 ||
    perf.pnl_pct >= 3;
  const negativeEvidence =
    perf.pnl_pct <= -5 ||
    perf.range_efficiency <= 30 ||
    closeReasonText.includes("out of range") ||
    closeReasonText.includes("oor") ||
    closeReasonText.includes("low yield") ||
    closeReasonText.includes("volume");

  let confidence = 0.35;
  if (outcome === "good") {
    confidence = positiveEvidence ? 0.82 : 0.22;
  } else if (outcome === "bad") {
    confidence = negativeEvidence ? 0.88 : 0.45;
  } else if (outcome === "poor") {
    confidence = negativeEvidence ? 0.68 : 0.32;
  }

  return {
    id: Date.now(),
    rule,
    tags,
    outcome,
    sourceType: "performance",
    confidence: Math.round(confidence * 100) / 100,
    context,
    pnl_pct: perf.pnl_pct,
    fees_earned_usd: perf.fees_earned_usd,
    initial_value_usd: perf.initial_value_usd,
    range_efficiency: perf.range_efficiency,
    close_reason: perf.close_reason,
    pool: perf.pool,
    created_at: new Date().toISOString(),
  };
}

// ─── Adaptive Threshold Evolution ──────────────────────────────

/**
 * Analyze closed position performance and evolve screening thresholds.
 * Writes changes to user-config.json and returns a summary.
 *
 * @param {Array}  perfData - Array of performance records (from lessons.json)
 * @param {Object} config   - Live config object (mutated in place)
 * @returns {{ changes: Object, rationale: Object } | null}
 */
export function evolveThresholds(perfData, config) {
  if (!perfData || perfData.length < MIN_EVOLVE_POSITIONS) return null;

  const winners = perfData.filter((p) => p.pnl_pct > 0);
  const losers  = perfData.filter((p) => p.pnl_pct < -5);

  // Need at least some signal in both directions before adjusting
  const hasSignal = winners.length >= 2 || losers.length >= 2;
  if (!hasSignal) return null;

  const changes   = {};
  const rationale = {};

  // ── 1. minFeeActiveTvlRatio ───────────────────────────────────
  // Raise the floor if low-fee pools consistently underperform.
  {
    const winnerFees = winners.map((p) => p.fee_tvl_ratio).filter(isFiniteNum);
    const loserFees  = losers.map((p) => p.fee_tvl_ratio).filter(isFiniteNum);
    const current    = config.screening.minFeeActiveTvlRatio;

    if (winnerFees.length >= 2) {
      // Minimum fee/TVL among winners — we know pools below this don't work for us
      const minWinnerFee = Math.min(...winnerFees);
      if (minWinnerFee > current * 1.2) {
        const target  = minWinnerFee * 0.85; // stay slightly below min winner
        const newVal  = clamp(nudge(current, target, MAX_CHANGE_PER_STEP), 0.05, 10.0);
        const rounded = Number(newVal.toFixed(2));
        if (rounded > current) {
          changes.minFeeActiveTvlRatio = rounded;
          rationale.minFeeActiveTvlRatio = `Lowest winner fee_tvl=${minWinnerFee.toFixed(2)} — raised floor from ${current} → ${rounded}`;
        }
      }
    }

    if (loserFees.length >= 2) {
      // If losers all had high fee/TVL, that's noise (pumps then crash) — don't raise min
      // But if losers had low fee/TVL, raise min
      const maxLoserFee = Math.max(...loserFees);
      if (maxLoserFee < current * 1.5 && winnerFees.length > 0) {
        const minWinnerFee = Math.min(...winnerFees);
        if (minWinnerFee > maxLoserFee) {
          const target  = maxLoserFee * 1.2;
          const newVal  = clamp(nudge(current, target, MAX_CHANGE_PER_STEP), 0.05, 10.0);
          const rounded = Number(newVal.toFixed(2));
        if (rounded > current && !changes.minFeeActiveTvlRatio) {
          changes.minFeeActiveTvlRatio = rounded;
          rationale.minFeeActiveTvlRatio = `Losers had fee_tvl<=${maxLoserFee.toFixed(2)}, winners higher — raised floor from ${current} → ${rounded}`;
          }
        }
      }
    }
  }

  // ── 2. minOrganic ─────────────────────────────────────────────
  // Raise organic floor if low-organic tokens consistently failed.
  {
    const loserOrganics  = losers.map((p) => p.organic_score).filter(isFiniteNum);
    const winnerOrganics = winners.map((p) => p.organic_score).filter(isFiniteNum);
    const current        = config.screening.minOrganic;

    if (loserOrganics.length >= 2 && winnerOrganics.length >= 1) {
      const avgLoserOrganic  = avg(loserOrganics);
      const avgWinnerOrganic = avg(winnerOrganics);
      // Only raise if there's a clear gap (winners consistently more organic)
      if (avgWinnerOrganic - avgLoserOrganic >= 10) {
        // Set floor just below worst winner
        const minWinnerOrganic = Math.min(...winnerOrganics);
        const target = Math.max(minWinnerOrganic - 3, current);
        const newVal = clamp(Math.round(nudge(current, target, MAX_CHANGE_PER_STEP)), 60, 90);
        if (newVal > current) {
          changes.minOrganic = newVal;
          rationale.minOrganic = `Winner avg organic ${avgWinnerOrganic.toFixed(0)} vs loser avg ${avgLoserOrganic.toFixed(0)} — raised from ${current} → ${newVal}`;
        }
      }
    }
  }

  // ── 3. minVolume ──────────────────────────────────────────────
  // Adjust volume floor based on winner/loser volume patterns.
  {
    const current = config.screening.minVolume;
    if (typeof current === "number" && isFinite(current)) {
      const winnerVols = winners.map((p) => p.volume ?? p.signal_snapshot?.volume).filter(isFiniteNum);
      const loserVols  = losers.map((p) => p.volume ?? p.signal_snapshot?.volume).filter(isFiniteNum);
      if (winnerVols.length >= 2 && loserVols.length >= 2) {
        const minWinnerVol = Math.min(...winnerVols);
        const avgLoserVol  = avg(loserVols);
        if (minWinnerVol > current * 1.3 && avgLoserVol < minWinnerVol * 0.7) {
          const target = minWinnerVol * 0.8;
          const newVal = clamp(Math.round(nudge(current, target, MAX_CHANGE_PER_STEP)), 100, 5000);
          if (newVal > current) {
            changes.minVolume = newVal;
            rationale.minVolume = `Winners had volume>=${minWinnerVol.toFixed(0)}, losers avg ${avgLoserVol.toFixed(0)} — raised floor from ${current} → ${newVal}`;
          }
        }
      }
    }
  }

  // ── 4. minHolders ─────────────────────────────────────────────
  // Raise holder floor if low-holder tokens consistently failed.
  {
    const current = config.screening.minHolders;
    if (typeof current === "number" && isFinite(current)) {
      const winnerHolders = winners.map((p) => p.holder_count ?? p.signal_snapshot?.holder_count).filter(isFiniteNum);
      const loserHolders  = losers.map((p) => p.holder_count ?? p.signal_snapshot?.holder_count).filter(isFiniteNum);
      if (winnerHolders.length >= 2 && loserHolders.length >= 2) {
        const minWinnerHolders = Math.min(...winnerHolders);
        const avgLoserHolders  = avg(loserHolders);
        if (minWinnerHolders > current * 1.2 && avgLoserHolders < minWinnerHolders * 0.8) {
          const target = minWinnerHolders * 0.85;
          const newVal = clamp(Math.round(nudge(current, target, MAX_CHANGE_PER_STEP)), 100, 5000);
          if (newVal > current) {
            changes.minHolders = newVal;
            rationale.minHolders = `Winners had holders>=${minWinnerHolders.toFixed(0)}, losers avg ${avgLoserHolders.toFixed(0)} — raised floor from ${current} → ${newVal}`;
          }
        }
      }
    }
  }

  // ── 5. minMcap ────────────────────────────────────────────────
  // Adjust mcap floor based on winner/loser patterns.
  {
    const current = config.screening.minMcap;
    if (typeof current === "number" && isFinite(current)) {
      const winnerMcaps = winners.map((p) => p.mcap ?? p.signal_snapshot?.mcap).filter(isFiniteNum);
      const loserMcaps  = losers.map((p) => p.mcap ?? p.signal_snapshot?.mcap).filter(isFiniteNum);
      if (winnerMcaps.length >= 2 && loserMcaps.length >= 2) {
        const minWinnerMcap = Math.min(...winnerMcaps);
        const avgLoserMcap  = avg(loserMcaps);
        if (minWinnerMcap > current * 1.3 && avgLoserMcap < minWinnerMcap * 0.6) {
          const target = minWinnerMcap * 0.8;
          const newVal = clamp(Math.round(nudge(current, target, MAX_CHANGE_PER_STEP)), 50000, 5000000);
          if (newVal > current) {
            changes.minMcap = newVal;
            rationale.minMcap = `Winners had mcap>=${formatNum(minWinnerMcap)}, losers avg ${formatNum(avgLoserMcap)} — raised floor from ${formatNum(current)} → ${formatNum(newVal)}`;
          }
        }
      }
    }
  }

  // ── 6. maxBundlersPct ─────────────────────────────────────────
  // Lower bundler ceiling if high-bundler tokens consistently failed.
  {
    const current = config.screening.maxBundlersPct;
    if (typeof current === "number" && isFinite(current)) {
      const winnerBundlers = winners.map((p) => p.bundler_pct ?? p.signal_snapshot?.bundler_pct).filter(isFiniteNum);
      const loserBundlers  = losers.map((p) => p.bundler_pct ?? p.signal_snapshot?.bundler_pct).filter(isFiniteNum);
      if (loserBundlers.length >= 2 && winnerBundlers.length >= 2) {
        const maxWinnerBundler = Math.max(...winnerBundlers);
        const avgLoserBundler  = avg(loserBundlers);
        if (avgLoserBundler > maxWinnerBundler * 1.3 && avgLoserBundler > current * 0.8) {
          const target = maxWinnerBundler * 1.1;
          const newVal = clamp(Math.round(nudge(current, target, MAX_CHANGE_PER_STEP)), 10, 50);
          if (newVal < current) {
            changes.maxBundlersPct = newVal;
            rationale.maxBundlersPct = `Losers avg bundler ${avgLoserBundler.toFixed(0)}% > winners max ${maxWinnerBundler.toFixed(0)}% — lowered ceiling from ${current} → ${newVal}`;
          }
        }
      }
    }
  }

  // ── 7. minTokenFeesSol ───────────────────────────────────────
  {
    const current = config.screening.minTokenFeesSol;
    if (typeof current === "number" && isFinite(current)) {
      const winnerFees = winners.map((p) => p.total_fees_sol ?? p.signal_snapshot?.total_fees_sol).filter(isFiniteNum);
      const loserFees  = losers.map((p) => p.total_fees_sol ?? p.signal_snapshot?.total_fees_sol).filter(isFiniteNum);
      if (winnerFees.length >= 2 && loserFees.length >= 2) {
        const minWinnerFee = Math.min(...winnerFees);
        const avgLoserFee  = avg(loserFees);
        if (minWinnerFee > current * 1.3 && avgLoserFee < minWinnerFee * 0.6) {
          const target = minWinnerFee * 0.8;
          const newVal = clamp(Math.round(nudge(current, target, MAX_CHANGE_PER_STEP)), 5, 200);
          if (newVal > current) {
            changes.minTokenFeesSol = newVal;
            rationale.minTokenFeesSol = `Winners had fees>=${minWinnerFee.toFixed(1)} SOL, losers avg ${avgLoserFee.toFixed(1)} — raised floor from ${current} → ${newVal}`;
          }
        }
      }
    }
  }

  // ── 8. minBinStep ─────────────────────────────────────────────
  {
    const current = config.screening.minBinStep;
    if (typeof current === "number" && isFinite(current)) {
      const winnerBins = winners.map((p) => p.bin_step ?? p.signal_snapshot?.bin_step).filter(isFiniteNum);
      const loserBins  = losers.map((p) => p.bin_step ?? p.signal_snapshot?.bin_step).filter(isFiniteNum);
      if (winnerBins.length >= 2 && loserBins.length >= 2) {
        const minWinnerBin = Math.min(...winnerBins);
        const maxLoserBin  = Math.max(...loserBins);
        if (minWinnerBin > current && maxLoserBin < minWinnerBin) {
          const target = minWinnerBin * 0.9;
          const newVal = clamp(Math.round(nudge(current, target, MAX_CHANGE_PER_STEP)), 1, 500);
          if (newVal > current) {
            changes.minBinStep = newVal;
            rationale.minBinStep = `Winners bin_step>=${minWinnerBin}, losers max ${maxLoserBin} — raised floor from ${current} → ${newVal}`;
          }
        }
      }
    }
  }

  // ── 9. maxBinStep ─────────────────────────────────────────────
  {
    const current = config.screening.maxBinStep;
    if (typeof current === "number" && isFinite(current)) {
      const winnerBins = winners.map((p) => p.bin_step ?? p.signal_snapshot?.bin_step).filter(isFiniteNum);
      const loserBins  = losers.map((p) => p.bin_step ?? p.signal_snapshot?.bin_step).filter(isFiniteNum);
      if (winnerBins.length >= 2 && loserBins.length >= 2) {
        const maxWinnerBin = Math.max(...winnerBins);
        const avgLoserBin  = avg(loserBins);
        if (avgLoserBin > maxWinnerBin * 1.3) {
          const target = maxWinnerBin * 1.1;
          const newVal = clamp(Math.round(nudge(current, target, MAX_CHANGE_PER_STEP)), 1, 500);
          if (newVal < current) {
            changes.maxBinStep = newVal;
            rationale.maxBinStep = `Losers avg bin_step ${avgLoserBin.toFixed(0)} > winners max ${maxWinnerBin} — lowered ceiling from ${current} → ${newVal}`;
          }
        }
      }
    }
  }

  // ── 10. maxMcap ───────────────────────────────────────────────
  {
    const current = config.screening.maxMcap;
    if (typeof current === "number" && isFinite(current)) {
      const winnerMcaps = winners.map((p) => p.mcap ?? p.signal_snapshot?.mcap).filter(isFiniteNum);
      const loserMcaps  = losers.map((p) => p.mcap ?? p.signal_snapshot?.mcap).filter(isFiniteNum);
      if (winnerMcaps.length >= 2 && loserMcaps.length >= 2) {
        const maxWinnerMcap = Math.max(...winnerMcaps);
        const avgLoserMcap  = avg(loserMcaps);
        if (avgLoserMcap > maxWinnerMcap * 1.5) {
          const target = maxWinnerMcap * 1.2;
          const newVal = clamp(Math.round(nudge(current, target, MAX_CHANGE_PER_STEP)), 100000, 50000000);
          if (newVal < current) {
            changes.maxMcap = newVal;
            rationale.maxMcap = `Losers avg mcap ${formatNum(avgLoserMcap)} > winners max ${formatNum(maxWinnerMcap)} — lowered ceiling from ${formatNum(current)} → ${formatNum(newVal)}`;
          }
        }
      }
    }
  }

  if (Object.keys(changes).length === 0) return { changes: {}, rationale: {} };

  // ── Persist changes to user-config.json (nested global path) ───
  let userConfig = {};
  if (fs.existsSync(USER_CONFIG_PATH)) {
    try { userConfig = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8")); } catch { /* ignore */ }
  }

  // Write to global.screening (new nested format), not root level
  if (!userConfig.global) userConfig.global = {};
  if (!userConfig.global.screening) userConfig.global.screening = {};
  Object.assign(userConfig.global.screening, changes);
  userConfig._lastEvolved = new Date().toISOString();
  userConfig._positionsAtEvolution = perfData.length;

  fs.writeFileSync(USER_CONFIG_PATH, JSON.stringify(userConfig, null, 2));

  // Apply to live config object immediately
  for (const [key, value] of Object.entries(changes)) {
    config.screening[key] = value;
  }

  // Log a lesson summarizing the evolution
  const data = load();
  upsertLesson(data, {
    id: Date.now(),
    rule: `[AUTO-EVOLVED @ ${perfData.length} positions] ${Object.entries(changes).map(([k, v]) => `${k}=${v}`).join(", ")} — ${Object.values(rationale).join("; ")}`,
    tags: ["evolution", "config_change"],
    outcome: "manual",
    created_at: new Date().toISOString(),
  });
  save(data);

  return { changes, rationale };
}

// ─── Helpers ───────────────────────────────────────────────────

function isFiniteNum(n) {
  return typeof n === "number" && isFinite(n);
}

function avg(arr) {
  return arr.reduce((s, x) => s + x, 0) / arr.length;
}

function percentile(arr, p) {
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

/** Move current toward target by at most maxChange fraction. */
function nudge(current, target, maxChange) {
  const delta = target - current;
  const maxDelta = current * maxChange;
  if (Math.abs(delta) <= maxDelta) return target;
  return current + Math.sign(delta) * maxDelta;
}

// ─── Confidence Decay ──────────────────────────────────────────

/** Extract timestamp from a lesson, tolerant of missing fields. */
function lessonTimestamp(lesson) {
  if (lesson.created_at) return new Date(lesson.created_at).getTime();
  if (lesson.timestamp) return new Date(lesson.timestamp).getTime();
  if (lesson.id && typeof lesson.id === "number" && lesson.id > 1e12) return lesson.id;
  return 0;
}

/** Lesson age in hours from current time. */
function lessonAgeHours(lesson, nowMs = Date.now()) {
  const ts = lessonTimestamp(lesson);
  return ts > 0 ? (nowMs - ts) / (1000 * 60 * 60) : 0;
}

/** Compute effective confidence with exponential decay. */
function effectiveConfidence(lesson, nowMs = Date.now()) {
  const raw = typeof lesson.confidence === "number" ? lesson.confidence : 0.5;
  const ageHours = lessonAgeHours(lesson, nowMs);
  if (ageHours <= 0) return raw;
  const decay = Math.pow(0.5, ageHours / LESSON_DECAY_HALF_LIFE_HOURS);
  return raw * decay;
}

/** Whether a lesson should be pruned due to age. */
function isPrunedByAge(lesson, nowMs = Date.now()) {
  if (lesson.pinned) return false;
  const ageHours = lessonAgeHours(lesson, nowMs);
  return ageHours > LESSON_PRUNE_AFTER_HOURS;
}

// ─── Lesson Deduplication ──────────────────────────────────────

/** Normalize a lesson rule for comparison. */
function normalizeLessonText(rule) {
  if (!rule) return "";
  return String(rule)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[,.;:()=\[\]-]/g, " ")
    .replace(/\b\d+\.?\d*\b/g, "__NUM__")
    .toLowerCase()
    .trim();
}

/** Jaccard-like similarity on normalized text tokens. */
function lessonTextSimilarity(a, b) {
  const normA = normalizeLessonText(a);
  const normB = normalizeLessonText(b);
  if (!normA || !normB) return 0;
  const tokensA = new Set(normA.split(" ").filter(Boolean));
  const tokensB = new Set(normB.split(" ").filter(Boolean));
  const intersection = [...tokensA].filter((t) => tokensB.has(t)).length;
  const union = new Set([...tokensA, ...tokensB]).size;
  return union > 0 ? intersection / union : 0;
}

/** Check if two lessons share a similar pool type or context. */
function lessonsShareContext(a, b) {
  if (a.pool && b.pool && a.pool === b.pool) return true;
  if (a.pool_name && b.pool_name && a.pool_name === b.pool_name) return true;
  const contextA = normalizeLessonText(a.rule || a.context || "");
  const contextB = normalizeLessonText(b.rule || b.context || "");
  const textSim = lessonTextSimilarity(contextA, contextB);
  return textSim >= 0.5;
}

/** Full similarity check for dedup matching. */
function lessonSimilarityScore(a, b) {
  const textSim = lessonTextSimilarity(a.rule, b.rule);
  const contextMatch = lessonsShareContext(a, b) ? 0.15 : 0;
  const sameOutcome = a.outcome === b.outcome ? 0.1 : 0;
  return textSim + contextMatch + sameOutcome;
}

/** Find an existing lesson similar enough to the candidate. */
function findDuplicateLesson(lessons, candidate) {
  for (const existing of lessons) {
    if (existing.id === candidate.id) continue;
    const score = lessonSimilarityScore(existing, candidate);
    if (score >= LESSON_DEDUP_SIMILARITY) return existing;
  }
  return null;
}

/** Merge a duplicate lesson into the existing one. */
function mergeLesson(existing, incoming) {
  existing.confidence = Math.min(1.0, (existing.confidence + incoming.confidence) / 2 * 1.15);
  if (incoming.pinned) existing.pinned = true;
  if (incoming.tags) {
    existing.tags = existing.tags || [];
    for (const t of incoming.tags) {
      if (!existing.tags.includes(t)) existing.tags.push(t);
    }
  }
  existing.merged_count = (existing.merged_count || 1) + 1;
  existing.updated_at = incoming.created_at || new Date().toISOString();
  if (incoming.pnl_pct != null) existing.last_pnl_pct = incoming.pnl_pct;
  if (incoming.range_efficiency != null) existing.last_range_efficiency = incoming.range_efficiency;
  if (incoming.close_reason) existing.last_close_reason = incoming.close_reason;
  return existing;
}

/** Insert lesson with dedup: merge if similar exists, else append. */
function upsertLesson(data, lesson) {
  const dup = findDuplicateLesson(data.lessons, lesson);
  if (dup) {
    mergeLesson(dup, lesson);
    return dup;
  }
  data.lessons.push(lesson);
  return lesson;
}

// ─── Manual Lessons ────────────────────────────────────────────

/**
 * Add a manual lesson (e.g. from operator observation).
 *
 * @param {string}   rule
 * @param {string[]} tags
 * @param {Object}   opts
 * @param {boolean}  opts.pinned - Always inject regardless of cap
 * @param {string}   opts.role   - "SCREENER" | "MANAGER" | "GENERAL" | null (all roles)
 */
export function addLesson(rule, tags = [], { pinned = false, role = null } = {}) {
  const safeRule = sanitizeLessonText(rule);
  if (!safeRule) return;
  const data = load();
  const lesson = {
    id: Date.now(),
    rule: safeRule,
    tags,
    outcome: "manual",
    sourceType: tags.includes("self_tune") || tags.includes("config_change") ? "config_change" : "manual",
    pinned: !!pinned,
    role: role || null,
    created_at: new Date().toISOString(),
  };
  upsertLesson(data, lesson);
  save(data);
  log("lessons", `Manual lesson added${pinned ? " [PINNED]" : ""}${role ? ` [${role}]` : ""}: ${safeRule}`);
  // Push disabled — pull-only mode
  // void pushHiveLesson(lesson);
}

/**
 * Pin a lesson by ID — pinned lessons are always injected regardless of cap.
 */
export function pinLesson(id) {
  const data = load();
  const lesson = data.lessons.find((l) => l.id === id);
  if (!lesson) return { found: false };
  lesson.pinned = true;
  save(data);
  log("lessons", `Pinned lesson ${id}: ${lesson.rule.slice(0, 60)}`);
  return { found: true, pinned: true, id, rule: lesson.rule };
}

/**
 * Unpin a lesson by ID.
 */
export function unpinLesson(id) {
  const data = load();
  const lesson = data.lessons.find((l) => l.id === id);
  if (!lesson) return { found: false };
  lesson.pinned = false;
  save(data);
  return { found: true, pinned: false, id, rule: lesson.rule };
}

/**
 * List lessons with optional filters — for agent browsing via Telegram.
 */
export function listLessons({ role = null, pinned = null, tag = null, limit = 30 } = {}) {
  const data = load();
  let lessons = [...data.lessons];

  if (pinned !== null) lessons = lessons.filter((l) => !!l.pinned === pinned);
  if (role)            lessons = lessons.filter((l) => !l.role || l.role === role);
  if (tag)             lessons = lessons.filter((l) => l.tags?.includes(tag));

  return {
    total: lessons.length,
    lessons: lessons.slice(-limit).map((l) => ({
      id: l.id,
      rule: l.rule.slice(0, 120),
      tags: l.tags,
      outcome: l.outcome,
      pinned: !!l.pinned,
      role: l.role || "all",
      created_at: l.created_at?.slice(0, 10),
    })),
  };
}

/**
 * Remove lessons matching a keyword in their rule text (case-insensitive).
 */
export function removeLessonsByKeyword(keyword) {
  const data = load();
  const before = data.lessons.length;
  const kw = keyword.toLowerCase();
  data.lessons = data.lessons.filter((l) => !l.rule.toLowerCase().includes(kw));
  save(data);
  return before - data.lessons.length;
}

/**
 * Clear ALL lessons (keeps performance data).
 */
export function clearAllLessons() {
  const data = load();
  const count = data.lessons.length;
  data.lessons = [];
  save(data);
  return count;
}

/**
 * Clear ALL performance records.
 */
export function clearPerformance() {
  const data = load();
  const count = data.performance.length;
  data.performance = [];
  save(data);
  return count;
}

// ─── Lesson Retrieval ──────────────────────────────────────────

// Tags that map to each agent role — used for role-aware lesson injection
const ROLE_TAGS = {
  SCREENER: ["screening", "narrative", "strategy", "deployment", "token", "volume", "entry", "bundler", "holders", "organic"],
  MANAGER:  ["management", "risk", "oor", "fees", "position", "hold", "close", "pnl", "rebalance", "claim"],
  GENERAL:  [], // all lessons
};

/**
 * Get lessons formatted for injection into the system prompt.
 * Structured injection with three tiers:
 *   1. Pinned        — always injected, up to PINNED_CAP
 *   2. Role-matched  — lessons tagged for this agentType, up to ROLE_CAP
 *   3. Recent        — fill remaining slots up to RECENT_CAP
 *
 * @param {Object} opts
 * @param {string} [opts.agentType]  - "SCREENER" | "MANAGER" | "GENERAL"
 * @param {number} [opts.maxLessons] - Override total cap (default 35)
 */
export function getLessonsForPrompt(opts = {}) {
  // Support legacy call signature: getLessonsForPrompt(20)
  if (typeof opts === "number") opts = { maxLessons: opts };

  const { agentType = "GENERAL", maxLessons } = opts;

  const data = load();
  if (data.lessons.length === 0) return null;

  // Smaller caps for automated cycles — they don't need the full lesson history
  const isAutoCycle = agentType === "SCREENER" || agentType === "MANAGER";
  const PINNED_CAP  = isAutoCycle ? 5  : 10;
  const ROLE_CAP    = isAutoCycle ? 6  : 15;
  const RECENT_CAP  = maxLessons ?? (isAutoCycle ? 10 : 35);

  const outcomePriority = { bad: 0, poor: 1, failed: 1, good: 2, worked: 2, manual: 1, neutral: 3, evolution: 2 };
  const now = Date.now();
  const byPriority = (a, b) => {
    // Use effective confidence for decay-aware sorting
    const ea = effectiveConfidence(a, now);
    const eb = effectiveConfidence(b, now);
    const outcomeDiff = (outcomePriority[a.outcome] ?? 3) - (outcomePriority[b.outcome] ?? 3);
    if (outcomeDiff !== 0) return outcomeDiff;
    return eb - ea; // higher effective confidence first
  };

  // ── Tier 1: Pinned ──────────────────────────────────────────────
  // Respect role even for pinned lessons — a pinned SCREENER lesson shouldn't pollute MANAGER
  const pinned = data.lessons
    .filter((l) => l.pinned && (!l.role || l.role === agentType || agentType === "GENERAL"))
    .sort(byPriority)
    .slice(0, PINNED_CAP);

  const usedIds = new Set(pinned.map((l) => l.id));

  // ── Tier 2: Role-matched ────────────────────────────────────────
  const roleTags = ROLE_TAGS[agentType] || [];
  const roleMatched = data.lessons
    .filter((l) => {
      if (usedIds.has(l.id)) return false;
      // Include if: lesson has no role restriction OR matches this role
      const roleOk = !l.role || l.role === agentType || agentType === "GENERAL";
      // Include if: lesson has role-relevant tags OR no tags (general)
      const tagOk  = roleTags.length === 0 || !l.tags?.length || l.tags.some((t) => roleTags.includes(t));
      return roleOk && tagOk;
    })
    .sort(byPriority)
    .slice(0, ROLE_CAP);

  roleMatched.forEach((l) => usedIds.add(l.id));

  // ── Tier 3: Recent fill ─────────────────────────────────────────
  const remainingBudget = RECENT_CAP - pinned.length - roleMatched.length;
  const recent = remainingBudget > 0
    ? data.lessons
        .filter((l) => {
          if (usedIds.has(l.id)) return false;
          // Prune old unpinned lessons that have decayed below floor
          if (!l.pinned && effectiveConfidence(l, now) < LESSON_CONFIDENCE_FLOOR) {
            return false;
          }
          // Prune lessons older than max age (unless pinned)
          if (!l.pinned && isPrunedByAge(l, now)) return false;
          return true;
        })
        .sort((a, b) => {
          // Sort by effective confidence first, then recency
          const confDiff = effectiveConfidence(b, now) - effectiveConfidence(a, now);
          if (Math.abs(confDiff) > 0.01) return confDiff;
          return (b.created_at || "").localeCompare(a.created_at || "");
        })
        .slice(0, remainingBudget)
    : [];

  const selected = [...pinned, ...roleMatched, ...recent];
  const shared = getSharedLessonsForPrompt({
    agentType,
    maxLessons: isAutoCycle ? 4 : 6,
  });
  if (selected.length === 0 && !shared) return null;

  const sections = [];
  if (pinned.length)      sections.push(`── PINNED (${pinned.length}) ──\n` + fmt(pinned));
  if (roleMatched.length) sections.push(`── ${agentType} (${roleMatched.length}) ──\n` + fmt(roleMatched));
  if (recent.length)      sections.push(`── RECENT (${recent.length}) ──\n` + fmt(recent));
  if (shared)             sections.push(`── HIVEMIND ──\n${shared}`);

  return sections.join("\n\n");
}

function fmt(lessons) {
  return lessons.map((l) => {
    const date = l.created_at ? l.created_at.slice(0, 16).replace("T", " ") : "unknown";
    const pin  = l.pinned ? "📌 " : "";
    return `${pin}[${l.outcome.toUpperCase()}] [${date}] ${l.rule}`;
  }).join("\n");
}

/**
 * Get individual performance records filtered by time window.
 * Tool handler: get_performance_history
 *
 * @param {Object} opts
 * @param {number} [opts.hours=24]   - How many hours back to look
 * @param {number} [opts.limit=50]   - Max records to return
 */
export function getPerformanceHistory({ hours = 24, limit = 50 } = {}) {
  const data = load();
  const p = data.performance;

  if (p.length === 0) return { positions: [], count: 0, hours };

  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

  const filtered = p
    .filter((r) => r.recorded_at >= cutoff)
    .slice(-limit)
    .map((r) => ({
      pool_name: r.pool_name,
      pool: r.pool,
      strategy: r.strategy,
      pnl_usd: r.pnl_usd,
      pnl_pct: r.pnl_pct,
      fees_earned_usd: r.fees_earned_usd,
      range_efficiency: r.range_efficiency,
      minutes_held: r.minutes_held,
      close_reason: r.close_reason,
      closed_at: r.recorded_at,
    }));

  const totalPnl = filtered.reduce((s, r) => s + (r.pnl_usd ?? 0), 0);
  const wins = filtered.filter((r) => r.pnl_usd > 0).length;

  return {
    hours,
    count: filtered.length,
    total_pnl_usd: Math.round(totalPnl * 100) / 100,
    win_rate_pct: filtered.length > 0 ? Math.round((wins / filtered.length) * 100) : null,
    positions: filtered,
  };
}

/**
 * Get performance stats summary.
 */
export function getPerformanceSummary() {
  const data = load();
  const p = data.performance;

  if (p.length === 0) return null;

  const totalPnl = p.reduce((s, x) => s + x.pnl_usd, 0);
  const avgPnlPct = p.reduce((s, x) => s + x.pnl_pct, 0) / p.length;
  const avgRangeEfficiency = p.reduce((s, x) => s + x.range_efficiency, 0) / p.length;
  const wins = p.filter((x) => x.pnl_usd > 0).length;

  return {
    total_positions_closed: p.length,
    total_pnl_usd: Math.round(totalPnl * 100) / 100,
    avg_pnl_pct: Math.round(avgPnlPct * 100) / 100,
    avg_range_efficiency_pct: Math.round(avgRangeEfficiency * 10) / 10,
    win_rate_pct: Math.round((wins / p.length) * 100),
    total_lessons: data.lessons.length,
  };
}

/**
 * Get per-author Discord signal accuracy stats.
 * Groups closed positions by discord_author and computes win rate, avg PnL, etc.
 */
export function getAuthorStats() {
  const data = load();
  const entries = data.performance.filter(
    (p) => p.discord_author || p.signal_snapshot?.discord_author,
  );

  if (entries.length === 0) return { authors: [], total_discord_tracked: 0 };

  const authorMap = {};
  for (const e of entries) {
    const author = e.discord_author || e.signal_snapshot?.discord_author;
    if (!author) continue;
    if (!authorMap[author]) {
      authorMap[author] = { author, total: 0, wins: 0, losses: 0, total_pnl_usd: 0, total_pnl_pct: 0 };
    }
    const a = authorMap[author];
    a.total++;
    a.total_pnl_usd += e.pnl_usd || 0;
    a.total_pnl_pct += e.pnl_pct || 0;
    if ((e.pnl_usd || 0) > 0) a.wins++;
    else if ((e.pnl_usd || 0) < 0) a.losses++;
  }

  const authors = Object.values(authorMap)
    .map((a) => ({
      ...a,
      win_rate_pct: a.total > 0 ? Math.round((a.wins / a.total) * 100) : 0,
      avg_pnl_usd: a.total > 0 ? Math.round((a.total_pnl_usd / a.total) * 100) / 100 : 0,
      avg_pnl_pct: a.total > 0 ? Math.round((a.total_pnl_pct / a.total) * 100) / 100 : 0,
    }))
    .sort((a, b) => b.win_rate_pct - a.win_rate_pct);

  return { authors, total_discord_tracked: entries.length };
}

// ─── PnL Reconciliation ───────────────────────────────────────

/**
 * Backfill performance records that have zero/fake PnL because the
 * Meteora closed-positions API hadn't settled when the position was closed.
 *
 * Re-fetches from the on-chain API and updates records with real values.
 *
 * @param {string} walletAddress - Wallet address to query closed positions for
 * @returns {{ fixed: number, skipped: number, errors: string[] }}
 */
export async function reconcileClosedPnl(walletAddress) {
  if (!walletAddress) {
    try {
      const { deriveAddress } = await import("./tools/wallet.js");
      const pk = process.env.WALLET_PRIVATE_KEY;
      walletAddress = pk ? deriveAddress(pk) : null;
    } catch { /* will return early below */ }
  }
  if (!walletAddress) return { fixed: 0, skipped: 0, errors: ["No wallet address available"] };

  const data = load();
  const perf = data.performance;
  if (!perf.length) return { fixed: 0, skipped: 0, errors: [] };

  const ZERO_CUTOFF = 0.001;
  let fixed = 0, skipped = 0;
  const errors = [];

  for (let i = 0; i < perf.length; i++) {
    const r = perf[i];
    // Only fix records that look unsettled: zero final_value and positive initial_value
    const isUnsettled =
      (r.final_value_usd == null || r.final_value_usd < ZERO_CUTOFF) &&
      (r.initial_value_usd != null && r.initial_value_usd > 0);
    if (!isUnsettled) continue;
    if (!r.pool) { skipped++; continue; }

    try {
      const url = `https://dlmm.datapi.meteora.ag/positions/${r.pool}/pnl?user=${walletAddress}&status=closed&pageSize=50&page=1`;
      const res = await fetch(url);
      if (!res.ok) { errors.push(`${r.pool_name}: HTTP ${res.status}`); continue; }
      const body = await res.json();
      const entry = (body.positions || []).find(
        (p) => p.positionAddress === r.position,
      );
      if (!entry) { skipped++; continue; }

      const pnlUsd = parseFloat(entry.pnlUsd || 0);
      const finalValue = parseFloat(entry.allTimeWithdrawals?.total?.usd || 0);
      const initialValue = parseFloat(entry.allTimeDeposits?.total?.usd || 0);
      const feesUsd = parseFloat(entry.allTimeFees?.total?.usd || 0) || r.fees_earned_usd || 0;

      if (finalValue > 0) {
        r.final_value_usd = finalValue;
        r.initial_value_usd = initialValue || r.initial_value_usd;
        r.fees_earned_usd = feesUsd;
        r.pnl_usd = Math.round((finalValue + feesUsd - r.initial_value_usd) * 100) / 100;
        r.pnl_pct = r.initial_value_usd > 0
          ? Math.round(((r.pnl_usd / r.initial_value_usd) * 100) * 100) / 100
          : r.pnl_pct;
        r._reconciled_at = new Date().toISOString();
        fixed++;
        log("reconcile", `Backfilled ${r.pool_name}: pnl=${r.pnl_usd}, fees=${r.fees_earned_usd}, final=${r.final_value_usd}`);
      } else {
        skipped++;
      }
    } catch (e) {
      errors.push(`${r.pool_name}: ${e.message}`);
    }
  }

  if (fixed > 0) {
    save(data);
    log("reconcile", `PnL reconciliation complete: ${fixed} fixed, ${skipped} skipped, ${errors.length} errors`);
  }

  return { fixed, skipped, errors };
}
