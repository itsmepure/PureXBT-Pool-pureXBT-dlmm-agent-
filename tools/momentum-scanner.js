// tools/momentum-scanner.js
// Momentum/breakout scanner for Agent B (Opsi B: hot-list directly drives deploy).
// Replaces the old BB/RSI dip-eater entry+exit gate.
//
// Architecture (2-tier):
//  - Slow tier (10-min screening cron): prescreen pools -> setCandidatePools(candidates)
//    to maintain the candidate universe (mint -> full pool candidate object).
//  - Fast tier (scanIntervalSec, default 20s, NO LLM): scanMomentum() fetches DexScreener
//    5m metrics per candidate, scores them, maintains a hot-list of pools scoring >= entryScore.
//    On each scan completion an onScanComplete callback fires so index.js can consume
//    getHotList() and drive deploys directly (subject to maxPositions/dedup/cooldown).
//
// Exit: momentumExitFlag() -> ADDITIONAL close trigger (buys<sells OR price<0). The risk
// backstop (SL/TP/trailing/hardStop) always runs and is never suppressed by this.

import { getMetrics5m as _defaultFetcher } from "./dexscreener.js";

// ---- pure scoring ----------------------------------------------------------

export function scoreMomentum(metrics, cfg) {
  const t = cfg.thresholds || {};
  const w = cfg.weights || {};
  const parts = {
    volumeUsd: metrics.volume_5m >= t.volumeUsd ? w.volumeUsd || 0 : 0,
    buysVsSells: metrics.buys_vs_sells_5m >= t.buysVsSells ? w.buysVsSells || 0 : 0,
    priceChangePct: metrics.price_change_5m >= t.priceChangePct ? w.priceChangePct || 0 : 0,
    txCount: metrics.tx_count_5m >= t.txCount ? w.txCount || 0 : 0,
  };
  const score = parts.volumeUsd + parts.buysVsSells + parts.priceChangePct + parts.txCount;
  // HARD PREREQUISITE (Oracle #6): a breakout must have non-negative price change.
  // Even if volume/buys/tx alone clear entryScore, reject if price is falling.
  const priceOk = metrics.price_change_5m >= 0;
  const entry = priceOk && score >= cfg.entryScore;
  return { score, entry, parts, priceOk };
}

export function momentumExitFlag(metrics, cfg) {
  const exit = cfg.exit || {};
  const bvsFloor = exit.buysVsSellsBelow ?? 1.0;
  const pcFloor = exit.priceChangeBelow ?? 0;
  /* __MOMEXITGATE__ #4: OR -> AND — butuh konfirmasi dua sisi (seller dominan DAN harga merah) */
  return metrics.buys_vs_sells_5m < bvsFloor && metrics.price_change_5m < pcFloor;
}

// ---- injectable fetcher (for offline tests) --------------------------------

let _fetcher = _defaultFetcher;
export function setMetricsFetcher(fn) {
  _fetcher = fn || _defaultFetcher;
}

// ---- candidate universe (slow tier feeds this) -----------------------------

// mint -> full pool candidate object (from prescreenPools), used to resolve a hot
// mint back to a deployable pool without re-running the funnel.
const _candidateMap = new Map();

export function setCandidatePools(candidates) {
  const list = Array.isArray(candidates) ? candidates : [];
  const next = new Map();
  for (const c of list) {
    const mint = c?.base?.mint || c?.base_mint || null;
    if (mint) next.set(mint, c);
  }
  // Prune hot/exit state for mints that left the candidate universe (Oracle #3).
  for (const mint of Array.from(_hot.keys())) {
    if (!next.has(mint)) _hot.delete(mint);
  }
  for (const mint of Array.from(_exit.keys())) {
    if (!next.has(mint)) _exit.delete(mint);
  }
  _candidateMap.clear();
  for (const [k, v] of next) _candidateMap.set(k, v);
}

export function getCandidateMints() {
  return Array.from(_candidateMap.keys());
}
export function getCandidatePool(mint) {
  return _candidateMap.get(mint) || null;
}

// ---- hot-list --------------------------------------------------------------

// mint -> { mint, candidate, score, metrics, at }
const _hot = new Map();
export function _resetHotList() {
  _hot.clear();
}

function _hotTtlMs(cfg) {
  const sec = Number(cfg?.hotTtlSec);
  return Number.isFinite(sec) && sec > 0 ? sec * 1000 : 90000;
}

