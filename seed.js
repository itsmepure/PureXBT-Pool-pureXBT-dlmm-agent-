/**
 * Seed test data for PureXBT Pool dashboard preview.
 * Run: node seed.js
 */
import fs from "fs";

const now = new Date();

// ─── state.json ────────────────────────────────────────────────
const state = {
  positions: {
    "pos_a1b2c3d4e5f6": {
      deployedAt: new Date(now - 1000 * 60 * 45).toISOString(),
      pool: "7Rj8aJw5qLY9HLDzZ2gF7Lx3kRmN6pQsT1oUv4WbXcY",
      poolName: "BONK/SOL",
      baseMint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
      binRange: "231-300",
      deployAmountSol: 0.72,
      strategy: "volatile_momentum",
      status: "in_range",
      oorSince: null,
      claimedFees: { usd: 1.84, sol: 0.0089 },
      note: null,
      instruction: null,
    },
    "pos_z9y8x7w6v5u4": {
      deployedAt: new Date(now - 1000 * 60 * 180).toISOString(),
      pool: "3Ngj4dXCq8kfZWZrRGRe6Be5XpLJtBQRALnKqTP1L9mH",
      poolName: "SAMO/SOL",
      baseMint: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
      binRange: "112-168",
      deployAmountSol: 0.55,
      strategy: "aggressive_narrow",
      status: "oor",
      oorSince: new Date(now - 1000 * 60 * 12).toISOString(),
      claimedFees: { usd: 0.32, sol: 0.0015 },
      note: "Watch closely — volatility spiking",
      instruction: null,
    },
    "pos_k1l2m3n4o5p6": {
      deployedAt: new Date(now - 1000 * 60 * 90).toISOString(),
      pool: "5HvG95yQvqChtGHd8UtLmgBx6m8PGS9qBtsR4cSmKyKo",
      poolName: "MYRO/SOL",
      baseMint: "HhJpBhRRn4g56VsyLuT8DL5Bv31HkXqsrahTTDRZe6oE",
      binRange: "178-234",
      deployAmountSol: 0.68,
      strategy: "balanced_default",
      status: "in_range",
      oorSince: null,
      claimedFees: { usd: 2.91, sol: 0.0138 },
      note: null,
      instruction: null,
    },
  },
  recentEvents: [],
  lastUpdated: now.toISOString(),
};

fs.writeFileSync("./state.json", JSON.stringify(state, null, 2));
console.log("state.json seeded with 3 positions");

// ─── decision-log.json ─────────────────────────────────────────
const decisions = {
  decisions: [
    {
      id: "dec_1",
      ts: new Date(now - 1000 * 60 * 45).toISOString(),
      type: "deploy",
      actor: "SCREENER",
      pool: "7Rj8aJw5qLY9HLDzZ2gF7Lx3kRmN6pQsT1oUv4WbXcY",
      pool_name: "BONK/SOL",
      position: "pos_a1b2c3d4e5f6",
      summary: "Deployed 0.72 SOL single-side on BONK/SOL pool — strong organic volume + high fee/TVL ratio.",
      reason: "Fees 24h: $8.2k. TVL: $89k. Organic score: 72. Holders: 8.4k. Bin step 100 within range. Signal quality: HIGH.",
      risks: ["Small cap token — sudden volume drop possible", "BONK has history of 50%+ drawdowns"],
      metrics: { deployAmountSol: 0.72, binsBelow: 42, feeTvlRatio: 0.092, organicScore: 72 },
      rejected: ["WIF/SOL — TVL too high ($280k)", "POPCAT/SOL — bundle% 34% exceeds threshold"],
    },
    {
      id: "dec_2",
      ts: new Date(now - 1000 * 60 * 180).toISOString(),
      type: "deploy",
      actor: "SCREENER",
      pool: "3Ngj4dXCq8kfZWZrRGRe6Be5XpLJtBQRALnKqTP1L9mH",
      pool_name: "SAMO/SOL",
      position: "pos_z9y8x7w6v5u4",
      summary: "Deployed 0.55 SOL single-side on SAMO/SOL — OG meme token, steady community pool.",
      reason: "Fees 24h: $4.1k. TVL: $52k. Organic score: 68. Holders: 6.2k. Bin step 120 within range.",
      risks: ["Low TVL pool — liquidity may thin out", "SAMO volume seasonal"],
      metrics: { deployAmountSol: 0.55, binsBelow: 38, feeTvlRatio: 0.079, organicScore: 68 },
      rejected: ["COST/SOL — minHolders 320 below threshold 500"],
    },
    {
      id: "dec_3",
      ts: new Date(now - 1000 * 60 * 90).toISOString(),
      type: "deploy",
      actor: "SCREENER",
      pool: "5HvG95yQvqChtGHd8UtLmgBx6m8PGS9qBtsR4cSmKyKo",
      pool_name: "MYRO/SOL",
      position: "pos_k1l2m3n4o5p6",
      summary: "Deployed 0.68 SOL single-side on MYRO/SOL — high fee pool, growing volume trend.",
      reason: "Fees 24h: $6.7k. TVL: $73k. Organic score: 75. Holders: 9.1k. Bin step 85 within range.",
      risks: ["MYRO still in price discovery phase"],
      metrics: { deployAmountSol: 0.68, binsBelow: 45, feeTvlRatio: 0.092, organicScore: 75 },
      rejected: ["PENG/SOL — top10 holders 62% exceeds 55% threshold"],
    },
    {
      id: "dec_4",
      ts: new Date(now - 1000 * 60 * 120).toISOString(),
      type: "skip",
      actor: "SCREENER",
      pool: "9XyZ...ab12",
      pool_name: "MEME/SOL",
      summary: "Skipped MEME/SOL — bundler detection triggered (42% bundled supply).",
      reason: "Bundler percentage 42% exceeds max 25%. Token likely sniper-botted at launch.",
      risks: ["High probability of orchestrated dump"],
      metrics: { bundlePct: 42, top10Pct: 68, organicScore: 31 },
      rejected: ["Single candidate pool, no alternatives within screening window"],
    },
    {
      id: "dec_5",
      ts: new Date(now - 1000 * 60 * 60).toISOString(),
      type: "skip",
      actor: "SCREENER",
      pool: "4WxY...cd34",
      pool_name: "DUMP/SOL",
      summary: "Skipped DUMP/SOL — deployer in blocked list (known rug history).",
      reason: "Deployer wallet matches blocked pattern from deployer-blacklist.json.",
      risks: ["Known rug deployer — zero trust"],
      metrics: {},
      rejected: ["Immediate skip on blocklist match, no further screening"],
    },
    {
      id: "dec_6",
      ts: new Date(now - 1000 * 60 * 270).toISOString(),
      type: "close",
      actor: "MANAGER",
      pool: "4KxY...ef56",
      pool_name: "WIF/SOL",
      position: "pos_old_wif_001",
      summary: "Closed WIF/SOL position — trailing stop triggered after drop from peak.",
      reason: "Peak PnL: +14.2%. Current: +8.1%. Drop: 6.1% exceeds trailing trigger 4% with drop 2%. Locked profits.",
      risks: [],
      metrics: { pnlPct: 8.1, pnlUsd: 3.24, feesUsd: 4.56, minutesHeld: 412 },
      rejected: ["HOLD — initial LLM suggestion rejected by deterministic trailing exit rule"],
    },
  ],
};

fs.writeFileSync("./decision-log.json", JSON.stringify(decisions, null, 2));
console.log("decision-log.json seeded with 6 decisions");

console.log("Seed complete. Restart dashboard: node run-dashboard.js");
