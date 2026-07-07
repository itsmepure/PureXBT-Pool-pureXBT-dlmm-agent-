/**
 * pureXBT Dashboard — HTTP API server + static UI host.
 *
 * Level B: Dashboard with state overview + control buttons.
 * Ready for Level C: Extend GET /api/history, /api/analytics etc.
 *
 * PORT: DASHBOARD_PORT env or 3000. Set "DASHBOARD_PASSWORD" for basic auth.
 * UI: serves dashboard-ui.html from same directory at GET /.
 */

import http from "http";
import https from "https";
import fs from "fs";
import path from "path";
import { spawn, execSync } from "child_process";
import { fileURLToPath } from "url";
import "dotenv/config";
import { log } from "./logger.js";
import { config } from "./config.js";
import { getTrackedPositions, getLastBriefingDate, setLastBriefingDate } from "./state.js";
import { getRecentDecisions } from "./decision-log.js";
import { getPerformanceHistory, reconcileClosedPnl } from "./lessons.js";
import { getMyPositions } from "./tools/dlmm.js";
import { getWalletBalances, deriveAddress, resetWallet } from "./tools/wallet.js";
import { resetDlmmWallet } from "./tools/dlmm.js";
import { executeTool , grantUserConfigOverride } from "./tools/executor.js";
import { agentLoop } from "./agent.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.DASHBOARD_PORT || "3000", 10);
const PASSWORD = process.env.DASHBOARD_PASSWORD || "";
const USER_CONFIG_PATH = path.join(__dirname, "user-config.json");
const UI_FILE = path.join(__dirname, "dashboard-ui.html");
const ENV_FILE = path.join(__dirname, ".env");
const USER_CONFIG_FILE = path.join(__dirname, "user-config.json");
const WALLETS_FILE = path.join(__dirname, "wallets.json");
const AGENT_PID_FILE = path.join(__dirname, ".agent-pid");
const CHAT_HISTORY_PATH = path.join(__dirname, "chat-history.json");
const POOL_MEMORY_FILE = path.join(__dirname, "pool-memory.json");
const CHAT_MAX_MESSAGES = 100;
const CHAT_MAX_STEPS = 15;
let _chatBusy = false;

function loadChatHistory(wallet) {
  try {
    if (fs.existsSync(CHAT_HISTORY_PATH)) {
      const data = JSON.parse(fs.readFileSync(CHAT_HISTORY_PATH, "utf8"));
      if (wallet) data.messages = data.messages.filter(m => (m.wallet || "") === wallet);
      return data;
    }
  } catch { }
  return { messages: [] };
}

function saveChatHistory(data) {
  try {
    while (data.messages.length > CHAT_MAX_MESSAGES) data.messages.shift();
    fs.writeFileSync(CHAT_HISTORY_PATH, JSON.stringify(data, null, 2));
  } catch (e) {
    log(`[CHAT] save error: ${e.message}`, "error");
  }
}

function formatToolSteps(result) {
  if (!result.trace || !Array.isArray(result.trace) || result.trace.length === 0) return "";
  const lines = ["\n<details><summary>Tool calls (" + result.trace.length + ")</summary>\n"];
  for (const step of result.trace) {
    const name = step.tool || step.name || "?";
    const ok = step.success ? "✓" : "✗";
    const out = String(step.output || "").split("\n")[0].slice(0, 120);
    lines.push(`- ${ok} \`${name}\` — ${out}`);
  }
  lines.push("\n</details>");
  return lines.join("\n");
}

async function handlePostChat(req, res) {
  if (!requireOwner(req, res)) return;
  const body = await parseBody(req);
  const message = String(body.message || "").trim();
  if (!message) return jsonReply(res, 400, { error: "Pesan tidak boleh kosong" });
  const wallet = String(body.wallet || "").trim();

  if (_chatBusy) return jsonReply(res, 429, { error: "Agent sedang memproses pesan lain. Tunggu sebentar." });

  const history = loadChatHistory(); // no filter — load ALL so sessionHistory is complete
  history.messages.push({ role: "user", content: message, wallet, ts: Date.now() });

  _chatBusy = true;
  const t0 = Date.now();
  try {
    log(`[CHAT] user: ${message.slice(0, 100)}${wallet ? " [" + wallet.slice(0, 6) + "]" : ""}`, "info");
    const sessionHistory = history.messages.slice(-20).map(m => ({
      role: m.role === "agent" ? "assistant" : m.role,
      content: m.content,
    }));

    // model = null → agentLoop picks config.llm.generalModel → .env LLM_MODEL
    const result = await agentLoop(
      message,
      CHAT_MAX_STEPS,
      sessionHistory.slice(0, -1),
      "GENERAL",
      null,
      4096,
      { interactive: true, source: "CHAT", wallet: wallet || undefined }
    );

    const finalText = result?.content || result?.finalAnswer || result?.output || "— tidak ada respons —";
    const steps = formatToolSteps(result?.result || result);
    const reply = finalText + (steps ? "\n" + steps : "");
    const ms = Date.now() - t0;

    history.messages.push({ role: "agent", content: reply, wallet, ts: Date.now(), ms, steps: (result?.result?.trace || result?.trace || []).length });
    saveChatHistory(history);

    log(`[CHAT] agent replied in ${ms}ms (${(result?.result?.trace || result?.trace || []).length} steps)`, "info");
    jsonReply(res, 200, {
      ok: true,
      reply,
      steps: (result?.result?.trace || result?.trace || []).length,
      ms,
    });
  } catch (e) {
    log(`[CHAT] error: ${e.message}`, "error");
    const errMsg = e.message.includes("<html") ? "LLM API gateway timeout — server sibuk, coba lagi dalam beberapa detik" : e.message;
    history.messages.push({ role: "agent", content: `⚠ Error: ${errMsg}`, wallet, ts: Date.now(), error: true });
    saveChatHistory(history);
    jsonReply(res, 500, { error: errMsg });
  } finally {
    _chatBusy = false;
  }
}

function handleGetChatHistory(req, res) {
  if (!requireOwner(req, res)) return;
  const url = new URL(req.url, "http://localhost");
  const wallet = (url.searchParams.get("wallet") || "").trim();
  const history = loadChatHistory(wallet || undefined);
  const messages = history.messages.map(m => ({
    role: m.role,
    content: m.content,
    ts: m.ts,
    ms: m.ms,
    steps: m.steps,
    error: m.error || false,
  }));
  jsonReply(res, 200, { ok: true, messages, busy: _chatBusy });
}

function handleDeleteChatHistory(req, res) {
  if (!requireOwner(req, res)) return;
  try { fs.unlinkSync(CHAT_HISTORY_PATH); } catch { }
  jsonReply(res, 200, { ok: true, cleared: true });
}

// ─── Helpers ────────────────────────────────────────────────────

function jsonReply(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify(data));
}

function parseBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      try { resolve(JSON.parse(body)); } catch { resolve(null); }
    });
  });
}

// Auth system with owner/preview roles
// Owner: Basic auth with DASHBOARD_PASSWORD (from .env)
// Preview: x-dashboard-role header = "preview" (no password needed)
function getRole(req) {
  const roleHeader = (req.headers["x-dashboard-role"] || "").toLowerCase();
  if (roleHeader === "preview") return "preview";
  if (!PASSWORD) return "owner";
  const auth = req.headers["authorization"] || "";
  const b64 = auth.replace("Basic ", "");
  const pw = Buffer.from(b64, "base64").toString("utf8").split(":")[1] || "";
  if (pw !== PASSWORD) return null;
  return "owner";
}

function requireOwner(req, res) {
  const role = getRole(req);
  if (role === "owner") return true;
  if (role === "preview") {
    res.writeHead(403, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify({ ok: false, error: "Forbidden — owner login required", role: "preview" }));
    return false;
  }
  res.writeHead(401, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify({ ok: false, error: "Unauthorized" }));
  return false;
}

function authCheck(req, res) {
  return requireOwner(req, res);
}

function getClientIP(req) {
  const xff = req.headers["x-forwarded-for"];
  return xff ? xff.split(",")[0].trim() : req.socket.remoteAddress;
}

function assertSafeEnvValue(name, value, maxLength = 500) {
  if (value == null) return "";
  const text = String(value).trim();
  if (text.length > maxLength) throw new Error(`${name} is too long`);
  if (/[\r\n]/.test(text)) throw new Error(`${name} must be a single line`);
  return text;
}

function maskSecret(value) {
  const text = String(value || "");
  if (!text) return "";
  if (text.length <= 8) return "********";
  return `${text.slice(0, 4)}...${text.slice(-4)}`;
}

function sanitizeForPreview(data) {
  if (!data || typeof data !== "object") return data;
  if (Array.isArray(data)) return data.map(sanitizeForPreview);
  const out = {};
  const SENSITIVE = new Set(["privateKey", "apiKey", "key", "secret", "password", "token", "maskedKey", "apiKeyMasked", "llm"]);
  for (const k of Object.keys(data)) {
    if (SENSITIVE.has(k) || k.toLowerCase().includes("key") || k.toLowerCase().includes("secret")) {
      out[k] = "*** PREVIEW MODE ***";
    } else if (typeof data[k] === "object" && data[k] !== null) {
      out[k] = sanitizeForPreview(data[k]);
    } else {
      out[k] = data[k];
    }
  }
  return out;
}

function readUserConfig() {
  try {
    if (!fs.existsSync(USER_CONFIG_FILE)) return {};
    return JSON.parse(fs.readFileSync(USER_CONFIG_FILE, "utf8"));
  } catch {
    return {};
  }
}

function writeUserConfig(nextConfig) {
  fs.writeFileSync(USER_CONFIG_FILE, JSON.stringify(nextConfig, null, 2) + "\n");
}

function writeEnvValues(values) {
  const existing = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, "utf8") : "";
  const lines = existing ? existing.split(/\r?\n/) : [];
  const handled = new Set();
  const next = lines.map((line) => {
    const match = line.match(/^#?\s*(LLM_BASE_URL|LLM_API_KEY|LLM_MODEL)=/);
    if (!match) return line;
    const key = match[1];
    handled.add(key);
    return `${key}=${values[key] ?? ""}`;
  });

  const missing = ["LLM_BASE_URL", "LLM_API_KEY", "LLM_MODEL"].filter((key) => !handled.has(key));
  if (missing.length) {
    if (next.length && next[next.length - 1] !== "") next.push("");
    next.push("# -- Dashboard custom LLM --");
    for (const key of missing) next.push(`${key}=${values[key] ?? ""}`);
  }
  fs.writeFileSync(ENV_FILE, next.join("\n").replace(/\n*$/, "\n"));
}

// ─── API: State ─────────────────────────────────────────────────

async function getBalanceForAddress(address) {
  try {
    const rpc = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getBalance", params: [address] });
    const res = await fetch(rpc, { method: "POST", headers: { "Content-Type": "application/json" }, body, signal: AbortSignal.timeout(5000) });
    const data = await res.json();
    if (data.result?.value !== undefined) return data.result.value / 1e9;
  } catch {}
  return null;
}

// ─── API: State ─────────────────────────────────────────────────
const _stateCache = { ts: 0, payload: null };
const STATE_CACHE_MS = 1_000; // serve cached state for 1s (matches dashboard poll interval)

