import {
  Connection,
  PublicKey,
  LAMPORTS_PER_SOL,
  VersionedTransaction,
  Keypair,
} from "@solana/web3.js";
import bs58 from "bs58";
import { log } from "../logger.js";
import { config } from "../config.js";

let _connection = null;
let _wallet = null;

function getConnection() {
  if (!_connection) _connection = new Connection(process.env.RPC_URL, "confirmed");
  return _connection;
}

function getWallet() {
  if (!_wallet) {
    if (!process.env.WALLET_PRIVATE_KEY) throw new Error("WALLET_PRIVATE_KEY not set");
    _wallet = Keypair.fromSecretKey(bs58.decode(process.env.WALLET_PRIVATE_KEY));
  }
  return _wallet;
}

const JUPITER_PRICE_API = "https://api.jup.ag/price/v3";
const JUPITER_SWAP_V2_API = "https://api.jup.ag/swap/v2";
const DEFAULT_JUPITER_API_KEY = ""; // set via process.env.JUPITER_API_KEY or user-config.json

function getJupiterApiKey() {
  return config.jupiter.apiKey || process.env.JUPITER_API_KEY || DEFAULT_JUPITER_API_KEY;
}

function getJupiterReferralParams() {
  const referralAccount = String(config.jupiter.referralAccount || "").trim();
  const referralFee = Number(config.jupiter.referralFeeBps || 0);
  if (!referralAccount || !Number.isFinite(referralFee) || referralFee <= 0) {
    return null;
  }
  if (referralFee < 50 || referralFee > 255) {
    log("swap_warn", `Ignoring Jupiter referral fee ${referralFee}; Ultra requires 50-255 bps`);
    return null;
  }
  try {
    new PublicKey(referralAccount);
  } catch {
    log("swap_warn", "Ignoring invalid Jupiter referral account");
    return null;
  }
  return { referralAccount, referralFee: Math.round(referralFee) };
}

// ─── Helius 429 protection: cache + retry + fallback ──────────────────────
const _balanceCache = {
  data: null,           // cached result
  until: 0,             // valid until epoch ms
  fetchPromise: null,   // in-flight dedup
};
const BALANCE_CACHE_TTL_MS = 30_000; // 30s

const RETRY_MAX = 3;
const RETRY_BASE_MS = 1000;
const RETRY_MAX_MS = 30000;

async function fetchWithRetry(url, attempt = 1) {
  try {
    const res = await fetch(url);
    if (res.ok) return res;

    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get("retry-after") || "0", 10);
      const waitMs = retryAfter > 0
        ? Math.min(retryAfter * 1000, RETRY_MAX_MS)
        : Math.min(RETRY_BASE_MS * Math.pow(2, attempt - 1), RETRY_MAX_MS);

      if (attempt <= RETRY_MAX) {
        log("wallet_retry", `Helius 429 — waiting ${waitMs}ms (attempt ${attempt}/${RETRY_MAX})`);
        await new Promise(r => setTimeout(r, waitMs));
        return fetchWithRetry(url, attempt + 1);
      }
    }

    throw new Error(`Helius API error: ${res.status} ${res.statusText}`);
  } catch (error) {
    if (attempt <= RETRY_MAX && error.name === "TypeError") {
      const waitMs = Math.min(RETRY_BASE_MS * Math.pow(2, attempt - 1), RETRY_MAX_MS);
      log("wallet_retry", `Helius network error — waiting ${waitMs}ms (attempt ${attempt}/${RETRY_MAX})`);
      await new Promise(r => setTimeout(r, waitMs));
      return fetchWithRetry(url, attempt + 1);
    }
    throw error;
  }
}

/**
 * Get current wallet balances: SOL, USDC, and all SPL tokens using Helius Wallet API.
 * Returns USD-denominated values provided by Helius.
 * Falls back to Solana RPC for SOL + USDC when Helius is down.
 */
