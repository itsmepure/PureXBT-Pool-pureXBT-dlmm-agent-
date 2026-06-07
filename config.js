import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USER_CONFIG_PATH = path.join(__dirname, "user-config.json");
const DEFAULT_HIVEMIND_URL = "https://api.agentmeridian.xyz";
const DEFAULT_AGENT_PUREXBT_API_URL = DEFAULT_HIVEMIND_URL + "/api";
const DEFAULT_AGENT_PUREXBT_PUBLIC_KEY = "cHVyZVhCVC1pcy10aGUtYmVzdC1hZ2VudHM=";
const DEFAULT_HIVEMIND_API_KEY = DEFAULT_AGENT_PUREXBT_PUBLIC_KEY;

let u = fs.existsSync(USER_CONFIG_PATH)
  ? JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"))
  : {};

/**
 * Get merged config section with wallet-specific overrides.
 * Priority: wallet override > global > legacy root-level > default
 * Re-reads file if reload=true (used by reloadScreeningThresholds).
 */
function getSection(name, freshU = null) {
  const cfg = freshU || u;
  const legacy = cfg[name] || {};
  const global = (cfg.global && cfg.global[name]) || {};
  const walletId = process.env.WALLET_ID;
  const walletOverride = (walletId && cfg.wallets && cfg.wallets[walletId] && cfg.wallets[walletId][name]) || {};
  return { ...legacy, ...global, ...walletOverride };
}

/**
 * Returns the path where config changes should be persisted to,
 * accounting for per-wallet overrides.
 * @param {string} section - Section name (risk, screening, management, schedule, llm)
 * @returns {string[]} Array path for nesting (e.g. ["global","screening"])
 */
export function getConfigPersistPath(section) {
  const walletId = process.env.WALLET_ID;
  if (walletId) {
    return ["wallets", walletId, section];
  }
  return ["global", section];
}

export { getSection };

const risk = getSection("risk");
const screening = getSection("screening");
const management = getSection("management");
const schedule = getSection("schedule");
const llm = getSection("llm");
export const MIN_SAFE_BINS_BELOW = 35;