async function handleState(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const walletFilter = url.searchParams.get("wallet") || "";
  const role = getRole(req);
  // Auto-bust cache when pool-memory.json was recently updated (deploy/close event)
  let forceRefresh = url.searchParams.get("force") === "1";
  if (!forceRefresh && fs.existsSync(POOL_MEMORY_FILE)) {
    try {
      const mtime = fs.statSync(POOL_MEMORY_FILE).mtimeMs;
      if (Date.now() - mtime < 20_000) forceRefresh = true;
    } catch (_) { /* skip */ }
  }
  // serve from cache when fresh and no force trigger
  if (role !== "preview" && !forceRefresh && _stateCache.payload && (Date.now() - _stateCache.ts) < STATE_CACHE_MS) {
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(_stateCache.payload);
    return;
  }
  try {
    const envKey = process.env.WALLET_PRIVATE_KEY || "";
    const envAddr = envKey ? (deriveAddress(envKey) || "") : "";
    const posOpts = (walletFilter && walletFilter !== "all") ? { wallet_address: walletFilter } : {};
    const [posResult, balances, tracked] = await Promise.all([
      getMyPositions({ ...posOpts, force: forceRefresh }).catch(() => ({ positions: [], wallet: null })),
      getWalletBalances().catch(() => ({ sol: 0, sol_price: 0, tokens: [] })),
      getTrackedPositions(true) || {},
    ]);

    // When wallet=all, also query positions for registered non-primary wallets
    let extraPositions = [];
    if (!walletFilter || walletFilter === "all") {
      const regWallets = loadWallets();
      const nonPrimaryWallets = regWallets.filter(w => w.address !== envAddr);
      if (nonPrimaryWallets.length > 0) {
        const extraResults = await Promise.all(
          nonPrimaryWallets.map(w =>
            getMyPositions({ wallet_address: w.address, force: forceRefresh }).catch(() => ({ positions: [], wallet: w.address }))
          )
        );
        extraPositions = extraResults.flatMap(r => {
          const raw = (r && Array.isArray(r.positions)) ? r.positions : [];
          return raw.map(p => ({ ...p, _wallet: r.wallet }));
        });
      }
    }
    const rawPositions = [
      ...((posResult && Array.isArray(posResult.positions)) ? posResult.positions : []),
      ...extraPositions,
    ];
    const queryWallet = posResult?.wallet || null;
    const enriched = rawPositions.map((p, i) => {
      const addr = p.position || p.address || p.publicKey?.toBase58?.();
      // Meteora PnL API uses different field names than Meteora SDK
      const pnlPct = p.pnl_pct_change ?? p.pnlPctChange ?? p.pnl_pct ?? p.pnlPct ?? (p.pnl?.percentage ?? null);
      const pnlUsd = p.pnl_usd ?? p.pnlUsd ?? p.pnl?.usd ?? null;
      const pnlSuspicious = p.pnl_pct_suspicious === true; /* __PNLRENDER__ */
      const pnlSol = p.pnl_sol ?? p.pnlSol ?? p.pnl?.sol ?? null;
      const valueUsd = p.value_usd ?? p.total_value ?? p.valueUsd ?? p.totalDeposit ?? null;
      const feesUsd = p.unclaimed_fees_usd ?? p.feesUsd ?? p.fees?.usd ?? null;
      const feesSol = p.unclaimed_fees_sol ?? p.feesSol ?? p.fees?.sol ?? null;
      const inRange = p.in_range !== false && p.inRange !== false;
      const status = p.status || (!inRange ? "OOR" : "IN_RANGE");
      let t = tracked.find(tr => tr.position === addr || tr.position === p.position) || {};
      if (!t.pool_name && !t.pool && addr && addr !== "0") {
        // Direct lookup: search tracked array by comparing all entries' position field (fallback for array format)
        for (const entry of tracked) {
          if (entry.position === addr || entry.position === p.position) { t = entry; break; }
        }
      }
      // Compute hold time from deployed_at (state.json) or age_minutes (Meteora API)
      const ageFromPosNum = typeof p.age_minutes === "number" ? Math.round(p.age_minutes) : null;
      const ageFromTracked = t.deployed_at
        ? Math.round((Date.now() - new Date(t.deployed_at).getTime()) / 60000)
        : null;
      const holdMinutes = ageFromPosNum ?? ageFromTracked ?? 0;

      // NOTE: removed index-based fallback — it matched wrong positions (index != wallet)
      return {
        wallet: p._wallet || queryWallet || p.wallet || null,
        address: (addr && addr !== "0") ? addr : (Object.entries(tracked).filter(([, v]) => !v.closed)[i]?.[0] || "0"),
        pool: p.pool || p.poolAddress || p.pool_address || null,
        poolName: p.pair || t.pool_name || null,
        pnlPct: (pnlSuspicious || typeof pnlPct !== "number") ? null : parseFloat(pnlPct.toFixed(2)),
        pnlSol: typeof pnlSol === "number" ? parseFloat(pnlSol.toFixed(4)) : null,
        pnlUsd: (pnlSuspicious || typeof pnlUsd !== "number") ? null : parseFloat(pnlUsd.toFixed(2)),
        valueUsd: typeof valueUsd === "number" ? parseFloat(valueUsd.toFixed(2)) : null,
        feesUsd: typeof feesUsd === "number" ? parseFloat(feesUsd.toFixed(2)) : null,
        feesSol: (() => {
          const solNum = typeof feesSol === "number" ? feesSol : null;
          if (solNum != null && solNum > 0) return parseFloat(solNum.toFixed(4));
          if (typeof feesUsd === "number" && feesUsd > 0 && balances?.sol_price > 0) return parseFloat((feesUsd / balances.sol_price).toFixed(4));
          return solNum != null ? parseFloat(solNum.toFixed(4)) : null;
        })(),
        status,
        binRange: t.bin_range || { min: null, max: null },
        activeBin: typeof p.activeBin === "number" ? p.activeBin : null,
        binStep: t.bin_step || null,
        isOOR: t.out_of_range_since != null,
        oorSince: t.out_of_range_since || null,
        deployedAt: t.deployed_at || null,
        notes: Array.isArray(t.notes) ? t.notes.slice(-3) : [],
        peakPnlPct: t.peak_pnl_pct || 0,
        strategy: t.strategy || null,
        deployAmountSol: (() => {
          const v = t.amount_sol;
          if (typeof v === 'number') return v;
          try {
            const raw = fs.readFileSync("./state.json", "utf8");
            const st = JSON.parse(raw);
            const positions = st.positions || {};
            const key = Object.keys(positions).find(k => k === addr || k === p.position);
            return key ? positions[key].amount_sol ?? null : null;
          } catch { return null; }
        })(),
        holdMinutes,
      };
    });

    // Fallback: if Meteora API returned no positions, show tracked ones from state.json
    if (enriched.length === 0 && Object.keys(tracked).length > 0) {
      const isSpecificWallet = walletFilter && walletFilter !== "all";
      const trackedArr = Object.entries(tracked)
        .filter(([, t]) => !t.closed)
        .filter(([, t]) => !isSpecificWallet || t.wallet === walletFilter)
        .map(([addr, t]) => ({
          wallet: t.wallet || queryWallet || null,
          address: addr,
          pool: t.pool || null,
          poolName: t.pool_name || null,
          pnlPct: t.peak_pnl_pct || 0,
          pnlSol: null,
          pnlUsd: null,
          valueUsd: t.initial_value_usd || null,
          feesUsd: t.total_fees_claimed_usd || 0,
          feesSol: (t.total_fees_claimed_usd && balances?.sol_price > 0 ? parseFloat(((t.total_fees_claimed_usd || 0) / balances.sol_price).toFixed(4)) : null),
          status: t.out_of_range_since ? "OOR" : "IN_RANGE",
          binRange: t.bin_range || { min: null, max: null },
          activeBin: t.active_bin_at_deploy || null,
          binStep: t.bin_step || null,
          isOOR: t.out_of_range_since != null,
          oorSince: t.out_of_range_since || null,
          deployedAt: t.deployed_at || null,
          notes: Array.isArray(t.notes) ? t.notes.slice(-3) : [],
          peakPnlPct: t.peak_pnl_pct || 0,
          strategy: t.strategy || null,
          deployAmountSol: t.amount_sol || null,
          holdMinutes: t.deployed_at ? Math.round((Date.now() - new Date(t.deployed_at).getTime()) / 60000) : 0,
          // compute unrealized PnL from pnlPct * valueUsd when pnlUsd is not available
          pnlUsd: t.initial_value_usd && t.peak_pnl_pct ? Math.round(t.initial_value_usd * t.peak_pnl_pct) / 100 : 0,
        }));
      enriched.push(...trackedArr);
    }

    // Final wallet filter: only return positions owned by the requested wallet
    if (walletFilter && walletFilter !== "all") {
      for (let i = enriched.length - 1; i >= 0; i--) {
        if (enriched[i].wallet !== walletFilter) enriched.splice(i, 1);
      }
    }

    const closedCount = Object.values(tracked).filter((t) => t.closed).length;
    const openPnlUsd = enriched.reduce((sum, p) => sum + (Number(p.pnlUsd) || 0), 0);

    // per-wallet balance: if filtering non-primary wallet, fetch via RPC
    let balanceSol = balances.sol ?? 0;
    if (walletFilter) {
      if (envAddr && !walletFilter.toLowerCase().startsWith(envAddr.toLowerCase().slice(0,12))) {
        const alt = await getBalanceForAddress(walletFilter);
        if (alt != null) balanceSol = alt;
      }
    } else {
      // "all wallets" — sum balances from ALL registered wallets
      const regWallets = loadWallets();
      for (const w of regWallets) {
        // skip duplicate of primary wallet (primary is already in balances.sol)
        if (envAddr && w.address === envAddr) continue;
        const alt = await getBalanceForAddress(w.address);
        if (alt != null) balanceSol += alt;
      }
    }

    // compute realized PnL + win rate from lessons.json (permanent position history)
    const perfHistory = getPerformanceHistory({ hours: 999999, limit: 10000 });
    const perfPositions = perfHistory.positions || [];
    let realizedPnlUsd = 0, totalCloses = 0, wonCloses = 0;
    for (const r of perfPositions) {
      totalCloses++;
      const pnl = r.pnl_usd ?? 0;
      realizedPnlUsd += Number(pnl) || 0;
      if ((Number(pnl) || 0) > 0) wonCloses++;
    }
    const winRate = totalCloses > 0 ? Math.round((wonCloses / totalCloses) * 100) : 0;

    // deploy count from pool-memory.json
    let totalDeploys = 0;
    try {
      const poolDb = JSON.parse(fs.readFileSync(POOL_MEMORY_FILE, "utf8"));
      if (poolDb && typeof poolDb === "object") {
        for (const pool of Object.values(poolDb)) {
          totalDeploys += pool.total_deploys || 0;
        }
      }
    } catch (_) { /* pool-memory unavailable */ }
    const totalPnlUsd = openPnlUsd + realizedPnlUsd;

    const payload = {
      ok: true,
      dryRun: process.env.DRY_RUN === "true",
      balanceSol,
      solPrice: balances.sol_price || 0,
      tokens: balances.tokens || [],
      positions: enriched,
      positionCount: enriched.length,
      closedCount,
      openPnlUsd: Math.round(openPnlUsd * 100) / 100,
      realizedPnlUsd: Math.round(realizedPnlUsd * 100) / 100,
      usdIdrRate: _usdIdrRate, /* __IDR__ */
      totalPnlUsd: Math.round(totalPnlUsd * 100) / 100,
      winRate,
      totalDeploys,
      wallet: walletFilter || "all",
      wallets: [...new Set([...loadWallets().map(w=>w.address), envAddr, ...getRecentDecisions(500).map(d=>d.walletAddress).filter(Boolean)].filter(Boolean))],
      maxPositions: config.risk?.maxPositions ?? 3,
      stopLossPct: config.management?.stopLossPct ?? -50,
      takeProfitPct: config.management?.takeProfitPct ?? 5,
      dailyStopCount: 0,
      dailyStopDate: "",
      lastUpdated: new Date().toISOString(),
    };
    if (role === "preview") {
      payload.positions = (payload.positions || []).map(p => ({ ...p, address: "***", wallet: "***" }));
    }
    const payloadJson = JSON.stringify(payload);
    if (role !== "preview") {
      _stateCache.payload = payloadJson;
      _stateCache.ts = Date.now();
    }
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(payloadJson);
  } catch (err) {
    jsonReply(res, 500, { ok: false, error: err.message });
  }
}

// ─── API: Config ────────────────────────────────────────────────

function handleGetConfig(req, res) {
  const safe = {
    risk: { ...config.risk },
    screening: { ...config.screening },
    management: { ...config.management },
    schedule: { ...config.schedule },
    llm: { ...config.llm },
    jupiter: config.jupiter ? { ...config.jupiter } : {},
    hiveMind: { enabled: !!(config.hiveMind?.url && config.hiveMind.url !== "https://api.agentmeridian.xyz") },
  };
  const role = getRole(req);
  if (role === "preview") {
    safe.llm = sanitizeForPreview(safe.llm);
    safe.hiveMind = { enabled: safe.hiveMind.enabled, note: "*** PREVIEW MODE ***" };
  }
  jsonReply(res, 200, { ok: true, config: safe });
}

