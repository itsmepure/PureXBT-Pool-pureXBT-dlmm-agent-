import { Connection, PublicKey } from "@solana/web3.js";
import { config } from "../config.js";
import { poolNameFromMemory } from "../pool-memory.js"; /* __POOLNAME_FALLBACK__ */
import { log } from "../logger.js";
import {
  getTrackedPosition,
  markOutOfRange,
  markInRange,
  minutesOutOfRange,
} from "../state.js";

// ─── RPC-derived PnL engine (Sprint B) ──────────────────────────
// Live position value (current liquidity + claimable fees) is read ON-CHAIN
// via the Meteora DLMM SDK on a dedicated RPC. Deposit history (cost basis,
// withdrawals, claimed fees) comes ONLY from the Meteora /pnl API — its
// precomputed live pnl/balances are intentionally ignored. Token USD prices
// come from Jupiter. No LPAgent / agentmeridian dependency.
//
// This module is self-contained (no import from dlmm.js) to avoid a circular
// import — dlmm.js calls computePositions() as its RPC-first path.

const JUP_SEARCH = "https://datapi.jup.ag/v1/assets/search";
const METEORA_PNL = "https://dlmm.datapi.meteora.ag/positions";

let _DLMM = null;
async function loadDlmmSdk() {
  if (!_DLMM) {
    const mod = await import("@meteora-ag/dlmm");
    _DLMM = mod.default;
  }
  return _DLMM;
}

let _pnlConnection = null;
function getPnlConnection() {
  if (!_pnlConnection) {
    const url = config.pnl?.rpcUrl || process.env.RPC_URL;
    _pnlConnection = new Connection(url, "confirmed");
  }
  return _pnlConnection;
}

function safeNum(value) {
  const n = parseFloat(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}
function maybeNum(value) {
  if (value == null || value === "") return null;
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : null;
}
function round(value, decimals = 4) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}
function unique(arr) {
  return [...new Set(arr.filter(Boolean))];
}

// ─── Meteora /pnl per pool (deposit history) ────────────────────
export async function fetchMeteoraPnlForPool(poolAddress, walletAddress) {
  const url = `${METEORA_PNL}/${poolAddress}/pnl?user=${walletAddress}&status=open&pageSize=100&page=1`;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      log("pnl_api", `HTTP ${res.status} for pool ${poolAddress.slice(0, 8)}: ${body.slice(0, 120)}`);
      return {};
    }
    const data = await res.json();
    const positions = data.positions || data.data || [];
    const byAddress = {};
    for (const p of positions) {
      const addr = p.positionAddress || p.address || p.position;
      if (addr) byAddress[addr] = p;
    }
    return byAddress;
  } catch (e) {
    log("pnl_api", `Fetch error for pool ${poolAddress.slice(0, 8)}: ${e.message}`);
    return {};
  }
}