function numericConfig(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// Strategy bins: read from global.strategy (new nested format) first, then root (legacy)
const _strategySrc = (u.global && u.global.strategy) || u;
const legacyBinsBelow = numericConfig(_strategySrc.binsBelow);
const configuredMinBinsBelow = numericConfig(_strategySrc.minBinsBelow) ?? 60;
const configuredMaxBinsBelow = numericConfig(_strategySrc.maxBinsBelow)
  ?? (legacyBinsBelow != null ? Math.max(legacyBinsBelow, configuredMinBinsBelow) : 120);
const configuredDefaultBinsBelow = numericConfig(_strategySrc.defaultBinsBelow) ?? legacyBinsBelow ?? configuredMaxBinsBelow;
const strategyMinBinsBelow = Math.max(MIN_SAFE_BINS_BELOW, Math.round(configuredMinBinsBelow));
const strategyMaxBinsBelow = Math.max(strategyMinBinsBelow, Math.round(configuredMaxBinsBelow));
const strategyDefaultBinsBelow = Math.max(
  strategyMinBinsBelow,
  Math.min(strategyMaxBinsBelow, Math.round(configuredDefaultBinsBelow)),
);

// Apply wallet/RPC from user-config if not already in env
if (u.rpcUrl)    process.env.RPC_URL            ||= u.rpcUrl;
if (u.walletKey) process.env.WALLET_PRIVATE_KEY ||= u.walletKey;
if (u.llmModel)  process.env.LLM_MODEL          ||= u.llmModel;
if (u.llmBaseUrl) process.env.LLM_BASE_URL      ||= u.llmBaseUrl;
if (u.llmApiKey)  process.env.LLM_API_KEY       ||= u.llmApiKey;
if (u.dryRun !== undefined) process.env.DRY_RUN ||= String(u.dryRun);
if (u.publicApiKey) process.env.PUBLIC_API_KEY ||= u.publicApiKey;
if (u.agentPureXbtApiUrl) process.env.AGENT_PUREXBT_API_URL ||= u.agentPureXbtApiUrl;

const indicatorUserConfig = u.chartIndicators ?? {};

function nonEmptyString(...values) {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

export const config = {
  // ─── Risk Limits ─────────────────────────
  risk: {
    maxPositions:    risk.maxPositions    ?? 3,
    maxDeployAmount: risk.maxDeployAmount ?? 50,
    maxSwapSol:      risk.maxSwapSol      ?? null,
    hardStopLossPct:      risk.hardStopLossPct      ?? null,
    dailyMaxDrawdownSol:  risk.dailyMaxDrawdownSol  ?? null,
    dailyMaxStopLosses:   risk.dailyMaxStopLosses   ?? 3,
  },

  // ─── Pool Screening Thresholds ───────────
  screening: {
    excludeHighSupplyConcentration: screening.excludeHighSupplyConcentration ?? true,
    minFeeActiveTvlRatio: screening.minFeeActiveTvlRatio ?? 0.05,
    minTvl:            screening.minTvl            ?? 10_000,
    maxTvl:            screening.maxTvl !== undefined ? screening.maxTvl : 150_000,
    minVolume:         screening.minVolume         ?? 500,
    minOrganic:        screening.minOrganic        ?? 60,
    minQuoteOrganic:   screening.minQuoteOrganic   ?? 60,
    minHolders:        screening.minHolders        ?? 500,
    minMcap:           screening.minMcap           ?? 150_000,
    maxMcap:           screening.maxMcap           ?? 10_000_000,
    minBinStep:        screening.minBinStep        ?? 80,
    maxBinStep:        screening.maxBinStep        ?? 125,
    timeframe:         screening.timeframe         ?? "5m",
    category:          screening.category          ?? "trending",
    minTokenFeesSol:   screening.minTokenFeesSol   ?? 30,
    useDiscordSignals: screening.useDiscordSignals ?? false,
    discordSignalMode: screening.discordSignalMode ?? "merge",
    avoidPvpSymbols:   screening.avoidPvpSymbols   ?? true,
    blockPvpSymbols:   screening.blockPvpSymbols   ?? false,
    maxBundlePct:      screening.maxBundlePct      ?? 30,
    maxBotHoldersPct:  screening.maxBotHoldersPct  ?? 30,
    maxTop10Pct:       screening.maxTop10Pct       ?? 60,
    allowedLaunchpads: screening.allowedLaunchpads ?? [],
    blockedLaunchpads: screening.blockedLaunchpads  ?? [],
    minTokenAgeHours:  screening.minTokenAgeHours   ?? null,
    maxTokenAgeHours:  screening.maxTokenAgeHours   ?? null,
    athFilterPct:      screening.athFilterPct       ?? null,
    pumpCheckEnabled:  screening.pumpCheckEnabled    ?? false,
    maxPumpPct1h:       screening.maxPumpPct1h        ?? 10,
    athSoftCapEnabled:  screening.athSoftCapEnabled   ?? true,
    athSoftCapPct:      screening.athSoftCapPct       ?? 15,
    athSoftCapMaxScore: screening.athSoftCapMaxScore  ?? 40,
    securityCheckEnabled: screening.securityCheckEnabled ?? false,
    holderCheckEnabled:   screening.holderCheckEnabled   ?? false,
    trendingDiscoveryEnabled: screening.trendingDiscoveryEnabled ?? false,
  },

  // ─── Position Management ────────────────
  management: {
    minClaimAmount:        management.minClaimAmount        ?? 5,
    autoSwapAfterClaim:    management.autoSwapAfterClaim    ?? true,
    outOfRangeBinsToClose: management.outOfRangeBinsToClose ?? null,
    outOfRangeWaitMinutes: management.outOfRangeWaitMinutes ?? 30,
    oorCooldownTriggerCount: management.oorCooldownTriggerCount ?? 3,
    oorCooldownHours:       management.oorCooldownHours       ?? 12,
    repeatDeployCooldownEnabled: management.repeatDeployCooldownEnabled ?? true,
    repeatDeployCooldownTriggerCount: management.repeatDeployCooldownTriggerCount ?? 3,
    repeatDeployCooldownHours: management.repeatDeployCooldownHours ?? 12,
    repeatDeployCooldownScope: management.repeatDeployCooldownScope ?? "token",
    repeatDeployCooldownMinFeeEarnedPct: management.repeatDeployCooldownMinFeeEarnedPct ?? management.repeatDeployCooldownMinFeeYieldPct ?? 0,
    minVolumeToRebalance:  management.minVolumeToRebalance  ?? 1000,
    stopLossPct:           management.stopLossPct           ?? management.emergencyPriceDropPct ?? -50,
    takeProfitPct:         management.takeProfitPct         ?? management.takeProfitFeePct ?? 5,
    minFeePerTvl24h:       management.minFeePerTvl24h       ?? 7,
    minAgeBeforeYieldCheck: management.minAgeBeforeYieldCheck ?? 60,
    feeTvlDecayPct:        management.feeTvlDecayPct        ?? 50,
    minSolToOpen:          management.minSolToOpen          ?? 0.55,
    deployAmountSol:       management.deployAmountSol       ?? 0.5,
    gasReserve:            management.gasReserve            ?? 0.2,
    positionSizePct:       management.positionSizePct       ?? 0.35,
    trailingTakeProfit:    management.trailingTakeProfit    ?? true,
    trailingTriggerPct:    management.trailingTriggerPct    ?? 3,
    trailingDropPct:       management.trailingDropPct       ?? 1.5,
    pnlSanityMaxDiffPct:   management.pnlSanityMaxDiffPct   ?? 5,
    solMode:               management.solMode               ?? false,
  },

  // ─── Strategy Mapping ───────────────────
  strategy: {
    strategy:     u.strategy     ?? "bid_ask",
    minBinsBelow: strategyMinBinsBelow,
    maxBinsBelow: strategyMaxBinsBelow,
    defaultBinsBelow: strategyDefaultBinsBelow,
  },

  // ─── Scheduling ─────────────────────────
  schedule: {
    managementIntervalMin:  schedule.managementIntervalMin  ?? 10,
    screeningIntervalMin:   schedule.screeningIntervalMin   ?? 30,
    healthCheckIntervalMin: schedule.healthCheckIntervalMin ?? 60,
  },

  // ─── LLM Settings ──────────────────────
  llm: {
    temperature: llm.temperature ?? 0.373,
    maxTokens:   llm.maxTokens   ?? 4096,
    maxSteps:    llm.maxSteps    ?? 20,
    managementModel: llm.managementModel ?? process.env.LLM_MODEL ?? "openrouter/healer-alpha",
    screeningModel:  llm.screeningModel  ?? process.env.LLM_MODEL ?? "openrouter/hunter-alpha",
    generalModel:    llm.generalModel    ?? process.env.LLM_MODEL ?? "openrouter/healer-alpha",
  },

  // ─── Darwinian Signal Weighting ───────
  darwin: {
    enabled:        u.darwinEnabled     ?? true,
    windowDays:     u.darwinWindowDays  ?? 60,
    recalcEvery:    u.darwinRecalcEvery ?? 5,    // recalc every N closes
    boostFactor:    u.darwinBoost       ?? 1.05,
    decayFactor:    u.darwinDecay       ?? 0.95,
    weightFloor:    u.darwinFloor       ?? 0.3,
    weightCeiling:  u.darwinCeiling     ?? 2.5,
    minSamples:     u.darwinMinSamples  ?? 10,
  },

  // ─── Common Token Mints ────────────────
  tokens: {
    SOL:  "So11111111111111111111111111111111111111112",
    USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    USDT: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  },

  // ─── HiveMind ─────────────────────────
  hiveMind: {
    url: nonEmptyString(u.hiveMindUrl, process.env.HIVE_MIND_URL) || null,
    apiKey: nonEmptyString(u.hiveMindApiKey, process.env.HIVEMIND_API_KEY, DEFAULT_HIVEMIND_API_KEY),
    agentId: u.agentId ?? null,
    pullMode: u.hiveMindPullMode ?? "auto",
  },

  api: {
    url: nonEmptyString(u.agentPureXbtApiUrl, process.env.AGENT_PUREXBT_API_URL, DEFAULT_AGENT_PUREXBT_API_URL),
    publicApiKey: nonEmptyString(u.publicApiKey, process.env.PUBLIC_API_KEY, DEFAULT_AGENT_PUREXBT_PUBLIC_KEY),
    lpAgentRelayEnabled: u.lpAgentRelayEnabled ?? false,
  },

  jupiter: {
    // Internal Jupiter Ultra settings; override by env or user-config.
    apiKey: process.env.JUPITER_API_KEY ?? u.jupiter?.apiKey ?? "",
    referralAccount:
      u.jupiter?.referralAccount ||
      process.env.JUPITER_REFERRAL_ACCOUNT ||
      "",
    referralFeeBps: Number(
      u.jupiter?.referralFeeBps ??
      process.env.JUPITER_REFERRAL_FEE_BPS ??
      0,
    ),
  },

  indicators: {
    enabled: indicatorUserConfig.enabled ?? false,
    entryPreset: indicatorUserConfig.entryPreset ?? "supertrend_break",
    exitPreset: indicatorUserConfig.exitPreset ?? "supertrend_break",
    rsiLength: indicatorUserConfig.rsiLength ?? 2,
    intervals: Array.isArray(indicatorUserConfig.intervals)
      ? indicatorUserConfig.intervals
      : ["5_MINUTE"],
    candles: indicatorUserConfig.candles ?? 298,
    rsiOversold: indicatorUserConfig.rsiOversold ?? 30,
    rsiOverbought: indicatorUserConfig.rsiOverbought ?? 80,
    requireAllIntervals: indicatorUserConfig.requireAllIntervals ?? false,
  },
};

/**
 * Compute the optimal deploy amount for a given wallet balance.
 * Scales position size with wallet growth (compounding).
 *
 * Formula: clamp(deployable × positionSizePct, floor=deployAmountSol, ceil=maxDeployAmount)
 *
 * Examples (defaults: gasReserve=0.2, positionSizePct=0.35, floor=0.5):
 *   0.8 SOL wallet → 0.6 SOL deploy  (floor)
 *   2.0 SOL wallet → 0.63 SOL deploy
 *   3.0 SOL wallet → 0.98 SOL deploy
 *   4.0 SOL wallet → 1.33 SOL deploy
 */
export function computeDeployAmount(walletSol) {
  const reserve  = config.management.gasReserve      ?? 0.2;
  const pct      = config.management.positionSizePct ?? 0.35;
  const floor    = config.management.deployAmountSol;
  const ceil     = config.risk.maxDeployAmount;
  const deployable = Math.max(0, walletSol - reserve);
  const dynamic    = deployable * pct;
  const result     = Math.min(ceil, Math.max(floor, dynamic));
  return parseFloat(result.toFixed(2));
}

/**
 * Reload user-config.json and apply updated screening thresholds to the
 * in-memory config object. Called after threshold evolution so the next
 * agent cycle uses the evolved values without a restart.
 * Supports per-wallet overrides via WALLET_ID env var.
 */
export function reloadScreeningThresholds() {
  try {
    if (!fs.existsSync(USER_CONFIG_PATH)) return;
    const freshU = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"));
    const freshScreening = getSection("screening", freshU);
    const s = config.screening;
    for (const [key, val] of Object.entries(freshScreening)) {
      if (val !== undefined && val !== null) s[key] = val;
    }
    // strategy bins (from global or root)
    const strategySrc = (freshU.global && freshU.global.strategy) || freshU;
    const minBinsBelow = numericConfig(strategySrc.minBinsBelow) ?? config.strategy.minBinsBelow;
    const maxBinsBelow = numericConfig(strategySrc.maxBinsBelow) ?? numericConfig(strategySrc.binsBelow) ?? config.strategy.maxBinsBelow;
    const defaultBinsBelow = numericConfig(strategySrc.defaultBinsBelow) ?? numericConfig(strategySrc.binsBelow) ?? config.strategy.defaultBinsBelow ?? maxBinsBelow;
    config.strategy.minBinsBelow = Math.max(MIN_SAFE_BINS_BELOW, Math.round(minBinsBelow));
    config.strategy.maxBinsBelow = Math.max(config.strategy.minBinsBelow, Math.round(maxBinsBelow));
    config.strategy.defaultBinsBelow = Math.max(
      config.strategy.minBinsBelow,
      Math.min(config.strategy.maxBinsBelow, Math.round(defaultBinsBelow)),
    );
  } catch { /* ignore */ }
}