async function handlePostConfig(req, res) {
  if (!requireOwner(req, res)) return;
  const body = await parseBody(req);
  const changes = body?.changes || (body?.key ? { [body.key]: body.value } : body);
  if (!changes || typeof changes !== "object" || Array.isArray(changes)) {
    return jsonReply(res, 400, { ok: false, error: "Missing config changes in body" });
  }
  try {
    const result = await (grantUserConfigOverride(), executeTool)("update_config", { /* __USERONLY__ jalur user */
      changes,
      reason: body?.reason || "dashboard_config",
    });
    jsonReply(res, 200, { ok: result?.success !== false, result });
  } catch (err) {
    jsonReply(res, 500, { ok: false, error: err.message });
  }
}

// ─── API: Custom LLM ─────────────────────────────────────────────

function handleGetLLM(req, res) {
  if (getRole(req) === "preview") return jsonReply(res, 200, { ok: true, llm: { baseUrl: "*** PREVIEW MODE ***", apiKeySet: false, apiKeyMasked: "*** PREVIEW MODE ***", model: "*** PREVIEW MODE ***", managementModel: "*** PREVIEW MODE ***", screeningModel: "*** PREVIEW MODE ***", generalModel: "*** PREVIEW MODE ***", restartRequired: true, note: "Preview mode — LLM config hidden" }});
  const apiKey = process.env.LLM_API_KEY || process.env.OPENROUTER_API_KEY || "";
  const activeModel = process.env.LLM_MODEL || config.llm?.generalModel || "";
  jsonReply(res, 200, {
    ok: true,
    llm: {
      baseUrl: process.env.LLM_BASE_URL || "https://openrouter.ai/api/v1",
      apiKeySet: !!apiKey,
      apiKeyMasked: maskSecret(apiKey),
      model: activeModel,
      managementModel: config.llm?.managementModel || activeModel,
      screeningModel: config.llm?.screeningModel || activeModel,
      generalModel: config.llm?.generalModel || activeModel,
      restartRequired: true,
    },
  });
}

async function handlePostLLM(req, res) {
  if (!requireOwner(req, res)) return;
  const body = await parseBody(req);
  if (!body || typeof body !== "object") {
    return jsonReply(res, 400, { ok: false, error: "Invalid JSON body" });
  }

  try {
    const baseUrl = assertSafeEnvValue("LLM_BASE_URL", body.baseUrl || body.LLM_BASE_URL || "", 300);
    const model = assertSafeEnvValue("LLM_MODEL", body.model || body.LLM_MODEL || "", 200);
    const apiKey = assertSafeEnvValue("LLM_API_KEY", body.apiKey || body.LLM_API_KEY || "", 500);
    if (!model) return jsonReply(res, 400, { ok: false, error: "LLM_MODEL is required" });

    const userConfig = readUserConfig();
    userConfig.llmBaseUrl = baseUrl;
    userConfig.llmModel = model;
    userConfig.managementModel = model;
    userConfig.screeningModel = model;
    userConfig.generalModel = model;
    if (apiKey) userConfig.llmApiKey = apiKey;
    writeUserConfig(userConfig);

    process.env.LLM_BASE_URL = baseUrl;
    process.env.LLM_MODEL = model;
    if (apiKey) process.env.LLM_API_KEY = apiKey;
    config.llm.managementModel = model;
    config.llm.screeningModel = model;
    config.llm.generalModel = model;

    writeEnvValues({
      LLM_BASE_URL: baseUrl,
      LLM_API_KEY: apiKey || process.env.LLM_API_KEY || "",
      LLM_MODEL: model,
    });

    jsonReply(res, 200, {
      ok: true,
      llm: {
        baseUrl,
        apiKeySet: !!(apiKey || process.env.LLM_API_KEY),
        apiKeyMasked: maskSecret(apiKey || process.env.LLM_API_KEY || ""),
        model,
        restartRequired: true,
      },
      message: "LLM config saved. Restart the agent/dashboard for base URL and API key changes to fully apply.",
    });
  } catch (err) {
    jsonReply(res, 400, { ok: false, error: err.message });
  }
}

// ─── API: Decisions ─────────────────────────────────────────────

function handleDecisions(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const limit = parseInt(url.searchParams.get("limit") || "30", 10);
  const wallet = url.searchParams.get("wallet") || "";
  try {
    const envKey = process.env.WALLET_PRIVATE_KEY || "";
    const envAddr = envKey ? (deriveAddress(envKey) || "") : "";
    let decisions = getRecentDecisions(limit);
    if (wallet && wallet !== "all") {
      const envAddrDerived = envAddr.toLowerCase().slice(0, 12);
      decisions = decisions.filter((d) => {
        const dw = (d.walletAddress || "").toLowerCase();
        return dw.startsWith(wallet.toLowerCase().slice(0, 12)) || (!dw && envAddrDerived === wallet.toLowerCase().slice(0, 12));
      });
    }
    decisions = decisions.map((d) => ({
      ...d,
      walletAddress: d.walletAddress || envAddr || null,
    }));
    jsonReply(res, 200, { ok: true, decisions, count: decisions.length, wallet: wallet || "all" });
  } catch (err) {
    jsonReply(res, 500, { ok: false, error: err.message });
  }
}

// ─── API: Activity Stats ─────────────────────────────────────────

const STAT_PERIODS = { "6h": 6, "1d": 24, "7d": 168, "14d": 336, "1m": 720 };

function handleStats(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const period = url.searchParams.get("period") || "1d";
  const wallet = url.searchParams.get("wallet") || "";
  const fromParam = url.searchParams.get("from") || null;
  const toParam = url.searchParams.get("to") || null;

  let cutoffDate, endDate;
  if (fromParam) {
    cutoffDate = new Date(fromParam);
    if (isNaN(cutoffDate.getTime())) cutoffDate = new Date(Date.now() - 24 * 60 * 60 * 1000);
    if (toParam) {
      endDate = new Date(toParam);
      if (isNaN(endDate.getTime())) endDate = new Date();
      else endDate.setHours(23, 59, 59, 999); // end of day
    } else {
      endDate = new Date();
    }
    if (endDate < cutoffDate) { const tmp = cutoffDate; cutoffDate = endDate; endDate = tmp; }
  } else {
    const h = STAT_PERIODS[period] || 24;
    cutoffDate = new Date(Date.now() - h * 60 * 60 * 1000);
    endDate = new Date();
  }
  const hours = Math.max(1, Math.ceil((endDate - cutoffDate) / (60 * 60 * 1000)));

  try {
    const envKey = process.env.WALLET_PRIVATE_KEY || "";
    const envAddr = envKey ? (deriveAddress(envKey) || "") : "";

    // Closed positions from lessons.json (permanent history)
    const perfHistory = getPerformanceHistory({ hours, limit: 10000 });
    const perfPositions = perfHistory.positions || [];
    let closes = 0, totalPnlUsd = 0, totalFeesUsd = 0, won = 0, lost = 0;
    for (const r of perfPositions) {
      if (fromParam) {
        const closeDate = new Date(r.closed_at || r.close_date || r.timestamp || 0);
        if (closeDate < cutoffDate || closeDate > endDate) continue;
      }
      closes++;
      const pnl = r.pnl_usd ?? 0;
      const fees = r.fees_earned_usd ?? 0;
      totalPnlUsd += Number(pnl) || 0;
      totalFeesUsd += Number(fees) || 0;
      if ((Number(pnl) || 0) > 0) won++;
      else lost++;
    }

    // Deploy count from pool-memory.json filtered by period
    let deploys = 0;
    try {
      const poolDb = JSON.parse(fs.readFileSync(POOL_MEMORY_FILE, "utf8"));
      if (poolDb && typeof poolDb === "object") {
        for (const pool of Object.values(poolDb)) {
          if (pool.deploys && Array.isArray(pool.deploys)) {
            for (const d of pool.deploys) {
              const deployDate = new Date(d.deployed_at || d.timestamp);
              if (deployDate < cutoffDate) continue;
              if (deployDate > endDate) continue;
              deploys++;
            }
          }
        }
      }
    } catch (_) { /* pool-memory unavailable */ }

    // Wallet list from decision-log + known wallets
    const allDecisions = getRecentDecisions(500);

    jsonReply(res, 200, {
      ok: true,
      period,
      wallet: wallet || "all",
      hours,
      cutoff: cutoffDate.toISOString(),
      end: endDate.toISOString(),
      stats: {
        deploys, closes, won, lost,
        winRate: closes > 0 ? Math.round((won / closes) * 100) : 0,
        totalPnlUsd: Math.round(totalPnlUsd * 100) / 100,
        totalFeesUsd: Math.round(totalFeesUsd * 100) / 100,
        totalProfits: Math.round((totalPnlUsd + totalFeesUsd) * 100) / 100,
      },
      wallets: [...new Set([...loadWallets().map(w=>w.address), envAddr, ...allDecisions.map((d) => d.walletAddress).filter(Boolean)].filter(Boolean))],
      periods: Object.keys(STAT_PERIODS),
    });
  } catch (err) {
    jsonReply(res, 500, { ok: false, error: err.message });
  }
}

// ─── API: Position History ──────────────────────────────────────

