import { discoverPools, getPoolDetail, getTopCandidates, meteoraFetchWithCache } from "./screening.js";
import {
  getActiveBin,
  deployPosition,
  getMyPositions,
  getWalletPositions,
  getPositionPnl,
  claimFees,
  closePosition,
  searchPools,
} from "./dlmm.js";
import { getWalletBalances, swapToken, deriveAddress } from "./wallet.js";
import { studyTopLPers } from "./study.js";
import { addLesson, clearAllLessons, clearPerformance, removeLessonsByKeyword, getPerformanceHistory, pinLesson, unpinLesson, listLessons, deleteLesson, manageLesson, getAuthorStats } from "../lessons.js";
import { setPositionInstruction } from "../state.js";

import { getPoolMemory, addPoolNote } from "../pool-memory.js";
import { addStrategy, listStrategies, getStrategy, setActiveStrategy, removeStrategy } from "../strategy-library.js";
import { addToBlacklist, removeFromBlacklist, listBlacklist } from "../token-blacklist.js";
import { blockDev, unblockDev, listBlockedDevs } from "../dev-blocklist.js";
import { addSmartWallet, removeSmartWallet, listSmartWallets, checkSmartWalletsOnPool } from "../smart-wallets.js";
import { getTokenInfo, getTokenHolders, getTokenNarrative } from "./token.js";
import { config, reloadScreeningThresholds, MIN_SAFE_BINS_BELOW, getConfigPersistPath } from "../config.js";
import { getRecentDecisions, appendDecision } from "../decision-log.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { execSync, spawn } from "child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USER_CONFIG_PATH = path.join(__dirname, "../user-config.json");
const POOL_DISCOVERY_BASE = "https://pool-discovery-api.datapi.meteora.ag";
const MIN_VOLATILITY_TIMEFRAME = "30m";
const TIMEFRAME_MINUTES = {
  "5m": 5,
  "15m": 15,
  "30m": 30,
  "1h": 60,
  "2h": 120,
  "4h": 240,
  "12h": 720,
  "24h": 1440,
};
import { log, logAction } from "../logger.js";
import { notifyDeploy, notifyClose, notifySwap } from "../telegram.js";

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function getVolatilityTimeframe(sourceTimeframe) {
  const source = String(sourceTimeframe || "").trim();
  const sourceMinutes = TIMEFRAME_MINUTES[source];
  const minMinutes = TIMEFRAME_MINUTES[MIN_VOLATILITY_TIMEFRAME];
  return sourceMinutes != null && sourceMinutes >= minMinutes ? source : MIN_VOLATILITY_TIMEFRAME;
}

// Split one token's full balance: usdcPct% -> USDC (parked realized profit, not
// redeployed), remainder -> SOL (compounded for next screening cycle). Each leg
// has its own try/catch so one failing does not block the other. A dust-floor
// guard redirects a too-small USDC leg fully to SOL to avoid Jupiter
// "Failed to get quotes" on tiny amounts. Callers must pre-filter blacklist/SOL/USDC.
// Returns { parked_usdc, compound_sol, usdc_tx, sol_tx, did_swap }.
// OPSI B fee-split: swap every leftover token FULL to SOL first, then park a
// share of realized PROFIT (USD) into USDC. This replaces the old per-token
// 2-leg split. sweepAllToSol() converts all tokens to SOL; parkProfitToUsdc()
// converts a profit slice of SOL into USDC afterwards. Callers pre-filter
// blacklist / SOL / USDC.
const FEESPLIT_SOL_MINT = "So11111111111111111111111111111111111111112";
const FEESPLIT_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

