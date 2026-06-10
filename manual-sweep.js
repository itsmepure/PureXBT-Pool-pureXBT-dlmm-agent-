// Manual one-shot sweep for known leftover token.
// Skips suspected scam mint per user instruction.
import { getWalletBalances, swapToken } from "./tools/wallet.js";

const TARGET_MINT = "HHx47YqoCTdM82f1PGAfkyavUhvQexqDDoUiP8PD8j2C";
const BLACKLIST = new Set([
  "9XHkrup9a1xvRyMMX7UK3QnpPdbnqQCiZZouHFfiTW8T", // user-flagged scam
]);
const SOL_MINT = "So11111111111111111111111111111111111111112";

(async () => {
  if (BLACKLIST.has(TARGET_MINT)) {
    console.log("REFUSE: target is in blacklist");
    process.exit(1);
  }
  console.log("Fetching wallet balances...");
  const b = await getWalletBalances({});
  console.log("SOL:", b.sol);
  const tok = (b.tokens || []).find(t => t.mint === TARGET_MINT);
  if (!tok) {
    console.log(`Token ${TARGET_MINT} not found in wallet (already swept?). Done.`);
    process.exit(0);
  }
  console.log(`Found: balance=${tok.balance} usd=$${tok.usd?.toFixed(4) || "?"} symbol=${tok.symbol || "?"}`);
  if (Number(tok.balance) <= 0) {
    console.log("Zero balance, skipping.");
    process.exit(0);
  }
  console.log(`Swapping ${tok.balance} of ${TARGET_MINT} -> SOL...`);
  const res = await swapToken({ input_mint: TARGET_MINT, output_mint: SOL_MINT, amount: tok.balance });
  console.log("Result:", JSON.stringify(res, null, 2));
})().catch(e => {
  console.error("ERROR:", e.message);
  process.exit(1);
});
