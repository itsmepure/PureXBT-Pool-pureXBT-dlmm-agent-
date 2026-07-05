const TG_CYCLE_NOTIFS = process.env.TG_CYCLE_NOTIFS === "1"; // notif siklus screening/management ke Telegram — default MATI (hanya deploy/close + balasan user)
import "./envcrypt.js";
import cron from "node-cron";
import readline from "readline";
import path from "path";
import { fileURLToPath } from "url";
import { agentLoop } from "./agent.js";
import { log } from "./logger.js";
import { getMyPositions, closePosition, getActiveBin } from "./tools/dlmm.js";
import { getWalletBalances } from "./tools/wallet.js";
import { getTopCandidates } from "./tools/screening.js";
import { prescreenPools } from "./pool-scorer.js";
import { config, reloadScreeningThresholds, computeDeployAmount } from "./config.js";
import { evolveThresholds, getPerformanceSummary } from "./lessons.js";
import { executeTool, registerCronRestarter } from "./tools/executor.js";
import {
  startPolling,
  stopPolling,
  sendMessage,
  sendMessageWithButtons,
  sendHTML,
  editMessage,
  editMessageWithButtons,
  answerCallbackQuery,
  notifyOutOfRange,
  isEnabled as telegramEnabled,
  createLiveMessage,
} from "./telegram.js";
import { generateBriefing } from "./briefing.js";
import { getLastBriefingDate, setLastBriefingDate, getTrackedPosition, getTrackedPositions, setPositionInstruction, updatePnlAndCheckExits, queuePeakConfirmation, resolvePendingPeak, queueTrailingDropConfirmation, resolvePendingTrailingDrop } from "./state.js";
import { getActiveStrategy } from "./strategy-library.js";
import { recordPositionSnapshot, recallForPool, addPoolNote } from "./pool-memory.js";
import { checkSmartWalletsOnPool } from "./smart-wallets.js";
import { getTokenNarrative, getTokenInfo } from "./tools/token.js";
import { stageSignals } from "./signal-tracker.js";
import { getWeightsSummary } from "./signal-weights.js";
import { bootstrapHiveMind, ensureAgentId, getHiveMindPullMode, isHiveMindEnabled, pullHiveMindLessons, pullHiveMindPresets, registerHiveMindAgent, startHiveMindBackgroundSync } from "./hivemind.js";
import { appendDecision } from "./decision-log.js";
import { startDashboard, stopDashboard } from "./dashboard.js";

const entrypointPath = process.env.pm_exec_path || process.argv[1];
const isMain = entrypointPath
  ? path.resolve(entrypointPath) === fileURLToPath(import.meta.url)
  : false;

// --- Process role flags (dashboard split) ---
// DASHBOARD_ONLY=1  -> this process runs ONLY the dashboard HTTP server (no trading loops).
// AGENT_NO_DASHBOARD=1 -> this (agent) process must NOT host the dashboard.
const DASHBOARD_ONLY = process.env.DASHBOARD_ONLY === "1" || process.env.DASHBOARD_ONLY === "true";
const AGENT_NO_DASHBOARD = process.env.AGENT_NO_DASHBOARD === "1" || process.env.AGENT_NO_DASHBOARD === "true";

// Daily stop-loss guard: blocks new deploys if too many losses today
let _dailyStopCount = 0;
let _dailyStopDate = "";

if (isMain) {
  log("startup", "DLMM LP Agent starting...");
  log("startup", `PID: ${process.pid}  |  Port: ${process.env.DASHBOARD_PORT || "3000"}  |  Uptime: ${new Date().toISOString()}`);
  log("startup", `Mode: ${process.env.DRY_RUN === "true" ? "DRY RUN" : "LIVE"}`);
  log("startup", `Model: ${process.env.LLM_MODEL || "hermes-3-405b"}`);
  try {
    ensureAgentId();
  } catch (e) {
    log("startup_error", `ensureAgentId failed: ${e.message}`);
  }
  bootstrapHiveMind().catch((error) => log("hivemind_warn", `Bootstrap failed: ${error.message}`));
  try {
    startHiveMindBackgroundSync();
  } catch (e) {
    log("hivemind_warn", `startHiveMindBackgroundSync threw: ${e.message}`);
  }
  if (DASHBOARD_ONLY || !AGENT_NO_DASHBOARD) {
    try {
      startDashboard();
    } catch (e) {
      log("dashboard_error", `startDashboard threw: ${e.message}`);
    }
  }
}

// ─── Top-level safety net: log + exit gracefully on unhandled errors ───
process.on("uncaughtException", (err) => {
  try { log("uncaught", `[FATAL] ${err.message}\n${err.stack || ""}`); } catch {}
  setTimeout(() => process.exit(1), 1000).unref?.();
});

process.on("unhandledRejection", (reason) => {
  const msg = reason instanceof Error ? `${reason.message}\n${reason.stack || ""}` : String(reason);
  try { log("unhandled_rejection", `[WARN] ${msg}`); } catch {}
});

const TP_PCT = config.management.takeProfitPct;
const DEPLOY = config.management.deployAmountSol;

// ═══════════════════════════════════════════
//  CYCLE TIMERS
// ═══════════════════════════════════════════
const timers = {
  managementLastRun: null,
  screeningLastRun: null,
};

function nextRunIn(lastRun, intervalMin) {
  if (!lastRun) return intervalMin * 60;
  const elapsed = (Date.now() - lastRun) / 1000;
  return Math.max(0, intervalMin * 60 - elapsed);
}

