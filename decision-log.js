import fs from "fs";
import { log } from "./logger.js";
import { deriveAddress } from "./tools/wallet.js";

const DECISION_LOG_FILE = "./decision-log.json";
const MAX_DECISIONS = 100;
const DECISION_TTL_MS = 48 * 60 * 60 * 1000; // 48 hours

function load() {
  if (!fs.existsSync(DECISION_LOG_FILE)) {
    return { decisions: [] };
  }
  try {
    return JSON.parse(fs.readFileSync(DECISION_LOG_FILE, "utf8"));
  } catch (error) {
    log("decision_log_warn", `Invalid ${DECISION_LOG_FILE}: ${error.message}`);
    return { decisions: [] };
  }
}

function save(data) {
  fs.writeFileSync(DECISION_LOG_FILE, JSON.stringify(data, null, 2));
}

/** Remove decisions older than DECISION_TTL_MS to save storage */
function pruneOldDecisions(data) {
  const cutoff = Date.now() - DECISION_TTL_MS;
  const before = data.decisions.length;
  data.decisions = data.decisions.filter((d) => {
    const ts = typeof d.ts === "string" ? new Date(d.ts).getTime() : (d.ts || 0);
    return ts >= cutoff;
  });
  const removed = before - data.decisions.length;
  if (removed > 0) {
    log("decision_log", `Pruned ${removed} old decision(s) (>48h). ${data.decisions.length} remaining.`);
  }
  return data;
}

function sanitize(value, maxLen = 280) {
  if (value == null) return null;
  return String(value).replace(/\s+/g, " ").trim().slice(0, maxLen) || null;
}