// Swap each token's full balance to SOL. Returns { compound_sol, swept[] }.
async function sweepAllToSol(tokens, label = "Auto-sweep") {
  const swept = [];
  let compound_sol = 0;
  for (const tok of tokens) {
    try {
      const total = Number(tok.balance);
      if (!(total > 0)) continue;
      const sym = tok.symbol || tok.mint.slice(0, 8);
      const usdLabel = Number.isFinite(Number(tok.usd)) && tok.usd > 0 ? `$${Number(tok.usd).toFixed(2)}` : "no-price";
      log("executor", `${label}: ${sym} (${usdLabel}, bal=${total}) -> SOL (full)`);
      const r = await swapToken({ input_mint: tok.mint, output_mint: FEESPLIT_SOL_MINT, amount: total });
      if (r?.success !== false && (r?.amount_out || r?.tx)) {
        const got = r?.amount_out ? Number(r.amount_out) / 1e9 : 0;
        compound_sol += got;
        swept.push({ mint: tok.mint, symbol: tok.symbol, usd: tok.usd, sol_out: got, tx: r.tx || null });
        if (got > 0) log("executor", `${label}: received ${got.toFixed(6)} SOL from ${sym}`);
      } else {
        log("executor_warn", `${label}: swap-to-SOL skipped/failed for ${tok.mint.slice(0, 8)}: ${r?.error || "no tx"}`);
      }
    } catch (e) {
      log("executor_warn", `${label}: swap-to-SOL error for ${tok.mint.slice(0, 8)}: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 1500)); // rate-limit between swaps
  }
  return { compound_sol, swept };
}

// Park a profit slice into USDC. profitUsd in USD; solPrice in USD/SOL.
// Converts profitUsd -> SOL amount, takes usdcPct% of it, swaps SOL -> USDC.
// Returns { parked_usdc, parked_sol, tx }. No-op if profit<=0 or solPrice<=0
// or the SOL slice is dust (<0.002 SOL, Jupiter rejects tiny quotes).
async function parkProfitToUsdc(profitUsd, solPrice, usdcPct, label = "Auto-park") {
  const out = { parked_usdc: 0, parked_sol: 0, tx: null };
  const pUsd = Number(profitUsd);
  const px = Number(solPrice);
  const pct = Math.max(0, Math.min(100, Number(usdcPct) || 0));
  if (!(pUsd > 0)) { log("executor", `${label}: no profit to park (pnl_usd=${pUsd})`); return out; }
  if (!(px > 0)) { log("executor_warn", `${label}: sol_price unavailable, keeping all in SOL`); return out; }
  if (pct <= 0) { return out; }
  const profitSol = pUsd / px;
  const parkSol = profitSol * (pct / 100);
  if (!(parkSol >= 0.002)) {
    log("executor", `${label}: park slice too small (${parkSol.toFixed(6)} SOL), keeping all in SOL`);
    return out;
  }
  try {
    const r = await swapToken({ input_mint: FEESPLIT_SOL_MINT, output_mint: FEESPLIT_USDC_MINT, amount: parkSol });
    if (r?.success !== false && (r?.amount_out || r?.tx)) {
      out.parked_sol = parkSol;
      out.tx = r.tx || null;
      if (r?.amount_out) out.parked_usdc = Number(r.amount_out) / 1e6;
      log("executor", `${label}: parked ${out.parked_usdc.toFixed(2)} USDC (${parkSol.toFixed(6)} SOL of profit)`);
    } else {
      log("executor_warn", `${label}: SOL->USDC park skipped/failed: ${r?.error || "no tx"}`);
    }
  } catch (e) {
    log("executor_warn", `${label}: SOL->USDC park error: ${e.message}`);
  }
  return out;
}

async function getBalancesWithRetry(maxRetry = 2, delayMs = 2000) {
  let bal = await getWalletBalances({});
  let attempt = 0;
  while (bal && bal._fallback_rpc === true && attempt < maxRetry) {
    attempt++;
    log("executor_warn", `getBalancesWithRetry: Helius on RPC-fallback (tokens hidden), retry ${attempt}/${maxRetry} in ${delayMs}ms`);
    await new Promise(r => setTimeout(r, delayMs));
    bal = await getWalletBalances({ force: true });
  }
  if (bal && bal._fallback_rpc === true) {
    log("executor_warn", `getBalancesWithRetry: still on RPC-fallback after ${maxRetry} retries; proceeding (sweep may see no tokens)`);
  }
  return bal;
}

// After a close, withdrawn LP tokens may take a few seconds to settle/index in
// the wallet balance provider. A plain balance read can return 0 sweep candidates
// even though the base_mint token just landed. This waits a settle delay, then
// retries (force-fresh) until the just-closed base_mint shows up in tokens.
async function getBalancesAfterClose(baseMint, settleMs = 4000, maxRetry = 3, delayMs = 3000) {
  if (settleMs > 0) {
    await new Promise(r => setTimeout(r, settleMs));
  }
  let bal = await getBalancesWithRetry();
  if (!baseMint) return bal;
  const hasBase = (b) => Array.isArray(b && b.tokens) && b.tokens.some(t => t && t.mint === baseMint && Number(t.balance) > 0);
  let attempt = 0;
  while (!hasBase(bal) && attempt < maxRetry) {
    attempt++;
    log("executor_warn", `getBalancesAfterClose: base_mint ${baseMint.slice(0,8)} not settled yet, retry ${attempt}/${maxRetry} in ${delayMs}ms`);
    await new Promise(r => setTimeout(r, delayMs));
    bal = await getWalletBalances({ force: true });
  }
  if (hasBase(bal)) {
    log("executor", `getBalancesAfterClose: base_mint ${baseMint.slice(0,8)} settled after ${attempt} retry(ies)`);
  } else {
    log("executor_warn", `getBalancesAfterClose: base_mint ${baseMint.slice(0,8)} never appeared after ${maxRetry} retries; proceeding`);
  }
  return bal;
}

function poolDetailTvl(pool) {
  return numberOrNull(pool?.tvl ?? pool?.active_tvl ?? pool?.liquidity);
}

function poolDetailBinStep(pool) {
  return numberOrNull(pool?.dlmm_params?.bin_step ?? pool?.pool_config?.bin_step);
}

function poolDetailFeeActiveTvlRatio(pool) {
  return numberOrNull(pool?.fee_active_tvl_ratio);
}

function poolDetailVolatility(pool) {
  return numberOrNull(pool?.volatility);
}

async function fetchFreshPoolDetail(poolAddress, timeframe = config.screening.timeframe || "5m") {
  const encodedTimeframe = encodeURIComponent(timeframe);
  const filter = encodeURIComponent(`pool_address=${poolAddress}`);
  const url = `${POOL_DISCOVERY_BASE}/pools?page_size=1&filter_by=${filter}&timeframe=${encodedTimeframe}`;
  // Use 120s cache + retry/backoff via meteoraFetchWithCache
  const data = await meteoraFetchWithCache(url);
  return (data?.data || [])[0] ?? null;
}

async function validateDeployPoolThresholds(args) {
  let detail;
  try {
    detail = await fetchFreshPoolDetail(args.pool_address);
    if (!detail) throw new Error(`Pool ${args.pool_address} not found`);
  } catch (error) {
    return {
      pass: false,
      reason: `Could not verify pool screening thresholds before deploy: ${error.message}`,
    };
  }

  const tvl = poolDetailTvl(detail);
  const minTvl = numberOrNull(config.screening.minTvl);
  const maxTvl = numberOrNull(config.screening.maxTvl);
  if (tvl == null) {
    return {
      pass: false,
      reason: "Could not verify pool TVL before deploy.",
    };
  }
  if (minTvl != null && minTvl > 0 && tvl < minTvl) {
    return {
      pass: false,
      reason: `Pool TVL $${tvl} is below configured minTvl $${minTvl}.`,
    };
  }
  if (maxTvl != null && maxTvl > 0 && tvl > maxTvl) {
    return {
      pass: false,
      reason: `Pool TVL $${tvl} is above configured maxTvl $${maxTvl}.`,
    };
  }

  const feeActiveTvlRatio = poolDetailFeeActiveTvlRatio(detail);
  const minFeeActiveTvlRatio = numberOrNull(config.screening.minFeeActiveTvlRatio);
  if (
    minFeeActiveTvlRatio != null &&
    minFeeActiveTvlRatio > 0 &&
    (feeActiveTvlRatio == null || feeActiveTvlRatio < minFeeActiveTvlRatio)
  ) {
    return {
      pass: false,
      reason: `Pool fee/active-TVL ${feeActiveTvlRatio ?? "unknown"}% is below configured minFeeActiveTvlRatio ${minFeeActiveTvlRatio}%.`,
    };
  }

  const volatilityTimeframe = getVolatilityTimeframe(config.screening.timeframe || "5m");
  let volatilityDetail = detail;
  if ((config.screening.timeframe || "5m") !== volatilityTimeframe) {
    try {
      volatilityDetail = await fetchFreshPoolDetail(args.pool_address, volatilityTimeframe);
    } catch (error) {
      return {
        pass: false,
        reason: `Could not verify pool ${volatilityTimeframe} volatility before deploy: ${error.message}`,
      };
    }
  }

  const volatility = poolDetailVolatility(volatilityDetail);
  if (volatility == null || volatility <= 0) {
    return {
      pass: false,
      reason: `Pool ${volatilityTimeframe} volatility ${volatility ?? "unknown"} is unusable. Refusing deploy.`,
    };
  }

  const actualBinStep = poolDetailBinStep(detail);
  const minStep = numberOrNull(config.screening.minBinStep);
  const maxStep = numberOrNull(config.screening.maxBinStep);
  if (actualBinStep != null && minStep != null && actualBinStep < minStep) {
    return {
      pass: false,
      reason: `Pool bin_step ${actualBinStep} is below configured minBinStep ${minStep}.`,
    };
  }
  if (actualBinStep != null && maxStep != null && actualBinStep > maxStep) {
    return {
      pass: false,
      reason: `Pool bin_step ${actualBinStep} is above configured maxBinStep ${maxStep}.`,
    };
  }

  return { pass: true };
}

// Registered by index.js so update_config can restart cron jobs when intervals change
let _cronRestarter = null;
export function registerCronRestarter(fn) { _cronRestarter = fn; }

function coerceBoolean(value, key) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  throw new Error(`${key} must be true or false`);
}

function coerceFiniteNumber(value, key) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`${key} must be a finite number`);
  return n;
}

function coerceString(value, key) {
  if (typeof value !== "string") throw new Error(`${key} must be a string`);
  return value.trim();
}

function coerceStringArray(value, key) {
  if (!Array.isArray(value)) throw new Error(`${key} must be an array of strings`);
  return value.map((entry) => coerceString(entry, key)).filter(Boolean);
}

function normalizeConfigValue(key, value) {
  const booleanKeys = new Set([
    "excludeHighSupplyConcentration",
    "useDiscordSignals",
    "avoidPvpSymbols",
    "blockPvpSymbols",
    "autoSwapAfterClaim",
    "trailingTakeProfit",
    "solMode",
    "darwinEnabled",
    "lpAgentRelayEnabled",
  ]);
  const arrayKeys = new Set(["allowedLaunchpads", "blockedLaunchpads"]);
  const stringKeys = new Set([
    "timeframe",
    "category",
    "discordSignalMode",
    "strategy",
    "managementModel",
    "screeningModel",
    "generalModel",
    "hiveMindUrl",
    "hiveMindApiKey",
    "agentId",
    "hiveMindPullMode",
    "publicApiKey",
    "agentMeridianApiUrl",
  ]);
  if (value === null) return null;
  if (booleanKeys.has(key)) return coerceBoolean(value, key);
  if (arrayKeys.has(key)) return coerceStringArray(value, key);
  if (stringKeys.has(key)) return coerceString(value, key);
  return coerceFiniteNumber(value, key);
}

// ─── Discord Signals Reader ───────────────────────────────────
const DISCORD_SIGNALS_FILE = path.join(__dirname, "..", "discord-signals.json");

function getDiscordSignals({ limit = 10 } = {}) {
  const maxLimit = Math.min(Math.max(1, Number(limit) || 10), 50);

  if (!fs.existsSync(DISCORD_SIGNALS_FILE)) {
    return {
      success: true,
      signals: [],
      count: 0,
      disclaimer: "No Discord signals found. The discord-listener may not be running or has not captured any signals yet.",
    };
  }

  let signals;
  try {
    signals = JSON.parse(fs.readFileSync(DISCORD_SIGNALS_FILE, "utf8"));
  } catch {
    return { success: false, error: "Could not parse discord-signals.json" };
  }

  if (!Array.isArray(signals) || signals.length === 0) {
    return {
      success: true,
      signals: [],
      count: 0,
      disclaimer: "Discord signals file exists but contains no signals.",
    };
  }

  const pending = signals
    .filter((s) => s.status === "pending")
    .slice(0, maxLimit)
    .map((s) => ({
      pool_address: s.pool_address,
      base_mint: s.base_mint,
      base_symbol: s.base_symbol,
      discord_author: s.discord_author,
      discord_channel: s.discord_channel,
      rug_score: s.rug_score,
      total_fees_sol: s.total_fees_sol,
      token_age_minutes: s.token_age_minutes,
      queued_at: s.queued_at,
    }));

  return {
    success: true,
    signals: pending,
    count: pending.length,
    total_in_file: signals.length,
    disclaimer: "DISCORD SIGNALS ARE REFERENCE ONLY — NOT confirmed buy signals. Always cross-check with your own screening (organic score, holders, fees, volume) before deploying. Never deploy solely because a Discord signal exists.",
  };
}

async function fetchDiscord({ limit = 30, maxAgeHours = 24, channel = null } = {}) {
  try {
    const raw = fs.readFileSync(DISCORD_SIGNALS_PATH, "utf-8");
    const all = JSON.parse(raw);
    let signals = Array.isArray(all) ? all : all.signals || [];
    if (channel) signals = signals.filter(s => s.discord_channel === channel);
    if (maxAgeHours > 0 && maxAgeHours < 720) {
      const cutoff = Date.now() - maxAgeHours * 3600000;
      signals = signals.filter(s => {
        const ts = new Date(s.queued_at || s.created_at || 0).getTime();
        return ts >= cutoff;
      });
    }
    signals.sort((a, b) => new Date(b.queued_at || 0) - new Date(a.queued_at || 0));
    signals = signals.slice(0, Math.min(limit, 50));
    return {
      success: true,
      signals: signals.map(s => ({
        pool_address: s.pool_address,
        base_symbol: s.base_symbol,
        discord_channel: s.discord_channel,
        discord_author: s.discord_author,
        status: s.status || "pending",
        queued_at: s.queued_at,
        age_minutes: s.queued_at ? Math.round((Date.now() - new Date(s.queued_at).getTime()) / 60000) : null,
      })),
      count: signals.length,
      total_available: Array.isArray(all) ? all.length : (all.signals || []).length,
      filters: { limit, maxAgeHours, channel },
    };
  } catch (e) {
    return { success: false, error: e.message, signals: [], count: 0 };
  }
}

async function readDiscordChannel({ channel } = {}) {
  if (!channel) return { success: false, error: "channel name required", signals: [] };
  return await fetchDiscord({ channel, limit: 30, maxAgeHours: 0 });
}

// Map tool names to implementations
const toolMap = {
  discover_pools: discoverPools,
  get_top_candidates: getTopCandidates,
  get_pool_detail: getPoolDetail,
  get_position_pnl: getPositionPnl,
  get_active_bin: getActiveBin,
  deploy_position: deployPosition,
  get_my_positions: getMyPositions,
  get_wallet_positions: getWalletPositions,
  search_pools: searchPools,
  get_token_info: getTokenInfo,
  get_token_holders: getTokenHolders,
  get_token_narrative: getTokenNarrative,
  add_smart_wallet: addSmartWallet,
  remove_smart_wallet: removeSmartWallet,
  list_smart_wallets: listSmartWallets,
  check_smart_wallets_on_pool: checkSmartWalletsOnPool,
  claim_fees: claimFees,
  close_position: closePosition,
  get_wallet_balance: getWalletBalances,
  swap_token: swapToken,
  get_top_lpers: studyTopLPers,
  study_top_lpers: studyTopLPers,
  set_position_note: ({ position_address, instruction }) => {
    const ok = setPositionInstruction(position_address, instruction || null);
    if (!ok) return { error: `Position ${position_address} not found in state` };
    return { saved: true, position: position_address, instruction: instruction || null };
  },
  self_update: async () => {
    try {
      const result = execSync("git pull", { cwd: process.cwd(), encoding: "utf8" }).trim();
      if (result.includes("Already up to date")) {
        return { success: true, updated: false, message: "Already up to date — no restart needed." };
      }
      // Delay restart so this tool response (and Telegram message) gets sent first
      setTimeout(() => {
        if (!process.env.pm_id) {
          const child = spawn(process.execPath, process.argv.slice(1), {
            detached: true,
            stdio: "inherit",
            cwd: process.cwd(),
          });
          child.unref();
        }
        process.exit(0);
      }, 3000);
      const restartMode = process.env.pm_id
        ? "PM2 detected — exiting in 3s so PM2 can restart the managed process."
        : "Restarting in 3s...";
      return { success: true, updated: true, message: `Updated! ${restartMode}\n${result}` };
    } catch (e) {
      return { success: false, error: e.message };
    }
  },
  get_performance_history: getPerformanceHistory,
  get_recent_decisions: ({ limit } = {}) => ({ decisions: getRecentDecisions(limit || 6) }),
  add_strategy:        addStrategy,
  list_strategies:     listStrategies,
  get_strategy:        getStrategy,
  set_active_strategy: setActiveStrategy,
  remove_strategy:     removeStrategy,
  get_pool_memory: getPoolMemory,
  add_pool_note: addPoolNote,
  get_discord_signals: getDiscordSignals,
  get_author_stats: getAuthorStats,
  fetch_discord: fetchDiscord,
  read_discord_channel: readDiscordChannel,
  add_to_blacklist: addToBlacklist,
  remove_from_blacklist: removeFromBlacklist,
  list_blacklist: listBlacklist,
  block_deployer: blockDev,
  unblock_deployer: unblockDev,
  list_blocked_deployers: listBlockedDevs,
  add_lesson: ({ rule, tags, pinned, role }) => {
    addLesson(rule, tags || [], { pinned: !!pinned, role: role || null });
    return { saved: true, rule, pinned: !!pinned, role: role || "all" };
  },
  pin_lesson:   ({ id }) => pinLesson(id),
  unpin_lesson: ({ id }) => unpinLesson(id),
  delete_lesson: ({ id }) => {
    const r = deleteLesson(id);
    if (!r.found) return { error: `Lesson ${id} not found` };
    return r;
  },
  manage_lesson: ({ id, rule, tags, pinned, role }) => {
    const r = manageLesson(id, { rule, tags, pinned, role });
    if (!r.found) return { error: `Lesson ${id} not found` };
    return r;
  },
  list_lessons: ({ role, pinned, tag, limit } = {}) => listLessons({ role, pinned, tag, limit }),
  clear_lessons: ({ mode, keyword }) => {
    if (mode === "all") {
      const n = clearAllLessons();
      log("lessons", `Cleared all ${n} lessons`);
      return { cleared: n, mode: "all" };
    }
    if (mode === "performance") {
      const n = clearPerformance();
      log("lessons", `Cleared ${n} performance records`);
      return { cleared: n, mode: "performance" };
    }
    if (mode === "keyword") {
      if (!keyword) return { error: "keyword required for mode=keyword" };
      const n = removeLessonsByKeyword(keyword);
      log("lessons", `Cleared ${n} lessons matching "${keyword}"`);
      return { cleared: n, mode: "keyword", keyword };
    }
    return { error: "invalid mode" };
  },
  update_config: ({ changes, reason = "" }) => {
    // Flat key → config section mapping (covers everything in config.js)
    const CONFIG_MAP = {
      // screening
      minFeeActiveTvlRatio: ["screening", "minFeeActiveTvlRatio"],
      excludeHighSupplyConcentration: ["screening", "excludeHighSupplyConcentration"],
      minTvl: ["screening", "minTvl"],
      maxTvl: ["screening", "maxTvl"],
      minVolume: ["screening", "minVolume"],
      minOrganic: ["screening", "minOrganic"],
      minQuoteOrganic: ["screening", "minQuoteOrganic"],
      minHolders: ["screening", "minHolders"],
      minMcap: ["screening", "minMcap"],
      maxMcap: ["screening", "maxMcap"],
      minBinStep: ["screening", "minBinStep"],
      maxBinStep: ["screening", "maxBinStep"],
      timeframe: ["screening", "timeframe"],
      category: ["screening", "category"],
      minTokenFeesSol: ["screening", "minTokenFeesSol"],
      useDiscordSignals: ["screening", "useDiscordSignals"],
      discordSignalMode: ["screening", "discordSignalMode"],
      avoidPvpSymbols: ["screening", "avoidPvpSymbols"],
      blockPvpSymbols: ["screening", "blockPvpSymbols"],
      maxBundlePct:     ["screening", "maxBundlePct"],
      maxBotHoldersPct: ["screening", "maxBotHoldersPct"],
      maxTop10Pct: ["screening", "maxTop10Pct"],
      allowedLaunchpads: ["screening", "allowedLaunchpads"],
      blockedLaunchpads: ["screening", "blockedLaunchpads"],
      minTokenAgeHours: ["screening", "minTokenAgeHours"],
      maxTokenAgeHours: ["screening", "maxTokenAgeHours"],
      athFilterPct:     ["screening", "athFilterPct"],
      minFeePerTvl24h: ["management", "minFeePerTvl24h"],
      // management
      minClaimAmount: ["management", "minClaimAmount"],
      autoSwapAfterClaim: ["management", "autoSwapAfterClaim"],
      feeSplitUsdcPct: ["management", "feeSplitUsdcPct"],
      outOfRangeBinsToClose: ["management", "outOfRangeBinsToClose"],
      outOfRangeWaitMinutes: ["management", "outOfRangeWaitMinutes"],
      oorCooldownTriggerCount: ["management", "oorCooldownTriggerCount"],
      oorCooldownHours: ["management", "oorCooldownHours"],
      repeatDeployCooldownEnabled: ["management", "repeatDeployCooldownEnabled"],
      repeatDeployCooldownTriggerCount: ["management", "repeatDeployCooldownTriggerCount"],
      repeatDeployCooldownHours: ["management", "repeatDeployCooldownHours"],
      repeatDeployCooldownScope: ["management", "repeatDeployCooldownScope"],
      repeatDeployCooldownMinFeeEarnedPct: ["management", "repeatDeployCooldownMinFeeEarnedPct"],
      minVolumeToRebalance: ["management", "minVolumeToRebalance"],
      stopLossPct: ["management", "stopLossPct"],
      takeProfitPct: ["management", "takeProfitPct"],
      takeProfitFeePct: ["management", "takeProfitPct"],
      trailingTakeProfit: ["management", "trailingTakeProfit"],
      trailingTriggerPct: ["management", "trailingTriggerPct"],
      trailingDropPct: ["management", "trailingDropPct"],
      pnlSanityMaxDiffPct: ["management", "pnlSanityMaxDiffPct"],
      solMode: ["management", "solMode"],
      minSolToOpen: ["management", "minSolToOpen"],
      deployAmountSol: ["management", "deployAmountSol"],
      gasReserve: ["management", "gasReserve"],
      positionSizePct: ["management", "positionSizePct"],
      minAgeBeforeYieldCheck: ["management", "minAgeBeforeYieldCheck"],
      // risk
      maxPositions: ["risk", "maxPositions"],
      maxDeployAmount: ["risk", "maxDeployAmount"],
      // schedule
      managementIntervalMin: ["schedule", "managementIntervalMin"],
      screeningIntervalMin: ["schedule", "screeningIntervalMin"],
      healthCheckIntervalMin: ["schedule", "healthCheckIntervalMin"],
      // models
      managementModel: ["llm", "managementModel"],
      screeningModel: ["llm", "screeningModel"],
      generalModel: ["llm", "generalModel"],
      temperature: ["llm", "temperature"],
      maxTokens: ["llm", "maxTokens"],
      maxSteps: ["llm", "maxSteps"],
      // strategy
      strategy: ["strategy", "strategy"],
      binsBelow: ["strategy", "maxBinsBelow", ["maxBinsBelow"]],
      minBinsBelow: ["strategy", "minBinsBelow"],
      maxBinsBelow: ["strategy", "maxBinsBelow"],
      defaultBinsBelow: ["strategy", "defaultBinsBelow"],
      // hivemind
      hiveMindUrl: ["hiveMind", "url"],
      hiveMindApiKey: ["hiveMind", "apiKey"],
      agentId: ["hiveMind", "agentId"],
      hiveMindPullMode: ["hiveMind", "pullMode"],
      // meridian api / relay
      publicApiKey: ["api", "publicApiKey"],
      agentMeridianApiUrl: ["api", "url"],
      lpAgentRelayEnabled: ["api", "lpAgentRelayEnabled"],
      // chart indicators
      chartIndicatorsEnabled: ["indicators", "enabled", ["chartIndicators", "enabled"]],
      indicatorEntryPreset: ["indicators", "entryPreset", ["chartIndicators", "entryPreset"]],
      indicatorExitPreset: ["indicators", "exitPreset", ["chartIndicators", "exitPreset"]],
      rsiLength: ["indicators", "rsiLength", ["chartIndicators", "rsiLength"]],
      indicatorIntervals: ["indicators", "intervals", ["chartIndicators", "intervals"]],
      indicatorCandles: ["indicators", "candles", ["chartIndicators", "candles"]],
      rsiOversold: ["indicators", "rsiOversold", ["chartIndicators", "rsiOversold"]],
      rsiOverbought: ["indicators", "rsiOverbought", ["chartIndicators", "rsiOverbought"]],
      requireAllIntervals: ["indicators", "requireAllIntervals", ["chartIndicators", "requireAllIntervals"]],
    };

    const applied = {};
    const unknown = [];

    // Build case-insensitive lookup
    const CONFIG_MAP_LOWER = Object.fromEntries(
      Object.entries(CONFIG_MAP).map(([k, v]) => [k.toLowerCase(), [k, v]])
    );

    if (!changes || typeof changes !== "object" || Array.isArray(changes)) {
      return { success: false, error: "changes must be an object", reason };
    }

    const STRATEGY_BIN_KEYS = new Set(["binsBelow", "minBinsBelow", "maxBinsBelow", "defaultBinsBelow"]);
    for (const [key, val] of Object.entries(changes)) {
      const match = CONFIG_MAP[key] ? [key, CONFIG_MAP[key]] : CONFIG_MAP_LOWER[key.toLowerCase()];
      if (!match) { unknown.push(key); continue; }
      try {
        let normalizedVal = val;
        if (STRATEGY_BIN_KEYS.has(match[0])) {
          const numericVal = Number(val);
          if (!Number.isFinite(numericVal)) {
            throw new Error(`${match[0]} must be a finite number`);
          }
          normalizedVal = Math.max(MIN_SAFE_BINS_BELOW, Math.round(numericVal));
        } else {
          normalizedVal = normalizeConfigValue(match[0], val);
        }
        applied[match[0]] = normalizedVal;
      } catch (error) {
        return { success: false, error: error.message, key: match[0], reason };
      }
    }

    if (Object.keys(applied).length === 0) {
      log("config", `update_config failed — unknown keys: ${JSON.stringify(unknown)}, raw changes: ${JSON.stringify(changes)}`);
      return { success: false, unknown, reason };
    }

    let userConfig = {};
    if (fs.existsSync(USER_CONFIG_PATH)) {
      try {
        userConfig = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"));
      } catch (error) {
        return { success: false, error: `Invalid user-config.json: ${error.message}`, reason };
      }
    }

    // Apply to live config immediately after the persisted config is known-good.
    for (const [key, val] of Object.entries(applied)) {
      const [section, field] = CONFIG_MAP[key];
      const before = config[section][field];
      config[section][field] = val;
      log("config", `update_config: config.${section}.${field} ${before} → ${val} (verify: ${config[section][field]})`);
    }
    if (
      applied.binsBelow != null ||
      applied.minBinsBelow != null ||
      applied.maxBinsBelow != null ||
      applied.defaultBinsBelow != null
    ) {
      config.strategy.minBinsBelow = Math.max(MIN_SAFE_BINS_BELOW, Math.round(Number(config.strategy.minBinsBelow ?? MIN_SAFE_BINS_BELOW)));
      config.strategy.maxBinsBelow = Math.max(config.strategy.minBinsBelow, Math.round(Number(config.strategy.maxBinsBelow ?? config.strategy.minBinsBelow)));
      config.strategy.defaultBinsBelow = Math.max(
        config.strategy.minBinsBelow,
        Math.min(
          config.strategy.maxBinsBelow,
          Math.round(Number(config.strategy.defaultBinsBelow ?? config.strategy.maxBinsBelow)),
        ),
      );
    }

    for (const [key, val] of Object.entries(applied)) {
      const [section, field] = CONFIG_MAP[key];
      const explicitPath = CONFIG_MAP[key]?.[2];
      if (Array.isArray(explicitPath) && explicitPath.length > 0) {
        let target = userConfig;
        for (const part of explicitPath.slice(0, -1)) {
          if (!target[part] || typeof target[part] !== "object" || Array.isArray(target[part])) {
            target[part] = {};
          }
          target = target[part];
        }
        target[explicitPath[explicitPath.length - 1]] = val;
      } else {
        // Per-wallet aware persist: writes to global.<section> or wallets[id].<section>
        const basePath = getConfigPersistPath(section);
        let target = userConfig;
        for (const part of basePath) {
          if (!target[part] || typeof target[part] !== "object" || Array.isArray(target[part])) {
            target[part] = {};
          }
          target = target[part];
        }
        target[field] = val;
      }
    }
    userConfig._lastAgentTune = new Date().toISOString();
    fs.writeFileSync(USER_CONFIG_PATH, JSON.stringify(userConfig, null, 2));

    // Restart cron jobs if intervals changed
    const intervalChanged = applied.managementIntervalMin != null || applied.screeningIntervalMin != null;
    if (intervalChanged && _cronRestarter) {
      _cronRestarter();
      log("config", `Cron restarted — management: ${config.schedule.managementIntervalMin}m, screening: ${config.schedule.screeningIntervalMin}m`);
    }

    // Skip repeated volatility-driven interval changes; they are operational tuning, not reusable lessons.
    const lessonsKeys = Object.keys(applied).filter(
      k => k !== "managementIntervalMin" && k !== "screeningIntervalMin"
    );
    if (lessonsKeys.length > 0) {
      const summary = lessonsKeys.map(k => `${k}=${applied[k]}`).join(", ");
      addLesson(`[SELF-TUNED] Changed ${summary} — ${reason}`, ["self_tune", "config_change"]);
    }

    log("config", `Agent self-tuned: ${JSON.stringify(applied)} — ${reason}`);
    return { success: true, applied, unknown, reason };
  },
};

// Tools that modify on-chain state (need extra safety checks)
const WRITE_TOOLS = new Set([
  "deploy_position",
  "claim_fees",
  "close_position",
  "swap_token",
]);
const PROTECTED_TOOLS = new Set([
  ...WRITE_TOOLS,
  "self_update",
]);

/**
 * Execute a tool call with safety checks and logging.
 */
export async function executeTool(name, args) {
  const startTime = Date.now();

  // Strip model artifacts like "<|channel|>commentary" appended to tool names
  name = name.replace(/<.*$/, "").trim();

  // ─── Validate tool exists ─────────────────
  const fn = toolMap[name];
  if (!fn) {
    const error = `Unknown tool: ${name}`;
    log("error", error);
    return { error };
  }

  // ─── Pre-execution safety checks ──────────
  if (PROTECTED_TOOLS.has(name)) {
    const safetyCheck = await runSafetyChecks(name, args);
    if (!safetyCheck.pass) {
      log("safety_block", `${name} blocked: ${safetyCheck.reason}`);
      return {
        blocked: true,
        reason: safetyCheck.reason,
      };
    }
  }

  // ─── Execute ──────────────────────────────
  try {
    const result = await fn(args);
    const duration = Date.now() - startTime;
    const success = result?.success !== false && !result?.error;

    logAction({
      tool: name,
      args,
      result: summarizeResult(result),
      duration_ms: duration,
      success,
    });

    if (success) {
      if (name === "swap_token" && result.tx) {
        notifySwap({ inputSymbol: args.input_mint?.slice(0, 8), outputSymbol: args.output_mint === "So11111111111111111111111111111111111111112" || args.output_mint === "SOL" ? "SOL" : args.output_mint?.slice(0, 8), amountIn: result.amount_in, amountOut: result.amount_out, tx: result.tx }).catch(() => {});
      } else if (name === "deploy_position") {
        notifyDeploy({ pair: result.pool_name || args.pool_name || args.pool_address?.slice(0, 8), amountSol: args.amount_y ?? args.amount_sol ?? 0, position: result.position, tx: result.txs?.[0] ?? result.tx, priceRange: result.price_range, rangeCoverage: result.range_coverage, binStep: result.bin_step, baseFee: result.base_fee, strategy: args.strategy || result.strategy, strategyReason: args.strategy_reason || "" /* __HYBRIDSTRAT__ */ }).catch(() => {});
      } else if (name === "close_position") {
        if (!args.suppress_close_notif && !String(args.reason || "").toLowerCase().includes("chase_up")) /* __NOTIFSUPPRESS__ card close chase ditunda sampai nasib redeploy jelas */
        notifyClose({ /* __PNLCARD_CALLSITE__ */
          pair: result.pool_name || args.position_address?.slice(0, 8),
          pnlUsd: result.pnl_usd ?? 0,
          pnlPct: result.pnl_pct ?? 0,
          result,
          reason: args.reason || result.close_reason || "", /* __CLOSEREASON__ */
          walletAddress: (() => { try { return deriveAddress(process.env.WALLET_PRIVATE_KEY || ""); } catch { return null; } })(),
          brand: process.env.CARD_BRAND || "PureXBT",
          url: process.env.CARD_URL || "dlmm.purexbt.dev",
        }).catch(() => {});
        appendDecision({
          type: "close",
          ts: Date.now(),
          walletAddress: deriveAddress(process.env.WALLET_PRIVATE_KEY || ""),
          pool_name: result.pool_name || args.position_address?.slice(0, 8),
          position: result.position || args.position_address,
          metrics: {
            pnl_usd: result.pnl_usd ?? 0,
            pnl_pct: result.pnl_pct ?? 0,
            fees_usd: result.fees_earned_usd ?? result.total_fees_usd ?? 0,
            fees_sol: result.fees_earned_sol ?? result.total_fees_sol ?? 0,
            minutes_held: result.minutes_held ?? null,
          },
          reason: args.reason || result.close_reason || "",
        });
        // Note low-yield closes in pool memory so screener avoids redeploying
        if (args.reason && args.reason.toLowerCase().includes("yield")) {
          const poolAddr = result.pool || args.pool_address;
          if (poolAddr) addPoolNote({ pool_address: poolAddr, note: `Closed: low yield (fee/TVL below threshold) at ${new Date().toISOString().slice(0,10)}` }).catch?.(() => {});
        }
        // Auto-sweep all leftover non-SOL/USDC tokens back to SOL after close.
        // This handles: base_mint missing on relay path, multi-pool residue,
        // partial-fill leftovers, or any prior un-swept dust above threshold.
        if (!args.skip_swap) {
          try {
            const SOL_MINT = "So11111111111111111111111111111111111111112";
            const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
            // Permanent sweep blacklist — never auto-swap these mints (suspected scam / drain risk)
            const SWAP_BLACKLIST = new Set([]);
            const MIN_SWEEP_USD = 0.20;
            const MIN_SWEEP_BALANCE_NO_PRICE = 1; // for tokens with null/0 usd, require >1 unit
            const isSolLike = (m) => typeof m === "string" && m.length >= 32 && m.length <= 44 && m.startsWith("So1");

            const balances = await getBalancesAfterClose(result.base_mint);
            const allTokens = balances.tokens || [];
            const sweepable = allTokens.filter(t => {
              if (!t || !t.mint) return false;
              if (isSolLike(t.mint)) return false; // skip SOL family (incl. Helius typo "So111...111")
              if (t.mint === USDC_MINT) return false;
              if (SWAP_BLACKLIST.has(t.mint)) return false;
              if (Number(t.balance) <= 0) return false;
              const usd = Number(t.usd);
              if (Number.isFinite(usd) && usd > 0) return usd >= MIN_SWEEP_USD;
              // No price data — fall back to raw balance threshold to avoid worthless dust
              return Number(t.balance) >= MIN_SWEEP_BALANCE_NO_PRICE;
            });

            // Split ratio: usdcPct% of each swept token -> USDC (parked), rest -> SOL
            const usdcPct = Math.max(0, Math.min(100, Number(config.management.feeSplitUsdcPct ?? 40)));

            // OPSI B: swap ALL leftover tokens to SOL first, then park a slice of
            // realized PROFIT (result.pnl_usd, USD) into USDC. Loss/BEP -> all stays SOL.
            log("executor", `Auto-sweep (Opsi B): ${sweepable.length} candidate(s) from ${allTokens.length} token accounts -> SOL, then park ${usdcPct}% of profit to USDC`);

            // Prioritize the position base_mint first (so notify reflects the close)
            sweepable.sort((a, b) => {
              if (a.mint === result.base_mint) return -1;
              if (b.mint === result.base_mint) return 1;
              return (Number(b.usd) || 0) - (Number(a.usd) || 0);
            });

            const sweepRes = await sweepAllToSol(sweepable, "Auto-sweep");
            const swept = sweepRes.swept;
            const solGained = sweepRes.compound_sol;
            if (swept.length > 0) {
              result.swept_tokens = swept;
              const baseTok = swept.find(s => s.mint === result.base_mint);
              if (baseTok) {
                result.auto_swapped = true;
                if (baseTok.sol_out) result.sol_received = baseTok.sol_out;
              }
            }
            // Park profit slice to USDC (uses live sol_price from the balances call above)
            const profitUsd = Number(result.pnl_usd);
            const solPrice = Number(balances.sol_price);
            const park = await parkProfitToUsdc(profitUsd, solPrice, usdcPct, "Auto-park");
            const keptSol = Math.max(0, solGained - (park.parked_sol || 0));
            if (park.parked_usdc > 0) result.parked_usdc = park.parked_usdc;
            if (solGained > 0) result.compound_sol = keptSol;
            if (swept.length > 0 || park.parked_usdc > 0) {
              result.auto_swap_note = park.parked_usdc > 0
                ? `Opsi B: swept ${swept.length} token(s) -> ${solGained.toFixed(6)} SOL; parked ${park.parked_usdc.toFixed(2)} USDC (${usdcPct}% of profit), kept ${keptSol.toFixed(6)} SOL. Do NOT call swap_token again.`
                : `Opsi B: swept ${swept.length} token(s) -> ${solGained.toFixed(6)} SOL; no profit to park (kept all in SOL). Do NOT call swap_token again.`;
            }
          } catch (e) {
            log("executor_warn", `Auto-sweep after close failed: ${e.message}`);
          }
        }
      } else if (name === "claim_fees") {
        // Auto-compound claimed fees: split every non-SOL/USDC token in the wallet
        // usdcPct% -> USDC (parked) / rest -> SOL (compounded). Not gated on
        // result.base_mint (often unpopulated on the relay path) — sweep-all mirrors
        // the close handler so the split reliably fires, and auto_swap_note stops the
        // LLM from doing its own 100%-SOL swap_token afterwards.
        if (config.management.autoSwapAfterClaim) {
          try {
            const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
            const SWAP_BLACKLIST = new Set([]);
            const MIN_SWEEP_USD = 0.20;
            const MIN_SWEEP_BALANCE_NO_PRICE = 1;
            const isSolLike = (m) => typeof m === "string" && m.length >= 32 && m.length <= 44 && m.startsWith("So1");
            const usdcPct = Math.max(0, Math.min(100, Number(config.management.feeSplitUsdcPct ?? 40)));

            const balances = await getBalancesWithRetry();
            const allTokens = balances.tokens || [];
            const sweepable = allTokens.filter(t => {
              if (!t || !t.mint) return false;
              if (isSolLike(t.mint)) return false;
              if (t.mint === USDC_MINT) return false;
              if (SWAP_BLACKLIST.has(t.mint)) return false;
              if (Number(t.balance) <= 0) return false;
              const usd = Number(t.usd);
              if (Number.isFinite(usd) && usd > 0) return usd >= MIN_SWEEP_USD;
              return Number(t.balance) >= MIN_SWEEP_BALANCE_NO_PRICE;
            });
            // Prioritize the claimed position's base_mint first
            sweepable.sort((a, b) => {
              if (a.mint === result.base_mint) return -1;
              if (b.mint === result.base_mint) return 1;
              return (Number(b.usd) || 0) - (Number(a.usd) || 0);
            });

            log("executor", `Auto-compound (Opsi B): swap ${sweepable.length} claimed token(s) -> SOL, then park ${usdcPct}% to USDC`);
            const sweepRes = await sweepAllToSol(sweepable, "Auto-compound");
            const swept = sweepRes.swept;
            const solGained = sweepRes.compound_sol;
            if (swept.length > 0) {
              result.swept_tokens = swept;
              result.auto_compounded = true;
            }
            let parkedUsdc = 0;
            let keptSol = solGained;
            const solPrice = Number(balances.sol_price);
            const parkSol = solGained * (usdcPct / 100);
            if (solGained > 0 && usdcPct > 0 && solPrice > 0 && parkSol >= 0.002) {
              try {
                const r = await swapToken({ input_mint: FEESPLIT_SOL_MINT, output_mint: FEESPLIT_USDC_MINT, amount: parkSol });
                if (r && r.success) {
                  parkedUsdc = Number(r.amount_out) / 1e6;
                  keptSol = solGained - parkSol;
                  log("executor", `Auto-compound: parked ${parkedUsdc.toFixed(2)} USDC, kept ${keptSol.toFixed(6)} SOL`);
                } else {
                  log("executor_warn", `Auto-compound USDC park failed, keeping all SOL: ${r && r.error}`);
                }
              } catch (e) {
                log("executor_warn", `Auto-compound USDC park error, keeping all SOL: ${e.message}`);
              }
            }
            if (parkedUsdc > 0) result.parked_usdc = parkedUsdc;
            if (keptSol > 0) result.compound_sol = keptSol;
            if (swept.length > 0) {
              result.auto_swap_note = parkedUsdc > 0
                ? `Claimed fees: swept to SOL, parked ${parkedUsdc.toFixed(2)} USDC / kept ${keptSol.toFixed(6)} SOL. Do NOT call swap_token again.`
                : `Claimed fees: swept ${keptSol.toFixed(6)} SOL (no USDC park). Do NOT call swap_token again.`;
            }          } catch (e) {
            log("executor_warn", `Auto-swap after claim failed: ${e.message}`);
          }
        }
        appendDecision({
          type: "claim",
          ts: Date.now(),
          walletAddress: deriveAddress(process.env.WALLET_PRIVATE_KEY || ""),
          pool_name: result.pool_name || args.position_address?.slice(0, 8),
          position: result.position || args.position_address,
          metrics: {
            fees_usd: result.fees_usd ?? result.fees_earned_usd ?? 0,
            fees_sol: result.fees_sol ?? result.fees_earned_sol ?? 0,
          },
          reason: "fee claim",
        });
      }
    }

    return result;
  } catch (error) {
    const duration = Date.now() - startTime;

    logAction({
      tool: name,
      args,
      error: error.message,
      duration_ms: duration,
      success: false,
    });

    // Return error to LLM so it can decide what to do
    return {
      error: error.message,
      tool: name,
    };
  }
}

/**
 * Run safety checks before executing write operations.
 */
async function runSafetyChecks(name, args) {
  switch (name) {
    case "deploy_position": {
      /* __CHASEBYPASS__ grant one-shot dari chase #1 (bukan tool — LLM tidak bisa memicu) */
      if (consumeChaseDeployBypass(args.pool_address)) {
        log("safety", `deploy_position: threshold pool DI-BYPASS (chase #1) utk ${String(args.pool_address).slice(0, 8)}`);
      } else {
        const poolThresholds = await validateDeployPoolThresholds(args);
        if (!poolThresholds.pass) return poolThresholds;
      }

      // Reject pools with bin_step out of configured range
      const minStep = config.screening.minBinStep;
      const maxStep = config.screening.maxBinStep;
      if (args.bin_step != null && (args.bin_step < minStep || args.bin_step > maxStep)) {
        return {
          pass: false,
          reason: `bin_step ${args.bin_step} is outside the allowed range of [${minStep}-${maxStep}].`,
        };
      }

      const deployAmountY = Number(args.amount_y ?? args.amount_sol ?? 0);
      const deployAmountX = Number(args.amount_x ?? 0);
      if (Number.isFinite(deployAmountX) && deployAmountX > 0) {
        return {
          pass: false,
          reason: "This agent only supports single-side SOL deploys. Use amount_y/amount_sol and keep amount_x=0.",
        };
      }
      const requestedBinsBelow = Number(args.bins_below ?? config.strategy.defaultBinsBelow ?? config.strategy.minBinsBelow);
      const requestedBinsAbove = Number(args.bins_above ?? 0);
      const minBinsBelow = Math.max(MIN_SAFE_BINS_BELOW, Number(config.strategy.minBinsBelow ?? MIN_SAFE_BINS_BELOW));
      const isSingleSidedSol = deployAmountY > 0 && deployAmountX <= 0;
      const requestedTotalBins = requestedBinsBelow + requestedBinsAbove;
      const requestedVolatility = args.volatility == null ? null : Number(args.volatility);
      if (args.volatility != null && (!Number.isFinite(requestedVolatility) || requestedVolatility <= 0)) {
        return {
          pass: false,
          reason: `volatility ${args.volatility} is invalid. Refusing deploy because the volatility feed is unusable.`,
        };
      }
      /* __DEPTHCLAMP__ paksa downside_pct masuk band strategi (spot 30-40, bid_ask 40-60) */
      if (args.downside_pct != null && Number.isFinite(Number(args.downside_pct))) {
        const band = args.strategy === "spot" ? [30, 40] : args.strategy === "bid_ask" ? [40, 60] : [30, 60];
        const req = Number(args.downside_pct);
        const clamped = Math.min(band[1], Math.max(band[0], req));
        if (clamped !== req) {
          log("safety", `deploy_position: downside_pct ${req} di luar band ${args.strategy || "?"} [${band[0]}-${band[1]}] — di-clamp ke ${clamped}`);
          args.downside_pct = clamped;
        }
      }
      if (
        args.downside_pct == null &&
        args.upside_pct == null &&
        (
          !Number.isFinite(requestedBinsBelow) ||
          !Number.isFinite(requestedBinsAbove) ||
          !Number.isInteger(requestedBinsBelow) ||
          !Number.isInteger(requestedBinsAbove) ||
          requestedBinsBelow < 0 ||
          requestedBinsAbove < 0 ||
          requestedTotalBins < minBinsBelow
        )
      ) {
        return {
          pass: false,
          reason: `deploy range ${requestedTotalBins} total bins is below minimum ${minBinsBelow}. Refusing 1-bin/tiny-range deploy.`,
        };
      }
      if (
        isSingleSidedSol &&
        args.downside_pct == null &&
        (!Number.isFinite(requestedBinsBelow) || !Number.isInteger(requestedBinsBelow) || requestedBinsBelow < minBinsBelow)
      ) {
        return {
          pass: false,
          reason: `bins_below ${args.bins_below ?? "missing"} is below minimum ${minBinsBelow}. Refusing 1-bin/tiny-range deploy.`,
        };
      }
      if (
        isSingleSidedSol &&
        args.upside_pct == null &&
        (!Number.isFinite(requestedBinsAbove) || !Number.isInteger(requestedBinsAbove) || requestedBinsAbove < 0)
      ) {
        return {
          pass: false,
          reason: "Single-side SOL deploy needs bins_above as a non-negative integer (empty upside headroom only).", /* __UPSIDEHEADROOM__ */
        };
      }

      // Check position count limit + duplicate pool guard — force fresh scan to avoid stale cache
      const positions = await getMyPositions({ force: true });
      if (positions.total_positions >= config.risk.maxPositions) {
        return {
          pass: false,
          reason: `Max positions (${config.risk.maxPositions}) reached. Close a position first.`,
        };
      }
      const alreadyInPool = positions.positions.some(
        (p) => p.pool === args.pool_address
      );
      if (alreadyInPool) {
        return {
          pass: false,
          reason: `Already have an open position in pool ${args.pool_address}. Cannot open duplicate.`,
        };
      }

      // Block same base token across different pools
      if (args.base_mint) {
        const alreadyHasMint = positions.positions.some(
          (p) => p.base_mint === args.base_mint
        );
        if (alreadyHasMint) {
          return {
            pass: false,
            reason: `Already holding base token ${args.base_mint} in another pool. One position per token only.`,
          };
        }
      }

      // Check amount limits
      const amountY = deployAmountY;
      if (!Number.isFinite(amountY) || amountY <= 0) {
        return {
          pass: false,
          reason: `Must provide a positive SOL amount (amount_y).`,
        };
      }

      const minDeploy = Math.max(0.1, config.management.deployAmountSol);
      if (amountY < minDeploy) {
        return {
          pass: false,
          reason: `Amount ${amountY} SOL is below the minimum deploy amount (${minDeploy} SOL). Use at least ${minDeploy} SOL.`,
        };
      }
      if (amountY > config.risk.maxDeployAmount) {
        return {
          pass: false,
          reason: `SOL amount ${amountY} exceeds maximum allowed per position (${config.risk.maxDeployAmount}).`,
        };
      }

      // Check SOL balance
      if (process.env.DRY_RUN !== "true") {
        const balance = await getWalletBalances();
        const gasReserve = config.management.gasReserve;
        const minRequired = amountY + gasReserve;
        if (balance.sol < minRequired) {
          return {
            pass: false,
            reason: `Insufficient SOL: have ${balance.sol} SOL, need ${minRequired} SOL (${amountY} deploy + ${gasReserve} gas reserve).`,
          };
        }
      }

      return { pass: true };
    }

    case "swap_token": {
      // HARDENED: Only allow swap TO SOL/USDC or FROM SOL (for edge-case funding).
      // This prevents the LLM from being prompted into swapping to attacker tokens
      // via token narratives, pool names, or other untrusted data.
      const SOL_MINT = "So11111111111111111111111111111111111111112";
      const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

      // Normalize SOL-like typos (e.g. "So111...111" with 1 trailing 1 instead of 2)
      // before whitelist check, so LLM mistakes don't block legitimate swaps to SOL.
      const normalizeSolLike = (m) => {
        if (!m) return m;
        if (m === "SOL" || m === "native") return SOL_MINT;
        if (typeof m === "string" && m.length >= 32 && m.length <= 44 && m.startsWith("So1") && m !== SOL_MINT) {
          return SOL_MINT;
        }
        return m;
      };
      args.input_mint = normalizeSolLike(args.input_mint);
      args.output_mint = normalizeSolLike(args.output_mint);

      // Permanent sweep blacklist — refuse to interact with these mints at all
      const SWAP_BLACKLIST = new Set([]);
      if (SWAP_BLACKLIST.has(args.input_mint) || SWAP_BLACKLIST.has(args.output_mint)) {
        return {
          pass: false,
          reason: `Mint ${args.input_mint} or ${args.output_mint} is in the permanent swap blacklist (suspected scam/drain).`,
        };
      }

      const allowedOut = new Set([SOL_MINT, USDC]);
      if (!allowedOut.has(args.output_mint) && args.input_mint !== SOL_MINT) {
        return {
          pass: false,
          reason: `Swap output ${args.output_mint} not in whitelist. Only SOL and USDC are allowed as output tokens.`,
        };
      }
      // Hard cap on SOL swap amount
      const maxSwapSol = config.risk?.maxSwapSol ?? 5;
      if (args.input_mint === SOL_MINT && Number(args.amount) > maxSwapSol) {
        return {
          pass: false,
          reason: `Swap amount ${args.amount} SOL exceeds maxSwapSol ${maxSwapSol}.`,
        };
      }
      return { pass: true };
    }

    case "self_update": {
      if (process.env.ALLOW_SELF_UPDATE !== "true") {
        return {
          pass: false,
          reason: "self_update is disabled by default. Set ALLOW_SELF_UPDATE=true locally if you really want to enable it.",
        };
      }
      if (!process.stdin.isTTY) {
        return {
          pass: false,
          reason: "self_update is only allowed from a local interactive TTY session, not from Telegram or background automation.",
        };
      }
      return { pass: true };
    }

    default:
      return { pass: true };
  }
}

/**
 * Summarize a result for logging (truncate large responses).
 */
function summarizeResult(result) {
  const str = JSON.stringify(result);
  if (str.length > 1000) {
    return str.slice(0, 1000) + "...(truncated)";
  }
  return result;
}

/* __CHASEBYPASS__ one-shot threshold bypass utk chase #1 deterministic.
   Dipanggil dari kode (index.js) TEPAT sebelum executeTool deploy_position;
   BUKAN tool & BUKAN argumen tool — LLM tidak punya jalur untuk memicu ini. */
const _chaseDeployBypass = new Map();
export function grantChaseDeployBypass(poolAddress) {
  if (!poolAddress) return;
  _chaseDeployBypass.set(String(poolAddress), Date.now() + 60000);
}
function consumeChaseDeployBypass(poolAddress) {
  const key = String(poolAddress ?? "");
  const exp = _chaseDeployBypass.get(key);
  if (!exp) return false;
  _chaseDeployBypass.delete(key);
  return Date.now() <= exp;
}