function formatCountdown(seconds) {
  if (seconds <= 0) return "now";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function buildPrompt() {
  const mgmt = formatCountdown(nextRunIn(timers.managementLastRun, config.schedule.managementIntervalMin));
  const scrn = formatCountdown(nextRunIn(timers.screeningLastRun, config.schedule.screeningIntervalMin));
  return `[manage: ${mgmt} | screen: ${scrn}]\n> `;
}

// ═══════════════════════════════════════════
//  CRON DEFINITIONS
// ═══════════════════════════════════════════
let _cronTasks = [];
let _managementBusy = false; // prevents overlapping management cycles
let _screeningBusy = false;  // prevents overlapping screening cycles
let _screeningLastTriggered = 0; // epoch ms — prevents management from spamming screening
let _pollTriggeredAt = 0;
/* __CHASEUP__ chase-up OOR-atas */
import { recordChase, chaseCountInWindow } from "./pool-memory.js";
import { notifyChase, notifyChaseResult } from "./telegram.js"; /* __CHASERESULT__ */
const _chaseOorUpSince = new Map();
const _chaseDispatched = new Set(); // epoch ms — cooldown for poller-triggered management
const _peakConfirmTimers = new Map();
const _trailingDropConfirmTimers = new Map();
const TRAILING_PEAK_CONFIRM_DELAY_MS = 15_000;
const TRAILING_PEAK_CONFIRM_TOLERANCE = 0.85;
const TRAILING_DROP_CONFIRM_DELAY_MS = 15_000;
const TRAILING_DROP_CONFIRM_TOLERANCE_PCT = 1.0;

const FAST_OOR_MINUTES = 10;
const FAST_OOR_FEE_TVL_MAX = 0.10;
const FAST_OOR_ORGANIC_MAX = 75;

function getEffectiveOorTimeout(trackedPosition) {
  if (!trackedPosition) return config.management.outOfRangeWaitMinutes;
  const feeTvl = Number(trackedPosition.fee_tvl_ratio ?? trackedPosition.initial_fee_tvl_24h ?? 0);
  const organic = Number(trackedPosition.organic_score ?? 0);
  if (feeTvl < FAST_OOR_FEE_TVL_MAX || organic < FAST_OOR_ORGANIC_MAX) {
    return FAST_OOR_MINUTES;
  }
  return config.management.outOfRangeWaitMinutes;
}

/** Strip <think>...</think> reasoning blocks that some models leak into output */
function stripThink(text) {
  if (!text) return text;
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

function sanitizeUntrustedPromptText(text, maxLen = 500) {
  if (!text) return null;
  const cleaned = String(text)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[<>`]/g, "")
    .trim()
    .slice(0, maxLen);
  return cleaned ? JSON.stringify(cleaned) : null;
}

function shouldUsePnlRecheck() {
  return !config.api.lpAgentRelayEnabled;
}

function schedulePeakConfirmation(positionAddress) {
  if (!positionAddress || _peakConfirmTimers.has(positionAddress)) return;

  const timer = setTimeout(async () => {
    _peakConfirmTimers.delete(positionAddress);
    try {
      const result = await getMyPositions({ force: true, silent: true }).catch(() => null);
      const position = result?.positions?.find((p) => p.position === positionAddress);
      resolvePendingPeak(positionAddress, position?.pnl_pct ?? null, TRAILING_PEAK_CONFIRM_TOLERANCE);
    } catch (error) {
      log("state_warn", `Peak confirmation failed for ${positionAddress}: ${error.message}`);
    }
  }, TRAILING_PEAK_CONFIRM_DELAY_MS);

  _peakConfirmTimers.set(positionAddress, timer);
}

function scheduleTrailingDropConfirmation(positionAddress) {
  if (!positionAddress || _trailingDropConfirmTimers.has(positionAddress)) return;

  const timer = setTimeout(async () => {
    _trailingDropConfirmTimers.delete(positionAddress);
    try {
      const result = await getMyPositions({ force: true, silent: true }).catch(() => null);
      const position = result?.positions?.find((p) => p.position === positionAddress);
      const resolved = resolvePendingTrailingDrop(
        positionAddress,
        position?.pnl_pct ?? null,
        config.management.trailingDropPct,
        TRAILING_DROP_CONFIRM_TOLERANCE_PCT,
      );
      if (resolved?.confirmed) {
        log("state", `[Trailing recheck] Confirmed trailing exit for ${positionAddress} — triggering management`);
        runManagementCycle({ silent: true }).catch((e) => log("cron_error", `Trailing recheck management failed: ${e.message}`));
      }
    } catch (error) {
      log("state_warn", `Trailing drop confirmation failed for ${positionAddress}: ${error.message}`);
    }
  }, TRAILING_DROP_CONFIRM_DELAY_MS);

  _trailingDropConfirmTimers.set(positionAddress, timer);
}

async function runBriefing() {
  log("cron", "Starting morning briefing");
  try {
    const briefing = await generateBriefing();
    if (telegramEnabled()) {
      await sendHTML(briefing);
    }
    setLastBriefingDate();
  } catch (error) {
    log("cron_error", `Morning briefing failed: ${error.message}`);
  }
}

/**
 * If the agent restarted after the 1:00 AM UTC cron window,
 * fire the briefing immediately on startup so it's never skipped.
 */
async function maybeRunMissedBriefing() {
  const todayUtc = new Date().toISOString().slice(0, 10);
  const lastSent = getLastBriefingDate();

  if (lastSent === todayUtc) return; // already sent today

  // Only fire if it's past the scheduled time (1:00 AM UTC)
  const nowUtc = new Date();
  const briefingHourUtc = 1;
  if (nowUtc.getUTCHours() < briefingHourUtc) return; // too early, cron will handle it

  log("cron", `Missed briefing detected (last sent: ${lastSent || "never"}) — sending now`);
  await runBriefing();
}

function stopCronJobs() {
  for (const task of _cronTasks) task.stop();
  if (_cronTasks._pnlPollInterval) clearInterval(_cronTasks._pnlPollInterval);
  _cronTasks = [];
}

export async function runManagementCycle({ silent = false } = {}) {
  if (_managementBusy) return null;
  _managementBusy = true;
  timers.managementLastRun = Date.now();
  log("cron", "Starting management cycle");
  let mgmtReport = null;
  let positions = [];
  let liveMessage = null;
  const screeningCooldownMs = 5 * 60 * 1000;

  try {
    if (TG_CYCLE_NOTIFS && !silent && telegramEnabled()) {
      liveMessage = await createLiveMessage("🔄 <b>NGECEK POSISI, BOS</b>", "Lagi dievaluasi posisine...");
    }
    const livePositions = await getMyPositions({ force: true }).catch(() => null);
    positions = livePositions?.positions || [];

    if (positions.length === 0) {
      log("cron", "No open positions — triggering screening cycle");
      mgmtReport = "No open positions. Triggering screening cycle.";
      runScreeningCycle().catch((e) => log("cron_error", `Triggered screening failed: ${e.message}`));
      return mgmtReport;
    }

    // Snapshot + load pool memory
    const positionData = positions.map((p) => {
      recordPositionSnapshot(p.pool, p);
      return { ...p, recall: recallForPool(p.pool) };
    });

    // JS trailing TP check
    const exitMap = new Map();
    for (const p of positionData) {
      if (
        !p.pnl_pct_suspicious &&
        queuePeakConfirmation(p.position, p.pnl_pct, { immediate: !shouldUsePnlRecheck() }) &&
        shouldUsePnlRecheck()
      ) {
        schedulePeakConfirmation(p.position);
      }
      const exit = updatePnlAndCheckExits(p.position, p, config.management);
      if (exit) {
        if (exit.action === "TRAILING_TP" && exit.needs_confirmation && shouldUsePnlRecheck()) {
          if (queueTrailingDropConfirmation(p.position, exit.peak_pnl_pct, exit.current_pnl_pct, config.management.trailingDropPct)) {
            scheduleTrailingDropConfirmation(p.position);
          }
          continue;
        }
        exitMap.set(p.position, exit.reason);
        log("state", `Exit alert for ${p.pair}: ${exit.reason}`);
      }
    }

    // ── Deterministic rule checks (no LLM) ──────────────────────────
    // action: CLOSE | CLAIM | STAY | INSTRUCTION (needs LLM)
    const actionMap = new Map();
    for (const p of positionData) {
      // Hard exit — highest priority
      if (exitMap.has(p.position)) {
        actionMap.set(p.position, { action: "CLOSE", rule: "exit", reason: exitMap.get(p.position) });
        continue;
      }
      // Instruction-set — pass to LLM, can't parse in JS
      if (p.instruction) {
        actionMap.set(p.position, { action: "INSTRUCTION" });
        continue;
      }

      const closeRule = getDeterministicCloseRule(p, config.management);
      if (closeRule) {
        actionMap.set(p.position, closeRule);
        continue;
      }
      // Claim rule
      if ((p.unclaimed_fees_usd ?? 0) >= config.management.minClaimAmount) {
        actionMap.set(p.position, { action: "CLAIM" });
        if (config.management.autoSwapAfterClaim) {
          log("cron", `Auto-compound: ${p.pair} has $${(p.unclaimed_fees_usd ?? 0).toFixed(2)} unclaimed — will claim + swap to SOL for redeploy`);
        }
        continue;
      }
      actionMap.set(p.position, { action: "STAY" });
    }

    // Track daily stop-loss count for drawdown guard
    const today = new Date().toISOString().slice(0, 10);
    if (_dailyStopDate !== today) { _dailyStopCount = 0; _dailyStopDate = today; }
    for (const [addr, act] of actionMap) {
      if (act.action === "CLOSE" && (act.rule === 1 || act.rule === "exit")) {
        const p = positionData.find(x => x.position === addr);
        if (p && (p.pnl_pct ?? 0) < 0) _dailyStopCount++;
      }
    }

    // ── Build JS report ──────────────────────────────────────────────
    const totalValue = positionData.reduce((s, p) => s + (p.total_value_usd ?? 0), 0);
    const totalUnclaimed = positionData.reduce((s, p) => s + (p.unclaimed_fees_usd ?? 0), 0);

    const reportLines = positionData.map((p) => {
      const act = actionMap.get(p.position);
      const inRange = p.in_range ? "🟢 IN" : `🔴 OOR ${p.minutes_out_of_range ?? 0}m`;
      const val = config.management.solMode ? `◎${p.total_value_usd ?? "?"}` : `$${p.total_value_usd ?? "?"}`;
      const unclaimed = config.management.solMode ? `◎${p.unclaimed_fees_usd ?? "?"}` : `$${p.unclaimed_fees_usd ?? "?"}`;
      const statusLabel = act.action === "INSTRUCTION" ? "HOLD (instruction)" : act.action;
      let line = `**${p.pair}** | Age: ${p.age_minutes ?? "?"}m | Val: ${val} | Unclaimed: ${unclaimed} | PnL: ${p.pnl_pct ?? "?"}% | Yield: ${p.fee_per_tvl_24h ?? "?"}% | ${inRange} | ${statusLabel}`;
      if (p.instruction) line += `\nNote: "${p.instruction}"`;
      if (act.action === "CLOSE" && act.rule === "exit") line += `\n⚡ Trailing TP: ${act.reason}`;
      if (act.action === "CLOSE" && act.rule && act.rule !== "exit") line += `\nRule ${act.rule}: ${act.reason}`;
      if (act.action === "CLAIM") line += `\n→ Claiming fees`;
      return line;
    });

    const needsAction = [...actionMap.values()].filter(a => a.action !== "STAY");
    const actionSummary = needsAction.length > 0
      ? needsAction.map(a => a.action === "INSTRUCTION" ? "EVAL instruction" : `${a.action}${a.reason ? ` (${a.reason})` : ""}`).join(", ")
      : "no action";

    const cur = config.management.solMode ? "◎" : "$";
    mgmtReport = reportLines.join("\n\n") +
      `\n\n💼 <b>Ringkesan, Bos:</b> ${positions.length} posisi | ${cur}${totalValue.toFixed(4)} | fee: ${cur}${totalUnclaimed.toFixed(4)} | ${actionSummary}`;

    // ── Call LLM only if action needed ──────────────────────────────
    const actionPositions = positionData.filter(p => {
      const a = actionMap.get(p.position);
      return a.action !== "STAY";
    });

    if (actionPositions.length > 0) {
      log("cron", `Management: ${actionPositions.length} action(s) needed — invoking LLM [model: ${config.llm.managementModel}]`);

      const actionBlocks = actionPositions.map((p) => {
        const act = actionMap.get(p.position);
        return [
          `POSITION: ${p.pair} (${p.position})`,
          `  pool: ${p.pool}`,
          `  action: ${act.action}${act.rule && act.rule !== "exit" ? ` — Rule ${act.rule}: ${act.reason}` : ""}${act.rule === "exit" ? ` — ⚡ Trailing TP: ${act.reason}` : ""}`,
          `  pnl_pct: ${p.pnl_pct}% | unclaimed_fees: ${cur}${p.unclaimed_fees_usd} | value: ${cur}${p.total_value_usd} | fee_per_tvl_24h: ${p.fee_per_tvl_24h ?? "?"}%`,
          `  bins: lower=${p.lower_bin} upper=${p.upper_bin} active=${p.active_bin} | oor_minutes: ${p.minutes_out_of_range ?? 0}`,
          p.instruction ? `  instruction: "${p.instruction}"` : null,
        ].filter(Boolean).join("\n");
      }).join("\n\n");

      const { content } = await agentLoop(`
MANAGEMENT ACTION REQUIRED — ${actionPositions.length} position(s)

${actionBlocks}

RULES:
- CLOSE: call close_position only — it handles fee claiming internally, do NOT call claim_fees first
- CLAIM: call claim_fees with position address
- INSTRUCTION: evaluate the instruction condition. If met → close_position. If not → HOLD, do nothing.
- ⚡ exit alerts: close immediately, no exceptions

Execute the required actions. Do NOT re-evaluate CLOSE/CLAIM — rules already applied. Just execute.
After executing, write a brief one-line result per position.
      `, config.llm.maxSteps, [], "MANAGER", config.llm.managementModel, 2048, {
        onToolStart: async ({ name }) => { await liveMessage?.toolStart(name); },
        onToolFinish: async ({ name, result, success }) => { await liveMessage?.toolFinish(name, result, success); },
      });

      mgmtReport += `\n\n${content}`;
    } else {
      log("cron", "Management: all positions STAY — skipping LLM");
      await liveMessage?.note("No tool actions needed.");
    }

    // Trigger screening after management
    const afterPositions = await getMyPositions({ force: true }).catch(() => null);
    const afterCount = afterPositions?.positions?.length ?? 0;
    if (afterCount < config.risk.maxPositions && Date.now() - _screeningLastTriggered > screeningCooldownMs) {
      log("cron", `Post-management: ${afterCount}/${config.risk.maxPositions} positions — triggering screening`);
      runScreeningCycle().catch((e) => log("cron_error", `Triggered screening failed: ${e.message}`));
    }
  } catch (error) {
    log("cron_error", `Management cycle failed: ${error.message}`);
    mgmtReport = `Management cycle failed: ${error.message}`;
  } finally {
    _managementBusy = false;
    drainTelegramQueue().catch(() => {});
    if (TG_CYCLE_NOTIFS && !silent && telegramEnabled()) {
      if (mgmtReport) {
        if (liveMessage) await liveMessage.finalize(stripThink(mgmtReport)).catch(() => {});
        else sendMessage(`🔄 <b>LAPORAN POSISI, BOS</b>\n\n${stripThink(mgmtReport)}`).catch(() => { });
      }
      for (const p of positions) {
        const trackedPos = getTrackedPosition(p.position);
        const oorTimeout = getEffectiveOorTimeout(trackedPos);
        if (!p.in_range && p.minutes_out_of_range >= oorTimeout) {
          notifyOutOfRange({ pair: p.pair, minutesOOR: p.minutes_out_of_range }).catch(() => { });
        }
      }
    }
  }
  return mgmtReport;
}

export async function runScreeningCycle({ silent = false } = {}) {
  const screeningStartedAt = Date.now();
  // Stale-busy guard: if a previous cycle has been "busy" far longer than two intervals,
  // assume it died/hung and clear the lock so screening can resume. Otherwise skip.
  const intervalMin = config.schedule?.screeningIntervalMin || 10;
  const staleBusyMs = Math.max(20 * 60_000, intervalMin * 2 * 60_000);
  if (_screeningBusy) {
    const busyForMs = screeningStartedAt - (_screeningLastTriggered || 0);
    if (_screeningLastTriggered && busyForMs > staleBusyMs) {
      log("cron_error", `Screening busy lock stale (${busyForMs}ms > ${staleBusyMs}ms) — clearing and proceeding`);
    } else {
      log("cron", `Screening skipped — previous cycle still running (${busyForMs}ms)`);
      return null;
    }
  }
  _screeningBusy = true; // set immediately — prevents TOCTOU race with concurrent callers
  _screeningLastTriggered = screeningStartedAt;

  // Function-scope diagnostics (assigned in body/finally for structured summary logging)
  let prescreenedCount = 0;
  let passingCount = 0;
  let deployAttempted = false;
  let deploySucceeded = false;
  let screeningOutcome = "started";

  // Daily drawdown guard: block new deploys if too many stops today
  const maxDailyStops = config.risk?.dailyMaxStopLosses ?? 3;
  const today = new Date().toISOString().slice(0, 10);
  if (_dailyStopDate !== today) { _dailyStopCount = 0; _dailyStopDate = today; }
  if (_dailyStopCount >= maxDailyStops) {
    log("cron", `Screening skipped — daily stop-loss limit reached (${_dailyStopCount}/${maxDailyStops})`);
    _screeningBusy = false;
    drainTelegramQueue().catch(() => {});
    return `Daily stop-loss limit reached (${_dailyStopCount}). No new deploys until tomorrow.`;
  }

  // Hard guards — don't even run the agent if preconditions aren't met
  let prePositions, preBalance;
  let liveMessage = null;
  let screenReport = null;
  try {
    [prePositions, preBalance] = await Promise.all([getMyPositions({ force: true }), getWalletBalances()]);
    if (prePositions.total_positions >= config.risk.maxPositions) {
      log("cron", `Screening skipped — max positions reached (${prePositions.total_positions}/${config.risk.maxPositions})`);
      screenReport = `Screening skipped — max positions reached (${prePositions.total_positions}/${config.risk.maxPositions}).`;
      appendDecision({
        type: "skip",
        actor: "SCREENER",
        summary: "Screening skipped",
        reason: `Max positions reached (${prePositions.total_positions}/${config.risk.maxPositions})`,
      });
      _screeningBusy = false;
      drainTelegramQueue().catch(() => {});
      return screenReport;
    }
    const minRequired = config.management.deployAmountSol + config.management.gasReserve;
    const isDryRun = process.env.DRY_RUN === "true";
    if (!isDryRun && preBalance.sol < minRequired) {
      log("cron", `Screening skipped — insufficient SOL (${preBalance.sol.toFixed(3)} < ${minRequired} needed for deploy + gas)`);
      screenReport = `Screening skipped — insufficient SOL (${preBalance.sol.toFixed(3)} < ${minRequired} needed for deploy + gas).`;
      appendDecision({
        type: "skip",
        actor: "SCREENER",
        summary: "Screening skipped",
        reason: `Insufficient SOL (${preBalance.sol.toFixed(3)} < ${minRequired})`,
      });
      _screeningBusy = false;
      drainTelegramQueue().catch(() => {});
      return screenReport;
    }
  } catch (e) {
    log("cron_error", `Screening pre-check failed: ${e.message}`);
    screenReport = `Screening pre-check failed: ${e.message}`;
    _screeningBusy = false;
    drainTelegramQueue().catch(() => {});
    return screenReport;
  }
  if (TG_CYCLE_NOTIFS && !silent && telegramEnabled()) {
    liveMessage = await createLiveMessage("🔍 <b>NYARI POOL, BOS</b>", "Lagi dipindai kandidate...");
  }
  timers.screeningLastRun = Date.now();
  log("cron", `Starting screening cycle [model: ${config.llm.screeningModel}]`);
  try {
    // Reuse pre-fetched balance — no extra RPC call needed
    const currentBalance = preBalance;
    const deployAmount = computeDeployAmount(currentBalance.sol);
    log("cron", `Computed deploy amount: ${deployAmount} SOL (wallet: ${currentBalance.sol} SOL)`);

    // Load active strategy
    const activeStrategy = getActiveStrategy();
    const strategyBlock = activeStrategy
      ? `ACTIVE STRATEGY: ${activeStrategy.name} — LP: ${activeStrategy.lp_strategy} | bins_above: ${activeStrategy.range?.bins_above ?? 0} (FIXED — never change) | deposit: ${activeStrategy.entry?.single_side === "sol" ? "SOL only (amount_y, amount_x=0)" : "dual-sided"} | best for: ${activeStrategy.best_for}${activeStrategy.lp_strategy === "hybrid" ? `\nSTRATEGY SELECTION RULES (hybrid — pick spot or bid_ask per candidate): ${activeStrategy.entry?.notes ?? ""}` : ""}` /* __HYBRIDSTRAT__ */
      : `No active strategy — use default bid_ask, bins_above: 0, SOL only.`;

    // Phase 1: Deterministic pre-screening — score, enrich memory/wallets in parallel, return top 5
    const prescreenResult = await prescreenPools({ limit: 5 }).catch((e) => {
      log("screening_error", `Prescreen failed: ${e.message}`);
      return { candidates: [], rejected: [], totalScreened: 0, ms: 0 };
    });
    const prescreened = prescreenResult.candidates || [];
    prescreenedCount = prescreened.length;
    const rejectedArr = Array.isArray(prescreenResult.rejected) ? prescreenResult.rejected : [];
    const earlyFilteredExamples = rejectedArr.slice(0, 5)
      .map((r) => ({ name: r.name, reason: r.reason }));
    log("screening", `Prescreen: ${prescreenResult.totalScreened} screened → ${prescreened.length} qualified (${prescreenResult.ms}ms)`);

    if (prescreened.length === 0) {
      screeningOutcome = "no_candidates_after_prescreen";
      const rejExamples = earlyFilteredExamples.slice(0, 3)
        .map((e) => `- ${e.name}: ${e.reason}`)
        .join("\n");
      screenReport = rejExamples
        ? `No candidates available after prescreen.\nFiltered:\n${rejExamples}`
        : `No candidates available (all filtered by deterministic pre-screening).`;
      appendDecision({
        type: "no_deploy",
        actor: "SCREENER",
        summary: "No candidates after prescreen",
        reason: rejExamples || "All candidates rejected by deterministic scoring",
        rejected: earlyFilteredExamples.map((e) => `${e.name}: ${e.reason}`),
      });
      return screenReport;
    }

    // Phase 2: Fetch narrative + token info for ALL prescreened candidates in parallel
    const allCandidates = await Promise.all(prescreened.map(async (c) => {
      const mint = c.base?.mint;
      const [narrative, tokenInfo] = await Promise.allSettled([
        mint ? getTokenNarrative({ mint }) : Promise.resolve(null),
        mint ? getTokenInfo({ query: mint }) : Promise.resolve(null),
      ]);
      return {
        pool: c,
        sw: c._sw || null,
        n: narrative.status === "fulfilled" ? narrative.value : null,
        ti: tokenInfo.status === "fulfilled" ? tokenInfo.value?.results?.[0] : null,
        mem: c._memRecall || null,
        _score: c._finalScore,
        _rawScore: c._rawScore,
        _memAdjust: c._memAdjust,
        _walletBonus: c._walletBonus,
        _memSummary: c._memSummary,
        _walletSummary: c._walletSummary,
      };
    }));

    // Hard filters after token recon — block launchpads and excessive Jupiter bot holders
    const filteredOut = [];
    const passing = allCandidates.filter(({ pool, ti }) => {
      const launchpad = ti?.launchpad ?? null;
      if (launchpad && config.screening.allowedLaunchpads?.length > 0 && !config.screening.allowedLaunchpads.includes(launchpad)) {
        log("screening", `Skipping ${pool.name} — launchpad ${launchpad} not in allow-list`);
        filteredOut.push({ name: pool.name, reason: `launchpad ${launchpad} not in allow-list` });
        return false;
      }
      if (launchpad && config.screening.blockedLaunchpads.includes(launchpad)) {
        log("screening", `Skipping ${pool.name} — blocked launchpad (${launchpad})`);
        filteredOut.push({ name: pool.name, reason: `blocked launchpad (${launchpad})` });
        return false;
      }
      const botPct = ti?.audit?.bot_holders_pct;
      const maxBotHoldersPct = config.screening.maxBotHoldersPct;
      if (botPct != null && maxBotHoldersPct != null && botPct > maxBotHoldersPct) {
        log("screening", `Bot-holder filter: dropped ${pool.name} — bots ${botPct}% > ${maxBotHoldersPct}%`);
        filteredOut.push({ name: pool.name, reason: `bot holders ${botPct}% > ${maxBotHoldersPct}%` });
        return false;
      }
      return true;
    });

    passingCount = passing.length;
    if (passing.length === 0) {
      screeningOutcome = "no_candidates_after_filters";
      const combined = filteredOut.length > 0 ? filteredOut : earlyFilteredExamples;
      const combinedExamples = combined.slice(0, 3)
        .map((entry) => `- ${entry.name}: ${entry.reason}`)
        .join("\n");
      screenReport = combinedExamples
        ? `No candidates available.\nFiltered examples:\n${combinedExamples}`
        : `No candidates available (all filtered by launchpad / holder-quality rules).`;
      appendDecision({
        type: "no_deploy",
        actor: "SCREENER",
        summary: "No candidates available",
        reason: combinedExamples || "All candidates filtered before deploy",
        rejected: combined.slice(0, 5).map((entry) => `${entry.name}: ${entry.reason}`),
      });
      return screenReport;
    }

    if (passing.length === 1) {
      const skipReason = getLoneCandidateSkipReason(passing[0]);
      if (skipReason) {
        const candidateName = passing[0].pool?.name || "unknown";
        screenReport = [
          "⛔ NO DEPLOY",
          "",
          "Cycle finished with no valid entry.",
          "",
          "BEST LOOKING CANDIDATE",
          candidateName,
          "",
          "WHY SKIPPED",
          `Only one candidate survived filtering, but it was not worth deploying: ${skipReason}.`,
          "",
          "REJECTED",
          `- ${candidateName}: ${skipReason}`,
        ].join("\n");
        appendDecision({
          type: "no_deploy",
          actor: "SCREENER",
          summary: "Single candidate skipped",
          reason: skipReason,
          pool: passing[0].pool?.pool,
          pool_name: candidateName,
        });
        return screenReport;
      }
    }

    // Pre-fetch active_bin for all passing candidates in parallel
    const activeBinResults = await Promise.allSettled(
      passing.map(({ pool }) => getActiveBin({ pool_address: pool.pool }))
    );

    // Build compact candidate blocks — enriched with prescreen scores
    const candidateBlocks = passing.map(({ pool, sw, n, ti, mem, _score, _rawScore, _memAdjust, _walletBonus, _memSummary, _walletSummary }, i) => {
      const botPct = ti?.audit?.bot_holders_pct ?? "?";
      const top10Pct = ti?.audit?.top_holders_pct ?? "?";
      const feesSol = ti?.global_fees_sol ?? "?";
      const launchpad = ti?.launchpad ?? null;
      const priceChange = ti?.stats_1h?.price_change;
      const netBuyers = ti?.stats_1h?.net_buyers;
      const activeBin = activeBinResults[i]?.status === "fulfilled" ? activeBinResults[i].value?.binId : null;

      // OKX signals
      const okxParts = [
        pool.risk_level     != null ? `risk=${pool.risk_level}`               : null,
        pool.bundle_pct     != null ? `bundle=${pool.bundle_pct}%`            : null,
        pool.sniper_pct     != null ? `sniper=${pool.sniper_pct}%`            : null,
        pool.suspicious_pct != null ? `suspicious=${pool.suspicious_pct}%`    : null,
        pool.new_wallet_pct != null ? `new_wallets=${pool.new_wallet_pct}%`   : null,
        pool.is_rugpull != null ? `rugpull=${pool.is_rugpull ? "YES" : "NO"}` : null,
        pool.is_wash != null ? `wash=${pool.is_wash ? "YES" : "NO"}` : null,
      ].filter(Boolean).join(", ");
      const okxUnavailable = !okxParts && pool.price_vs_ath_pct == null;

      const okxTags = [
        pool.smart_money_buy    ? "smart_money_buy"    : null,
        pool.kol_in_clusters    ? "kol_in_clusters"    : null,
        pool.dex_boost          ? "dex_boost"          : null,
        pool.dex_screener_paid  ? "dex_screener_paid"  : null,
        pool.dev_sold_all       ? "dev_sold_all(bullish)" : null,
      ].filter(Boolean).join(", ");
      const pvpLine = pool.is_pvp
        ? `  pvp: HIGH — rival ${pool.pvp_rival_name || pool.pvp_symbol} (${pool.pvp_rival_mint?.slice(0, 8)}...) has pool ${pool.pvp_rival_pool?.slice(0, 8)}..., tvl=$${pool.pvp_rival_tvl}, holders=${pool.pvp_rival_holders}, fees=${pool.pvp_rival_fees}SOL`
        : null;

      // Prescreen score breakdown
      const scoreLine = `  prescreen: score=${_score?.toFixed(1) ?? "?"} (raw=${_rawScore?.toFixed(1) ?? "?"}, mem=${_memAdjust >= 0 ? "+" : ""}${_memAdjust ?? 0}, wallet=+${_walletBonus ?? 0})`;

      const block = [
        `POOL: ${pool.name} (${pool.pool})`,
        scoreLine,
        `  metrics: bin_step=${pool.bin_step}, fee_pct=${pool.fee_pct}%, fee_tvl=${pool.fee_active_tvl_ratio}, vol=$${pool.volume_window}, tvl=$${pool.tvl ?? pool.active_tvl}, volatility_${pool.volatility_timeframe || "30m"}=${pool.volatility}, mcap=$${pool.mcap}, organic=${pool.organic_score}${pool.token_age_hours != null ? `, age=${pool.token_age_hours}h` : ""}`,
        `  audit: top10=${top10Pct}%, bots=${botPct}%, fees=${feesSol}SOL${launchpad ? `, launchpad=${launchpad}` : ""}`,
        pvpLine,
        okxParts ? `  okx: ${okxParts}` : okxUnavailable ? `  okx: unavailable` : null,
        okxTags  ? `  tags: ${okxTags}` : null,
        pool.price_vs_ath_pct != null ? `  ath: price_vs_ath=${pool.price_vs_ath_pct}%${pool.top_cluster_trend ? `, top_cluster=${pool.top_cluster_trend}` : ""}` : null,
        `  smart_wallets: ${sw?.in_pool?.length ?? 0} present${sw?.in_pool?.length ? ` → CONFIDENCE BOOST (${sw.in_pool.map(w => w.name).join(", ")})` : ""}`,
        activeBin != null ? `  active_bin: ${activeBin}` : null,
        priceChange != null ? `  1h: price${priceChange >= 0 ? "+" : ""}${priceChange}%, net_buyers=${netBuyers ?? "?"}` : null,
        pool.price_vs_ath_pct != null ? `  ath_distance: ${Math.abs(pool.price_vs_ath_pct)}% from ATH${pool._athCapped ? " [SOFT-CAPPED]" : ""}` : null,
        n?.narrative ? `  narrative_untrusted: ${sanitizeUntrustedPromptText(n.narrative, 500)}` : `  narrative_untrusted: none`,
        mem ? `  memory_untrusted: ${sanitizeUntrustedPromptText(mem, 500)}` : null,
      ].filter(Boolean).join("\n");

      // Stage signals for Darwinian weighting — captured before LLM decides
      if (config.darwin?.enabled) {
        const baseMint = pool.base?.mint || pool.base_mint || ti?.mint || null;
        stageSignals(pool.pool, {
          base_mint:             baseMint,
          organic_score:         pool.organic_score         ?? null,
          fee_tvl_ratio:         pool.fee_active_tvl_ratio  ?? null,
          volume:                pool.volume_window         ?? null,
          mcap:                  pool.mcap                  ?? null,
          holder_count:          ti?.holders                ?? null,
          smart_wallets_present: (sw?.in_pool?.length ?? 0) > 0,
          narrative_quality:     n?.narrative ? "present" : "absent",
          volatility:            pool.volatility            ?? null,
        });
      }

      return block;
    });

    const weightsSummary = config.darwin?.enabled ? getWeightsSummary() : null;

    const { content } = await agentLoop(`
SCREENING CYCLE
${strategyBlock}
Positions: ${prePositions.total_positions}/${config.risk.maxPositions} | SOL: ${currentBalance.sol.toFixed(3)} | Deploy: ${deployAmount} SOL

PRE-SCREENED CANDIDATES (${passing.length} pools, ranked by deterministic score):
${candidateBlocks.join("\n\n")}

REJECTION SUMMARY (${earlyFilteredExamples.length} pools filtered before LLM):
${earlyFilteredExamples.map(e => `- ${e.name}: ${e.reason}`).join("\n")}

STEPS:
1. Candidates are already pre-scored (see prescreen: line). Higher score = stronger metrics + pool memory + smart wallet signals. Use the score as a strong starting signal, but override it if narrative/audit reveals dealbreakers.
2. Decide if any candidate is actually worth deploying. One surviving candidate is not automatically good enough.
3. Pick the best candidate based on prescreen score, narrative quality, smart wallets, and pool metrics.
4. Call deploy_position (active_bin is pre-fetched above — no need to call get_active_bin).
   bins_below = round(${config.strategy.minBinsBelow} + (candidate volatility/5)*(${config.strategy.maxBinsBelow - config.strategy.minBinsBelow}))
      THEN apply adaptive floor:
      - if fee_tvl < 0.15% → +15 bins below (wider downside)
      - if organic < 80 → +10 bins below (wider downside)
      Final: clamp to [60, 120].
   pass deploy_position.volatility = the candidate volatility value.
   For single-side SOL deploys, do not invent upside:
   set amount_y only, keep amount_x = 0, keep bins_above = 0, and let the upper bin stay at the active bin.
5. Report in this exact format (no tables, no extra sections):
   🚀 DEPLOYED

   <pool name>
   <pool address>

    ◎ <deploy amount> SOL | <strategy> | bin <active_bin> | score: <prescreen score>
    Range: <minPrice> → <maxPrice>
    Range cover: <downside %> downside | <upside %> upside | <total width %> total

   IMPORTANT:
   - Do NOT calculate the range percentages yourself.
   - Use the actual deploy_position tool result:
     range_coverage.downside_pct
     range_coverage.upside_pct
     range_coverage.width_pct

   MARKET
   Fee/TVL: <x>%
   Volume: $<x>
   TVL: $<x>
   Volatility: <x>
   Organic: <x>
   Mcap: $<x>
   Age: <x>h

   AUDIT
   Top10: <x>%
   Bots: <x>%
   Fees paid: <x> SOL
   Smart wallets: <names or none>

   RISK
   <If OKX advanced/risk data exists, list only the fields that actually exist: Risk level, Bundle, Sniper, Suspicious, ATH distance, Rugpull, Wash.>
   <If only rugpull/wash exist, list just those.>
   <If OKX enrichment is missing, write exactly: OKX: unavailable>

    WHY THIS WON
    <2-4 concise sentences on why this pool won, key risks, and why it still beat the alternatives>
6. If no pool qualifies, report in this exact format instead:
   ⛔ NO DEPLOY

   Cycle finished with no valid entry.

   BEST LOOKING CANDIDATE
   <name or none>

   WHY SKIPPED
   <2-4 concise sentences explaining why nothing was good enough>

   REJECTED
   <short flat list of top candidate names and why they were skipped>
IMPORTANT:
- Never write "unknown" for OKX. Use real values, omit missing fields, or write exactly "OKX: unavailable".
- Keep the whole report compact and highly scannable for Telegram.
      `, Math.min(config.llm.maxSteps, 10), [], "SCREENER", config.llm.screeningModel, 2048, {
        onToolStart: async ({ name }) => {
          if (name === "deploy_position") deployAttempted = true;
          await liveMessage?.toolStart(name);
        },
        onToolFinish: async ({ name, result, success }) => {
          if (name === "deploy_position") {
            deployAttempted = true;
            deploySucceeded = Boolean(success && result?.success !== false && !result?.error && !result?.blocked);
          }
          await liveMessage?.toolFinish(name, result, success);
        },
      });
    screenReport = content;
    if (/⛔\s*NO DEPLOY/i.test(content)) {
      screeningOutcome = "llm_no_deploy";
      appendDecision({
        type: "no_deploy",
        actor: "SCREENER",
        summary: "LLM chose no deploy",
        reason: stripThink(content).slice(0, 500),
      });
    } else if (!deploySucceeded) {
      screeningOutcome = deployAttempted ? "deploy_attempt_failed" : "no_successful_deploy";
      appendDecision({
        type: "no_deploy",
        actor: "SCREENER",
        summary: deployAttempted ? "Deploy attempt did not succeed" : "No successful deploy in screening cycle",
        reason: stripThink(content).slice(0, 500),
      });
    }
    if (deploySucceeded) screeningOutcome = "deploy_succeeded";
  } catch (error) {
    screeningOutcome = "error";
    log("cron_error", `Screening cycle failed: ${error.message}`);
    screenReport = `Screening cycle failed: ${error.message}`;
  } finally {
    log("screening", `Screening summary — outcome=${screeningOutcome} prescreened=${prescreenedCount} passing=${passingCount} deployAttempted=${deployAttempted} deploySucceeded=${deploySucceeded} durationMs=${Date.now() - screeningStartedAt}`);
    _screeningBusy = false;
    drainTelegramQueue().catch(() => {});
    if (TG_CYCLE_NOTIFS && !silent && telegramEnabled()) {
      if (screenReport) {
        if (liveMessage) await liveMessage.finalize(stripThink(screenReport)).catch(() => {});
        else sendMessage(`🔍 <b>LAPORAN SCREENING, BOS</b>\n\n${stripThink(screenReport)}`).catch(() => { });
      }
    }
  }
  return screenReport;
}

export function startCronJobs() {
  stopCronJobs(); // stop any running tasks before (re)starting

  const mgmtTask = cron.schedule(`*/${Math.max(1, config.schedule.managementIntervalMin)} * * * *`, async () => {
    if (_managementBusy) return;
    timers.managementLastRun = Date.now();
    await runManagementCycle();
  });

  const screenTask = cron.schedule(`*/${Math.max(1, config.schedule.screeningIntervalMin)} * * * *`, runScreeningCycle);

  const healthTask = cron.schedule(`0 * * * *`, async () => {
    log("cron", "Starting health check");
    try {
      const [portfolio, positions] = await Promise.all([
        getWalletBalances().catch(() => null),
        getMyPositions({ force: true, silent: true }).catch(() => ({ positions: [] })),
      ]);
      const posList = positions?.positions || [];
      const totalValue = posList.reduce((s, p) => s + (p.total_value_usd ?? 0), 0);
      const totalUnclaimed = posList.reduce((s, p) => s + (p.unclaimed_fees_usd ?? 0), 0);
      const oorCount = posList.filter(p => {
        const tracked = getTrackedPosition(p.position);
        return !p.in_range && p.minutes_out_of_range >= getEffectiveOorTimeout(tracked);
      }).length;
      const pnlValues = posList.map(p => p.pnl_pct ?? 0);
      const avgPnl = pnlValues.length ? (pnlValues.reduce((s, v) => s + v, 0) / pnlValues.length).toFixed(1) : "N/A";
      const solMode = config.management.solMode;
      const cur = solMode ? "SOL" : "USD";
      const balanceLine = portfolio ? `${portfolio.sol.toFixed(3)} SOL ($${portfolio.sol_usd})` : "unavailable";
      log("health", `Portfolio: ${posList.length} positions | ${cur} ${totalValue.toFixed(2)} | unclaimed fees ${cur} ${totalUnclaimed.toFixed(2)} | avg PnL ${avgPnl}% | OOR: ${oorCount} | wallet: ${balanceLine}`);

      // Auto-reconcile unsettled PnL records (run every hour, minimal overhead)
      try {
        const { reconcileClosedPnl } = await import("./lessons.js");
        const envKey = process.env.WALLET_PRIVATE_KEY || "";
        const addr = envKey ? (await import("./tools/wallet.js")).deriveAddress(envKey) : "";
        if (addr) await reconcileClosedPnl(addr);
      } catch { /* reconciliation is best-effort, never block health check */ }
    } catch (error) {
      log("cron_error", `Health check failed: ${error.message}`);
    }
  });

  // Morning Briefing at 8:00 AM UTC+7 (1:00 AM UTC)
  const briefingTask = cron.schedule(`0 1 * * *`, async () => {
    await runBriefing();
  }, { timezone: 'UTC' });

  // Every 6h — catch up if briefing was missed (agent restart, crash, etc.)
  const briefingWatchdog = cron.schedule(`0 */6 * * *`, async () => {
    await maybeRunMissedBriefing();
  }, { timezone: 'UTC' });

  // Lightweight 60s PnL poller — updates trailing TP state between management cycles, no LLM
  let _pnlPollBusy = false;
  const _directClosing = new Set(); // prevent duplicate close attempts during execution

  // Read from config, default 60s — was 10s, reduced for Helius rate limits
  const pnlPollMs = (config.schedule?.pnlPollIntervalSec || 60) * 1000;

  const pnlPollInterval = setInterval(async () => {
    if (_managementBusy || _screeningBusy || _pnlPollBusy) return;
    if (getTrackedPositions(true).length === 0) return;
    _pnlPollBusy = true;
    try {
      const result = await getMyPositions({ force: true, silent: true }).catch(() => null);
      if (!result?.positions?.length) return;
      for (const p of result.positions) {
        if (
          !p.pnl_pct_suspicious &&
          queuePeakConfirmation(p.position, p.pnl_pct, { immediate: !shouldUsePnlRecheck() }) &&
          shouldUsePnlRecheck()
        ) {
          schedulePeakConfirmation(p.position);
        }
        /* __CHASEUP__ deteksi OOR-ATAS → konfirmasi LLM utk chase */
        try {
          const mgm = config.management;
          if (mgm.chaseOorUpEnabled !== false && p.active_bin != null && p.upper_bin != null && p.active_bin > p.upper_bin) {
            if (!_chaseOorUpSince.has(p.position)) _chaseOorUpSince.set(p.position, Date.now());
            const aboveMin = (Date.now() - _chaseOorUpSince.get(p.position)) / 60000;
            const solPure = (p.token_x_value_usd ?? 0) < 25;
            const chases = chaseCountInWindow(p.pool, mgm.chaseWindowHours ?? 6);
            const chCd = config.schedule.managementIntervalMin * 60 * 1000;
            if (aboveMin >= (mgm.chaseOorUpMinutes ?? 5) && solPure && chases < (mgm.maxChasesPerPool ?? 2) && !_chaseDispatched.has(p.position) && Date.now() - _pollTriggeredAt >= chCd) {
              _pollTriggeredAt = Date.now();
              _chaseDispatched.add(p.position);
              const dispatchedAt = Date.now(); /* __CHASERESULT__ */
              recordChase(p.pool);
              log("state", `[CHASE] ${p.pair} OOR-ATAS ${Math.round(aboveMin)}m, sisa token ~$${(p.token_x_value_usd ?? 0).toFixed?.(2) ?? p.token_x_value_usd}, chase ${chases + 1}/${mgm.maxChasesPerPool ?? 2} — konfirmasi LLM`);
              notifyChase({ pair: p.pair, minutes: Math.round(aboveMin), chaseNum: chases + 1, maxChase: mgm.maxChasesPerPool ?? 2 }).catch(() => {});
              const chasePrompt = `CHASE-UP CHECK: Position ${p.position} (${p.pair}) in pool ${p.pool} has been OUT OF RANGE ABOVE for ${Math.round(aboveMin)} minutes — price pumped above our range. The position is ~100% SOL (no impermanent loss). Chase attempt ${chases + 1}/${mgm.maxChasesPerPool ?? 2}. First evaluate momentum with pool/token data. IF momentum is still healthy: (1) close_position with reason \"chase_up\", then (2) deploy_position on the SAME pool ${p.pool} below the new price — follow the ACTIVE STRATEGY (hybrid + RANGE DEPTH RULES; a strong pump usually means bid_ask), single-side SOL (amount_y per config, amount_x=0, bins_above=0). IF momentum is broken or volume dried up: just close_position with a normal reason. Act now, no questions.`;
              agentLoop(chasePrompt, config.llm.maxSteps, [], "GENERAL")
                .then((r) => {
                  log("state", `[CHASE] selesai: ${String(r?.content || "").slice(0, 160)}`);
                  try { /* __CHASERESULT__ */
                    const redeployed = getTrackedPositions(true).find((t) => t.pool === p.pool && t.deployed_at && Date.parse(t.deployed_at) >= dispatchedAt - 5000);
                    notifyChaseResult({ pair: p.pair, ok: !!redeployed, detail: String(r?.content || "") }).catch(() => {});
                  } catch { /* notif best-effort */ }
                })
                .catch((e) => log("cron_error", `[CHASE] gagal: ${e.message}`))
                .finally(() => _chaseDispatched.delete(p.position));
              break;
            }
          } else { _chaseOorUpSince.delete(p.position); }
        } catch { /* jangan ganggu poller */ }
        const exit = updatePnlAndCheckExits(p.position, p, config.management);
        if (exit) {
          if (exit.action === "TRAILING_TP" && exit.needs_confirmation && shouldUsePnlRecheck()) {
            if (queueTrailingDropConfirmation(p.position, exit.peak_pnl_pct, exit.current_pnl_pct, config.management.trailingDropPct)) {
              scheduleTrailingDropConfirmation(p.position);
            }
            continue;
          }
          const cooldownMs = config.schedule.managementIntervalMin * 60 * 1000;
          const sinceLastTrigger = Date.now() - _pollTriggeredAt;
          if (sinceLastTrigger >= cooldownMs) {
            _pollTriggeredAt = Date.now();
            log("state", `[PnL poll] Exit alert: ${p.pair} — ${exit.reason} — triggering management`);
            runManagementCycle({ silent: true }).catch((e) => log("cron_error", `Poll-triggered management failed: ${e.message}`));
          } else {
            log("state", `[PnL poll] Exit alert: ${p.pair} — ${exit.reason} — cooldown (${Math.round((cooldownMs - sinceLastTrigger) / 1000)}s left)`);
          }
          break;
        }
        const closeRule = getDeterministicCloseRule(p, config.management);
        if (closeRule) {
          // ── Rule 1 (stop-loss) & Rule 2 (take-profit): DIRECT CLOSE, no cooldown, no LLM ──
          // These are time-critical — LLM roundtrip costs 60-120s, cooldown costs up to 7min more.
          // Direct executeTool("close_position") closes in ~15-30s.
          if (closeRule.rule <= 2 && !_directClosing.has(p.position)) {
            _directClosing.add(p.position);
            _pollTriggeredAt = Date.now();
            log("state",
              `[PnL poller] DIRECT close: ${p.pair} — Rule ${closeRule.rule}: ${closeRule.reason} [PnL: ${p.pnl_pct}%] — bypassing management`,
            );
            executeTool("close_position", {
              position_address: p.position,
              action: "CLOSE",
              reason: `PnL poller: ${closeRule.reason}`,
              metadata: { position: p },
            }).catch((e) => {
              log("cron_error", `Direct close failed for ${p.pair}: ${e.message}`);
              _directClosing.delete(p.position); // allow retry on next poll
            }).then(() => {
              _directClosing.delete(p.position); // clean up after close completes
            });
            break; // stop polling this cycle — one close at a time
          }
          // ── Other deterministic rules (OOR, low yield): cooldown-gated → management cycle ──
          const cooldownMs = config.schedule.managementIntervalMin * 60 * 1000;
          const sinceLastTrigger = Date.now() - _pollTriggeredAt;
          if (sinceLastTrigger >= cooldownMs) {
            _pollTriggeredAt = Date.now();
            log("state", `[PnL poll] Deterministic close rule: ${p.pair} — Rule ${closeRule.rule}: ${closeRule.reason} — triggering management`);
            runManagementCycle({ silent: true }).catch((e) => log("cron_error", `Poll-triggered management failed: ${e.message}`));
          } else {
            log("state", `[PnL poll] Deterministic close rule: ${p.pair} — Rule ${closeRule.rule}: ${closeRule.reason} — cooldown (${Math.round((cooldownMs - sinceLastTrigger) / 1000)}s left)`);
          }
          break;
        }
      }
    } finally {
      _pnlPollBusy = false;
    }
  }, 10_000);

  _cronTasks = [mgmtTask, screenTask, healthTask, briefingTask, briefingWatchdog];
  // Store interval ref so stopCronJobs can clear it
  _cronTasks._pnlPollInterval = pnlPollInterval;
  log("cron", `Cycles started — management every ${config.schedule.managementIntervalMin}m, screening every ${config.schedule.screeningIntervalMin}m`);
}