export function appendDecision(entry) {
  const data = load();
  const wal = entry.walletAddress || (process.env.WALLET_PRIVATE_KEY ? (deriveAddress(process.env.WALLET_PRIVATE_KEY) || "") : "");
  const decision = {
    id: `dec_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    ts: new Date().toISOString(),
    type: entry.type || "note",
    actor: entry.actor || "GENERAL",
    walletAddress: entry.walletAddress || wal || null,
    pool: entry.pool || null,
    pool_name: sanitize(entry.pool_name || entry.pool, 120),
    position: entry.position || null,
    summary: sanitize(entry.summary),
    reason: sanitize(entry.reason, 500),
    risks: Array.isArray(entry.risks) ? entry.risks.map((r) => sanitize(r, 140)).filter(Boolean).slice(0, 6) : [],
    metrics: entry.metrics || {},
    rejected: Array.isArray(entry.rejected) ? entry.rejected.map((r) => sanitize(r, 180)).filter(Boolean).slice(0, 8) : [],
  };
  data.decisions.unshift(decision);
  data.decisions = data.decisions.slice(0, MAX_DECISIONS);
  pruneOldDecisions(data);
  save(data);
  return decision;
}

export function getRecentDecisions(limit = 10) {
  const data = load();
  return (data.decisions || []).slice(0, limit);
}

export function getDecisionSummary(limit = 6) {
  const decisions = getRecentDecisions(limit);
  if (!decisions.length) return "No recent structured decisions yet.";
  return decisions.map((d, i) => {
    const bits = [
      `${i + 1}. [${d.actor}] ${d.type.toUpperCase()} ${d.pool_name || d.pool || "unknown pool"}`,
      d.summary ? `summary: ${d.summary}` : null,
      d.reason ? `reason: ${d.reason}` : null,
      d.risks?.length ? `risks: ${d.risks.join(", ")}` : null,
      d.rejected?.length ? `rejected: ${d.rejected.join(" | ")}` : null,
    ].filter(Boolean);
    return bits.join(" | ");
  }).join("\n");
}

/**
 * Analyze decision history and extract win rate, PnL, and loss/win patterns.
 * Returns formatted text for LLM context injection (Ide 4: Feedback Injection).
 */
export function getPatternSummary(limit = 30) {
  const data = load();
  const decisions = (data.decisions || []).slice(0, limit);
  if (!decisions.length) return null;

  const deploys = decisions.filter((d) => d.type === "deploy");
  const closes = decisions.filter((d) => d.type === "close_position");

  const withPnl = closes.filter((d) => d.metrics?.pnl_pct != null && isFinite(d.metrics.pnl_pct));
  const wins = withPnl.filter((d) => d.metrics.pnl_pct > 0);
  const losses = withPnl.filter((d) => d.metrics.pnl_pct <= 0);

  const totalPnlUsd = withPnl.reduce((s, d) => s + (Number(d.metrics.pnl_usd) || 0), 0);
  const totalFeesSol = withPnl.reduce((s, d) => s + (Number(d.metrics.fees_sol) || 0), 0);
  const avgHoldMin = withPnl.length
    ? (withPnl.reduce((s, d) => s + (Number(d.metrics.minutes_held) || 0), 0) / withPnl.length)
    : 0;

  const winRate = withPnl.length > 0 ? ((wins.length / withPnl.length) * 100) : null;

  // Recent closes (last 5) with details
  const recentCloses = withPnl.slice(0, 5).map((d) => {
    const sign = d.metrics.pnl_pct > 0 ? "+" : "";
    return `- ${d.pool_name || d.pool}: ${sign}${d.metrics.pnl_pct.toFixed(2)}% (${sign}$${(d.metrics.pnl_usd || 0).toFixed(2)}) | ${d.reason || "no reason"}`;
  });

  // Extract close reason clusters from losses
  const lossReasons = losses.map((d) => (d.reason || "").toLowerCase());
  const reasonCounts = Object.fromEntries(
    Object.entries(
      lossReasons.reduce((acc, r) => {
        for (const kw of ["oor", "out of range", "dump", "pump", "volume", "dying", "manual", "stop loss"]) {
          if (r.includes(kw)) acc[kw] = (acc[kw] || 0) + 1;
        }
        return acc;
      }, {})
    )
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
  );

  // Build pattern text
  let out = `TRACK RECORD (last ${data.decisions.length} decisions):\n`;
  out += `Deploys: ${deploys.length} | Closes: ${withPnl.length} (Wins: ${wins.length}, Losses: ${losses.length})\n`;
  if (winRate != null) out += `Win rate: ${winRate.toFixed(0)}%\n`;
  out += `Net PnL: $${totalPnlUsd.toFixed(2)} | Fees collected: ${totalFeesSol.toFixed(3)} SOL\n`;
  if (avgHoldMin > 0) out += `Avg hold: ${(avgHoldMin / 60).toFixed(1)} hours\n`;

  if (recentCloses.length > 0) {
    out += `\nRecent closes:\n${recentCloses.join("\n")}\n`;
  }

  if (Object.keys(reasonCounts).length > 0) {
    out += `\nLOSS CLUSTERS: ${Object.entries(reasonCounts).map(([k, v]) => `${v}x ${k}`).join(", ")}\n`;
  }

  // AVOID/PURSUE heuristics
  const recommendations = [];
  if (winRate != null && winRate < 30) {
    recommendations.push("⚠️ Low win rate — be selective. Skip pools with weak conviction.");
  } else if (winRate != null && winRate > 60) {
    recommendations.push("✅ Healthy win rate — maintain current selection criteria.");
  }
  if (totalPnlUsd < -5) {
    recommendations.push("⚠️ Net negative PnL — reconsider deploy criteria and bin widths.");
  }
  if (reasonCounts["oor"] >= 2 || reasonCounts["out of range"] >= 2) {
    recommendations.push("⚠️ Multiple OOR closures — bin range may be too narrow. Consider widening bins_below for volatile pools.");
  }
  if (reasonCounts["dump"] >= 2) {
    recommendations.push("⚠️ Multiple dump closures — avoid tokens showing early dump signals (low organic %, dev selling).");
  }
  if (wins.length > 0 && wins.every((d) => d.metrics.minutes_held > 90)) {
    recommendations.push("✅ Winners held 90+ min — patience pays. Don't panic-close early.");
  }

  if (recommendations.length > 0) {
    out += `\nPATTERN NOTES:\n${recommendations.join("\n")}\n`;
  }

  return out.trim();
}