// ─── Jupiter prices (never cached) ──────────────────────────────
async function getJupiterPrices(mints) {
  const list = unique(mints.map((m) => String(m).trim()));
  if (!list.length) return {};
  try {
    const res = await fetch(`${JUP_SEARCH}?query=${list.join(",")}`, { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`Jupiter ${res.status}`);
    const assets = await res.json();
    const out = {};
    for (const a of assets) out[a.id] = maybeNum(a.usdPrice);
    return out;
  } catch (e) {
    log("pnl_price", `Jupiter price fetch failed: ${e.message}`);
    return {};
  }
}

// ─── Deposit-history cache (sig-invalidated + TTL) ──────────────
const _meteoraCache = new Map(); // pool -> { at, byPosition, sigByPosition }
let _pollCount = 0;

async function getLatestSig(conn, addr) {
  try {
    const sigs = await conn.getSignaturesForAddress(new PublicKey(addr), { limit: 1 });
    return sigs?.[0]?.signature ?? null;
  } catch {
    return null;
  }
}

async function getMeteoraData(conn, walletAddress, flat) {
  const ttlMs = Math.max(0, Number(config.pnl?.depositCacheTtlSec ?? 300)) * 1000;
  const positionsByPool = new Map();
  for (const f of flat) {
    if (!positionsByPool.has(f.pool)) positionsByPool.set(f.pool, []);
    positionsByPool.get(f.pool).push(f.position);
  }

  const byPosition = {};
  await Promise.all([...positionsByPool.entries()].map(async ([pool, positionAddrs]) => {
    const cached = _meteoraCache.get(pool);
    const sigByPosition = {};
    await Promise.all(positionAddrs.map(async (addr) => { sigByPosition[addr] = await getLatestSig(conn, addr); }));

    const ageOk = cached && Date.now() - cached.at < ttlMs;
    const sigsMatch = cached && positionAddrs.every((a) => cached.sigByPosition?.[a] === sigByPosition[a]);

    let data;
    if (ageOk && sigsMatch) {
      data = cached.byPosition;
    } else {
      data = await fetchMeteoraPnlForPool(pool, walletAddress);
      _meteoraCache.set(pool, { at: Date.now(), byPosition: data, sigByPosition });
    }
    for (const addr of positionAddrs) byPosition[addr] = data[addr] || null;
  }));

  return byPosition;
}

function mapEntries(map) {
  return map instanceof Map ? [...map.entries()] : Object.entries(map || {});
}

// ─── Build shaped position (matches getMyPositions output) ──────
function buildPosition(f, prices, solUsd, meteora, solMode) {
  const priceX = f.baseMint ? (prices[f.baseMint] ?? 0) : 0;

  const xHuman = safeNum(f.xRaw) / 10 ** f.decX;
  const yHuman = safeNum(f.yRaw) / 10 ** f.decY;
  const balancesUsd = xHuman * priceX + yHuman * (solUsd ?? 0);
  const balancesSol = solUsd ? balancesUsd / solUsd : yHuman;

  const feeXHuman = safeNum(f.feeXRaw) / 10 ** f.decX;
  const feeYHuman = safeNum(f.feeYRaw) / 10 ** f.decY;
  const claimableUsd = feeXHuman * priceX + feeYHuman * (solUsd ?? 0);
  const claimableSol = solUsd ? claimableUsd / solUsd : feeYHuman;

  const depositsUsd = safeNum(meteora?.allTimeDeposits?.total?.usd);
  const depositsSol = safeNum(meteora?.allTimeDeposits?.total?.sol);
  const withdrawUsd = safeNum(meteora?.allTimeWithdrawals?.total?.usd);
  const withdrawSol = safeNum(meteora?.allTimeWithdrawals?.total?.sol);
  const claimedUsd = safeNum(meteora?.allTimeFees?.total?.usd);
  const claimedSol = safeNum(meteora?.allTimeFees?.total?.sol);

  /* __COSTBASIS__ fallback cost basis dari tracking — deposit Meteora belum keindex/parsial.
     Utk deploy single-side SOL, amount_sol tracking = cost basis PASTI: PnL & stop-loss
     tidak perlu menunggu indexer. */
  const _trkCB = getTrackedPosition(f.position);
  const _expectSolCB = Number(_trkCB?.amount_sol) || 0;
  const _apiDepMissing = depositsSol <= 0;
  const _apiDepIncomplete = _expectSolCB > 0 && depositsSol > 0 && depositsSol < _expectSolCB * 0.9;
  const _useFallbackBasis = (_apiDepMissing || _apiDepIncomplete) && _expectSolCB > 0;
  const effDepositsSol = _useFallbackBasis ? _expectSolCB : depositsSol;
  const effDepositsUsd = _useFallbackBasis ? (solUsd > 0 ? _expectSolCB * solUsd : depositsUsd) : depositsUsd;
  const pnlUsd = balancesUsd + withdrawUsd + claimableUsd + claimedUsd - effDepositsUsd;
  const pnlSol = balancesSol + withdrawSol + claimableSol + claimedSol - effDepositsSol;
  const pctUsd = effDepositsUsd > 0 ? (pnlUsd / effDepositsUsd) * 100 : 0;
  const pctSol = effDepositsSol > 0 ? (pnlSol / effDepositsSol) * 100 : 0;
  const ourPct = solMode ? pctSol : pctUsd;

  // pnl_pct_diff: gap vs Meteora precomputed pct — DIAGNOSTIC ONLY (Sprint A rule).
  const reportedPct = solMode ? maybeNum(meteora?.pnlSolPctChange) : maybeNum(meteora?.pnlPctChange);
  const pnlPctDiff = reportedPct != null ? Math.abs(ourPct - reportedPct) : null;

  // Input-validity sanity (Sprint A): suspicious ONLY when it couldn't be priced.
  const holdsTokenX = xHuman > 0 || feeXHuman > 0;
  const priceMissing = !(solUsd > 0) || (holdsTokenX && !!f.baseMint && !(priceX > 0));
  /* __COSTBASIS__ basis efektif: fallback tracking menutup kasus missing/parsial —
     suspicious kini HANYA bila benar-benar tanpa basis atau tanpa harga. */
  const depositsMissing = (solMode ? effDepositsSol : effDepositsUsd) <= 0;
  const depositsIncomplete = false; // tertangani fallback cost-basis
  const pnlPctSuspicious = priceMissing || depositsMissing;
  if (pnlPctSuspicious) {
    log("pnl_warn", `${f.position.slice(0, 8)} suspicious tick — priceMissing=${priceMissing} depositsMissing=${depositsMissing} depositsIncomplete=${depositsIncomplete} (solUsd=${solUsd}, priceX=${priceX})`);
  }

  const inRange = f.active != null && f.lower != null && f.upper != null
    ? f.active >= f.lower && f.active <= f.upper
    : (meteora ? !meteora.isOutOfRange : true);
  if (inRange) markInRange(f.position);
  else markOutOfRange(f.position);

  const tracked = getTrackedPosition(f.position);
  const ageFromState = tracked?.deployed_at
    ? Math.floor((Date.now() - new Date(tracked.deployed_at).getTime()) / 60000)
    : null;
  const ageMinutes = meteora?.createdAt ? Math.floor((Date.now() - meteora.createdAt * 1000) / 60000) : ageFromState;

  return {
    position:           f.position,
    pool:               f.pool,
    pair:               tracked?.pool_name || poolNameFromMemory(f.pool) || (meteora ? `${meteora.tokenX ?? "?"}/${meteora.tokenY ?? "SOL"}` : "?/SOL"),
    base_mint:          f.baseMint,
    lower_bin:          f.lower ?? tracked?.bin_range?.min ?? null,
    upper_bin:          f.upper ?? tracked?.bin_range?.max ?? null,
    active_bin:         f.active ?? tracked?.bin_range?.active ?? null,
    in_range:           inRange,
    unclaimed_fees_usd: round(solMode ? claimableSol : claimableUsd),
    unclaimed_fees_sol: round(claimableSol, 8),
    unclaimed_fees_true_usd: round(claimableUsd),
    total_value_usd:    round(solMode ? balancesSol : balancesUsd),
    total_value_true_usd: round(balancesUsd),
    collected_fees_usd: round(solMode ? claimedSol : claimedUsd),
    collected_fees_true_usd: round(claimedUsd),
    pnl_usd:            round(solMode ? pnlSol : pnlUsd),
    pnl_true_usd:       round(pnlUsd),
    pnl_pct:            round(ourPct, 2),
    pnl_pct_derived:    round(ourPct, 2),
    pnl_pct_diff:       pnlPctDiff != null ? round(pnlPctDiff, 2) : null,
    pnl_pct_suspicious: !!pnlPctSuspicious,
    fee_per_tvl_24h:    meteora ? Math.round(safeNum(meteora.feePerTvl24h) * 100) / 100 : null,
    age_minutes:        ageMinutes,
    minutes_out_of_range: minutesOutOfRange(f.position),
    token_x_value_usd:  round(xHuman * priceX), /* __CHASEUP__ */
    instruction:        tracked?.instruction ?? null,
  };
}

// ─── Main entry: compute positions from RPC + Meteora deposits + Jupiter ──
// Returns same shape as getMyPositions, or THROWS so caller can fall back.
export async function computePositions(walletAddress) {
  const solMode = !!config.management?.solMode;
  const SOL_MINT = config.tokens.SOL;
  const conn = getPnlConnection();
  const DLMM = await loadDlmmSdk();

  const map = await DLMM.getAllLbPairPositionsByUser(conn, new PublicKey(walletAddress));
  _pollCount++;
  if (_pollCount % 20 === 1) {
    const n = [...mapEntries(map)].reduce((s, [, i]) => s + (i?.lbPairPositionsData?.length ?? 0), 0);
    log("pnl_tick", `RPC poller alive — ${n} position(s) tracked (tick #${_pollCount})`);
  }

  const flat = [];
  for (const [lbPairKey, info] of mapEntries(map)) {
    const decX = info?.tokenX?.mint?.decimals ?? 9;
    const decY = info?.tokenY?.mint?.decimals ?? 9;
    const baseMint = info?.tokenX?.mint?.address?.toString?.() ?? null;
    const active = info?.lbPair?.activeId ?? null;
    for (const p of info?.lbPairPositionsData || []) {
      const d = p.positionData || {};
      flat.push({
        position: p.publicKey.toString(),
        pool: lbPairKey,
        baseMint, decX, decY, active,
        lower: d.lowerBinId ?? null,
        upper: d.upperBinId ?? null,
        xRaw: d.totalXAmount,
        yRaw: d.totalYAmount,
        feeXRaw: d.feeX?.toString?.() ?? d.feeX ?? 0,
        feeYRaw: d.feeY?.toString?.() ?? d.feeY ?? 0,
      });
    }
  }

  if (flat.length === 0) {
    return { wallet: walletAddress, total_positions: 0, positions: [], source: "rpc" };
  }

  const [prices, meteoraByPosition] = await Promise.all([
    getJupiterPrices([SOL_MINT, ...flat.map((f) => f.baseMint)]),
    getMeteoraData(conn, walletAddress, flat),
  ]);
  const solUsd = prices[SOL_MINT] ?? null;

  const positions = flat.map((f) => buildPosition(f, prices, solUsd, meteoraByPosition[f.position], solMode));
  return { wallet: walletAddress, total_positions: positions.length, positions, source: "rpc" };
}