// ═══════════════════════════════════════════
//  GRACEFUL SHUTDOWN
// ═══════════════════════════════════════════
let _shuttingDown = false;

function withTimeout(promise, ms) {
  let timer = null;
  return Promise.race([
    promise,
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), ms);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function shutdown(signal) {
  if (_shuttingDown) {
    log("shutdown", `Received ${signal} while shutdown is already in progress.`);
    return;
  }
  _shuttingDown = true;

  // PM2 kill_timeout is 10s. Force-exit at 8s to avoid SIGKILL leaving sockets/ports bound.
  const forceExitTimer = setTimeout(() => {
    log("shutdown", "Force exit after 8s timeout (PM2 would SIGKILL at 10s).");
    process.exit(1);
  }, 8000);
  forceExitTimer.unref?.();

  log("shutdown", `Received ${signal}. Shutting down...`);
  try {
    stopPolling();
  } catch (e) {
    log("shutdown", `stopPolling threw: ${e.message}`);
  }
  try {
    stopCronJobs();
  } catch (e) {
    log("shutdown", `stopCronJobs threw: ${e.message}`);
  }
  try {
    stopDashboard();
  } catch (e) {
    log("shutdown", `stopDashboard threw: ${e.message}`);
  }

  const positions = await withTimeout(
    getMyPositions({ force: true, silent: true }).catch((error) => {
      log("shutdown", `Position snapshot failed during shutdown: ${error.message}`);
      return null;
    }),
    5000
  );
  if (positions) {
    log("shutdown", `Open positions at shutdown: ${positions.total_positions}`);
  } else {
    log("shutdown", "Open position snapshot skipped during shutdown timeout");
  }
  clearTimeout(forceExitTimer);
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// ═══════════════════════════════════════════
//  FORMAT CANDIDATES TABLE
// ═══════════════════════════════════════════
function formatCandidates(candidates) {
  if (!candidates.length) return "  No eligible pools found right now.";

  const lines = candidates.map((p, i) => {
    const name = (p.name || "unknown").padEnd(20);
    const ftvl = `${p.fee_active_tvl_ratio ?? p.fee_tvl_ratio}%`.padStart(8);
    const vol = `$${((p.volume_window || 0) / 1000).toFixed(1)}k`.padStart(8);
    const active = `${p.active_pct}%`.padStart(6);
    const org = String(p.organic_score).padStart(4);
    return `  [${i + 1}]  ${name}  fee/aTVL:${ftvl}  vol:${vol}  in-range:${active}  organic:${org}`;
  });

  return [
    "  #   pool                  fee/aTVL     vol    in-range  organic",
    "  " + "─".repeat(68),
    ...lines,
  ].join("\n");
}

function getDeterministicCloseRule(position, managementConfig) {
  const tracked = getTrackedPosition(position.position);
  const pnlSuspect = (() => {
    // Honor the upstream-aligned input-validity flag from getMyPositions (dlmm.js).
    // If the tick couldn't be priced (missing cost basis / collapsed value), the
    // PnL-based rules must not fire. Keeps this path in agreement with the poller
    // exit guard in state.js (updatePnlAndCheckExits).
    if (position.pnl_pct_suspicious) {
      log("cron_warn", `Suspect PnL for ${position.pair}: flagged pnl_pct_suspicious — skipping PnL rules`);
      return true;
    }
    if (position.pnl_pct == null) return false;
    if (position.pnl_pct > -90) return false;
    if (tracked?.amount_sol && (position.total_value_usd ?? 0) > 0.01) {
      log("cron_warn", `Suspect PnL for ${position.pair}: ${position.pnl_pct}% but position still has value — skipping PnL rules`);
      return true;
    }
    return false;
  })();

  if (!pnlSuspect && position.pnl_pct != null && position.pnl_pct <= managementConfig.stopLossPct) {
    return { action: "CLOSE", rule: 1, reason: "stop loss" };
  }
  if (!pnlSuspect && position.pnl_pct != null && position.pnl_pct >= managementConfig.takeProfitPct) {
    return { action: "CLOSE", rule: 2, reason: "take profit" };
  }
  const range = (position.upper_bin ?? 0) - (position.lower_bin ?? 0);
  const oorThreshold = typeof managementConfig.outOfRangeBinsToClose === "number"
    ? managementConfig.outOfRangeBinsToClose
    : Math.max(5, Math.floor((range || 80) * 0.25)); // 25% of range (min 5 bins)
  if (
    position.active_bin != null &&
    position.upper_bin != null &&
    position.active_bin > position.upper_bin + oorThreshold
  ) {
    return { action: "CLOSE", rule: 3, reason: `pumped far above range (active_bin ${position.active_bin} > upper ${position.upper_bin} + ${oorThreshold} threshold, range=${range})` };
  }
  const effectiveOorMinutes = getEffectiveOorTimeout(tracked);
  if (
    position.active_bin != null &&
    position.upper_bin != null &&
    position.active_bin > position.upper_bin &&
    (position.minutes_out_of_range ?? 0) >= effectiveOorMinutes
  ) {
    return { action: "CLOSE", rule: 4, reason: "OOR" };
  }
  if (
    position.fee_per_tvl_24h != null &&
    position.fee_per_tvl_24h < managementConfig.minFeePerTvl24h &&
    (position.age_minutes ?? 0) >= 60
  ) {
    return { action: "CLOSE", rule: 5, reason: "low yield" };
  }
  // Rule 6: F/TVL Decay — pool health degraded from entry
  const trackedPos = getTrackedPosition(position.position);
  if (trackedPos && trackedPos.initial_fee_tvl_24h != null && position.fee_per_tvl_24h != null) {
    const decayPct = managementConfig.feeTvlDecayPct ?? 50;
    const threshold = trackedPos.initial_fee_tvl_24h * (1 - decayPct / 100);
    if (position.fee_per_tvl_24h < threshold && (position.age_minutes ?? 0) >= managementConfig.minAgeBeforeYieldCheck) {
      return { action: "CLOSE", rule: 6, reason: `F/TVL decay ${trackedPos.initial_fee_tvl_24h.toFixed(2)}% → ${position.fee_per_tvl_24h.toFixed(2)}% (−${decayPct}% threshold)` };
    }
  }
  return null;
}

// ═══════════════════════════════════════════
//  INTERACTIVE REPL
// ═══════════════════════════════════════════
const isTTY = process.stdin.isTTY;
let cronStarted = false;
let busy = false;
const _telegramQueue = []; // queued messages received while agent was busy
const sessionHistory = []; // persists conversation across REPL turns
const MAX_HISTORY = 20;    // keep last 20 messages (10 exchanges)
let _ttyInterface = null;
let _latestCandidates = [];
let _latestCandidatesAt = null;

function setLatestCandidates(candidates = []) {
  _latestCandidates = Array.isArray(candidates) ? candidates : [];
  _latestCandidatesAt = new Date().toISOString();
}

function getLatestCandidatesMeta() {
  return {
    candidates: _latestCandidates,
    count: _latestCandidates.length,
    updatedAt: _latestCandidatesAt,
  };
}

function describeLatestCandidates(limit = 5) {
  if (!_latestCandidates.length) return "Belum ada kandidat tersimpan. Jalankan /screen dulu.";
  const lines = _latestCandidates.slice(0, limit).map((pool, i) => {
    const feeTvl = pool.fee_active_tvl_ratio ?? pool.fee_tvl_ratio ?? "?";
    const vol = pool.volume_window ?? pool.volume_24h ?? "?";
    const active = pool.active_pct ?? "?";
    const organic = pool.organic_score ?? "?";
    return `${i + 1}. ${pool.name} | fee/aTVL ${feeTvl}% | vol $${vol} | in-range ${active}% | organic ${organic}`;
  });
  const age = _latestCandidatesAt ? new Date(_latestCandidatesAt).toLocaleString("en-US", { hour12: false }) : "unknown";
  return `Kandidat terbaru (${_latestCandidates.length}) — diperbarui ${age}\n\n${lines.join("\n")}`;
}

function formatWalletStatus(wallet, positions) {
  const deployAmount = computeDeployAmount(wallet.sol);
  const hive = isHiveMindEnabled() ? "on" : "off";
  const dryRun = process.env.DRY_RUN === "true";
  const solColor = wallet.sol > 1 ? "#4ECB71" : "#E85D5D";
  return [
    "<b>── STATUS WALLET ──</b>",
    "",
    `<b>SOL:</b> <code>${wallet.sol}</code>  <b>USD:</b> <code>$${wallet.sol_usd}</code>`,
    `<b>Harga SOL:</b> <code>$${wallet.sol_price}</code>`,
    `<b>Posisi:</b> <code>${positions.total_positions}/${config.risk.maxPositions}</code>`,
    `<b>Deploy Brikutnya:</b> <code>${deployAmount} SOL</code>`,
    `<b>HiveMind:</b> <code>${hive}</code>`,
    `<b>Dry Run:</b> <code>${dryRun ? "ya" : "tidak"}</code>`,
  ].join("\n");
}

function formatConfigSnapshot() {
  return [
    "<b>── KONFIGURASI RUNTIME ──</b>",
    "",
    "<b>📐 Strategi</b>",
    `<code>${config.strategy.strategy}</code> | bins: ${config.strategy.minBinsBelow}–${config.strategy.maxBinsBelow} | default: ${config.strategy.defaultBinsBelow}`,
    "",
    "<b>💰 Deploy & Risiko</b>",
    `deploy: <code>${config.management.deployAmountSol} SOL</code> | gas: <code>${config.management.gasReserve}</code> | max pos: <code>${config.risk.maxPositions}</code>`,
    `SL: <code>${config.management.stopLossPct}%</code> | TP: <code>${config.management.takeProfitPct}%</code> | trailing: <code>${config.management.trailingTakeProfit ? "on" : "off"}</code>`,
    "",
    "<b>⏱️ OOR & Yield</b>",
    `tunggu: <code>${config.management.outOfRangeWaitMinutes}m</code> | yield min: <code>${config.management.minFeePerTvl24h}%</code> | umur min: <code>${config.management.minAgeBeforeYieldCheck}m</code>`,
    "",
    "<b>🔍 Screening</b>",
    `<code>${config.screening.category}</code> / <code>${config.screening.timeframe}</code> | TVL: ${config.screening.minTvl}–${config.screening.maxTvl}`,
    `Discord signals: <code>${config.screening.useDiscordSignals ? "on" : "off"}</code> | pump check: <code>${config.screening.pumpCheckEnabled ? "on" : "off"}</code>`,
    "",
    "<b>🔄 Interval</b>",
    `manage: <code>${config.schedule.managementIntervalMin}m</code> | screen: <code>${config.schedule.screeningIntervalMin}m</code>`,
    "",
    `<b>🧠 HiveMind:</b> <code>${isHiveMindEnabled() ? "aktif" : "nonaktif"}</code>${config.hiveMind.agentId ? " | <code>" + config.hiveMind.agentId + "</code>" : ""}`,
  ].join("\n");
}

function parseConfigValue(raw) {
  const value = String(raw ?? "").trim();
  if (!value.length) return "";
  if (/^(true|false)$/i.test(value)) return value.toLowerCase() === "true";
  if (/^null$/i.test(value)) return null;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  if ((value.startsWith("[") && value.endsWith("]")) || (value.startsWith("{") && value.endsWith("}"))) {
    return JSON.parse(value);
  }
  return value;
}

function settingValue(key) {
  const values = {
    solMode: config.management.solMode,
    lpAgentRelayEnabled: config.api.lpAgentRelayEnabled,
    chartIndicatorsEnabled: config.indicators.enabled,
    trailingTakeProfit: config.management.trailingTakeProfit,
    useDiscordSignals: config.screening.useDiscordSignals,
    blockPvpSymbols: config.screening.blockPvpSymbols,
    strategy: config.strategy.strategy,
    minBinsBelow: config.strategy.minBinsBelow,
    maxBinsBelow: config.strategy.maxBinsBelow,
    defaultBinsBelow: config.strategy.defaultBinsBelow,
    deployAmountSol: config.management.deployAmountSol,
    gasReserve: config.management.gasReserve,
    maxPositions: config.risk.maxPositions,
    maxDeployAmount: config.risk.maxDeployAmount,
    takeProfitPct: config.management.takeProfitPct,
    stopLossPct: config.management.stopLossPct,
    trailingTriggerPct: config.management.trailingTriggerPct,
    trailingDropPct: config.management.trailingDropPct,
    repeatDeployCooldownEnabled: config.management.repeatDeployCooldownEnabled,
    repeatDeployCooldownTriggerCount: config.management.repeatDeployCooldownTriggerCount,
    repeatDeployCooldownHours: config.management.repeatDeployCooldownHours,
    repeatDeployCooldownMinFeeEarnedPct: config.management.repeatDeployCooldownMinFeeEarnedPct,
    managementIntervalMin: config.schedule.managementIntervalMin,
    screeningIntervalMin: config.schedule.screeningIntervalMin,
    indicatorEntryPreset: config.indicators.entryPreset,
    indicatorExitPreset: config.indicators.exitPreset,
    rsiLength: config.indicators.rsiLength,
    indicatorIntervals: config.indicators.intervals,
    requireAllIntervals: config.indicators.requireAllIntervals,
  };
  return values[key];
}

function fmtSettingValue(value) {
  if (Array.isArray(value)) return value.join(",");
  if (typeof value === "boolean") return value ? "on" : "off";
  return String(value);
}

function settingButton(label, data) {
  return { text: label, callback_data: data };
}

function toggleButton(key, label) {
  return settingButton(`${label}: ${fmtSettingValue(settingValue(key))}`, `cfg:toggle:${key}`);
}

function stepButtons(key, label, step, { digits = 2 } = {}) {
  const value = Number(settingValue(key));
  const shown = Number.isFinite(value) ? value.toFixed(digits).replace(/\.?0+$/, "") : "?";
  return [
    settingButton(`- ${label}`, `cfg:step:${key}:${-step}`),
    settingButton(`${label}: ${shown}`, `cfg:noop`),
    settingButton(`+ ${label}`, `cfg:step:${key}:${step}`),
  ];
}

function renderSettingsMenu(page = "main") {
  const title = page === "main" ? "<b>── PENGATURAN ──</b>" : `<b>── PENGATURAN: ${page.toUpperCase()} ──</b>`;
  const enabledIcon = (val) => val ? "🟢" : "⚫";
  const summary = [
    title,
    "",
    `${enabledIcon(!config.management.solMode)} USD mode | ${enabledIcon(config.api.lpAgentRelayEnabled)} LPAgent relay`,
    `${enabledIcon(config.indicators.enabled)} Chart indicators | ${enabledIcon(config.management.trailingTakeProfit)} Trailing TP`,
    `<b>Strategy:</b> <code>${config.strategy.strategy}</code> | bins: ${config.strategy.minBinsBelow}–${config.strategy.maxBinsBelow}`,
    `<b>Deploy:</b> <code>${config.management.deployAmountSol} SOL</code> | TP/SL: ${config.management.takeProfitPct}%/${config.management.stopLossPct}%`,
  ].join("\n");

  const nav = [
    [
      settingButton("Utama", "cfg:page:main"),
      settingButton("Risiko", "cfg:page:risk"),
      settingButton("Screen", "cfg:page:screen"),
      settingButton("Indikator", "cfg:page:indicators"),
    ],
  ];

  const footer = [
    [
      settingButton("Refresh", `cfg:page:${page}`),
      settingButton("Tutup", "cfg:close"),
    ],
  ];

  let rows;
  if (page === "risk") {
    rows = [
      stepButtons("deployAmountSol", "Deploy", 0.1),
      stepButtons("gasReserve", "Gas", 0.05),
      stepButtons("maxPositions", "Max pos", 1, { digits: 0 }),
      stepButtons("maxDeployAmount", "Max SOL", 1, { digits: 0 }),
      stepButtons("takeProfitPct", "TP %", 1, { digits: 0 }),
      stepButtons("stopLossPct", "SL %", 5, { digits: 0 }),
      [toggleButton("trailingTakeProfit", "Trailing TP")],
      stepButtons("trailingTriggerPct", "Trail trigger", 0.5, { digits: 1 }),
      stepButtons("trailingDropPct", "Trail drop", 0.5, { digits: 1 }),
      [toggleButton("repeatDeployCooldownEnabled", "Repeat cooldown")],
      stepButtons("repeatDeployCooldownTriggerCount", "Repeat count", 1, { digits: 0 }),
      stepButtons("repeatDeployCooldownHours", "Repeat hrs", 1, { digits: 0 }),
      stepButtons("repeatDeployCooldownMinFeeEarnedPct", "Fee earned %", 0.1, { digits: 1 }),
    ];
  } else if (page === "screen") {
    rows = [
      [toggleButton("useDiscordSignals", "Discord signals"), toggleButton("blockPvpSymbols", "PVP hard block")],
      [
        settingButton(`Strategy: spot`, "cfg:set:strategy:spot"),
        settingButton(`Strategy: bid_ask`, "cfg:set:strategy:bid_ask"),
      ],
      stepButtons("minBinsBelow", "Min bins", 1, { digits: 0 }),
      stepButtons("maxBinsBelow", "Max bins", 1, { digits: 0 }),
      stepButtons("defaultBinsBelow", "Default bins", 1, { digits: 0 }),
      stepButtons("managementIntervalMin", "Manage min", 1, { digits: 0 }),
      stepButtons("screeningIntervalMin", "Screen min", 5, { digits: 0 }),
    ];
  } else if (page === "indicators") {
    rows = [
      [toggleButton("chartIndicatorsEnabled", "Chart indicators"), toggleButton("requireAllIntervals", "Require all TF")],
      [
        settingButton("TF: 5m", "cfg:set:indicatorIntervals:5_MINUTE"),
        settingButton("TF: 15m", "cfg:set:indicatorIntervals:15_MINUTE"),
        settingButton("TF: both", "cfg:set:indicatorIntervals:both"),
      ],
      [
        settingButton("Entry: ST", "cfg:set:indicatorEntryPreset:supertrend_break"),
        settingButton("Entry: RSI", "cfg:set:indicatorEntryPreset:rsi_reversal"),
        settingButton("Entry: ST/RSI", "cfg:set:indicatorEntryPreset:supertrend_or_rsi"),
      ],
      [
        settingButton("Exit: ST", "cfg:set:indicatorExitPreset:supertrend_break"),
        settingButton("Exit: RSI", "cfg:set:indicatorExitPreset:rsi_reversal"),
        settingButton("Exit: BB+RSI", "cfg:set:indicatorExitPreset:bb_plus_rsi"),
      ],
      stepButtons("rsiLength", "RSI len", 1, { digits: 0 }),
    ];
  } else {
    rows = [
      [toggleButton("solMode", "SOL mode"), toggleButton("lpAgentRelayEnabled", "LPAgent relay")],
      [toggleButton("chartIndicatorsEnabled", "Chart indicators"), toggleButton("trailingTakeProfit", "Trailing TP")],
      [
        settingButton("Risk / deploy", "cfg:page:risk"),
        settingButton("Screening", "cfg:page:screen"),
      ],
      [
        settingButton("Indikator", "cfg:page:indicators"),
        settingButton("Tampil config", "cfg:show"),
      ],
    ];
  }

  return { text: summary, keyboard: [...nav, ...rows, ...footer] };
}

async function showSettingsMenu({ messageId = null, page = "main" } = {}) {
  const menu = renderSettingsMenu(page);
  if (messageId) {
    await editMessageWithButtons(menu.text, messageId, menu.keyboard);
  } else {
    await sendMessageWithButtons(menu.text, menu.keyboard);
  }
}

function normalizeMenuValue(key, raw) {
  if (key === "indicatorIntervals") {
    if (raw === "both") return ["5_MINUTE", "15_MINUTE"];
    return [raw];
  }
  return parseConfigValue(raw);
}

async function applySettingsMenuCallback(msg) {
  const data = msg.callbackData || msg.text || "";
  const parts = data.split(":");
  const action = parts[1];
  let page = "main";

  if (action === "noop") {
    await answerCallbackQuery(msg.callbackQueryId);
    return;
  }
  if (action === "close") {
    await answerCallbackQuery(msg.callbackQueryId, "Tutup");
    await editMessage("Menu pengaturan ditutup.", msg.messageId);
    return;
  }
  if (action === "show") {
    await answerCallbackQuery(msg.callbackQueryId);
    await editMessageWithButtons(formatConfigSnapshot(), msg.messageId, [[settingButton("Kembali", "cfg:page:main")]]);
    return;
  }
  if (action === "page") {
    page = parts[2] || "main";
    await answerCallbackQuery(msg.callbackQueryId);
    await showSettingsMenu({ messageId: msg.messageId, page });
    return;
  }

  const key = parts[2];
  let value;
  if (action === "toggle") {
    value = !Boolean(settingValue(key));
  } else if (action === "step") {
    const current = Number(settingValue(key));
    const delta = Number(parts[3]);
    if (!Number.isFinite(current) || !Number.isFinite(delta)) {
    await answerCallbackQuery(msg.callbackQueryId, "Setting invalid");
    return;
  }
  value = Number((current + delta).toFixed(4));
  if (key === "maxPositions") value = Math.max(1, Math.round(value));
  if (key === "rsiLength") value = Math.max(2, Math.round(value));
  if (key === "repeatDeployCooldownTriggerCount") value = Math.max(1, Math.round(value));
  if (key === "repeatDeployCooldownHours") value = Math.max(0, Math.round(value));
  if (key === "repeatDeployCooldownMinFeeEarnedPct") value = Math.max(0, value);
  if (["minBinsBelow", "maxBinsBelow", "defaultBinsBelow"].includes(key)) value = Math.max(35, Math.round(value));
  if (["deployAmountSol", "gasReserve", "maxDeployAmount"].includes(key)) value = Math.max(0, value);
  } else if (action === "set") {
    value = normalizeMenuValue(key, parts.slice(3).join(":"));
  } else {
    await answerCallbackQuery(msg.callbackQueryId, "Aksi tidak dikenal");
    return;
  }

  const result = await executeTool("update_config", {
    changes: { [key]: value },
    reason: "Telegram settings menu",
  });
  if (!result?.success) {
    await answerCallbackQuery(msg.callbackQueryId, "Update config gagal");
    return;
  }
  page = key.startsWith("indicator") || key === "chartIndicatorsEnabled" || key === "rsiLength" || key === "requireAllIntervals"
    ? "indicators"
    : ["useDiscordSignals", "blockPvpSymbols", "strategy", "minBinsBelow", "maxBinsBelow", "defaultBinsBelow", "managementIntervalMin", "screeningIntervalMin"].includes(key)
      ? "screen"
      : "risk";
  await answerCallbackQuery(msg.callbackQueryId, `Updated ${key}`);
  await showSettingsMenu({ messageId: msg.messageId, page });
}

function formatHelpText() {
  return [
    "<b>── PUREXBT · PERINTAH TELEGRAM ──</b>",
    "",
    "<b>📊 Info & Status</b>",
    "<code>/status</code>    — ringkasan wallet + posisi",
    "<code>/wallet</code>    — saldo, deploy amount, HiveMind",
    "<code>/positions</code> — daftar posisi terbuka + PnL",
    "<code>/pool 1</code>    — detail posisi nomor #1",
    "<code>/config</code>    — konfigurasi runtime saat ini",
    "<code>/hive</code>      — status sync HiveMind",
    "",
    "<b>🎯 Screening & Deploy</b>",
    "<code>/screen</code>     — jalankan pemindaian pool deterministik",
    "<code>/candidates</code> — tampilkan kandidat terbaru tersimpan",
    "<code>/deploy 1</code>   — deploy kandidat berdasarkan indeks",
    "<code>/briefing</code>   — laporan briefing pagi",
    "",
    "<b>🔧 Kontrol Posisi</b>",
    "<code>/close 1</code>    — tutup posisi berdasarkan indeks",
    "<code>/closeall</code>   — tutup SEMUA posisi terbuka",
    "<code>/set 1 note</code> — pasang catatan di posisi",
    "",
    "<b>⚙️ Konfigurasi</b>",
    "<code>/settings</code>   — menu tombol interaktif",
    "<code>/setcfg key val</code> — update config langsung",
    "",
    "<b>⏯️ Sistem</b>",
    "<code>/pause</code>  — hentikan siklus otonom",
    "<code>/resume</code> — lanjutkan siklus otonom",
    "<code>/stop</code>   — matikan agent",
    "",
    "<b>💬 Chat</b>",
    "Pesan apa saja → agent LLM merespon secara natural",
  ].join("\n");
}

async function runDeterministicScreen(limit = 5) {
  const top = await getTopCandidates({ limit });
  const candidates = (top?.candidates || top?.pools || []).slice(0, limit);
  setLatestCandidates(candidates);
  if (candidates.length > 0) {
    const lines = candidates.map((pool, i) => {
      const feeTvl = pool.fee_active_tvl_ratio ?? pool.fee_tvl_ratio ?? "?";
      const vol = pool.volume_window ?? pool.volume_24h ?? "?";
      return `${i + 1}. ${pool.name} | ${pool.pool}\n   fee/aTVL ${feeTvl}% | vol $${vol} | organic ${pool.organic_score ?? "?"}`;
    });
    return `Kandidat teratas (${candidates.length})\n\n${lines.join("\n")}`;
  }
  const examples = (top?.filtered_examples || []).slice(0, 3)
    .map((entry) => `- ${entry.name}: ${entry.reason}`)
    .join("\n");
  return examples
    ? `Tidak ada kandidat tersedia.\nContoh terfilter:\n${examples}`
    : "Tidak ada kandidat tersedia saat ini.";
}

async function deployLatestCandidate(index) {
  const candidate = _latestCandidates[index];
  if (!candidate) {
    throw new Error("Indeks kandidat invalid. Jalankan /screen dulu.");
  }
  if (_latestCandidates.length === 1) {
    const mint = candidate.base?.mint || candidate.base_mint || null;
    const [smartWallets, narrative, tokenInfo] = await Promise.allSettled([
      checkSmartWalletsOnPool({ pool_address: candidate.pool }),
      mint ? getTokenNarrative({ mint }) : Promise.resolve(null),
      mint ? getTokenInfo({ query: mint }) : Promise.resolve(null),
    ]);
    const context = {
      pool: candidate,
      sw: smartWallets.status === "fulfilled" ? smartWallets.value : null,
      n: narrative.status === "fulfilled" ? narrative.value : null,
      ti: tokenInfo.status === "fulfilled" ? tokenInfo.value?.results?.[0] : null,
    };
    const skipReason = getLoneCandidateSkipReason(context);
    if (skipReason) {
      appendDecision({
        type: "no_deploy",
        actor: "SCREENER",
        summary: "Single cached candidate skipped",
        reason: skipReason,
        pool: candidate.pool,
        pool_name: candidate.name,
      });
      throw new Error(`NO DEPLOY: kandidat tunggal ${candidate.name} tidak layak deploy — ${skipReason}`);
    }
  }
  const deployAmount = computeDeployAmount((await getWalletBalances()).sol);
  const binsBelow = computeBinsBelow(candidate.volatility);
  const result = await executeTool("deploy_position", {
    pool_address: candidate.pool,
    amount_y: deployAmount,
    strategy: config.strategy.strategy,
    bins_below: binsBelow,
    bins_above: 0,
    pool_name: candidate.name,
    base_mint: candidate.base?.mint || candidate.base_mint || null,
    bin_step: candidate.bin_step,
    base_fee: candidate.base_fee,
    volatility: candidate.volatility,
    fee_tvl_ratio: candidate.fee_active_tvl_ratio ?? candidate.fee_tvl_ratio,
    organic_score: candidate.organic_score,
    initial_value_usd: candidate.tvl ?? candidate.active_tvl ?? null,
  });
  if (result?.success === false || result?.error) {
    throw new Error(result.error || "Deploy failed");
  }
  return { result, candidate, deployAmount, binsBelow };
}

function appendHistory(userMsg, assistantMsg) {
  sessionHistory.push({ role: "user", content: userMsg });
  sessionHistory.push({ role: "assistant", content: assistantMsg });
  // Trim to last MAX_HISTORY messages
  if (sessionHistory.length > MAX_HISTORY) {
    sessionHistory.splice(0, sessionHistory.length - MAX_HISTORY);
  }
}

function refreshPrompt() {
  if (!_ttyInterface) return;
  _ttyInterface.setPrompt(buildPrompt());
  _ttyInterface.prompt(true);
}

async function drainTelegramQueue() {
  while (_telegramQueue.length > 0 && !_managementBusy && !_screeningBusy && !busy) {
    const queued = _telegramQueue.shift();
    await telegramHandler(queued);
  }
}

async function telegramHandler(msg) {
  const text = msg?.text?.trim();
  if (!text) return;
  if (msg?.isCallback && text.startsWith("cfg:")) {
    try {
      await applySettingsMenuCallback(msg);
    } catch (e) {
      await answerCallbackQuery(msg.callbackQueryId, e.message).catch(() => {});
    }
    return;
  }
  if (text === "/settings" || text === "/menu" || text === "/configmenu") {
    await showSettingsMenu().catch((e) => sendMessage(`Error settings: ${e.message}`).catch(() => {}));
    return;
  }
  if (_managementBusy || _screeningBusy || busy) {
    if (_telegramQueue.length < 5) {
      _telegramQueue.push(msg);
      sendHTML(`⏳ <b>Antrian #${_telegramQueue.length}</b>: "${text.slice(0, 60)}"`).catch(() => {});
    } else {
      sendHTML("⚠️ <b>Antrian penuh</b> (5 pesan). Tunggu agent selesai.").catch(() => {});
    }
    return;
  }

  if (text === "/briefing") {
    try {
      const briefing = await generateBriefing();
      await sendHTML(briefing);
    } catch (e) {
      await sendMessage(`Error: ${e.message}`).catch(() => {});
    }
    return;
  }

  if (text === "/help") {
    await sendHTML(formatHelpText()).catch(() => {});
    return;
  }

  if (text === "/wallet" || text === "/status") {
    try {
      const [wallet, positions] = await Promise.all([getWalletBalances(), getMyPositions({ force: true })]);
      const suffix = text === "/status" && positions.total_positions
        ? `\n\nGunakan /positions untuk daftar bernomor.`
        : "";
      await sendHTML(`${formatWalletStatus(wallet, positions)}${suffix}`).catch(() => {});
    } catch (e) {
      await sendMessage(`Error: ${e.message}`).catch(() => {});
    }
    return;
  }

  if (text === "/config") {
    await sendHTML(formatConfigSnapshot()).catch(() => {});
    return;
  }

  if (text === "/positions") {
    try {
      const { positions, total_positions } = await getMyPositions({ force: true });
      if (total_positions === 0) { await sendHTML("<b>── POSISI, BOS ──</b>\n\nDereng wonten posisi mbukak, Tuanku."); return; }
      const cur = config.management.solMode ? "◎" : "$";
      const lines = positions.map((p, i) => {
        const pnlUsd = p.pnl_usd != null ? Number(p.pnl_usd) : 0;
        const pnlPct = p.pnl_pct != null ? Number(p.pnl_pct) : null;
        const pnlSign = pnlUsd >= 0 ? "+" : "";
        const pnlColor = pnlUsd >= 0 ? "#4ECB71" : "#E85D5D";
        const emoji = pnlUsd >= 0 ? "🟢" : "🔴";
        const pnlStr = `${emoji} ${pnlSign}${cur}${Math.abs(pnlUsd).toFixed(2)}${pnlPct != null ? " (" + pnlSign + pnlPct.toFixed(2) + "%)" : ""}`;
        const age = p.age_minutes != null ? `${p.age_minutes}m` : "?";
        const oorTag = !p.in_range ? " ⚠️ OOR" : "";
        return [
          `<b>${i + 1}. ${p.pair}</b>`,
          `Nilai: <code>${cur}${p.total_value_usd ?? "?"}</code> | PnL: ${pnlStr}`,
          `Fee: <code>${cur}${p.unclaimed_fees_usd ?? "?"}</code> | Umur: <code>${age}</code>${oorTag}`,
          `<code>/close ${i + 1}</code> tutup | <code>/pool ${i + 1}</code> detail`,
        ].join("\n");
      });
      await sendHTML(`<b>── POSISI, BOS (${total_positions}) ──</b>\n\n${lines.join("\n\n")}`);
    } catch (e) { await sendMessage(`Error: ${e.message}`).catch(() => {}); }
    return;
  }

  const poolMatch = text.match(/^\/pool\s+(\d+)$/i);
  if (poolMatch) {
    try {
      const idx = parseInt(poolMatch[1]) - 1;
      const { positions } = await getMyPositions({ force: true });
      if (idx < 0 || idx >= positions.length) { await sendMessage("Nomor invalid. Gunakan /positions dulu."); return; }
      const pos = positions[idx];
      const pnlUsd = pos.pnl_usd != null ? Number(pos.pnl_usd) : 0;
      const pnlSign = pnlUsd >= 0 ? "+" : "";
      const emoji = pnlUsd >= 0 ? "🟢" : "🔴";
      const rangeStatus = pos.in_range ? "🟢 DALAM RANGE" : `🔴 OOR ${pos.minutes_out_of_range ?? 0}m`;
      const cur = config.management.solMode ? "◎" : "$";
      await sendHTML([
        `<b>── POOL, BOS: ${pos.pair} ──</b>`,
        "",
        `<b>Pool:</b> <code>${pos.pool}</code>`,
        `<b>Posisi:</b> <code>${pos.position}</code>`,
        `<b>Range:</b> bin <code>${pos.lower_bin} → ${pos.upper_bin}</code> | active <code>${pos.active_bin}</code>`,
        `<b>PnL:</b> ${emoji} ${pnlSign}${cur}${Math.abs(pnlUsd).toFixed(2)} (${pnlSign}${(pos.pnl_pct ?? 0).toFixed(2)}%)`,
        `<b>Fee:</b> <code>${cur}${pos.unclaimed_fees_usd ?? "?"}</code>`,
        `<b>Nilai:</b> <code>${cur}${pos.total_value_usd ?? "?"}</code>`,
        `<b>Umur:</b> <code>${pos.age_minutes ?? "?"}m</code> | ${rangeStatus}`,
        pos.instruction ? `\n<b>Catatan:</b> ${pos.instruction}` : "",
        "",
        `<code>/close ${idx + 1}</code> untuk tutup`,
      ].filter(Boolean).join("\n")).catch(() => {});
    } catch (e) {
      await sendMessage(`Error: ${e.message}`).catch(() => {});
    }
    return;
  }

  const closeMatch = text.match(/^\/close\s+(\d+)$/i);
  if (closeMatch) {
    try {
      const idx = parseInt(closeMatch[1]) - 1;
      const { positions } = await getMyPositions({ force: true });
      if (idx < 0 || idx >= positions.length) { await sendMessage("Nomor invalid. Gunakan /positions dulu."); return; }
      const pos = positions[idx];
      await sendMessage(`Menutup <b>${pos.pair}</b>...`).catch(() => {});
      const result = await closePosition({ position_address: pos.position });
      if (result.success) {
        const closeTxs = result.close_txs?.length ? result.close_txs : result.txs;
        const claimNote = result.claim_txs?.length ? `\nclaim tx: ${result.claim_txs.join(", ")}` : "";
        const pnlUsd = result.pnl_usd != null ? Number(result.pnl_usd) : 0;
        const pnlSign = pnlUsd >= 0 ? "+" : "";
        const emoji = pnlUsd >= 0 ? "🟢" : "🔴";
        await sendHTML(
          `<b>── WIS DITUTUP, BOS ──</b>\n\n` +
          `<b>Pool:</b> ${pos.pair}\n` +
          `<b>PnL:</b> ${emoji} ${pnlSign}$${Math.abs(pnlUsd).toFixed(2)}\n` +
          `<b>Tx:</b> <code>${(closeTxs?.[0] || "n/a").slice(0, 16)}...</code>${claimNote}`
        ).catch(() => {});
      } else {
        await sendMessage(`❌ Tutup gagal: ${result.reason || JSON.stringify(result)}`).catch(() => {});
      }
    } catch (e) { await sendMessage(`Error: ${e.message}`).catch(() => {}); }
    return;
  }

  if (text === "/closeall") {
    try {
      const { positions } = await getMyPositions({ force: true });
      if (!positions.length) { await sendMessage("Tidak ada posisi terbuka."); return; }
      await sendMessage(`Menutup <b>${positions.length}</b> posisi...`).catch(() => {});
      const results = [];
      for (const pos of positions) {
        try {
          const result = await closePosition({ position_address: pos.position });
          const icon = result.success ? "✅" : "❌";
          results.push(`${icon} ${pos.pair}: ${result.success ? "tertutup" : `gagal (${result.reason || "tidak diketahui"})`}`);
        } catch (error) {
          results.push(`❌ ${pos.pair}: gagal (${error.message})`);
        }
      }
      await sendHTML(`<b>── KABEH WIS DITUTUP, BOS ──</b>\n\n${results.join("\n")}`).catch(() => {});
    } catch (e) {
      await sendMessage(`Error: ${e.message}`).catch(() => {});
    }
    return;
  }

  const setMatch = text.match(/^\/set\s+(\d+)\s+(.+)$/i);
  if (setMatch) {
    try {
      const idx = parseInt(setMatch[1]) - 1;
      const note = setMatch[2].trim();
      const { positions } = await getMyPositions({ force: true });
      if (idx < 0 || idx >= positions.length) { await sendMessage("Nomor invalid. Gunakan /positions dulu."); return; }
      const pos = positions[idx];
      setPositionInstruction(pos.position, note);
      await sendHTML(`<b>✅ Cathetan wis dipasang kanggo ${pos.pair}, Bos</b>\n<code>"${note}"</code>`).catch(() => {});
    } catch (e) { await sendMessage(`Error: ${e.message}`).catch(() => {}); }
    return;
  }

  const setCfgMatch = text.match(/^\/setcfg\s+([A-Za-z0-9_]+)\s+(.+)$/i);
  if (setCfgMatch) {
    try {
      const key = setCfgMatch[1];
      const value = parseConfigValue(setCfgMatch[2]);
      const result = await executeTool("update_config", {
        changes: { [key]: value },
        reason: "Telegram slash command /setcfg",
      });
      if (!result?.success) {
        await sendMessage(`Config gagal.\nTidak dikenal: ${(result?.unknown || []).join(", ") || "tidak ada"}`).catch(() => {});
        return;
      }
      await sendHTML(`<b>✅ Diperbarui</b> <code>${key}</code> = <code>${JSON.stringify(value)}</code>`).catch(() => {});
    } catch (e) {
      await sendMessage(`Error: ${e.message}`).catch(() => {});
    }
    return;
  }

  if (text === "/screen") {
    try {
      const result = await runDeterministicScreen(5);
      await sendHTML(`<b>── HASIL SCREENING ──</b>\n\n${result}`).catch(() => {});
    } catch (e) {
      await sendMessage(`Error: ${e.message}`).catch(() => {});
    }
    return;
  }

  if (text === "/candidates") {
    const result = describeLatestCandidates(5);
    await sendHTML(`<b>── KANDIDAT TERSIMPAN ──</b>\n\n<pre>${result}</pre>`).catch(() => {});
    return;
  }

  const deployMatch = text.match(/^\/deploy\s+(\d+)$/i);
  if (deployMatch) {
    try {
      const idx = parseInt(deployMatch[1]) - 1;
      const { candidate, result, deployAmount, binsBelow } = await deployLatestCandidate(idx);
      const coverage = result.range_coverage
        ? `Range: ${fmtPct(result.range_coverage.downside_pct)} downside | ${fmtPct(result.range_coverage.upside_pct)} upside`
        : `Strategy: ${config.strategy.strategy} | binsBelow: ${binsBelow}`;
      await sendHTML([
        `<b>── TERDEPLOY ──</b>`,
        "",
        `<b>Pool:</b> ${candidate.name}`,
        `<b>Alamat:</b> <code>${candidate.pool}</code>`,
        `<b>Jumlah:</b> <code>${deployAmount} SOL</code>`,
        coverage,
        `<b>Posisi:</b> <code>${(result.position || "n/a").slice(0, 12)}...</code>`,
        result.txs?.length ? `<b>Tx:</b> <code>${result.txs[0].slice(0, 16)}...</code>` : null,
      ].filter(Boolean).join("\n")).catch(() => {});
    } catch (e) {
      await sendMessage(`Error: ${e.message}`).catch(() => {});
    }
    return;
  }

  if (text === "/pause") {
    stopCronJobs();
    cronStarted = false;
    await sendHTML("<b>⏸ PAUSED</b>\n\nSiklus otonom dihentikan. Kontrol Telegram tetap berfungsi.\nGunakan <code>/resume</code> untuk memulai lagi.").catch(() => {});
    return;
  }

  if (text === "/resume") {
    if (!cronStarted) {
      cronStarted = true;
      timers.managementLastRun = Date.now();
      timers.screeningLastRun = Date.now();
      startCronJobs();
      await sendHTML("<b>▶️ DILANJUTKAN</b>\n\nSiklus otonom dimulai kembali.").catch(() => {});
    } else {
      await sendHTML("Siklus otonom sudah berjalan.").catch(() => {});
    }
    return;
  }

  if (text === "/hive" || text === "/hive pull") {
    try {
      const enabled = isHiveMindEnabled();
      const agentId = ensureAgentId();
      if (!enabled) {
        await sendHTML(`<b>── HIVEMIND ──</b>\n\n<b>Status:</b> nonaktif\n<b>Agent ID:</b> <code>${agentId}</code>\n\nIsi <code>hiveMindApiKey</code> untuk terhubung.`).catch(() => {});
        return;
      }
      const isManualPull = text === "/hive pull";
      const pullMode = getHiveMindPullMode();
      const [registerResult, lessons, presets] = await Promise.all([
        registerHiveMindAgent({ reason: isManualPull ? "telegram_pull" : "telegram_status" }),
        (pullMode === "auto" || isManualPull) ? pullHiveMindLessons(12) : Promise.resolve(null),
        (pullMode === "auto" || isManualPull) ? pullHiveMindPresets() : Promise.resolve(null),
      ]);
      await sendHTML([
        `<b>── HIVEMIND ──</b>`,
        "",
        `<b>Status:</b> aktif`,
        "",
        `<b>Agent ID:</b> <code>${agentId}</code>`,
        `<b>URL:</b> <code>${config.hiveMind.url}</code>`,
        `<b>Mode pull:</b> <code>${pullMode}</code>`,
        `<b>Register:</b> <code>${registerResult ? "ok" : "warn"}</code>`,
        `<b>Lesson bersama:</b> <code>${Array.isArray(lessons) ? lessons.length : (pullMode === "manual" ? "manual" : 0)}</code>`,
        `<b>Preset:</b> <code>${Array.isArray(presets) ? presets.length : (pullMode === "manual" ? "manual" : 0)}</code>`,
        isManualPull ? "\nPull manual: selesai" : null,
      ].join("\n")).catch(() => {});
    } catch (e) {
      await sendMessage(`HiveMind error: ${e.message}`).catch(() => {});
    }
    return;
  }

  busy = true;
  let liveMessage = null;
  try {
    log("telegram", `Incoming: ${text.slice(0, 50)}${text.length > 50 ? "..." : ""}`);
    const hasCloseIntent = /\bclose\b|\bsell\b|\bexit\b|\bwithdraw\b/i.test(text);
    const isDeployRequest = !hasCloseIntent && /\bdeploy\b|\bopen position\b|\blp into\b|\badd liquidity\b/i.test(text);
    const agentRole = isDeployRequest ? "SCREENER" : "GENERAL";
    const agentModel = agentRole === "SCREENER" ? config.llm.screeningModel : config.llm.generalModel;
    liveMessage = await createLiveMessage("🐶 <b>SIAP, BOS</b>", `Dhawuh: ${text.slice(0, 240)}`);
    const { content } = await agentLoop(text, config.llm.maxSteps, sessionHistory, agentRole, agentModel, null, {
      interactive: true,
      onToolStart: async ({ name }) => { await liveMessage?.toolStart(name); },
      onToolFinish: async ({ name, result, success }) => { await liveMessage?.toolFinish(name, result, success); },
    });
    appendHistory(text, content);
    if (liveMessage) await liveMessage.finalize(stripThink(content));
    else await sendMessage(stripThink(content));
  } catch (e) {
    if (liveMessage) await liveMessage.fail(e.message).catch(() => {});
    else await sendMessage(`Error: ${e.message}`).catch(() => {});
  } finally {
    busy = false;
    refreshPrompt();
    drainTelegramQueue().catch(() => {});
  }
}

function fmtPct(value) {
  const n = Number(value);
  return Number.isFinite(n) ? `${n.toFixed(2)}%` : "?";
}

function getLoneCandidateSkipReason({ pool, sw, n, ti } = {}) {
  if (!pool) return "missing candidate data";
  const smartWalletCount = Math.max(sw?.in_pool?.length ?? 0, Number(pool.gmgn_smart_wallets ?? 0) || 0);
  const tokenInfo = ti || {};
  const hasNarrative = !!n?.narrative;
  const globalFeesSol = Number(tokenInfo.global_fees_sol ?? pool.gmgn_total_fee_sol);
  const top10Pct = Number(tokenInfo.audit?.top_holders_pct ?? pool.gmgn_token_info_top10_pct ?? pool.gmgn_top10_holder_pct);
  const botPct = Number(tokenInfo.audit?.bot_holders_pct ?? pool.gmgn_bot_degen_pct);
  if (pool.is_wash) return "wash trading was flagged";
  if (pool.is_rugpull && smartWalletCount === 0) return "rugpull risk was flagged and no smart wallets offset it";
  if (pool.is_pvp && smartWalletCount === 0) return "PVP symbol conflict and no smart-wallet confirmation";
  if (Number.isFinite(globalFeesSol) && globalFeesSol < config.screening.minTokenFeesSol) {
    return `token fees ${globalFeesSol} SOL below minimum ${config.screening.minTokenFeesSol} SOL`;
  }
  if (Number.isFinite(top10Pct) && top10Pct > config.screening.maxTop10Pct) {
    return `top10 concentration ${top10Pct}% above maximum ${config.screening.maxTop10Pct}%`;
  }
  if (Number.isFinite(botPct) && botPct > config.screening.maxBotHoldersPct) {
    return `bot holders ${botPct}% above maximum ${config.screening.maxBotHoldersPct}%`;
  }
  if (!hasNarrative && smartWalletCount === 0) return "only candidate has no narrative and no smart-wallet confirmation";
  return null;
}

function computeBinsBelow(volatility) {
  const parsedVolatility = Number(volatility);
  if (!Number.isFinite(parsedVolatility) || parsedVolatility <= 0) {
    throw new Error(`Invalid volatility ${volatility ?? "unknown"} — refusing volatility-scaled deploy.`);
  }
  const lo = config.strategy.minBinsBelow;
  const hi = config.strategy.maxBinsBelow;
  return Math.max(lo, Math.min(hi, Math.round(lo + (parsedVolatility / 5) * (hi - lo))));
}

// Register restarter — when update_config changes intervals, running cron jobs get replaced
registerCronRestarter(() => { if (cronStarted) startCronJobs(); });

if (isMain && isTTY && !DASHBOARD_ONLY) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: buildPrompt(),
  });
  _ttyInterface = rl;

  // Update prompt countdown every 10 seconds
  setInterval(() => {
    if (!busy) {
      rl.setPrompt(buildPrompt());
      rl.prompt(true); // true = preserve current line
    }
  }, 10_000);

  function launchCron() {
    if (!cronStarted) {
      cronStarted = true;
      // Seed timers so countdown starts from now
      timers.managementLastRun = Date.now();
      timers.screeningLastRun = Date.now();
      startCronJobs();
      console.log("Autonomous cycles are now running.\n");
      rl.setPrompt(buildPrompt());
      rl.prompt(true);
    }
  }

  async function runBusy(fn) {
    if (busy) { console.log("Agent is busy, please wait..."); rl.prompt(); return; }
    busy = true; rl.pause();
    try { await fn(); }
    catch (e) { console.error(`Error: ${e.message}`); }
    finally { busy = false; rl.setPrompt(buildPrompt()); rl.resume(); rl.prompt(); }
  }

  // ── Startup: show wallet + top candidates ──
  console.log(`
╔═══════════════════════════════════════════╗
║         DLMM LP Agent — Ready             ║
╚═══════════════════════════════════════════╝
`);

  console.log("Fetching wallet and top pool candidates...\n");

  busy = true;
  try {
    const [wallet, positions, { candidates, total_eligible, total_screened }] = await Promise.all([
      getWalletBalances(),
      getMyPositions({ force: true }),
      getTopCandidates({ limit: 5 }),
    ]);

    setLatestCandidates(candidates);

    console.log(`Wallet:    ${wallet.sol} SOL  ($${wallet.sol_usd})  |  SOL price: $${wallet.sol_price}`);
    console.log(`Positions: ${positions.total_positions} open\n`);

    if (positions.total_positions > 0) {
      console.log("Open positions:");
      for (const p of positions.positions) {
        const status = p.in_range ? "in-range ✓" : "OUT OF RANGE ⚠";
        console.log(`  ${p.pair.padEnd(16)} ${status}  fees: $${p.unclaimed_fees_usd}`);
      }
      console.log();
    }

    console.log(`Top pools (${total_eligible} eligible from ${total_screened} screened):\n`);
    console.log(formatCandidates(candidates));

  } catch (e) {
    console.error(`Startup fetch failed: ${e.message}`);
  } finally {
    busy = false;
  }

  // Always start autonomous cycles on launch
  launchCron();
  maybeRunMissedBriefing().catch(() => { });

  startPolling(telegramHandler);

  console.log(`
Commands:
  1 / 2 / 3 ...  Deploy ${DEPLOY} SOL into that pool
  auto           Let the agent pick and deploy automatically
  /status        Refresh wallet + positions
  /candidates    Refresh top pool list
  /briefing      Show morning briefing (last 24h)
  /learn         Study top LPers from the best current pool and save lessons
  /learn <addr>  Study top LPers from a specific pool address
  /thresholds    Show current screening thresholds + performance stats
  /evolve        Manually trigger threshold evolution from performance data
  /stop          Shut down
`);

  rl.prompt();

  rl.on("line", async (line) => {
    const input = line.trim();
    if (!input) { rl.prompt(); return; }

    // ── Number pick: deploy into pool N ─────
    const pick = parseInt(input);
    const latest = getLatestCandidatesMeta().candidates;
    if (!isNaN(pick) && pick >= 1 && pick <= latest.length) {
      await runBusy(async () => {
        const pool = latest[pick - 1];
        console.log(`\nDeploying ${DEPLOY} SOL into ${pool.name}...\n`);
        const { content: reply } = await agentLoop(
          `Deploy ${DEPLOY} SOL into pool ${pool.pool} (${pool.name}). Call get_active_bin first then deploy_position. Report result.`,
          config.llm.maxSteps,
          [],
          "SCREENER"
        );
        console.log(`\n${reply}\n`);
        launchCron();
      });
      return;
    }

    // ── auto: agent picks and deploys ───────
    if (input.toLowerCase() === "auto") {
      await runBusy(async () => {
        console.log("\nAgent is picking and deploying...\n");
        const { content: reply } = await agentLoop(
          `get_top_candidates and deploy only if a candidate is clearly worth it. If there is only one weak candidate, report NO DEPLOY. For a valid deploy, use amount_y=${DEPLOY}, amount_x=0, bins_above=0, and bins_below from positive volatility. Execute now, don't ask.`,
          config.llm.maxSteps,
          [],
          "SCREENER"
        );
        console.log(`\n${reply}\n`);
        launchCron();
      });
      return;
    }

    // ── go: start cron without deploying ────
    if (input.toLowerCase() === "go") {
      launchCron();
      rl.prompt();
      return;
    }

    // ── Slash commands ───────────────────────
    if (input === "/stop") { await shutdown("user command"); return; }

    if (input === "/status") {
      await runBusy(async () => {
        const [wallet, positions] = await Promise.all([getWalletBalances(), getMyPositions({ force: true })]);
        console.log(`\nWallet: ${wallet.sol} SOL  ($${wallet.sol_usd})`);
        console.log(`Positions: ${positions.total_positions}`);
        for (const p of positions.positions) {
          const status = p.in_range ? "in-range ✓" : "OUT OF RANGE ⚠";
          console.log(`  ${p.pair.padEnd(16)} ${status}  fees: ${config.management.solMode ? "◎" : "$"}${p.unclaimed_fees_usd}`);
        }
        console.log();
      });
      return;
    }

    if (input === "/briefing") {
      await runBusy(async () => {
        const briefing = await generateBriefing();
        console.log(`\n${briefing.replace(/<[^>]*>/g, "")}\n`);
      });
      return;
    }

    if (input === "/candidates") {
      await runBusy(async () => {
        const { candidates, total_eligible, total_screened } = await getTopCandidates({ limit: 5 });
        setLatestCandidates(candidates);
        console.log(`\nTop pools (${total_eligible} eligible from ${total_screened} screened):\n`);
        console.log(formatCandidates(candidates));
        console.log();
      });
      return;
    }

    if (input === "/thresholds") {
      const s = config.screening;
      console.log("\nCurrent screening thresholds:");
      console.log(`  minFeeActiveTvlRatio: ${s.minFeeActiveTvlRatio}`);
      console.log(`  minOrganic:           ${s.minOrganic}`);
      console.log(`  minHolders:           ${s.minHolders}`);
      console.log(`  minTvl:               ${s.minTvl}`);
      console.log(`  maxTvl:               ${s.maxTvl}`);
      console.log(`  minVolume:            ${s.minVolume}`);
      console.log(`  minTokenFeesSol:      ${s.minTokenFeesSol}`);
      console.log(`  maxBundlePct:         ${s.maxBundlePct}`);
      console.log(`  maxBotHoldersPct:     ${s.maxBotHoldersPct}`);
      console.log(`  maxTop10Pct:          ${s.maxTop10Pct}`);
      console.log(`  timeframe:            ${s.timeframe}`);
      const perf = getPerformanceSummary();
      if (perf) {
        console.log(`\n  Based on ${perf.total_positions_closed} closed positions`);
        console.log(`  Win rate: ${perf.win_rate_pct}%  |  Avg PnL: ${perf.avg_pnl_pct}%`);
      } else {
        console.log("\n  No closed positions yet — thresholds are preset defaults.");
      }
      console.log();
      rl.prompt();
      return;
    }

    if (input.startsWith("/learn")) {
      await runBusy(async () => {
        const parts = input.split(" ");
        const poolArg = parts[1] || null;

        let poolsToStudy = [];

        if (poolArg) {
          poolsToStudy = [{ pool: poolArg, name: poolArg }];
        } else {
          // Fetch top 10 candidates across all eligible pools
          console.log("\nFetching top pool candidates to study...\n");
          const { candidates } = await getTopCandidates({ limit: 10 });
          if (!candidates.length) {
            console.log("No eligible pools found to study.\n");
            return;
          }
          poolsToStudy = candidates.map((c) => ({ pool: c.pool, name: c.name }));
        }

        console.log(`\nStudying top LPers across ${poolsToStudy.length} pools...\n`);
        for (const p of poolsToStudy) console.log(`  • ${p.name || p.pool}`);
        console.log();

        const poolList = poolsToStudy
          .map((p, i) => `${i + 1}. ${p.name} (${p.pool})`)
          .join("\n");

        const { content: reply } = await agentLoop(
          `Study top LPers across these ${poolsToStudy.length} pools by calling study_top_lpers for each:

${poolList}

For each pool, call study_top_lpers then move to the next. After studying all pools:
1. Identify patterns that appear across multiple pools (hold time, scalping vs holding, win rates).
2. Note pool-specific patterns where behaviour differs significantly.
3. Derive 4-8 concrete, actionable lessons using add_lesson. Prioritize cross-pool patterns — they're more reliable.
4. Summarize what you learned.

Focus on: hold duration, entry/exit timing, what win rates look like, whether scalpers or holders dominate.`,
          config.llm.maxSteps,
          [],
          "GENERAL"
        );
        console.log(`\n${reply}\n`);
      });
      return;
    }

    if (input === "/evolve") {
      await runBusy(async () => {
        const perf = getPerformanceSummary();
        if (!perf || perf.total_positions_closed < 5) {
          const needed = 5 - (perf?.total_positions_closed || 0);
          console.log(`\nNeed at least 5 closed positions to evolve. ${needed} more needed.\n`);
          return;
        }
        const fs = await import("fs");
        const lessonsData = JSON.parse(fs.default.readFileSync("./lessons.json", "utf8"));
        const result = evolveThresholds(lessonsData.performance, config);
        if (!result || Object.keys(result.changes).length === 0) {
          console.log("\nNo threshold changes needed — current settings already match performance data.\n");
        } else {
          reloadScreeningThresholds();
          console.log("\nThresholds evolved:");
          for (const [key, val] of Object.entries(result.changes)) {
            console.log(`  ${key}: ${result.rationale[key]}`);
          }
          console.log("\nSaved to user-config.json. Applied immediately.\n");
        }
      });
      return;
    }

    // ── Free-form chat ───────────────────────
    await runBusy(async () => {
      log("user", input);
      const { content } = await agentLoop(input, config.llm.maxSteps, sessionHistory, "GENERAL", config.llm.generalModel, null, { interactive: true });
      appendHistory(input, content);
      console.log(`\n${content}\n`);
    });
  });

  rl.on("close", () => shutdown("stdin closed"));

} else if (isMain && !DASHBOARD_ONLY) {
  // Non-TTY: start immediately
  log("startup", "Non-TTY mode — starting cron cycles immediately.");
  startCronJobs();
  maybeRunMissedBriefing().catch(() => { });
  startPolling(telegramHandler);
  (async () => {
    try {
      await runScreeningCycle({ silent: false });
    } catch (e) {
      log("startup_error", e.message);
    }
  })();
}
