/* __MOMEXITTUNER__ — outcome tracker + statistik utk self-tuning momentum-exit (Agent B, Sesi 32).
 * Alur: momentum-exit menembak → trackMomentumExit() snapshot harga exit → sampler cek harga 30m kemudian
 * → vonis good_exit (dump ≥3% = exit benar) / premature (naik ≥3% = kecepatan) / neutral
 * → append logs/momentum-exit-outcomes.jsonl. Tuner cron 12h memberi statistik ini ke LLM
 * yang boleh menyetel momentum.exit via update_config (kunci momentumExit*, ter-clamp).
 */
import fs from "fs";
import path from "path";
import { getMetrics5m } from "./dexscreener.js";
import { log } from "../logger.js";

const OUT_FILE = path.resolve("./logs/momentum-exit-outcomes.jsonl");
const SAMPLE_AFTER_MS = Number(process.env.MOMEXIT_SAMPLE_MS) || 30 * 60 * 1000;
const DUMP_GOOD_PCT = -3;   // harga turun ≥3% pasca-exit = exit menyelamatkan
const PUMP_PREMATURE_PCT = 3; // harga naik ≥3% pasca-exit = exit kecepatan

const _pending = new Map(); // position -> { mint, pair, exitPrice, at, cfg }

export function trackMomentumExit({ position, mint, pair, cfg }) {
  if (!position || !mint || _pending.has(position)) return;
  getMetrics5m(mint)
    .then((m) => {
      const px = Number(m?.price_usd);
      if (!Number.isFinite(px) || px <= 0) return;
      _pending.set(position, { mint, pair: pair || mint.slice(0, 8), exitPrice: px, at: Date.now(), cfg: { ...(cfg?.exit || {}) } });
      log("state", `[MOMEXIT-TRACK] ${pair}: snapshot harga exit $${px} — outcome disampling ${Math.round(SAMPLE_AFTER_MS / 60000)}m lagi`);
    })
    .catch(() => {});
}

let _samplerStarted = false;
export function startOutcomeSampler() {
  if (_samplerStarted) return;
  _samplerStarted = true;
  const t = setInterval(async () => {
    const now = Date.now();
    for (const [pos, it] of _pending) {
      if (now - it.at < SAMPLE_AFTER_MS) continue;
      _pending.delete(pos);
      try {
        const m = await getMetrics5m(it.mint);
        const px = Number(m?.price_usd);
        if (!Number.isFinite(px) || px <= 0) continue;
        const deltaPct = ((px - it.exitPrice) / it.exitPrice) * 100;
        const verdict = deltaPct <= DUMP_GOOD_PCT ? "good_exit" : deltaPct >= PUMP_PREMATURE_PCT ? "premature" : "neutral";
        fs.appendFileSync(OUT_FILE, JSON.stringify({
          ts: new Date().toISOString(), position: pos, pair: it.pair, mint: it.mint,
          exit_price: it.exitPrice, price_after: px, delta_pct: +deltaPct.toFixed(2),
          sample_min: Math.round(SAMPLE_AFTER_MS / 60000), verdict, exit_cfg: it.cfg,
        }) + "\n");
        log("state", `[MOMEXIT-OUTCOME] ${it.pair}: harga ${deltaPct >= 0 ? "+" : ""}${deltaPct.toFixed(1)}% ${Math.round(SAMPLE_AFTER_MS / 60000)}m pasca-exit → ${verdict}`);
      } catch { /* skip, jangan ganggu loop */ }
    }
  }, 60 * 1000);
  if (typeof t.unref === "function") t.unref();
}

export function getExitOutcomeStats(days = 7) {
  const stats = { window_days: days, total: 0, good_exit: 0, premature: 0, neutral: 0, avg_delta_pct: null, samples: [] };
  try {
    if (!fs.existsSync(OUT_FILE)) return stats;
    const cutoff = Date.now() - days * 86400000;
    const deltas = [];
    for (const line of fs.readFileSync(OUT_FILE, "utf8").split("\n")) {
      if (!line.trim()) continue;
      let j; try { j = JSON.parse(line); } catch { continue; }
      if (new Date(j.ts).getTime() < cutoff) continue;
      stats.total += 1;
      if (j.verdict in stats) stats[j.verdict] += 1;
      if (Number.isFinite(j.delta_pct)) deltas.push(j.delta_pct);
      stats.samples.push({ ts: j.ts, pair: j.pair, delta_pct: j.delta_pct, verdict: j.verdict, cfg: j.exit_cfg });
    }
    if (deltas.length) stats.avg_delta_pct = +(deltas.reduce((a, b) => a + b, 0) / deltas.length).toFixed(2);
    stats.samples = stats.samples.slice(-20); // batasi payload prompt
  } catch { /* stats best-effort */ }
  return stats;
}