async function handleHistory(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const wallet = url.searchParams.get("wallet") || "";

  try {
    const envKey = process.env.WALLET_PRIVATE_KEY || "";
    const envAddr = envKey ? (deriveAddress(envKey) || "") : "";

    // 1. Fetch live on-chain positions for ALL wallets
    const regWallets = loadWallets();
    const allAddrs = [envAddr, ...regWallets.map(w => w.address)].filter(Boolean);
    const onChainResults = await Promise.all(
      allAddrs.map(addr =>
        getMyPositions({ wallet_address: addr, silent: true }).catch(() => ({ positions: [], wallet: addr }))
      )
    );
    const liveSet = new Set();
    for (const r of onChainResults) {
      for (const p of ((r && Array.isArray(r.positions)) ? r.positions : [])) {
        const a = p.position || p.address || "";
        if (a) liveSet.add(a.toLowerCase());
      }
    }

    // 2. Tracked positions from state.json (may be empty after external closes)
    const tracked = getTrackedPositions(false) || [];
    const trackedArr = Array.isArray(tracked) ? tracked : Object.values(tracked);
    const trackedMap = new Map();
    for (const pos of trackedArr) {
      const key = (pos.position || "").toLowerCase();
      if (key) trackedMap.set(key, pos);
    }

    // 3. Recover phantom positions: deploys in decision-log not present in state.json
    const decisions = getRecentDecisions(500);
    const phantoms = [];
    for (const d of decisions) {
      if (d.type === "deploy" || d.action === "deploy") {
        const posAddr = (d.position || "").toLowerCase();
        if (posAddr && !trackedMap.has(posAddr)) {
          phantoms.push({
            position: d.position,
            pool_name: d.pool_name || d.pool || "",
            strategy: d.strategy || "spot",
            amount_sol: d.amount_sol || d.metrics?.deploy_sol || 0.25,
            deployed_at: d.ts,
            wallet: d.walletAddress || "",
            closed: true,
            _phantom: true,
          });
        }
      }
    }

    // 4. Close-event lookup from decision-log (has actual PnL data)
    // Prefer the entry with real metrics — duplicate closes (e.g. GENERAL then MANAGER) can have $0 fees
    const closeMap = {};
    for (const d of decisions) {
      if (d.type === "close" || d.action === "close") {
        const key = (d.position || "").toLowerCase();
        const existing = closeMap[key];
        if (!existing) { closeMap[key] = d; continue; }
        // Prefer entry with non-zero metrics (MANAGER close has real PnL, GENERAL close may have $0)
        const dPnl = Number(d.metrics?.pnl_usd) || 0;
        const dFees = Number(d.metrics?.fees_usd) || 0;
        const ePnl = Number(existing.metrics?.pnl_usd) || 0;
        const eFees = Number(existing.metrics?.fees_usd) || 0;
        // Keep the one with more data (non-zero pnl or fees)
        if ((dPnl !== 0 || dFees !== 0) && (ePnl === 0 && eFees === 0)) {
          closeMap[key] = d;
        } else if ((dPnl !== 0 || dFees !== 0) && (ePnl !== 0 || eFees !== 0)) {
          // Both have data — keep the one with higher absolute pnl (more reliable close)
          if (Math.abs(dPnl) > Math.abs(ePnl)) closeMap[key] = d;
          // Tie on PnL (duplicate close events have identical pnl_usd): keep the one
          // that actually carries fees. Otherwise the fees=0 sibling wins and the
          // Fees column renders $0. (Fixed 2026-06-12)
          else if (Math.abs(dPnl) === Math.abs(ePnl) && dFees > eFees) closeMap[key] = d;
        }
      }
    }

    // 4b. Aggregate claim events for fee tracking per position
    const claimsMap = {};
    for (const d of decisions) {
      if (d.type === "claim") {
        const key2 = (d.position || "").toLowerCase();
        if (!claimsMap[key2]) claimsMap[key2] = [];
        claimsMap[key2].push(d);
      }
    }

    // 5. Combine tracked + phantom, build rows with on-chain reconciliation
    const allRows = [...trackedArr, ...phantoms];
    const rows = [];
    let wins = 0, losses = 0, totalPnl = 0, totalFees = 0;

    for (const pos of allRows) {
      const addr = pos.position || "";
      const posWallet = (pos.wallet || "").toLowerCase();

      // Wallet filter
      if (wallet) {
        const filterPrefix = wallet.toLowerCase().slice(0, 12);
        const envPrefix = envAddr.toLowerCase().slice(0, 12);
        const matches = posWallet.startsWith(filterPrefix) || (!posWallet && envPrefix === filterPrefix);
        if (!matches) continue;
      }

      const closeEv = closeMap[addr.toLowerCase()];
      const isOnChain = liveSet.has(addr.toLowerCase());
      const isClosed = pos.closed || !isOnChain;

      // Determine status + reason
      let status, reason;
      if (!isClosed) {
        status = "open";
        reason = (Array.isArray(pos.notes) ? pos.notes[pos.notes.length - 1] : pos.notes) || "";
      } else if (pos.closed) {
        status = "closed";
        reason = (Array.isArray(pos.notes) ? pos.notes[pos.notes.length - 1] : pos.notes) || closeEv?.reason || "";
      } else {
        status = "externally_closed";
        reason = "not on-chain — closed via Meteora UI or manually";
      }

      // Append claim fee info to reason (from decision-log claim events)
      const posClaims = claimsMap[addr.toLowerCase()];
      let totalClaimedFees = 0, claimCount = 0;
      if (posClaims && posClaims.length > 0) {
        totalClaimedFees = posClaims.reduce((s, c) => s + (Number(c.metrics?.fees_usd) || 0), 0);
        claimCount = posClaims.length;
        if (totalClaimedFees > 0) {
          const parts = [];
          if (reason) parts.push(reason);
          parts.push(claimCount > 1
            ? `${claimCount} claims = $${totalClaimedFees.toFixed(2)} fees`
            : `Claimed $${totalClaimedFees.toFixed(2)} fees`);
          reason = parts.join(" · ");
        }
      }

      // PnL from close event > live state > pos fields
      const pnlUsd = closeEv?.metrics?.pnl_usd ?? closeEv?.metrics?.pnlUsd ?? pos.pnl_usd ?? 0;
      const pnlPct = closeEv?.metrics?.pnl_pct ?? closeEv?.metrics?.pnlPct ?? pos.pnl_pct ?? pos.peak_pnl_pct ?? 0;
      let feesUsd = closeEv?.metrics?.fees_usd ?? closeEv?.metrics?.feesUsd ?? pos.total_fees_claimed_usd ?? pos.fees_usd ?? 0;
      feesUsd += totalClaimedFees;
      let holdMin = closeEv?.metrics?.minutes_held ?? closeEv?.metrics?.minutesHeld ?? pos.hold_minutes ?? null;

      if (holdMin == null && pos.deployed_at) {
        const start = new Date(pos.deployed_at).getTime();
        const end = pos.closed_at ? new Date(pos.closed_at).getTime() : Date.now();
        holdMin = Math.round((end - start) / 60000);
      }

      if (isClosed) {
        totalPnl += Number(pnlUsd) || 0;
        totalFees += Number(feesUsd) || 0;
        if (closeEv) {
          if ((Number(pnlUsd) || 0) > 0) wins++;
          else losses++;
        }
      }

      rows.push({
        pool: pos.pool_name || addr.slice(0, 8) + "...",
        pool_address: addr,
        strategy: pos.strategy || "spot",
        deploy_sol: pos.amount_sol || pos.deploy_amount_sol || 0,
        pnl_usd: Number(pnlUsd) || 0,
        pnl_pct: Number(pnlPct) || 0,
        fees_usd: Number(feesUsd) || 0,
        hold_minutes: holdMin || 0,
        peak_pnl: pos.peak_pnl_pct || 0,
        status,
        reason,
        deployed_at: pos.deployed_at || "",
        wallet: pos.wallet || envAddr || "",
      });
    }

    // Estimate PnL from pool-memory snapshots for externally_closed positions
    try {
      if (fs.existsSync(POOL_MEMORY_FILE)) {
        const poolMem = JSON.parse(fs.readFileSync(POOL_MEMORY_FILE, "utf8"));
        for (const row of rows) {
          if (row.status !== "externally_closed") continue;
          for (const pool of Object.values(poolMem)) {
            if (!pool?.snapshots?.length) continue;
            const match = pool.snapshots
              .filter(s => s.position && s.position.toLowerCase() === row.pool_address.toLowerCase())
              .sort((a, b) => new Date(b.ts || 0) - new Date(a.ts || 0));
            if (!match.length) continue;
            const last = match[0];
            const estPnl = Number(last.pnl_pct) || 0;
            const estUsd = Number(last.pnl_usd) || 0;
            const estFees = Number(last.unclaimed_fees_usd) || 0;
          if (estPnl || estUsd) {
            row.pnl_pct = Math.round(estPnl * 100) / 100;
            row.pnl_usd = Math.round(estUsd * 100) / 100;
            row.fees_usd = Math.round(estFees * 100) / 100;
            row.reason = `(estimated from pool memory) ${row.reason || ""}`.trim();
            totalPnl += Number(estUsd) || 0;
            totalFees += Number(estFees) || 0;
          }
            break;
          }
        }
      }
    } catch (_) { /* pool-memory unavailable, skip estimation */ }

    rows.sort((a, b) => new Date(b.deployed_at || 0) - new Date(a.deployed_at || 0));

    const closed = wins + losses;
    const winRate = closed > 0 ? Math.round((wins / closed) * 100) : 0;

    jsonReply(res, 200, {
      ok: true,
      history: rows,
      summary: { total: rows.length, wins, losses, winRate, totalPnlUsd: Math.round(totalPnl * 100) / 100, totalFeesUsd: Math.round(totalFees * 100) / 100 },
    });
  } catch (err) {
    jsonReply(res, 500, { ok: false, error: err.message });
  }
}

// ═══════════════════════════════════════════════════════════════
// API: Equity Curve — aggregated cumulative PnL over time
// GET /api/equity-curve?timeframe=7D&wallet=&base=0
// ═══════════════════════════════════════════════════════════════

async function handleEquityCurve(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const timeframe = url.searchParams.get("timeframe") || "7D";
  const walletParam = url.searchParams.get("wallet") || "";
  const baseEquity = parseFloat(url.searchParams.get("base") || "0") || 0;

  const PERIOD_HOURS = { "1D": 24, "7D": 168, "30D": 720, "90D": 2160, "1Y": 8760, "ALL": 999999 };
  const GROUP_INTERVAL = { "1D": 3, "7D": 6, "30D": 24, "90D": 72, "1Y": 168, "ALL": 720 };
  const hours = PERIOD_HOURS[timeframe] || 168;

  try {
    const allHistory = getPerformanceHistory({ hours: Math.max(hours, 8760), limit: 10000 });
    let positions = (allHistory.positions || []).slice();

    // Filter by timeframe
    const cutoff = Date.now() - hours * 3600000;
    positions = positions.filter(r => {
      const ts = new Date(r.closed_at || r.close_date || r.timestamp || 0).getTime();
      return ts >= cutoff;
    });

    // Filter by wallet if specified
    if (walletParam && walletParam !== "all") {
      const decisions = getRecentDecisions(5000);
      const poolWallets = {};
      for (const d of decisions) {
        if (d.walletAddress && d.pool) poolWallets[d.pool.toLowerCase()] = d.walletAddress;
      }
      positions = positions.filter(r => {
        const key = (r.pool || "").toLowerCase();
        return poolWallets[key] === walletParam;
      });
    }

    // Sort oldest first
    positions.sort((a, b) => {
      const ta = new Date(a.closed_at || a.close_date || 0).getTime();
      const tb = new Date(b.closed_at || b.close_date || 0).getTime();
      return ta - tb;
    });

    if (positions.length === 0) {
      return jsonReply(res, 200, {
        ok: true, timeframe, empty: true,
        summary: {
          startingEquity: Math.round(baseEquity * 100) / 100,
          endingEquity: Math.round(baseEquity * 100) / 100,
          totalPnl: 0, totalFees: 0, returnPct: 0, winRate: 0,
          totalPositions: 0, openPositions: 0, maxDrawdown: 0,
        },
        series: [],
      });
    }

    // Build raw data points
    const rawPoints = positions.map(r => ({
      ts: new Date(r.closed_at || r.close_date || 0).getTime(),
      tsIso: new Date(r.closed_at || r.close_date || 0).toISOString(),
      pnl: Number(r.pnl_usd) || 0,
      fees: Number(r.fees_earned_usd) || 0,
      pool: r.pool_name || r.pool || "",
    }));

    // Aggregate into interval buckets
    const intervalMs = (GROUP_INTERVAL[timeframe] || 24) * 3600000;
    let cumPnl = 0, bucketPnl = 0, bucketFees = 0;
    let bucketTs = rawPoints[0].ts, bucketCount = 0;
    const series = [];

    for (const p of rawPoints) {
      if (bucketCount > 0 && p.ts - bucketTs > intervalMs) {
        series.push({
          ts: bucketTs, tsIso: new Date(bucketTs).toISOString(),
          pnl: Math.round(bucketPnl * 100) / 100,
          fees: Math.round(bucketFees * 100) / 100,
          cumPnl: Math.round(cumPnl * 100) / 100,
          equity: Math.round((baseEquity + cumPnl) * 100) / 100,
          count: bucketCount,
        });
        bucketPnl = 0; bucketFees = 0; bucketTs = p.ts; bucketCount = 0;
      }
      cumPnl += p.pnl; bucketPnl += p.pnl; bucketFees += p.fees;
      if (bucketCount === 0 && p.ts < bucketTs) bucketTs = p.ts;
      bucketCount++;
    }
    if (bucketCount > 0) {
      series.push({
        ts: bucketTs, tsIso: new Date(bucketTs).toISOString(),
        pnl: Math.round(bucketPnl * 100) / 100,
        fees: Math.round(bucketFees * 100) / 100,
        cumPnl: Math.round(cumPnl * 100) / 100,
        equity: Math.round((baseEquity + cumPnl) * 100) / 100,
        count: bucketCount,
      });
    }

    // Summary stats
    const totalPnl = rawPoints.reduce((s, r) => s + r.pnl, 0);
    const totalFees = rawPoints.reduce((s, r) => s + r.fees, 0);
    const wins = rawPoints.filter(r => r.pnl > 0).length;

    // Max drawdown from peak
    let peak = 0, maxDD = 0, running = 0;
    for (const r of rawPoints) {
      running += r.pnl;
      if (running > peak) peak = running;
      if (peak - running > maxDD) maxDD = peak - running;
    }

    // Open positions count
    const tracked = getTrackedPositions();
    const openCount = tracked.filter(p => !p.closed_at && p.status !== "closed").length;

    jsonReply(res, 200, {
      ok: true, timeframe,
      summary: {
        startingEquity: Math.round(baseEquity * 100) / 100,
        endingEquity: Math.round((baseEquity + running) * 100) / 100,
        totalPnl: Math.round(totalPnl * 100) / 100,
        totalFees: Math.round(totalFees * 100) / 100,
        returnPct: baseEquity > 0 ? Math.round((running / baseEquity) * 10000) / 100 : 0,
        winRate: positions.length > 0 ? Math.round((wins / positions.length) * 100) : 0,
        totalPositions: positions.length,
        openPositions: openCount,
        maxDrawdown: Math.round(maxDD * 100) / 100,
      },
      series,
    });
  } catch (err) {
    jsonReply(res, 500, { ok: false, error: err.message });
  }
}