export async function getWalletBalances() {
  let walletAddress;
  try {
    walletAddress = getWallet().publicKey.toString();
  } catch {
    return { wallet: null, sol: 0, sol_price: 0, sol_usd: 0, usdc: 0, tokens: [], total_usd: 0, error: "Wallet not configured" };
  }

  const HELIUS_KEY = process.env.HELIUS_API_KEY;
  if (!HELIUS_KEY) {
    log("wallet_error", "HELIUS_API_KEY not set in .env");
    return { wallet: walletAddress, sol: 0, sol_price: 0, sol_usd: 0, usdc: 0, tokens: [], total_usd: 0, error: "Helius API key missing" };
  }

  // ── Cache: return fresh cached value ─────────────────────────────────
  if (_balanceCache.data && Date.now() < _balanceCache.until) {
    return _balanceCache.data;
  }
  // ── Dedup: wait for in-flight fetch instead of hammering Helius ─────
  if (_balanceCache.fetchPromise) {
    return await _balanceCache.fetchPromise;
  }

  _balanceCache.fetchPromise = (async () => {
    try {
      const url = `https://api.helius.xyz/v1/wallet/${walletAddress}/balances?api-key=${HELIUS_KEY}`;
      const res = await fetchWithRetry(url);
      const data = await res.json();
      const balances = data.balances || [];

      // ─── Find SOL and USDC ────────────────────────────────────
      const solEntry = balances.find(b => b.mint === config.tokens.SOL || b.symbol === "SOL");
      const usdcEntry = balances.find(b => b.mint === config.tokens.USDC || b.symbol === "USDC");

      const solBalance = solEntry?.balance || 0;
      const solPrice = solEntry?.pricePerToken || 0;
      const solUsd = solEntry?.usdValue || 0;
      const usdcBalance = usdcEntry?.balance || 0;

      // ─── Map all tokens ───────────────────────────────────────
      const enrichedTokens = balances.map(b => ({
        mint: b.mint,
        symbol: b.symbol || b.mint.slice(0, 8),
        balance: b.balance,
        usd: b.usdValue ? Math.round(b.usdValue * 100) / 100 : null,
      }));

      const result = {
        wallet: walletAddress,
        sol: Math.round(solBalance * 1e6) / 1e6,
        sol_price: Math.round(solPrice * 100) / 100,
        sol_usd: Math.round(solUsd * 100) / 100,
        usdc: Math.round(usdcBalance * 100) / 100,
        tokens: enrichedTokens,
        total_usd: Math.round((data.totalUsdValue || 0) * 100) / 100,
      };
      _balanceCache.data = result;
      _balanceCache.until = Date.now() + BALANCE_CACHE_TTL_MS;
      _balanceCache.fetchPromise = null;
      return result;
    } catch (error) {
      _balanceCache.fetchPromise = null;
      log("wallet_error", `Helius failed: ${error.message} — falling back to Solana RPC`);
      try {
        const connection = getConnection();
        const pubkey = new PublicKey(walletAddress);
        const solLamports = await connection.getBalance(pubkey);
        const sol = Math.round((solLamports / LAMPORTS_PER_SOL) * 1e6) / 1e6;
        const usdcMint = new PublicKey(config.tokens.USDC);
        const tokenAccounts = await connection.getParsedTokenAccountsByOwner(pubkey, { mint: usdcMint });
        const usdcAmount = tokenAccounts.value[0]?.account?.data?.parsed?.info?.tokenAmount?.uiAmount ?? 0;
        const usdc = Math.round(usdcAmount * 100) / 100;
        const fallbackResult = {
          wallet: walletAddress,
          sol,
          sol_price: 0,
          sol_usd: 0,
          usdc,
          tokens: [],
          total_usd: 0,
          _fallback_rpc: true,
        };
        _balanceCache.data = fallbackResult;
        _balanceCache.until = Date.now() + 15000;
        log("wallet_info", `RPC fallback: ${sol} SOL, ${usdc} USDC`);
        return fallbackResult;
      } catch (rpcError) {
        log("wallet_error", `RPC fallback also failed: ${rpcError.message}`);
        return {
          wallet: walletAddress,
          sol: 0, sol_price: 0, sol_usd: 0,
          usdc: 0, tokens: [], total_usd: 0,
          error: `Helius+RPC both failed: ${error.message}`,
        };
      }
    }
  })();

  return await _balanceCache.fetchPromise;
}

/**
 * Swap tokens via Jupiter Swap API V2 (order → sign → execute).
 */
const SOL_MINT = "So11111111111111111111111111111111111111112";

