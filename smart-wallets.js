import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { log } from "./logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WALLETS_PATH = path.join(__dirname, "smart-wallets.json");

function loadWallets() {
  if (!fs.existsSync(WALLETS_PATH)) return { wallets: [] };
  try {
    return JSON.parse(fs.readFileSync(WALLETS_PATH, "utf8"));
  } catch {
    return { wallets: [] };
  }
}

function saveWallets(data) {
  fs.writeFileSync(WALLETS_PATH, JSON.stringify(data, null, 2));
}

const SOLANA_PUBKEY_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function addSmartWallet({ name, address, category = "alpha", type = "lp" }) {
  if (!SOLANA_PUBKEY_RE.test(address)) {
    return { success: false, error: "Invalid Solana address format" };
  }
  const data = loadWallets();
  const existing = data.wallets.find((w) => w.address === address);
  if (existing) {
    return { success: false, error: `Already tracked as "${existing.name}"` };
  }
  data.wallets.push({ name, address, category, type, addedAt: new Date().toISOString() });
  saveWallets(data);
  log("smart_wallets", `Added wallet: ${name} (${category}, type=${type})`);
  return { success: true, wallet: { name, address, category, type } };
}

export function updateSmartWallet({ address, name, category, type }) {
  const data = loadWallets();
  const w = data.wallets.find((w) => w.address === address);
  if (!w) return { success: false, error: "Wallet not found" };
  const oldName = w.name;
  if (name !== undefined && name.trim()) w.name = name.trim();
  if (category !== undefined && category.trim()) w.category = category.trim();
  if (type !== undefined && type.trim()) w.type = type.trim();
  saveWallets(data);
  log("smart_wallets", `Updated wallet "${oldName}" → name=${w.name} cat=${w.category} type=${w.type}`);
  return { success: true, wallet: { name: w.name, address, category: w.category, type: w.type, addedAt: w.addedAt } };
}

export function removeSmartWallet({ address }) {
  const data = loadWallets();
  const wallet = data.wallets.find((w) => w.address === address);
  if (!wallet) return { success: false, error: "Wallet not found" };
  data.wallets = data.wallets.filter((w) => w.address !== address);
  saveWallets(data);
  log("smart_wallets", `Removed wallet: ${wallet.name}`);
  return { success: true, removed: wallet.name };
}

export function listSmartWallets() {
  const { wallets } = loadWallets();
  return { total: wallets.length, wallets };
}

// Cache wallet positions for 5 minutes to avoid hammering RPC
const _cache = new Map(); // address -> { positions, fetchedAt }
const CACHE_TTL = 5 * 60 * 1000;
const _inflight = new Map(); // address -> Promise — dedupe concurrent queries for same wallet

export async function checkSmartWalletsOnPool({ pool_address }) {
  const { wallets: allWallets } = loadWallets();
  // Only check LP-type wallets — holder wallets don't have positions
  const wallets = allWallets.filter((w) => !w.type || w.type === "lp");
  if (wallets.length === 0) {
    return {
      pool: pool_address,
      tracked_wallets: 0,
      in_pool: [],
      confidence_boost: false,
      signal: "No smart wallets tracked yet — neutral signal",
    };
  }

  const { getWalletPositions } = await import("./tools/dlmm.js");

  const results = await Promise.all(
    wallets.map(async (wallet) => {
      try {
        const cached = _cache.get(wallet.address);
        if (cached && Date.now() - cached.fetchedAt < CACHE_TTL) {
          return { wallet, positions: cached.positions };
        }
        // Inflight dedupe: if same wallet is already being queried, share the promise
        let pending = _inflight.get(wallet.address);
        if (!pending) {
          pending = getWalletPositions({ wallet_address: wallet.address })
            .then((r) => r?.positions || [])
            .finally(() => _inflight.delete(wallet.address));
          _inflight.set(wallet.address, pending);
        }
        const positions = await pending;
        _cache.set(wallet.address, { positions, fetchedAt: Date.now() });
        return { wallet, positions };
      } catch {
        return { wallet, positions: [] };
      }
    })
  );

  const inPool = results
    .filter((r) => r.positions.some((p) => p.pool === pool_address))
    .map((r) => ({ name: r.wallet.name, category: r.wallet.category, address: r.wallet.address }));

  return {
    pool: pool_address,
    tracked_wallets: wallets.length,
    in_pool: inPool,
    confidence_boost: inPool.length > 0,
    signal: inPool.length > 0
      ? `${inPool.length}/${wallets.length} smart wallet(s) are in this pool: ${inPool.map((w) => w.name).join(", ")} — STRONG signal`
      : `0/${wallets.length} smart wallets in this pool — neutral, rely on fundamentals`,
  };
}

export async function getAllTrackedPools() {
  const { wallets: allWallets } = loadWallets();
  const wallets = allWallets.filter((w) => !w.type || w.type === "lp");
  if (wallets.length === 0) return [];

  const { getWalletPositions } = await import("./tools/dlmm.js");

  const results = await Promise.all(wallets.map(async (wallet) => {
    try {
      const cached = _cache.get(wallet.address);
      if (cached && Date.now() - cached.fetchedAt < CACHE_TTL) {
        return { wallet, positions: cached.positions };
      }
      let pending = _inflight.get(wallet.address);
      if (!pending) {
        pending = getWalletPositions({ wallet_address: wallet.address })
          .then((r) => r?.positions || [])
          .finally(() => _inflight.delete(wallet.address));
        _inflight.set(wallet.address, pending);
      }
      const positions = await pending;
      _cache.set(wallet.address, { positions, fetchedAt: Date.now() });
      return { wallet, positions };
    } catch {
      return { wallet, positions: [] };
    }
  }));

  const byPool = new Map();
  for (const { wallet, positions } of results) {
    for (const pos of positions) {
      const addr = pos.pool || pos.pool_address;
      if (!addr) continue;
      if (!byPool.has(addr)) {
        byPool.set(addr, {
          pool_address: addr,
          pool_name: pos.pool_name || addr.slice(0, 8) + "...",
          pool: { pool_address: addr, name: pos.pool_name || addr, _smart_wallet_tracked: true },
          tracked_by: [],
        });
      }
      byPool.get(addr).tracked_by.push({
        name: wallet.name,
        category: wallet.category,
        address: wallet.address,
      });
    }
  }

  const result = Array.from(byPool.values());
  log("smart_wallets", `getAllTrackedPools: ${result.length} unique pools across ${wallets.length} wallets, ${results.reduce((s,r) => s + r.positions.length, 0)} total positions`);
  return result;
}