// ��� API: Logs ��������������������������������������������������

function handleLogs(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const lines = parseInt(url.searchParams.get("lines") || "50", 10);
  const wallet = url.searchParams.get("wallet") || "";
  const today = new Date().toISOString().slice(0, 10);
  const logFile = path.resolve(`./logs/agent-${today}.log`);
  try {
    if (!fs.existsSync(logFile)) return jsonReply(res, 200, { ok: true, lines: [], total: 0 });
    const raw = fs.readFileSync(logFile, "utf8");
    const all = raw.split("\n").filter(Boolean);
    let filtered = all;
    if (wallet && wallet !== "all") {
      const addr = wallet.toLowerCase().slice(0, 12); // match first 12 chars
      filtered = all.filter((l) => {
        const lower = l.toLowerCase();
        // match [wallet] or wallet: prefix, or just the address somewhere
        return lower.includes(addr) || lower.includes(`wallet: ${addr}`);
      });
    }
    const recent = filtered.slice(-Math.min(lines, 200));
    const clean = recent.map((l) => (l.length > 300 ? l.slice(0, 300) + "..." : l));
    jsonReply(res, 200, { ok: true, lines: clean, total: filtered.length, wallet: wallet || "all" });
  } catch (err) {
    jsonReply(res, 500, { ok: false, error: err.message });
  }
}

// ─── API: Actions ───────────────────────────────────────────────

function resolveActionWallet(targetAddress) {
  if (!targetAddress || targetAddress === "" || targetAddress === "all") return null;
  const wallets = loadWallets();
  const found = wallets.find((w) => w.address === targetAddress);
  return found || null;
}

async function handleAction(req, res) {
  if (!requireOwner(req, res)) return;
  const body = await parseBody(req);
  if (!body || !body.action) {
    return jsonReply(res, 400, { ok: false, error: "Missing 'action' in body" });
  }
  const { action, position, pool, reason, wallet: walletTarget } = body;
  const ip = getClientIP(req);

  // Temporarily switch wallet key if a specific non-primary wallet was selected
  const originalKey = process.env.WALLET_PRIVATE_KEY;
  const originalLLMBase = process.env.LLM_BASE_URL;
  const originalLLMKey = process.env.LLM_API_KEY;
  const originalLLMModel = process.env.LLM_MODEL;
  const walletEntry = resolveActionWallet(walletTarget);
  if (walletEntry) {
    process.env.WALLET_PRIVATE_KEY = walletEntry.key;
    resetWallet();
    resetDlmmWallet();
    applyWalletLLM(walletEntry.llm || null);
    log("dashboard", `Switched to wallet ${walletEntry.name} (${walletTarget.slice(0, 8)}..) for action ${action} from ${ip}`);
  }

  try {
    let result;
    switch (action) {
      case "screen":
        log("dashboard", `Manual screening triggered from ${ip}`);
        result = await agentLoop(
          "Screen for new liquidity pool candidates and evaluate deployment opportunities",
          config.llm.maxSteps, [], "SCREENER");
        break;

      case "manage":
        log("dashboard", `Manual management triggered from ${ip}`);
        result = await agentLoop(
          "Review all open positions and decide whether to stay, close (stop-loss/take-profit/OOR), or redeploy",
          config.llm.maxSteps, [], "MANAGER");
        break;

      case "close":
        if (!position) return jsonReply(res, 400, { ok: false, error: "Missing 'position' address" });
        log("dashboard", `Manual close of ${position} from ${ip}`);
        result = await executeTool("close_position", {
          position_address: position,
          reason: reason || "manual_close_from_dashboard",
        });
        break;

      case "claim":
        if (!position) return jsonReply(res, 400, { ok: false, error: "Missing 'position' address" });
        log("dashboard", `Manual claim on ${position} from ${ip}`);
        result = await executeTool("claim_fees", { position_address: position });
        break;

      case "briefing":
        log("dashboard", `Manual briefing request from ${ip}`);
        result = await agentLoop(
          "Generate a concise performance briefing. Include: total PnL today, open positions status, recent decisions summary, key risks or alerts.",
          config.llm.maxSteps, [], "GENERAL");
        break;

      default:
        return jsonReply(res, 400, { ok: false, error: `Unknown action: ${action}. Valid: screen, manage, close, claim, briefing` });
    }
    jsonReply(res, 200, { ok: true, action, result: typeof result === "string" ? result.slice(0, 2000) : result });
  } catch (err) {
    log("dashboard_error", `Action ${action} failed: ${err.message}`);
    jsonReply(res, 500, { ok: false, error: err.message });
  } finally {
    // Restore primary wallet key + LLM (both in-memory AND .env file)
    if (walletEntry) {
      process.env.WALLET_PRIVATE_KEY = originalKey;
      if (originalLLMBase !== undefined) process.env.LLM_BASE_URL = originalLLMBase; else delete process.env.LLM_BASE_URL;
      if (originalLLMKey !== undefined) process.env.LLM_API_KEY = originalLLMKey; else delete process.env.LLM_API_KEY;
      if (originalLLMModel !== undefined) process.env.LLM_MODEL = originalLLMModel; else delete process.env.LLM_MODEL;
      writeEnvValues({
        LLM_BASE_URL: process.env.LLM_BASE_URL || "",
        LLM_API_KEY: process.env.LLM_API_KEY || "",
        LLM_MODEL: process.env.LLM_MODEL || "",
      });
      resetWallet();
      resetDlmmWallet();
      log("dashboard", `Restored primary wallet after action ${action}`);
    }
  }
}

// ─── API: LLM Status ────────────────────────────────────────────

let _llmStatusCache = { ok: false, model: "", error: null, checked: 0 };

function getLLMProviderInfo() {
  const activeWallet = getActiveWallet();
  // per-wallet LLM takes priority
  if (activeWallet?.llm?.apiKey) {
    return {
      apiKey: activeWallet.llm.apiKey,
      baseUrl: (activeWallet.llm.baseUrl || process.env.LLM_BASE_URL || "https://openrouter.ai/api/v1").replace(/\/+$/, ""),
      model: activeWallet.llm.model || process.env.LLM_MODEL || config.llm?.generalModel || "",
      fromWallet: true,
    };
  }
  const apiKey = process.env.LLM_API_KEY || process.env.OPENROUTER_API_KEY || "";
  const baseUrl = (process.env.LLM_BASE_URL || "https://openrouter.ai/api/v1").replace(/\/+$/, "");
  const model = process.env.LLM_MODEL || config.llm?.generalModel || "";
  return { apiKey, baseUrl, model, fromWallet: false };
}

async function probeLLMProvider(baseUrl, apiKey) {
  const url = new URL(`${baseUrl}/models`);
  const mod = url.protocol === "https:" ? https : http;

  return new Promise((resolve) => {
    const req = mod.request(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "User-Agent": "pureXBT-Dashboard/1.0",
      },
      timeout: 5000,
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        if (res.statusCode === 200) {
          resolve({ ok: true, status: res.statusCode, error: null });
        } else if (res.statusCode === 401 || res.statusCode === 403) {
          resolve({ ok: false, status: res.statusCode, error: `Auth failed (${res.statusCode}) — cek API key` });
        } else {
          resolve({ ok: false, status: res.statusCode, error: `HTTP ${res.statusCode}` });
        }
      });
    });
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, status: null, error: "Timeout — provider unreachable" });
    });
    req.on("error", (err) => {
      resolve({ ok: false, status: null, error: err.code === "ECONNREFUSED" ? "Connection refused — URL salah atau provider down" : err.code === "ENOTFOUND" ? "DNS not found — cek base URL" : err.message });
    });
    req.end();
  });
}

async function handleLLMStatus(req, res) {
  const { apiKey, baseUrl, model } = getLLMProviderInfo();
  const cacheAge = Date.now() - _llmStatusCache.checked;

  // return cached if fresh (<30s) and same model
  if (cacheAge < 30000 && _llmStatusCache.model === model && _llmStatusCache.checked) {
    return jsonReply(res, 200, _llmStatusCache);
  }

  if (!apiKey) {
    _llmStatusCache = { ok: false, model, error: "No API key set — isi LLM_API_KEY di dashboard atau .env", checked: Date.now() };
    return jsonReply(res, 200, _llmStatusCache);
  }

  _llmStatusCache.checked = Date.now();
  _llmStatusCache.model = model;
  try {
    const result = await probeLLMProvider(baseUrl, apiKey);
    _llmStatusCache.ok = result.ok;
    _llmStatusCache.error = result.error;
    _llmStatusCache.status = result.status;
    jsonReply(res, 200, _llmStatusCache);
  } catch {
    _llmStatusCache.ok = false;
    _llmStatusCache.error = "Unknown probe error";
    jsonReply(res, 200, _llmStatusCache);
  }
}

// ─── API: Wallet Manager ─────────────────────────────────────────

function loadWallets() {
  try {
    if (!fs.existsSync(WALLETS_FILE)) return [];
    return JSON.parse(fs.readFileSync(WALLETS_FILE, "utf8"));
  } catch { return []; }
}

function saveWallets(wallets) {
  fs.writeFileSync(WALLETS_FILE, JSON.stringify(wallets, null, 2) + "\n");
}

function maskKey(key) {
  if (!key || key.length < 8) return "***";
  return `${key.slice(0,4)}...${key.slice(-4)}`;
}