// Normalize any SOL-like address to the correct wrapped SOL mint
export function normalizeMint(mint) {
  if (!mint) return mint;
  const SOL_MINT = "So11111111111111111111111111111111111111112";
  if (
    mint === "SOL" || 
    mint === "native" || 
    /^So1+$/.test(mint) || 
    (mint.length >= 32 && mint.length <= 44 && mint.startsWith("So1") && mint !== SOL_MINT)
  ) {
    return SOL_MINT;
  }
  return mint;
}

export async function swapToken({
  input_mint,
  output_mint,
  amount,
}) {
  input_mint  = normalizeMint(input_mint);
  output_mint = normalizeMint(output_mint);

  if (process.env.DRY_RUN === "true") {
    return {
      dry_run: true,
      would_swap: { input_mint, output_mint, amount },
      message: "DRY RUN — no transaction sent",
    };
  }

  try {
    log("swap", `${amount} of ${input_mint} → ${output_mint}`);
    const wallet = getWallet();
    const connection = getConnection();

    // ─── Convert to smallest unit ──────────────────────────────
    let decimals = 9; // SOL default
    if (input_mint !== config.tokens.SOL) {
      const mintInfo = await connection.getParsedAccountInfo(new PublicKey(input_mint));
      decimals = mintInfo.value?.data?.parsed?.info?.decimals ?? 9;
    }
    const amountStr = Math.floor(amount * Math.pow(10, decimals)).toString();

    // ─── Get Swap V2 order (unsigned tx + requestId) ───────────
    const search = new URLSearchParams({
      inputMint: input_mint,
      outputMint: output_mint,
      amount: amountStr,
      taker: wallet.publicKey.toString(),
    });
    const referralParams = getJupiterReferralParams();
    if (referralParams) {
      search.set("referralAccount", referralParams.referralAccount);
      search.set("referralFee", String(referralParams.referralFee));
    }
    const orderUrl = `${JUPITER_SWAP_V2_API}/order?${search.toString()}`;
    const jupiterApiKey = getJupiterApiKey();

    const orderRes = await fetch(orderUrl, {
      headers: jupiterApiKey ? { "x-api-key": jupiterApiKey } : {},
    });
    if (!orderRes.ok) {
      const body = await orderRes.text();
      throw new Error(`Swap V2 order failed: ${orderRes.status} ${body}`);
    }

    const order = await orderRes.json();
    if (order.errorCode || order.errorMessage) {
      throw new Error(`Swap V2 order error: ${order.errorMessage || order.errorCode}`);
    }

    const { transaction: unsignedTx, requestId } = order;

    // ─── Deserialize and sign ─────────────────────────────────
    const tx = VersionedTransaction.deserialize(Buffer.from(unsignedTx, "base64"));
    tx.sign([wallet]);
    const signedTx = Buffer.from(tx.serialize()).toString("base64");

    // ─── Execute ───────────────────────────────────────────────
    const execRes = await fetch(`${JUPITER_SWAP_V2_API}/execute`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(jupiterApiKey ? { "x-api-key": jupiterApiKey } : {}),
      },
      body: JSON.stringify({ signedTransaction: signedTx, requestId }),
    });
    if (!execRes.ok) {
      throw new Error(`Swap V2 execute failed: ${execRes.status} ${await execRes.text()}`);
    }

    const result = await execRes.json();
    if (result.status === "Failed") {
      throw new Error(`Swap failed on-chain: code=${result.code}`);
    }

    log("swap", `SUCCESS tx: ${result.signature}`);
    if (referralParams && order.feeBps !== referralParams.referralFee) {
      log(
        "swap_warn",
        `Jupiter referral fee requested ${referralParams.referralFee} bps but order applied ${order.feeBps ?? "unknown"} bps`,
      );
    }

    return {
      success: true,
      tx: result.signature,
      input_mint,
      output_mint,
      amount_in: result.inputAmountResult,
      amount_out: result.outputAmountResult,
      referral_account: referralParams?.referralAccount || null,
      referral_fee_bps_requested: referralParams?.referralFee || 0,
      fee_bps_applied: order.feeBps ?? null,
      fee_mint: order.feeMint ?? null,
    };
  } catch (error) {
    log("swap_error", error.message);
    return { success: false, error: error.message };
  }
}

export function resetWallet() {
  _wallet = null;
}

export function deriveAddress(privateKeyRaw) {
  try {
    const kp = Keypair.fromSecretKey(bs58.decode(privateKeyRaw));
    return kp.publicKey.toBase58();
  } catch {
    return null;
  }
}
