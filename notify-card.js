// notify-card.js — PnL close card sender for Telegram. ESM.
// Drop-in module deployed alongside telegram.js. Keeps telegram.js edits minimal.
//
// Exports:
//   sendPnlCard({ result, tracked, brand, url, walletAddress, solPrice, chatId, token })
//     -> renders card PNG and posts via sendPhoto; returns true on success, false otherwise.
//
// Fully best-effort: any failure returns false so the caller can fall back to text.

import { renderPnlCard } from "./card-renderer.js";
import { buildCardData } from "./card-data.js";
import { log } from "./logger.js";

export async function sendPnlCard({ result, tracked, brand, url, walletAddress, solPrice, chatId, token, reason, reshapeNote } = {}) { /* __CLOSEREASON__ __RESHAPE1MSG__ */
  try {
    if (!token || !chatId) return false;

    const data = await buildCardData({ result, tracked, brand, url, walletAddress, solPrice });
    // caption: concise text summary (also survives if image somehow fails to display)
    const pos = Number(data.pnlSol) >= 0;
    const sign = pos ? "+" : "";
    let idrLine = ""; /* __IDR__ USD+IDR di caption; kurs null -> USD saja; USD tak bisa dihitung -> baris hilang */
    try {
      const { getUsdIdrRate, formatIdr } = await import("./tools/fx.js");
      const usd = Number.isFinite(Number(data.pnlUsd)) ? Number(data.pnlUsd)
        : (Number.isFinite(Number(solPrice)) && Number(solPrice) > 0 ? Number(data.pnlSol) * Number(solPrice) : null);
      if (usd != null && Number.isFinite(usd)) {
        const rate = await getUsdIdrRate();
        const usdTxt = `${usd >= 0 ? "+" : "-"}$${Math.abs(usd).toFixed(2)}`;
        const idrTxt = rate ? ` | ${usd >= 0 ? "+" : ""}${formatIdr(usd * rate)}` : "";
        idrLine = `\u2248 ${usdTxt}${idrTxt}\n`;
      }
    } catch { /* IDR best-effort */ }
    const _reshapeLine = reshapeNote ? `<b>${String(reshapeNote).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").slice(0, 150)}</b>\n` : ""; /* __RESHAPE1MSG__ */
    const caption =
      _reshapeLine +
      `<b>${pos ? "🟢" : "🔴"} ${data.pair} — POSISI DITUTUP</b>\n` +
      `PnL: <b>${sign}${Number(data.pnlSol).toFixed(4)} SOL</b> (${sign}${Number(data.pnlPct).toFixed(2)}%)\n` +
      idrLine +
      `Durasi: ${data.time}` +
      (reason ? `\nAlasan: ${String(reason).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").slice(0, 200)}` : "");

    const png = await renderPnlCard(data);
    if (!png || png.length < 1000) return false;

    const form = new FormData();
    form.append("chat_id", String(chatId));
    form.append("caption", caption.slice(0, 1024));
    form.append("parse_mode", "HTML");
    form.append("photo", new Blob([png], { type: "image/png" }), "pnl-card.png");

    /* __TGRETRY__ retry 2x (2s/5s) — network blip / 5xx / 429 */
    let res;
    for (let att = 0; ; att++) {
      try {
        res = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, { method: "POST", body: form });
        if (res.ok || (res.status < 500 && res.status !== 429) || att >= 2) break;
      } catch (e) {
        if (att >= 2) throw e;
      }
      await new Promise((r) => setTimeout(r, att === 0 ? 2000 : 5000));
    }
    if (!res.ok) {
      const err = await res.text().catch(() => "");
      log("telegram_error", `sendPhoto ${res.status}: ${err.slice(0, 200)}`);
      return false;
    }
    return true;
  } catch (e) {
    log("telegram_warn", `PnL card render/send failed: ${e.message}`);
    return false;
  }
}
