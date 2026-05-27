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
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import "dotenv/config";
import { log } from "./logger.js";
import { config } from "./config.js";
import { getTrackedPositions, getLastBriefingDate, setLastBriefingDate } from "./state.js";
import { getRecentDecisions } from "./decision-log.js";
import { getMyPositions } from "./tools/dlmm.js";
import { getWalletBalances, deriveAddress, resetWallet } from "./tools/wallet.js";
import { resetDlmmWallet } from "./tools/dlmm.js";
import { executeTool } from "./tools/executor.js";
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
const CHAT_MAX_MESSAGES = 100;
const CHAT_MAX_STEPS = 15;
let _chatBusy = false;

function loadChatHistory() {
  try {
    if (fs.existsSync(CHAT_HISTORY_PATH)) {
      return JSON.parse(fs.readFileSync(CHAT_HISTORY_PATH, "utf8"));
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
  const auth = authCheck(req, res);
  if (!auth) return;
  const body = await parseBody(req);
  const message = String(body.message || "").trim();
  if (!message) return jsonReply(res, 400, { error: "Pesan tidak boleh kosong" });

  if (_chatBusy) return jsonReply(res, 429, { error: "Agent sedang memproses pesan lain. Tunggu sebentar." });

  const history = loadChatHistory();
  history.messages.push({ role: "user", content: message, ts: Date.now() });

  _chatBusy = true;
  const t0 = Date.now();
  try {
    log(`[CHAT] user: ${message.slice(0, 100)}`, "info");
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
      { interactive: true, source: "CHAT" }
    );

    const finalText = result?.content || result?.finalAnswer || result?.output || "— tidak ada respons —";
    const steps = formatToolSteps(result?.result || result);
    const reply = finalText + (steps ? "\n" + steps : "");
    const ms = Date.now() - t0;

    history.messages.push({ role: "agent", content: reply, ts: Date.now(), ms, steps: (result?.result?.trace || result?.trace || []).length });
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
    history.messages.push({ role: "agent", content: `⚠ Error: ${errMsg}`, ts: Date.now(), error: true });
    saveChatHistory(history);
    jsonReply(res, 500, { error: errMsg });
  } finally {
    _chatBusy = false;
  }
}

function handleGetChatHistory(req, res) {
  const auth = authCheck(req, res);
  if (!auth) return;
  const history = loadChatHistory();
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
  const auth = authCheck(req, res);
  if (!auth) return;
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

function authCheck(req, res) {
  if (!PASSWORD) return true;
  const auth = req.headers["authorization"] || "";
  const b64 = auth.replace("Basic ", "");
  const pw = Buffer.from(b64, "base64").toString("utf8").split(":")[1] || "";
  if (pw !== PASSWORD) {
    res.writeHead(401);
    res.end(JSON.stringify({ ok: false, error: "Unauthorized" }));
    return false;
  }
  return true;
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
const STATE_CACHE_MS = 5_000; // serve cached state for 5s (matches dashboard poll interval)

async function handleState(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const walletFilter = url.searchParams.get("wallet") || "";
  // serve from cache when fresh and no ?force param
  const forceRefresh = url.searchParams.get("force") === "1";
  if (!forceRefresh && _stateCache.payload && (Date.now() - _stateCache.ts) < STATE_CACHE_MS) {
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(_stateCache.payload);
    return;
  }
  try {
    const envKey = process.env.WALLET_PRIVATE_KEY || "";
    const envAddr = envKey ? (deriveAddress(envKey) || "") : "";
    const posOpts = (walletFilter && walletFilter !== "all") ? { wallet_address: walletFilter } : {};
    const [posResult, balances, tracked] = await Promise.all([
      getMyPositions(posOpts).catch(() => ({ positions: [], wallet: null })),
      getWalletBalances().catch(() => ({ sol: 0, tokens: [] })),
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
            getMyPositions({ wallet_address: w.address }).catch(() => ({ positions: [], wallet: w.address }))
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
        pnlPct: typeof pnlPct === "number" ? parseFloat(pnlPct.toFixed(2)) : null,
        pnlSol: typeof pnlSol === "number" ? parseFloat(pnlSol.toFixed(4)) : null,
        pnlUsd: typeof pnlUsd === "number" ? parseFloat(pnlUsd.toFixed(2)) : null,
        valueUsd: typeof valueUsd === "number" ? parseFloat(valueUsd.toFixed(2)) : null,
        feesUsd: typeof feesUsd === "number" ? parseFloat(feesUsd.toFixed(2)) : null,
        feesSol: typeof feesSol === "number" ? parseFloat(feesSol.toFixed(4)) : null,
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
          feesSol: null,
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

    // compute realized PnL + win rate from decision log
    const allDecisions = getRecentDecisions(500);
    const walletDecisions = walletFilter
      ? allDecisions.filter(d => (d.walletAddress||"").toLowerCase().startsWith(walletFilter.toLowerCase().slice(0,12)))
      : allDecisions;
    let realizedPnlUsd = 0, totalDeploys = 0, wonCloses = 0, totalCloses = 0;
    for (const d of walletDecisions) {
      if (d.type === "deploy") totalDeploys++;
      if (d.type === "close") {
        totalCloses++;
        const pnl = d.metrics?.pnl_usd ?? d.metrics?.pnlUsd ?? 0;
        realizedPnlUsd += Number(pnl) || 0;
        if ((Number(pnl) || 0) > 0) wonCloses++;
      }
    }
    const winRate = totalCloses > 0 ? Math.round((wonCloses / totalCloses) * 100) : 0;
    const totalPnlUsd = openPnlUsd + realizedPnlUsd;

    const payload = JSON.stringify({
      ok: true,
      dryRun: process.env.DRY_RUN === "true",
      balanceSol,
      tokens: balances.tokens || [],
      positions: enriched,
      positionCount: enriched.length,
      closedCount,
      openPnlUsd: Math.round(openPnlUsd * 100) / 100,
      realizedPnlUsd: Math.round(realizedPnlUsd * 100) / 100,
      totalPnlUsd: Math.round(totalPnlUsd * 100) / 100,
      winRate,
      totalDeploys,
      wallet: walletFilter || "all",
      wallets: [...new Set([...loadWallets().map(w=>w.address), envAddr, ...allDecisions.map(d=>d.walletAddress).filter(Boolean)].filter(Boolean))],
      maxPositions: config.risk?.maxPositions ?? 3,
      stopLossPct: config.management?.stopLossPct ?? -50,
      takeProfitPct: config.management?.takeProfitPct ?? 5,
      dailyStopCount: 0,
      dailyStopDate: "",
      lastUpdated: new Date().toISOString(),
    });
    _stateCache.payload = payload;
    _stateCache.ts = Date.now();
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(payload);
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
  jsonReply(res, 200, { ok: true, config: safe });
}

async function handlePostConfig(req, res) {
  if (!authCheck(req, res)) return;
  const body = await parseBody(req);
  const changes = body?.changes || (body?.key ? { [body.key]: body.value } : body);
  if (!changes || typeof changes !== "object" || Array.isArray(changes)) {
    return jsonReply(res, 400, { ok: false, error: "Missing config changes in body" });
  }
  try {
    const result = await executeTool("update_config", {
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
  if (!authCheck(req, res)) return;
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
  const hours = STAT_PERIODS[period] || 24;
  const cutoff = Date.now() - hours * 60 * 60 * 1000;

  try {
    const envKey = process.env.WALLET_PRIVATE_KEY || "";
    const envAddr = envKey ? (deriveAddress(envKey) || "") : "";
    const all = getRecentDecisions(500);
    let filtered = all.filter((d) => new Date(d.ts || d.timestamp).getTime() >= cutoff);
    if (wallet) {
      const envAddrDerived = envAddr.toLowerCase().slice(0, 12);
      filtered = filtered.filter((d) => {
        const dw = (d.walletAddress || "").toLowerCase();
        // match exact or fallback: no walletAddress = belongs to env wallet
        return dw.startsWith(wallet.toLowerCase().slice(0, 12)) || (!dw && envAddrDerived === wallet.toLowerCase().slice(0, 12));
      });
    }

    let deploys = 0, closes = 0, skip = 0;
    let totalPnlUsd = 0, totalFeesUsd = 0, won = 0, lost = 0;

    for (const d of filtered) {
      if (d.type === "deploy" || d.action === "deploy") deploys++;
      else if (d.type === "close" || d.action === "close") {
        closes++;
        const pnl = d.metrics?.pnl_usd ?? d.metrics?.pnlUsd ?? 0;
        const fees = d.metrics?.feesUsd ?? d.metrics?.fees_usd ?? d.feesUsd ?? 0;
        totalPnlUsd += Number(pnl) || 0;
        totalFeesUsd += Number(fees) || 0;
        if ((Number(pnl) || 0) > 0) won++;
        else lost++;
      }
      else if (d.type === "skip" || d.action === "skip" || d.type === "no_deploy") skip++;
    }

    const winRate = closes > 0 ? Math.round((won / closes) * 100) : 0;

    jsonReply(res, 200, {
      ok: true,
      period,
      wallet: wallet || "all",
      hours,
      cutoff: new Date(cutoff).toISOString(),
      stats: { total: filtered.length, deploys, closes, skip, won, lost, winRate, totalPnlUsd: Math.round(totalPnlUsd * 100) / 100, totalFeesUsd: Math.round(totalFeesUsd * 100) / 100 },
      wallets: [...new Set([...loadWallets().map(w=>w.address), envAddr, ...all.map((d) => d.walletAddress).filter(Boolean)].filter(Boolean))],
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
    const closeMap = {};
    for (const d of decisions) {
      if (d.type === "close" || d.action === "close") {
        const key = (d.position || "").toLowerCase();
        closeMap[key] = d;
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

      // PnL from close event > live state > pos fields
      const pnlUsd = closeEv?.metrics?.pnl_usd ?? closeEv?.metrics?.pnlUsd ?? pos.pnl_usd ?? 0;
      const pnlPct = closeEv?.metrics?.pnl_pct ?? closeEv?.metrics?.pnlPct ?? pos.pnl_pct ?? pos.peak_pnl_pct ?? 0;
      const feesUsd = closeEv?.metrics?.fees_usd ?? closeEv?.metrics?.feesUsd ?? pos.total_fees_claimed_usd ?? pos.fees_usd ?? 0;
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

// ─── API: Logs ──────────────────────────────────────────────────

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
  if (!authCheck(req, res)) return;
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
      : (_primaryAgent && isProcessAlive(_primaryAgent.pid) ? { pid: _primaryAgent.pid, startedAt: _primaryAgent.startedAt } : null),
    config: w.config || {},
  }));
  jsonReply(res, 200, { ok: true, wallets: safe });
}

async function handlePostWallet(req, res) {
  if (!authCheck(req, res)) return;
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
  if (!authCheck(req, res)) return;
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
  if (!authCheck(req, res)) return;
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
  if (!authCheck(req, res)) return;
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
  const running = !!(_primaryAgent && isProcessAlive(_primaryAgent.pid));
  if (!running) _primaryAgent = null;
  jsonReply(res, 200, {
    ok: true,
    running,
    pid: running ? _primaryAgent.pid : null,
    startedAt: running ? _primaryAgent.startedAt : null,
  });
}

async function handleStartAgent(req, res) {
  if (!authCheck(req, res)) return;
  if (_primaryAgent && fs.existsSync(AGENT_PID_FILE)) {
    return jsonReply(res, 200, { ok: true, running: true, pid: _primaryAgent.pid, message: "Already running" });
  }
  try {
    const childEnv = { ...process.env };
    delete childEnv.pm_exec_path; // remove PM2 entrypoint so child detects isMain correctly
    const child = spawn("node", ["index.js"], {
      cwd: __dirname,
      env: childEnv,
      stdio: "ignore",
      detached: true,
      windowsHide: true,
    });
    child.unref();
    fs.writeFileSync(AGENT_PID_FILE, String(child.pid));
    _primaryAgent = { pid: child.pid, startedAt: new Date().toISOString() };
    log("dashboard", `Agent started (pid ${child.pid})`);
    jsonReply(res, 200, { ok: true, running: true, pid: child.pid, startedAt: _primaryAgent.startedAt });
  } catch (err) {
    jsonReply(res, 500, { ok: false, error: err.message });
  }
}

async function handleStopAgent(req, res) {
  if (!authCheck(req, res)) return;
  if (!_primaryAgent || !isProcessAlive(_primaryAgent.pid)) {
    _primaryAgent = null;
    try { fs.unlinkSync(AGENT_PID_FILE); } catch {}
    jsonReply(res, 200, { ok: true, running: false, message: "Not running" });
    return;
  }
  try {
    process.kill(_primaryAgent.pid, "SIGKILL");
    _primaryAgent = null;
    try { fs.unlinkSync(AGENT_PID_FILE); } catch {}
    log("dashboard", "Agent stopped");
    jsonReply(res, 200, { ok: true, running: false, message: "Stopped" });
  } catch (err) {
    jsonReply(res, 500, { ok: false, error: err.message });
  }
}

async function handleStartWallet(req, res) {
  if (!authCheck(req, res)) return;
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
  if (!authCheck(req, res)) return;
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
  if (!authCheck(req, res)) return;
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
  if (!authCheck(req, res)) return;
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
      userConfig.wallets[wallet.address] = body.config;
    }
    fs.writeFileSync(USER_CONFIG_PATH, JSON.stringify(userConfig, null, 2));
  } catch (err) {
    return jsonReply(res, 500, { ok: false, error: `Failed to write config: ${err.message}` });
  }

  // If this wallet is currently running, apply to runtime config immediately
  const isRunning = (wallet.id === "_env" && _primaryAgent && isProcessAlive(_primaryAgent.pid))
    || (wallet.running && isProcessAlive(wallet.running.pid));
  if (isRunning) {
    try {
      const changes = {};
      for (const section of ["risk", "screening", "management", "schedule", "llm"]) {
        if (body.config[section]) Object.assign(changes, body.config[section]);
      }
      if (Object.keys(changes).length) {
        await executeTool("update_config", { changes, reason: `dashboard wallet ${wallet.name}` });
      }
    } catch (err) {
      log("dashboard_warn", `Failed to apply wallet config: ${err.message}`);
    }
  }

  jsonReply(res, 200, { ok: true, config: body.config });
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
  "/api/state", "/api/config", "/api/llm", "/api/llm/status",
  "/api/wallets", "/api/agent", "/api/agent/start", "/api/agent/stop",
  "/api/decisions", "/api/stats", "/api/history", "/api/logs",
  "/api/action", "/api/chat", "/api/chat/history", "/api/health",
]);

function createServer() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const p = url.pathname;
    const isAPI = API_ROUTES.has(p) || p.startsWith("/api/wallets/") || p.startsWith("/api/agent/");

    try {

    // CORS preflight
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      });
      return res.end();
    }

  const BANNER_FILE = path.join(__dirname, "banner.png");

    // Static files
    if (req.method === "GET" && (p === "/" || p === "/index.html")) return serveUI(req, res);
    if (req.method === "GET" && p === "/banner.png") {
      if (!fs.existsSync(BANNER_FILE)) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        return res.end("banner.png not found");
      }
      res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" });
      return res.end(fs.readFileSync(BANNER_FILE));
    }

    // API routes
    if (p === "/api/state")     return handleState(req, res);
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
    if (p === "/api/logs")      return handleLogs(req, res);
    if (p === "/api/action" && req.method === "POST") return handleAction(req, res);
    if (p === "/api/chat" && req.method === "POST") return handlePostChat(req, res);
    if (p === "/api/chat/history" && req.method === "GET") return handleGetChatHistory(req, res);
    if (p === "/api/chat/history" && req.method === "DELETE") return handleDeleteChatHistory(req, res);

    // Health check (no auth)
    if (p === "/api/health")    return jsonReply(res, 200, { ok: true, ts: new Date().toISOString() });

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
  _server.listen(PORT, HOST, () => {
    log("dashboard", `Dashboard running on http://${HOST}:${PORT}`);
    if (PASSWORD) log("dashboard", `Basic auth enabled (password set via DASHBOARD_PASSWORD)`);
  });
  _server.on("error", (err) => {
    log("dashboard_error", `Failed to start: ${err.message}`);
    _server = null;
  });
}

export function stopDashboard() {
  if (!_server) return;
  _server.close();
  _server = null;
  log("dashboard", "Dashboard stopped");
}

export function getDashboardPort() {
  return PORT;
}
