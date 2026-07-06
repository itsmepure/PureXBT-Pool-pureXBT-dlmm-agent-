// daily-card.mjs — Build & send the Daily P&L summary card (Fabriq-style) to Telegram.
// Standalone: invoked by OS cron at 17:00 UTC (= 00:00 WIB) each day.
// Aggregates TODAY's closed positions (WIB window) from decision-log.json,
// converts USD figures to SOL via live SOL price, renders the card, sends via Telegram sendPhoto.
//
// Env (from agent .env, loaded by cron wrapper OR read here):
//   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, CARD_BRAND (optional, default "PureXBT")
// Positional arg: absolute path to the agent project dir (where decision-log.json + assets/ live).
//
// Background selection:
//   - if assets/bg-win.jpg & bg-lose.jpg exist -> adaptive by sign (A/B)
//   - else if assets/card-bg.jpg exists -> single image for all (Syerin)
//   - else -> Fabriq dark-green gradient fallback

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { renderDailyCard } from "./daily-card-renderer.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── project dir (where decision-log.json lives). Default = agent dir if this
//    file is deployed inside it; else pass as argv[2]. ──
const PROJECT_DIR = process.argv[2] || __dirname;

function readEnvFile(p) {
  const out = {};
  try {
    const txt = fs.readFileSync(p, "utf8");
    for (const line of txt.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch {}
  return out;
}

// prefer process.env, fall back to .env in project dir
const fileEnv = readEnvFile(path.join(PROJECT_DIR, ".env"));
const TOKEN = process.env.TELEGRAM_BOT_TOKEN || fileEnv.TELEGRAM_BOT_TOKEN;
const CHAT = process.env.TELEGRAM_CHAT_ID || fileEnv.TELEGRAM_CHAT_ID;
const BRAND = process.env.CARD_BRAND || fileEnv.CARD_BRAND || "PureXBT";

function fetchTimeout(url, opts = {}, ms = 12000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(t));
}

// Live SOL price (USD) — Jupiter datapi, fallback CoinGecko.
async function getSolPrice() {
  const SOL = "So11111111111111111111111111111111111111112";
  try {
    const r = await fetchTimeout(`https://datapi.jup.ag/v1/assets/search?query=${SOL}`, {}, 8000);
    if (r.ok) {
      const j = await r.json().catch(() => null);
      const arr = Array.isArray(j) ? j : (j?.data || j?.assets || []);
      const p = Number(arr?.[0]?.usdPrice ?? arr?.[0]?.price);
      if (Number.isFinite(p) && p > 0) return p;
    }
  } catch {}
  try {
    const r = await fetchTimeout("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd", {}, 8000);
    if (r.ok) {
      const j = await r.json().catch(() => null);
      const p = Number(j?.solana?.usd);
      if (Number.isFinite(p) && p > 0) return p;
    }
  } catch {}
  return 0;
}

// WIB "today" window in UTC ms. WIB = UTC+7, day boundary 00:00 WIB = 17:00 UTC prev day.
// When cron fires at 17:00 UTC on day D, the window that just ENDED is
// [17:00 UTC (D-1) .. 17:00 UTC (D)) = the full WIB day D. We report that day.
function wibWindow(now = new Date()) {
  // shift to WIB, floor to WIB midnight, that midnight = end of the reporting day.
  const wibNow = new Date(now.getTime() + 7 * 3600 * 1000);
  // WIB midnight of the current WIB day (the day that just started at cron fire):
  const wibMidnight = Date.UTC(wibNow.getUTCFullYear(), wibNow.getUTCMonth(), wibNow.getUTCDate(), 0, 0, 0);
  // convert that WIB-midnight back to real UTC ms:
  const endUtc = wibMidnight - 7 * 3600 * 1000;
  const startUtc = endUtc - 24 * 3600 * 1000;
  // label = the reporting day = the WIB day that just ended = (wibMidnight - 1ms)'s date
  const labelDate = new Date(wibMidnight - 1); // last moment of reporting WIB day, expressed as UTC fields
  return { startUtc, endUtc, labelDate };
}

function fmtDateLabel(d) {
  const months = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  return `${months[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}
function fmtUtc(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth()+1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} UTC`;
}

function pickBackground() {
  const a = path.join(PROJECT_DIR, "assets");
  const bgWin = path.join(a, "bg-win.jpg");
  const bgLose = path.join(a, "bg-lose.jpg");
  const single = path.join(a, "card-bg.jpg");
  return { bgWin, bgLose, single,
    hasAdaptive: fs.existsSync(bgWin) && fs.existsSync(bgLose),
    hasSingle: fs.existsSync(single) };
}

async function main() {
  if (!TOKEN || !CHAT) { console.error("Missing TELEGRAM_BOT_TOKEN/CHAT_ID"); process.exit(2); }

  const declogPath = path.join(PROJECT_DIR, "decision-log.json");
  let decisions = [];
  try {
    const j = JSON.parse(fs.readFileSync(declogPath, "utf8"));
    decisions = j.decisions || (Array.isArray(j) ? j : []);
  } catch (e) { console.error("decision-log read err:", e.message); }

  // DAILY_NOW env = ISO timestamp override for manual backfill of a specific day.
  // e.g. DAILY_NOW="2026-07-05T00:30:00+07:00" reports the WIB day that just ended (July 4).
  const nowOverride = process.env.DAILY_NOW ? new Date(process.env.DAILY_NOW) : new Date();
  const { startUtc, endUtc, labelDate } = wibWindow(Number.isNaN(nowOverride.getTime()) ? new Date() : nowOverride);

  // deploy events today -> sum amount_sol as deposits (SOL, native)
  let depositsSol = 0;
  const closes = [];
  for (const d of decisions) {
    const t = Date.parse(d.ts);
    if (!Number.isFinite(t) || t < startUtc || t >= endUtc) continue;
    if (d.type === "close") closes.push(d);
    else if (d.type === "deploy") depositsSol += Number(d.metrics?.amount_sol || 0);
  }

  let pnlUsd = 0, feesUsd = 0, feesSolDirect = 0, wins = 0;
  for (const c of closes) {
    const m = c.metrics || {};
    const pu = Number(m.pnl_usd || 0);
    pnlUsd += pu;
    feesUsd += Number(m.fees_usd || 0);
    feesSolDirect += Number(m.fees_sol || 0);
    if (pu > 0) wins++;
  }
  const positions = closes.length;
  const winRatePct = positions > 0 ? (wins / positions) * 100 : 0;

  const solPrice = await getSolPrice();
  const usdToSol = (u) => (solPrice > 0 ? u / solPrice : 0);

  const dailyPnlSol = usdToSol(pnlUsd);
  // fees: prefer direct SOL if present, else convert USD
  const feesSol = feesSolDirect > 0 ? feesSolDirect : usdToSol(feesUsd);
  // withdrawals = capital returned + realized pnl (identity for closed positions)
  const withdrawalsSol = Math.max(0, depositsSol + dailyPnlSol);

  // background selection (adaptive by sign, or single)
  const bg = pickBackground();
  let bgPath = null;
  if (bg.hasAdaptive) bgPath = dailyPnlSol >= 0 ? bg.bgWin : bg.bgLose;
  else if (bg.hasSingle) bgPath = bg.single;

  const data = {
    dateLabel: fmtDateLabel(labelDate),
    positions,
    dailyPnlSol,
    feesSol,
    depositsSol,
    withdrawalsSol,
    winRatePct,
    brand: BRAND,
    footerUtc: fmtUtc(Date.now()),
    bgPath,
  };

  const png = await renderDailyCard(data);

  // send via Telegram sendPhoto (multipart)
  const form = new FormData();
  form.append("chat_id", String(CHAT));
  let capFx = ""; /* __IDR__ pnlUsd = agregat USD harian (sudah dihitung di atas) */
  try {
    const { getUsdIdrRate, formatIdr } = await import("./tools/fx.js");
    if (Number.isFinite(Number(pnlUsd))) {
      const rate = await getUsdIdrRate();
      const usdTxt = `${pnlUsd >= 0 ? "+" : "-"}$${Math.abs(pnlUsd).toFixed(2)}`;
      capFx = ` | \u2248 ${usdTxt}` + (rate ? ` | ${pnlUsd >= 0 ? "+" : ""}${formatIdr(pnlUsd * rate)}` : "");
    }
  } catch { /* best-effort */ }
  const cap = `📊 Daily P&L — ${data.dateLabel}\n${dailyPnlSol >= 0 ? "🟢" : "🔴"} ${dailyPnlSol >= 0 ? "+" : "-"}${Math.abs(dailyPnlSol).toFixed(4)} SOL${capFx} | ${positions} posisi | WR ${winRatePct.toFixed(1)}%`;
  form.append("caption", cap);
  form.append("photo", new Blob([png], { type: "image/png" }), "daily.png");
  const r = await fetchTimeout(`https://api.telegram.org/bot${TOKEN}/sendPhoto`, { method: "POST", body: form }, 20000);
  const jr = await r.json().catch(() => ({}));
  console.log("daily card sent:", jr.ok === true, "| positions:", positions, "| pnlSol:", dailyPnlSol.toFixed(4), "| solPrice:", solPrice);
  if (!jr.ok) { console.error("TG error:", JSON.stringify(jr).slice(0, 300)); process.exit(1); }
}

main().catch((e) => { console.error("daily-card fatal:", e?.message || e); process.exit(1); });