// isHot with TTL check (Oracle #3): a stale hot entry expires even if never re-scanned.
export function isHot(mint, cfg) {
  const e = _hot.get(mint);
  if (!e) return false;
  const ttl = _hotTtlMs(cfg);
  if (Date.now() - e.at > ttl) {
    _hot.delete(mint);
    return false;
  }
  return true;
}

// Returns hot entries (TTL-filtered) sorted by score desc for the deploy queue.
export function getHotList(cfg) {
  const ttl = _hotTtlMs(cfg);
  const now = Date.now();
  const out = [];
  for (const e of _hot.values()) {
    if (now - e.at > ttl) {
      _hot.delete(e.mint);
      continue;
    }
    out.push(e);
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

// ---- exit flags ------------------------------------------------------------

const _exit = new Map(); // mint -> boolean
const _exitStreak = new Map(); /* __MOMEXITGATE__ #2: mint -> jumlah scan beruntun kondisi exit mentah nyala */
export function _resetExit() {
  _exit.clear();
  _exitStreak.clear(); /* __MOMEXITGATE__ */
}
export function getExitFlag(mint) {
  return _exit.get(mint) === true;
}

// ---- cooldown (10 min after close, per user decision m0339) -----------------

const _cooldown = new Map(); // mint -> untilTimestamp
export function _resetCooldown() {
  _cooldown.clear();
}
export function markDeployed(mint, cfg) {
  // Called after a position for `mint` is closed to prevent instant re-deploy churn.
  const sec = Number(cfg?.cooldownSec);
  const ms = Number.isFinite(sec) && sec > 0 ? sec * 1000 : 600000; // default 10 min
  _cooldown.set(mint, Date.now() + ms);
}
export function isOnCooldown(mint) {
  const until = _cooldown.get(mint);
  if (!until) return false;
  if (Date.now() >= until) {
    _cooldown.delete(mint);
    return false;
  }
  return true;
}

// ---- scan core -------------------------------------------------------------

async function _fetchWithConcurrency(mints, cfg) {
  const limit = Math.max(1, Number(cfg?.maxConcurrentScans) || 4);
  const results = new Map(); // mint -> metrics|null
  let idx = 0;
  async function worker() {
    while (idx < mints.length) {
      const i = idx++;
      const mint = mints[i];
      let metrics = null;
      try {
        metrics = await _fetcher(mint);
      } catch {
        metrics = null;
      }
      results.set(mint, metrics);
    }
  }
  const workers = [];
  for (let k = 0; k < Math.min(limit, mints.length); k++) workers.push(worker());
  await Promise.all(workers);
  return results;
}

export async function scanMomentum(candidateMints, cfg) {
  const mints = Array.isArray(candidateMints) ? candidateMints : [];
  let scanned = 0;
  _psScans++;
  if (_psWindowStart == null) _psWindowStart = Date.now();
  const metricsByMint = await _fetchWithConcurrency(mints, cfg);
  for (const mint of mints) {
    scanned++;
    const metrics = metricsByMint.get(mint) || null;
    if (!metrics) {
      // Keep existing exit flag during a data outage (Oracle #8): only clear hot.
      _hot.delete(mint);
      continue;
    }
    const _reason = prescreenReason(metrics, cfg);
    _psAcc[_reason] = (_psAcc[_reason] || 0) + 1;
    if (_reason !== "pass" && _reason !== "off") { _hot.delete(mint); continue; }
    const { score, entry } = scoreMomentum(metrics, cfg);
    if (entry) {
      const candidate = _candidateMap.get(mint) || null;
      _hot.set(mint, { mint, candidate, score, metrics, at: Date.now() });
    } else {
      _hot.delete(mint);
    }
    /* __MOMEXITGATE__ #2: persistence — flag valid setelah >= confirmTicks scan beruntun (default 3 ~ 1 menit @20s) */
    const _rawExit = momentumExitFlag(metrics, cfg);
    const _streak = _rawExit ? (_exitStreak.get(mint) || 0) + 1 : 0;
    _exitStreak.set(mint, _streak);
    _exit.set(mint, _streak >= ((cfg.exit || {}).confirmTicks ?? 3));
  }
  return { scanned, hot: _hot.size };
}

// ---- scan loop (fast tier) -------------------------------------------------

let _timer = null;
let _scanInFlight = false; // Oracle #4: prevent overlapping scans
let _onScanComplete = null;

export function setOnScanComplete(fn) {
  _onScanComplete = typeof fn === "function" ? fn : null;
}

export function startMomentumLoop(cfg) {
  stopMomentumLoop();
  if (!cfg || cfg.enabled === false) return;
  const ms = Math.max(50, Number(cfg.scanIntervalSec || 20) * 1000);
  const tick = async () => {
    if (_scanInFlight) return; // skip if a scan is still running
    _scanInFlight = true;
    try {
      await scanMomentum(getCandidateMints(), cfg);
      if (_onScanComplete) {
        try {
          await _onScanComplete(cfg);
        } catch {
          /* deploy-driver errors must not kill the scan loop */
        }
      }
    } catch {
      /* swallow */
    } finally {
      _scanInFlight = false;
    }
  };
  _timer = setInterval(tick, ms);
  if (_timer.unref) _timer.unref();
  tick();
}

export function stopMomentumLoop() {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
  _scanInFlight = false;
}

export function prescreenReason(metrics, cfg) {
  const p = cfg.prescreen;
  if (!p || p.enabled === false) return "off"; // prescreen off => pass-through
  const mcap = Number(metrics.market_cap);
  const lp = Number(metrics.lp_usd);
  const vol = Number(metrics.volume_5m);
  const tx = Number(metrics.tx_count_5m);
  if (!Number.isFinite(mcap) || !Number.isFinite(lp)) return "mcapMissing"; // fail-closed bucket
  if (mcap < p.mcapMin || mcap > p.mcapMax) return "mcapBand";
  if (vol < p.volumeUsd) return "vol";
  if (tx < p.txCount) return "tx";
  if (lp < p.lpUsd) return "lp";
  /* __TOKENAGE__ umur token minimal (jam) — fail-closed bila umur tak diketahui */
  if (p.minAgeHours != null && p.minAgeHours > 0) {
    const ageH = metrics.pair_age_h == null ? NaN : Number(metrics.pair_age_h);
    if (!Number.isFinite(ageH)) return "ageMissing";
    if (ageH < p.minAgeHours) return "age";
  }
  return "pass";
}

export function passesPrescreen(metrics, cfg) {
  const r = prescreenReason(metrics, cfg);
  return r === "pass" || r === "off";
}

// ---- prescreen observability (rollup counters; measurement only) -----------

const _psAcc = { pass: 0, off: 0, mcapMissing: 0, mcapBand: 0, vol: 0, tx: 0, lp: 0 };
let _psScans = 0;
let _psWindowStart = null; // ms; lazily initialized on first scan

export function _resetPrescreenStats(nowMs) {
  for (const k of Object.keys(_psAcc)) _psAcc[k] = 0;
  _psScans = 0;
  _psWindowStart = nowMs ?? null;
}

export function takePrescreenRollup(cfg, nowMs) {
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  if (_psWindowStart == null) { _psWindowStart = now; return null; }
  const windowMs = Math.max(1000, Number(cfg?.prescreen?.rollupSec ?? 300) * 1000);
  if (now - _psWindowStart < windowMs) return null;
  const evals = _psAcc.pass + _psAcc.off + _psAcc.mcapMissing + _psAcc.mcapBand + _psAcc.vol + _psAcc.tx + _psAcc.lp;
  const pct = (n) => (evals > 0 ? Math.round((n / evals) * 100) : 0);
  const summary = { scans: _psScans, evals, ..._psAcc };
  const line =
    `Prescreen 5m: scans=${_psScans} evals=${evals} ` +
    `pass=${_psAcc.pass}(${pct(_psAcc.pass)}%) off=${_psAcc.off} | ` +
    `reject mcapMissing=${_psAcc.mcapMissing}(${pct(_psAcc.mcapMissing)}%) ` +
    `mcapBand=${_psAcc.mcapBand} vol=${_psAcc.vol} tx=${_psAcc.tx} lp=${_psAcc.lp}`;
  _resetPrescreenStats(now);
  return { line, summary };
}

export function computeDownsidePct(volatility) {
  const v = Number(volatility);
  if (!Number.isFinite(v) || v <= 0) return 30; // safe default = lowest tier
  if (v > 20) return 75; // high vol => lower = -75%
  if (v > 10) return 55; // med vol  => lower = -55%
  return 30;             // low vol  => lower = -30%
}