function setActiveWalletPk(privateKey) {
  process.env.WALLET_PRIVATE_KEY = privateKey;
  resetWallet();
  resetDlmmWallet();
  // persist to .env
  const env = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, "utf8") : "";
  const lines = env.split(/\r?\n/);
  let found = false;
  const next = lines.map((line) => {
    if (line.match(/^#?\s*WALLET_PRIVATE_KEY=/)) { found = true; return `WALLET_PRIVATE_KEY=${privateKey}`; }
    return line;
  });
  if (!found) next.push(`WALLET_PRIVATE_KEY=${privateKey}`);
  fs.writeFileSync(ENV_FILE, next.join("\n").replace(/\n*$/, "\n"));
}

function applyWalletLLM(llm) {
  if (!llm) return;
  if (llm.baseUrl) process.env.LLM_BASE_URL = llm.baseUrl;
  if (llm.apiKey) process.env.LLM_API_KEY = llm.apiKey;
  if (llm.model) {
    process.env.LLM_MODEL = llm.model;
    config.llm.managementModel = llm.model;
    config.llm.screeningModel = llm.model;
    config.llm.generalModel = llm.model;
  }
  writeEnvValues({
    LLM_BASE_URL: process.env.LLM_BASE_URL || "",
    LLM_API_KEY: process.env.LLM_API_KEY || "",
    LLM_MODEL: process.env.LLM_MODEL || "",
  });
  // Invalidate LLM status cache
  _llmStatusCache.checked = 0;
}

function getActiveWallet() {
  const wallets = loadWallets();
  return wallets.find((w) => w.key === process.env.WALLET_PRIVATE_KEY) || null;
}

function handleGetWallets(req, res) {
  const wallets = loadWallets();
  const envKey = process.env.WALLET_PRIVATE_KEY || "";
  const envAddr = envKey ? (deriveAddress(envKey) || "") : "";

  // Auto-import .env wallet if not already in wallets.json
  if (envAddr && !wallets.some((w) => w.key === envKey)) {
    wallets.unshift({
      id: "_env",
      name: "Primary (.env)",
      key: envKey,
      address: envAddr,
      active: true,
      createdAt: null,
      llm: null,
      config: {},
    });
  }

  const safe = wallets.map((w) => ({
    id: w.id,
    name: w.name,
    address: w.address,
    maskedKey: maskKey(w.key),
    active: w.key === process.env.WALLET_PRIVATE_KEY,
    createdAt: w.createdAt,
    envWallet: w.id === "_env",
    llm: w.llm ? {
      baseUrl: w.llm.baseUrl || "",
      apiKeySet: !!w.llm.apiKey,
      model: w.llm.model || "",
    } : null,
    running: w.id !== "_env"
      ? (w.running && isProcessAlive(w.running.pid) ? { pid: w.running.pid, startedAt: w.running.startedAt } : null)
      : (getAgentRunningInfo() || null),
    config: w.config || {},
  }));
  const role = getRole(req);
  if (role === "preview") {
    const final = safe.map(w => ({ id: w.id, name: w.name, address: "*** PREVIEW MODE ***", maskedKey: "*** PREVIEW MODE ***", active: false, createdAt: w.createdAt, envWallet: w.envWallet, llm: null, running: null, config: {} }));
    return jsonReply(res, 200, { ok: true, wallets: final });
  }
  jsonReply(res, 200, { ok: true, wallets: safe });
}

async function handlePostWallet(req, res) {
  if (!requireOwner(req, res)) return;
  const body = await parseBody(req);
  if (!body || !body.privateKey) {
    return jsonReply(res, 400, { ok: false, error: "privateKey is required" });
  }
  const pk = String(body.privateKey).trim();
  const address = deriveAddress(pk);
  if (!address) {
    return jsonReply(res, 400, { ok: false, error: "Invalid private key — cannot decode" });
  }

  const wallets = loadWallets();
  // check dup
  if (wallets.some((w) => w.key === pk)) {
    return jsonReply(res, 409, { ok: false, error: "Wallet already exists" });
  }

  const wallet = {
    id: `w_${Date.now()}_${Math.random().toString(36).slice(2,6)}`,
    name: (body.name || `Wallet ${wallets.length + 1}`).trim(),
    key: pk,
    address,
    active: false,
    createdAt: new Date().toISOString(),
    llm: null,
  };

  // per-wallet LLM config
  if (body.llm && (body.llm.baseUrl || body.llm.apiKey || body.llm.model)) {
    wallet.llm = {
      baseUrl: (body.llm.baseUrl || "").trim(),
      apiKey: (body.llm.apiKey || "").trim(),
      model: (body.llm.model || "").trim(),
    };
  }

  if (body.setActive !== false) {
    wallet.active = true;
    wallets.forEach((w) => { w.active = false; });
    setActiveWalletPk(pk);
    if (wallet.llm) applyWalletLLM(wallet.llm);
  }

  wallets.push(wallet);
  saveWallets(wallets);

  log("dashboard", `Wallet added: ${address.slice(0,8)}... (${wallet.name})`);
  jsonReply(res, 200, {
    ok: true,
    wallet: {
      id: wallet.id,
      name: wallet.name,
      address: wallet.address,
      maskedKey: maskKey(wallet.key),
      active: wallet.active,
      createdAt: wallet.createdAt,
    },
  });
}

async function handleActivateWallet(req, res) {
  if (!requireOwner(req, res)) return;
  const walletId = req.url.split("/").pop();
  const wallets = loadWallets();
  const wallet = wallets.find((w) => w.id === walletId);
  if (!wallet) return jsonReply(res, 404, { ok: false, error: "Wallet not found" });

  wallets.forEach((w) => { w.active = (w.id === walletId); });
  saveWallets(wallets);
  setActiveWalletPk(wallet.key);
  if (wallet.llm) applyWalletLLM(wallet.llm);
  log("dashboard", `Wallet activated: ${wallet.address.slice(0,8)}...`);
  jsonReply(res, 200, { ok: true, address: wallet.address, name: wallet.name });
}

async function handlePostWalletLLM(req, res) {
  if (!requireOwner(req, res)) return;
  const walletId = req.url.replace(/\/llm$/, "").split("/").pop();
  const body = await parseBody(req);
  if (!body || typeof body !== "object") {
    return jsonReply(res, 400, { ok: false, error: "LLM config object required" });
  }
  const wallets = loadWallets();
  const wallet = wallets.find((w) => w.id === walletId);
  if (!wallet) return jsonReply(res, 404, { ok: false, error: "Wallet not found" });

  wallet.llm = wallet.llm || {};
  if (body.baseUrl !== undefined) wallet.llm.baseUrl = body.baseUrl || undefined;
  if (body.apiKey !== undefined) wallet.llm.apiKey = body.apiKey || undefined;
  if (body.model !== undefined) wallet.llm.model = body.model || undefined;

  if (!wallet.llm.baseUrl && !wallet.llm.apiKey && !wallet.llm.model) delete wallet.llm;

  saveWallets(wallets);
  log("dashboard", `Wallet LLM updated: ${wallet.address.slice(0,8)}...`);
  jsonReply(res, 200, { ok: true, llm: wallet.llm || null });
}

async function handleDeleteWallet(req, res) {
  if (!requireOwner(req, res)) return;
  const walletId = req.url.split("/").pop();
  const wallets = loadWallets();
  if (walletId === "_env") return jsonReply(res, 400, { ok: false, error: "Cannot delete .env primary wallet" });
  const idx = wallets.findIndex((w) => w.id === walletId);
  if (idx === -1) return jsonReply(res, 404, { ok: false, error: "Wallet not found" });

  const removed = wallets.splice(idx, 1)[0];
  const wasActive = removed.key === process.env.WALLET_PRIVATE_KEY;

  // stop running instance
  if (removed.running && isProcessAlive(removed.running.pid)) {
    try { process.kill(removed.running.pid); } catch {}
  }
  // clean env file
  try { fs.unlinkSync(getWalletEnvPath(removed.id)); } catch {}
  if (wasActive && wallets.length > 0) {
    wallets[0].active = true;
    setActiveWalletPk(wallets[0].key);
  } else if (wasActive) {
    setActiveWalletPk("");
  }
  saveWallets(wallets);
  log("dashboard", `Wallet removed: ${removed.address.slice(0,8)}...`);
  jsonReply(res, 200, { ok: true, wasActive });
}

// ─── Per-Wallet Agent Instances ──────────────────────────────────

function getWalletEnvPath(walletId) {
  return path.join(__dirname, `.env.w_${walletId}`);
}

function generateWalletEnv(wallet) {
  const baseEnv = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, "utf8") : "";
  const lines = baseEnv.split(/\r?\n/);
  const out = [];
  let inLlms = false;

  for (const line of lines) {
    // Replace wallet key
    if (line.match(/^#?\s*WALLET_PRIVATE_KEY=/)) {
      out.push(`WALLET_PRIVATE_KEY=${wallet.key}`);
      continue;
    }
    // Replace LLM if wallet has custom LLM
    if (wallet.llm?.baseUrl && line.match(/^#?\s*LLM_BASE_URL=/)) {
      out.push(`LLM_BASE_URL=${wallet.llm.baseUrl}`);
      continue;
    }
    if (wallet.llm?.apiKey && line.match(/^#?\s*LLM_API_KEY=/)) {
      out.push(`LLM_API_KEY=${wallet.llm.apiKey}`);
      continue;
    }
    if (wallet.llm?.model && line.match(/^#?\s*LLM_MODEL=/)) {
      out.push(`LLM_MODEL=${wallet.llm.model}`);
      continue;
    }
    out.push(line);
  }

  // Append missing LLM vars
  if (wallet.llm) {
    if (wallet.llm.baseUrl && !out.some((l) => l.startsWith("LLM_BASE_URL="))) {
      out.push(`LLM_BASE_URL=${wallet.llm.baseUrl}`);
    }
    if (wallet.llm.apiKey && !out.some((l) => l.startsWith("LLM_API_KEY="))) {
      out.push(`LLM_API_KEY=${wallet.llm.apiKey}`);
    }
    if (wallet.llm.model && !out.some((l) => l.startsWith("LLM_MODEL="))) {
      out.push(`LLM_MODEL=${wallet.llm.model}`);
    }
  }

  const envPath = getWalletEnvPath(wallet.id);
  fs.writeFileSync(envPath, out.join("\n").replace(/\n*$/, "\n"));
  return envPath;
}

function isProcessAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

const PM2_AGENT_NAME = "pureXBT";
const ECOSYSTEM_PATH = path.join(__dirname, "ecosystem.config.cjs");

function getPM2AgentInfo() {
  try {
    const raw = execSync("pm2 jlist", { encoding: "utf8", timeout: 5000 });
    const procs = JSON.parse(raw);
    const agent = procs.find((p) => p.name === PM2_AGENT_NAME);
    if (agent && agent.pm2_env?.status === "online") {
      return {
        pid: agent.pid,
        startedAt: agent.pm2_env?.pm_uptime
          ? new Date(agent.pm2_env.pm_uptime).toISOString()
          : null,
      };
    }
  } catch {}
  return null;
}

function getAgentRunningInfo() {
  const pm2 = getPM2AgentInfo();
  if (pm2) return pm2;
  if (_primaryAgent && isProcessAlive(_primaryAgent.pid)) {
    return { pid: _primaryAgent.pid, startedAt: _primaryAgent.startedAt };
  }
  return null;
}

// ─── Agent Start/Stop ───────────────────────────────────────────

function restoreAgentPid() {
  try {
    if (!fs.existsSync(AGENT_PID_FILE)) return;
    const raw = fs.readFileSync(AGENT_PID_FILE, "utf8").trim();
    const pid = parseInt(raw, 10);
    if (pid && isProcessAlive(pid)) {
      _primaryAgent = { pid, startedAt: null };
      log("dashboard", `Restored agent pid ${pid}`);
    } else {
      try { fs.unlinkSync(AGENT_PID_FILE); } catch {}
    }
  } catch {}
}

function getAgentStatus(req, res) {
  const info = getAgentRunningInfo();
  jsonReply(res, 200, {
    ok: true,
    running: !!info,
    pid: info ? info.pid : null,
    startedAt: info ? info.startedAt : null,
  });
}

async function handleStartAgent(req, res) {
  if (!requireOwner(req, res)) return;
  const info = getAgentRunningInfo();
  if (info) {
    return jsonReply(res, 200, { ok: true, running: true, pid: info.pid, message: "Already running" });
  }
  // Clean up stale PID file
  _primaryAgent = null;
  try { fs.unlinkSync(AGENT_PID_FILE); } catch {}
  try {
    const agentEnv = { ...process.env };
    delete agentEnv.DASHBOARD_ONLY;
    agentEnv.AGENT_NO_DASHBOARD = "1";
    try { execSync(`pm2 delete ${PM2_AGENT_NAME}`, { timeout: 10000, stdio: "ignore", env: agentEnv }); } catch {}
    execSync(`pm2 start ${ECOSYSTEM_PATH} --only ${PM2_AGENT_NAME}`, { timeout: 15000, env: agentEnv });
    log("dashboard", `Agent started via PM2 (${PM2_AGENT_NAME})`);
    await new Promise((r) => setTimeout(r, 1500));
    const newInfo = getPM2AgentInfo();
    jsonReply(res, 200, {
      ok: true,
      running: true,
      pid: newInfo?.pid || null,
      startedAt: newInfo?.startedAt || null,
      message: "Agent started via PM2",
    });
  } catch (err) {
    jsonReply(res, 500, { ok: false, error: `PM2 start failed: ${err.message}` });
  }
}

async function handleStopAgent(req, res) {
  if (!requireOwner(req, res)) return;
  const info = getAgentRunningInfo();
  if (!info) {
    _primaryAgent = null;
    try { fs.unlinkSync(AGENT_PID_FILE); } catch {}
    return jsonReply(res, 200, { ok: true, running: false, message: "Not running" });
  }
  try {
    execSync(`pm2 stop ${PM2_AGENT_NAME}`, { timeout: 10000 });
    _primaryAgent = null;
    try { fs.unlinkSync(AGENT_PID_FILE); } catch {}
    log("dashboard", `Agent stopped via PM2 (${PM2_AGENT_NAME})`);
    jsonReply(res, 200, { ok: true, running: false, message: "Agent stopped via PM2" });
  } catch (err) {
    // Fallback: kill directly if PM2 fails
    try {
      if (_primaryAgent && isProcessAlive(_primaryAgent.pid)) {
        process.kill(_primaryAgent.pid, "SIGKILL");
      }
      _primaryAgent = null;
      try { fs.unlinkSync(AGENT_PID_FILE); } catch {}
      log("dashboard", "Agent stopped (direct kill)");
      jsonReply(res, 200, { ok: true, running: false, message: "Stopped" });
    } catch (err2) {
      jsonReply(res, 500, { ok: false, error: err2.message });
    }
  }
}

async function handleStartWallet(req, res) {
  if (!requireOwner(req, res)) return;
  const walletId = req.url.replace(/\/start$/, "").split("/").pop();
  const wallets = loadWallets();
  const wallet = wallets.find((w) => w.id === walletId);
  if (!wallet) return jsonReply(res, 404, { ok: false, error: "Wallet not found" });

  // Check if already running
  if (wallet.running && isProcessAlive(wallet.running.pid)) {
    return jsonReply(res, 200, { ok: true, running: true, pid: wallet.running.pid, message: "Already running" });
  }

  try {
    const walletEnv = { ...process.env, WALLET_PRIVATE_KEY: wallet.key, WALLET_ID: wallet.address };
    if (wallet.llm) {
      if (wallet.llm.baseUrl) walletEnv.LLM_BASE_URL = wallet.llm.baseUrl;
      if (wallet.llm.apiKey) walletEnv.LLM_API_KEY = wallet.llm.apiKey;
      if (wallet.llm.model) walletEnv.LLM_MODEL = wallet.llm.model;
    }
    // never inherit OPENROUTER_API_KEY if wallet has its own LLM key
    if (wallet.llm?.apiKey) delete walletEnv.OPENROUTER_API_KEY;
    delete walletEnv.pm_exec_path; // remove PM2 entrypoint so child detects isMain correctly

    const child = spawn("node", ["index.js"], {
      cwd: __dirname,
      env: walletEnv,
      stdio: "ignore",
      detached: true,
    });

    child.unref();
    wallet.running = { pid: child.pid, startedAt: new Date().toISOString() };
    saveWallets(wallets);

    log("dashboard", `Wallet instance started: ${wallet.name} (pid ${child.pid})`);
    jsonReply(res, 200, { ok: true, running: true, pid: child.pid, address: wallet.address, name: wallet.name });
  } catch (err) {
    jsonReply(res, 500, { ok: false, error: err.message });
  }
}

async function handleStopWallet(req, res) {
  if (!requireOwner(req, res)) return;
  const walletId = req.url.replace(/\/stop$/, "").split("/").pop();
  const wallets = loadWallets();
  const wallet = wallets.find((w) => w.id === walletId);
  if (!wallet) return jsonReply(res, 404, { ok: false, error: "Wallet not found" });

  if (!wallet.running) {
    return jsonReply(res, 200, { ok: true, running: false, message: "Not running" });
  }

  try {
    if (isProcessAlive(wallet.running.pid)) {
      process.kill(wallet.running.pid);
      // force kill after 5s if still hanging
      setTimeout(() => {
        try { process.kill(wallet.running.pid, "SIGKILL"); } catch {}
      }, 5000);
    }
    wallet.running = null;
    saveWallets(wallets);

    // Clean up env file
    const envPath = getWalletEnvPath(walletId);
    try { fs.unlinkSync(envPath); } catch {}

    log("dashboard", `Wallet instance stopped: ${wallet.name}`);
    jsonReply(res, 200, { ok: true, running: false, message: "Stopped" });
  } catch (err) {
    jsonReply(res, 500, { ok: false, error: err.message });
  }
}

function resolveWallet(walletId) {
  // wallets.json entries
  const wallets = loadWallets();
  const wallet = wallets.find((w) => w.id === walletId);
  if (wallet) return wallet;
  // primary .env wallet
  if (walletId === "_env") {
    const envKey = process.env.WALLET_PRIVATE_KEY || "";
    const envAddr = envKey ? (deriveAddress(envKey) || "") : "";
    if (!envAddr) return null;
    return { id: "_env", name: "Primary (.env)", key: envKey, address: envAddr, active: true };
  }
  return null;
}

async function handleGetWalletConfig(req, res) {
  if (!requireOwner(req, res)) return;
  const walletId = req.url.replace(/\/config(\?.*)?$/, "").split("/").pop();
  const wallet = resolveWallet(walletId);
  if (!wallet) return jsonReply(res, 404, { ok: false, error: "Wallet not found" });

  try {
    const userConfig = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"));
    const walletConfig = userConfig.wallets?.[wallet.address] || {};
    jsonReply(res, 200, { ok: true, config: walletConfig });
  } catch (err) {
    jsonReply(res, 500, { ok: false, error: err.message });
  }
}

async function handlePostWalletConfig(req, res) {
  if (!requireOwner(req, res)) return;
  const walletId = req.url.replace(/\/config$/, "").split("/").pop();
  const body = await parseBody(req);
  if (!body || typeof body.config !== "object") {
    return jsonReply(res, 400, { ok: false, error: "config object required" });
  }
  const wallet = resolveWallet(walletId);
  if (!wallet) return jsonReply(res, 404, { ok: false, error: "Wallet not found" });

  // Write to user-config.json wallets[address] section
  try {
    const userConfig = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"));
    if (!userConfig.wallets) userConfig.wallets = {};
    if (Object.keys(body.config).length === 0) {
      delete userConfig.wallets[wallet.address];
    } else {
      /* __WALLETCFGMERGE__ deep-merge: form UI cuma tahu field standar — jangan hapus custom key (minBinStep, chase, poolCooldown, dll) */
      const prevBlock = userConfig.wallets[wallet.address] || {};
      const mergedBlock = { ...prevBlock };
      for (const [sec, val] of Object.entries(body.config)) {
        if (val && typeof val === "object" && !Array.isArray(val) && prevBlock[sec] && typeof prevBlock[sec] === "object" && !Array.isArray(prevBlock[sec])) {
          mergedBlock[sec] = { ...prevBlock[sec], ...val };
        } else {
          mergedBlock[sec] = val;
        }
      }
      userConfig.wallets[wallet.address] = mergedBlock;
    }
    fs.writeFileSync(USER_CONFIG_PATH, JSON.stringify(userConfig, null, 2));
  } catch (err) {
    return jsonReply(res, 500, { ok: false, error: `Failed to write config: ${err.message}` });
  }

  // If this wallet is currently running, apply to runtime config immediately
  const isRunning = (wallet.id === "_env" && !!getAgentRunningInfo())
    || (wallet.running && isProcessAlive(wallet.running.pid));
  if (isRunning) {
    try {
      const changes = {};
      for (const section of ["risk", "screening", "management", "schedule", "llm"]) {
        if (body.config[section]) Object.assign(changes, body.config[section]);
      }
      if (Object.keys(changes).length) {
        await (grantUserConfigOverride(), executeTool)("update_config", { /* __USERONLY__ jalur user */ changes, reason: `dashboard wallet ${wallet.name}` });
      }
    } catch (err) {
      log("dashboard_warn", `Failed to apply wallet config: ${err.message}`);
    }
  }

  jsonReply(res, 200, { ok: true, config: body.config });
}

// ─── Smart Wallets API ──────────────────────────────────────────

async function handleSmartWallets(req, res) {
  try {
    const { addSmartWallet, removeSmartWallet, listSmartWallets } = await import("./smart-wallets.js");
    if (req.method === "GET") {
      const result = listSmartWallets();
      return jsonReply(res, 200, { ok: true, ...result });
    }
    if (req.method === "POST") {
      const body = await parseBody(req);
      const { name, address, category, type } = body;
      if (!name || !address) return jsonReply(res, 400, { ok: false, error: "name and address are required" });
      const result = addSmartWallet({ name, address, category: category || "alpha", type: type || "lp" });
      if (!result.success) return jsonReply(res, 409, { ok: false, error: result.error });
      return jsonReply(res, 201, { ok: true, wallet: result.wallet });
    }
    if (req.method === "PATCH") {
      const body = await parseBody(req);
      const { address, name, category, type } = body;
      if (!address) return jsonReply(res, 400, { ok: false, error: "address is required" });
      const { updateSmartWallet } = await import("./smart-wallets.js");
      const result = updateSmartWallet({ address, name, category, type });
      if (!result.success) return jsonReply(res, 404, { ok: false, error: result.error });
      return jsonReply(res, 200, { ok: true, wallet: result.wallet });
    }
    if (req.method === "DELETE") {
      const url = new URL(req.url, `http://localhost:${PORT}`);
      const address = url.searchParams.get("address");
      if (!address) return jsonReply(res, 400, { ok: false, error: "address query param is required" });
      const result = removeSmartWallet({ address });
      if (!result.success) return jsonReply(res, 404, { ok: false, error: result.error });
      return jsonReply(res, 200, { ok: true, removed: result.removed });
    }
    jsonReply(res, 405, { ok: false, error: "Method not allowed" });
  } catch (err) {
    jsonReply(res, 500, { ok: false, error: err.message });
  }
}

async function handleSmartWalletCheck(req, res) {
  try {
    const body = req.method === "POST" ? await parseBody(req) : {};
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const poolAddress = body.pool_address || url.searchParams.get("pool_address");
    if (!poolAddress) return jsonReply(res, 400, { ok: false, error: "pool_address is required" });
    const { checkSmartWalletsOnPool } = await import("./smart-wallets.js");
    const result = await checkSmartWalletsOnPool({ pool_address: poolAddress });
    jsonReply(res, 200, { ok: true, ...result });
  } catch (err) {
    jsonReply(res, 500, { ok: false, error: err.message });
  }
}

async function handleSmartWalletPools(req, res) {
  try {
    const { getAllTrackedPools } = await import("./smart-wallets.js");
    const pools = await getAllTrackedPools();
    jsonReply(res, 200, { ok: true, total: pools.length, pools });
  } catch (err) {
    jsonReply(res, 500, { ok: false, error: err.message });
  }
}

// ─── Learning API ────────────────────────────────────────────────

async function handleLearning(req, res) {
  try {
    const result = { lessons: [], performance: [], weights: null, evolution: [], stats: {} };
    const lessonsPath = path.join(__dirname, "lessons.json");
    const weightsPath = path.join(__dirname, "signal-weights.json");
    if (fs.existsSync(lessonsPath)) {
      const raw = JSON.parse(fs.readFileSync(lessonsPath, "utf8"));
      result.lessons = raw.lessons || [];
      result.performance = raw.performance || [];
      result.evolution = result.lessons.filter(l =>
        (l.tags || []).some(t => t === "evolution" || t === "self_tune" || t === "config_change")
      );
      const perf = raw.performance || [];
      const wins = perf.filter(p => (p.pnl_pct || 0) > 0);
      const losses = perf.filter(p => (p.pnl_pct || 0) < 0);
      result.stats = {
        total_positions: perf.length,
        winners: wins.length,
        losers: losses.length,
        win_rate: perf.length ? ((wins.length / perf.length) * 100).toFixed(1) : "0",
        best_pnl: wins.length ? Math.max(...wins.map(p => p.pnl_pct || 0)).toFixed(2) : "0",
        worst_pnl: losses.length ? Math.min(...losses.map(p => p.pnl_pct || 0)).toFixed(2) : "0",
        avg_winner_pnl: wins.length ? (wins.reduce((s,p) => s + (p.pnl_pct||0), 0) / wins.length).toFixed(2) : "0",
        avg_loser_pnl: losses.length ? (losses.reduce((s,p) => s + (p.pnl_pct||0), 0) / losses.length).toFixed(2) : "0",
      };
    }
    if (fs.existsSync(weightsPath)) {
      result.weights = JSON.parse(fs.readFileSync(weightsPath, "utf8"));
    }
    jsonReply(res, 200, { ok: true, data: result });
  } catch (err) {
    jsonReply(res, 500, { ok: false, error: err.message });
  }
}

async function handleLearningKnowledge(req, res) {
  try {
    const knowledgePath = path.join(__dirname, "..", "agentlearning.md");
    if (!fs.existsSync(knowledgePath)) {
      return jsonReply(res, 404, { ok: false, error: "agentlearning.md not found" });
    }
    const text = fs.readFileSync(knowledgePath, "utf8");
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(text);
  } catch (err) {
    jsonReply(res, 500, { ok: false, error: err.message });
  }
}

// ─── PnL Reconciliation ────────────────────────────────────────

async function handleReconcile(req, res) {
  if (!requireOwner(req, res)) return;
  try {
    const envKey = process.env.WALLET_PRIVATE_KEY || "";
    const walletAddr = envKey ? (deriveAddress(envKey) || "") : "";
    const result = await reconcileClosedPnl(walletAddr);
    jsonReply(res, 200, { ok: true, ...result });
  } catch (err) {
    jsonReply(res, 500, { ok: false, error: err.message });
  }
}

// ─── Static UI ──────────────────────────────────────────────────

function serveUI(req, res) {
  if (!fs.existsSync(UI_FILE)) {
    res.writeHead(200, { "Content-Type": "text/html" });
    return res.end(`<!DOCTYPE html><html><head><title>pureXBT</title><style>body{font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;background:#0a0a0f;color:#e0e0e0;}</style></head><body><div style="text-align:center"><h1>pureXBT Dashboard</h1><p>dashboard-ui.html not found. Run <code>npm run build:ui</code> or place the UI file in the project directory.</p></div></body></html>`);
  }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
  res.end(fs.readFileSync(UI_FILE, "utf8"));
}

// ─── Router ─────────────────────────────────────────────────────

const API_ROUTES = new Set([
  "/api/state", "/api/config", "/api/momentum", "/api/llm", "/api/llm/status",
  "/api/wallets", "/api/agent", "/api/agent/start", "/api/agent/stop",
  "/api/decisions", "/api/stats", "/api/history", "/api/logs",
  "/api/action", "/api/chat", "/api/chat/history", "/api/health", "/api/auth/preview",
    "/api/learning", "/api/learning/knowledge", "/api/reconcile",
  "/api/smart-wallets", "/api/smart-wallets/check", "/api/smart-wallets/pools",
]);

function createServer() {
  const server = http.createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url, `http://localhost:${PORT}`);
    } catch {
      res.writeHead(400, { "Content-Type": "text/plain" });
      return res.end("Bad Request");
    }
    const p = url.pathname;
    const isAPI = API_ROUTES.has(p) || p.startsWith("/api/wallets/") || p.startsWith("/api/agent/");

    try {

    // CORS preflight
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, x-dashboard-role",
      });
      return res.end();
    }

    // Auth gate: GET → any role (preview or owner), POST/DELETE → owner only
    if (isAPI) {
      if (req.method === "GET") {
        if (!getRole(req)) {
          res.writeHead(401, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
          res.end(JSON.stringify({ ok: false, error: "Unauthorized — login or use x-dashboard-role: preview" }));
          return;
        }
      } else {
        if (!requireOwner(req, res)) return;
      }
    }

  const BANNER_FILE = path.join(__dirname, "banner.png");
  const LOGO_FILE = path.join(__dirname, "logo.svg");

    // Static files
    if (req.method === "GET" && (p === "/" || p === "/index.html")) return serveUI(req, res);
    if (req.method === "GET" && p === "/learning" || p === "/learning.html") {
      const learningFile = path.join(__dirname, "learning.html");
      if (!fs.existsSync(learningFile)) {
        res.writeHead(200, { "Content-Type": "text/html" });
        return res.end("learning.html not found on server");
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
      return res.end(fs.readFileSync(learningFile, "utf8"));
    }
    if (req.method === "GET" && p === "/smart-wallets" || p === "/smart-wallets.html") {
      const swFile = path.join(__dirname, "smart-wallets.html");
      if (!fs.existsSync(swFile)) {
        res.writeHead(200, { "Content-Type": "text/html" });
        return res.end("smart-wallets.html not found on server");
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
      return res.end(fs.readFileSync(swFile, "utf8"));
    }
    if (req.method === "GET" && p === "/banner.png") {
      if (!fs.existsSync(BANNER_FILE)) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        return res.end("banner.png not found");
      }
      res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" });
      return res.end(fs.readFileSync(BANNER_FILE));
    }
    if (req.method === "GET" && p === "/logo.svg") {
      if (!fs.existsSync(LOGO_FILE)) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        return res.end("logo.svg not found");
      }
      res.writeHead(200, { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=86400" });
      return res.end(fs.readFileSync(LOGO_FILE));
    }

    // API routes
    if (p === "/api/state")     return handleState(req, res);
    if (p === "/api/momentum" && req.method === "GET")  return handleGetMomentum(req, res); /* __MOMGATES__ */
    if (p === "/api/momentum" && req.method === "POST") return handlePostMomentum(req, res);
    if (p === "/api/config" && req.method === "GET")  return handleGetConfig(req, res);
    if (p === "/api/config" && req.method === "POST") return handlePostConfig(req, res);
    if (p === "/api/llm" && req.method === "GET") return handleGetLLM(req, res);
    if (p === "/api/llm" && req.method === "POST") return handlePostLLM(req, res);
    if (p === "/api/llm/status" && req.method === "GET") return handleLLMStatus(req, res);
    if (p === "/api/wallets" && req.method === "GET") return handleGetWallets(req, res);
    if (p === "/api/wallets" && req.method === "POST") return handlePostWallet(req, res);
    if (p.startsWith("/api/wallets/") && p.endsWith("/activate") && req.method === "POST") return handleActivateWallet(req, res);
    if (p.startsWith("/api/wallets/") && p.endsWith("/llm") && req.method === "POST") return handlePostWalletLLM(req, res);
    if (p.startsWith("/api/wallets/") && p.endsWith("/config") && req.method === "GET") return handleGetWalletConfig(req, res);
    if (p.startsWith("/api/wallets/") && p.endsWith("/config") && req.method === "POST") return handlePostWalletConfig(req, res);
    if (p.startsWith("/api/wallets/") && p.endsWith("/start") && req.method === "POST") return handleStartWallet(req, res);
    if (p.startsWith("/api/wallets/") && p.endsWith("/stop") && req.method === "POST") return handleStopWallet(req, res);
    if (p.startsWith("/api/wallets/") && req.method === "DELETE") return handleDeleteWallet(req, res);
    if (p === "/api/agent" && req.method === "GET") return getAgentStatus(req, res);
    if (p === "/api/agent/start" && req.method === "POST") return handleStartAgent(req, res);
    if (p === "/api/agent/stop" && req.method === "POST") return handleStopAgent(req, res);
    if (p === "/api/decisions") return handleDecisions(req, res);
    if (p === "/api/stats" && req.method === "GET") return handleStats(req, res);
    if (p === "/api/history" && req.method === "GET") return handleHistory(req, res);
    if (p === "/api/equity-curve" && req.method === "GET") return handleEquityCurve(req, res);
    if (p === "/api/logs")      return handleLogs(req, res);
    if (p === "/api/action" && req.method === "POST") return handleAction(req, res);
    if (p === "/api/chat" && req.method === "POST") return handlePostChat(req, res);
    if (p === "/api/chat/history" && req.method === "GET") return handleGetChatHistory(req, res);
    if (p === "/api/chat/history" && req.method === "DELETE") return handleDeleteChatHistory(req, res);

    // Health check (no auth)
    if (p === "/api/health") {
      const role = getRole(req);
      return jsonReply(res, 200, { ok: true, ts: new Date().toISOString(), role: role || "anonymous" });
    }

    // Learning API
    if (p === "/api/learning" && req.method === "GET") return handleLearning(req, res);
    if (p === "/api/learning/knowledge" && req.method === "GET") return handleLearningKnowledge(req, res);

    // Smart Wallets API
    if (p === "/api/smart-wallets") return handleSmartWallets(req, res);
    if (p === "/api/smart-wallets/check") return handleSmartWalletCheck(req, res);
    if (p === "/api/smart-wallets/pools") return handleSmartWalletPools(req, res);

    // PnL Reconciliation
    if (p === "/api/reconcile" && req.method === "POST") return handleReconcile(req, res);

    if (p === "/api/auth/preview" && req.method === "GET") {
      return jsonReply(res, 200, { ok: true, role: "preview", message: "Preview mode activated" });
    }

    // 404
    jsonReply(res, 404, { ok: false, error: "Not found" });

    } catch (err) {
      if (isAPI) {
        try {
          log("server_error", `${req.method} ${p}: ${err.stack || err.message}`);
          res.writeHead(500, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
          res.end(JSON.stringify({ ok: false, error: `Internal server error: ${err.message}` }));
        } catch { /* res may already be closed */ }
      } else {
        // non-API (static files) — let error propagate normally
        throw err;
      }
    }
  });

  return server;
}

let _server = null;
let _primaryAgent = null;

export function startDashboard() {
  if (_server) return;
  restoreAgentPid();
  _server = createServer();
  const HOST = process.env.DASHBOARD_HOST || "0.0.0.0";
  _server.on("error", (err) => {
    log("dashboard_error", `Failed to start on ${HOST}:${PORT} — ${err.message}`);
    if (err.code === "EADDRINUSE") {
      log("dashboard_error", `Port ${PORT} already in use. Another instance may be running. Exiting so PM2 can restart fresh.`);
      setTimeout(() => process.exit(1), 500).unref?.();
    }
    _server = null;
  });
  _server.listen({ port: PORT, host: HOST, exclusive: false }, () => {
    const addr = _server.address();
    log("dashboard", `Dashboard running on http://${addr?.address || HOST}:${addr?.port || PORT} (pid=${process.pid})`);
    if (PASSWORD) log("dashboard", `Basic auth enabled (password set via DASHBOARD_PASSWORD)`);
  });
}

export function stopDashboard() {
  if (!_server) return;
  if (typeof _server.closeAllConnections === "function") {
    try { _server.closeAllConnections(); } catch {}
  }
  _server.close();
  _server = null;
  log("dashboard", "Dashboard stopped");
}

export function getDashboardPort() {
  return PORT;
}

/* __IDR__ kurs USD->IDR utk panel realized pnl — refresh 30 menit, null-safe */
let _usdIdrRate = null;
(async function _refreshIdr() {
  try {
    const { getUsdIdrRate } = await import("./tools/fx.js");
    _usdIdrRate = await getUsdIdrRate();
  } catch { /* biarkan null */ }
  const t = setTimeout(_refreshIdr, 30 * 60 * 1000);
  if (t.unref) t.unref();
})();

/* __MOMGATES__ GET/POST gate momentum utk panel Settings — deep-merge PER-KEY (pelajaran wallet-config REPLACE bug) */
function handleGetMomentum(req, res) {
  if (getRole(req) === "preview") return jsonReply(res, 200, { ok: false, error: "preview" });
  try {
    const u = readUserConfig();
    const wid = process.env.WALLET_ID;
    const scr = (wid && u.wallets?.[wid]?.screening) || u.global?.screening || u.screening || {};
    const p = u.momentum?.prescreen || {}, t = u.momentum?.thresholds || {};
    jsonReply(res, 200, { ok: true, gates: {
      mcapMin: p.mcapMin ?? null, mcapMax: p.mcapMax ?? null, volumeUsd: p.volumeUsd ?? null,
      txCount: p.txCount ?? null, lpUsd: p.lpUsd ?? null,
      scanVolumeUsd: t.volumeUsd ?? null, scanTxCount: t.txCount ?? null,
      minVolume: scr.minVolume ?? 500,
    }});
  } catch (e) { jsonReply(res, 500, { ok: false, error: e.message }); }
}
async function handlePostMomentum(req, res) {
  if (!requireOwner(req, res)) return;
  const body = await parseBody(req);
  if (!body || typeof body !== "object") return jsonReply(res, 400, { ok: false, error: "Invalid body" });
  const num = (v) => (v === "" || v == null || !Number.isFinite(Number(v)) ? undefined : Number(v));
  try {
    const u = readUserConfig();
    u.momentum = u.momentum || {}; u.momentum.prescreen = u.momentum.prescreen || {}; u.momentum.thresholds = u.momentum.thresholds || {};
    const P = u.momentum.prescreen, T = u.momentum.thresholds;
    const map = { mcapMin: [P, "mcapMin"], mcapMax: [P, "mcapMax"], volumeUsd: [P, "volumeUsd"], txCount: [P, "txCount"], lpUsd: [P, "lpUsd"], scanVolumeUsd: [T, "volumeUsd"], scanTxCount: [T, "txCount"] };
    for (const [k, pair] of Object.entries(map)) { const v = num(body[k]); if (v !== undefined) pair[0][pair[1]] = v; }
    const mv = num(body.minVolume);
    if (mv !== undefined) {
      const wid = process.env.WALLET_ID;
      if (wid) { u.wallets = u.wallets || {}; u.wallets[wid] = u.wallets[wid] || {}; u.wallets[wid].screening = { ...(u.wallets[wid].screening || {}), minVolume: mv }; }
      else { u.global = u.global || {}; u.global.screening = { ...(u.global.screening || {}), minVolume: mv }; }
    }
    writeUserConfig(u);
    jsonReply(res, 200, { ok: true });
  } catch (e) { jsonReply(res, 500, { ok: false, error: e.message }); }
}
