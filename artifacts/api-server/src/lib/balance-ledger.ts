import fs from "fs";
import path from "path";

export const SOL_USD_RATE = 148.5;

const DATA_DIR = path.resolve(process.cwd(), ".data");
const BALANCES_FILE = path.join(DATA_DIR, "sidebet_balances.json");

interface BalanceEntry {
  balanceUsd: number;
  updatedAt: string;
}

type BalanceStore = Record<string, BalanceEntry>;

function loadStore(): BalanceStore {
  try {
    if (fs.existsSync(BALANCES_FILE)) {
      const raw = fs.readFileSync(BALANCES_FILE, "utf-8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        return parsed as BalanceStore;
      }
    }
  } catch (err) {
    console.warn("Failed to read sidebet_balances.json:", err);
  }
  return {};
}

function saveStore(store: BalanceStore): void {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    fs.writeFileSync(BALANCES_FILE, JSON.stringify(store, null, 2), "utf-8");
  } catch (err) {
    console.error("Failed to persist sidebet_balances.json:", err);
  }
}

function roundUsd(val: number): number {
  if (!Number.isFinite(val)) return 0;
  return Math.max(0, Number(val.toFixed(2)));
}

export function getUserBalanceUsd(userId: string): number {
  if (!userId) return 0;
  const store = loadStore();
  return roundUsd(store[userId]?.balanceUsd ?? 0);
}

export function creditUserBalanceUsd(userId: string, deltaUsd: number): number {
  if (!userId || !Number.isFinite(deltaUsd) || deltaUsd <= 0) {
    return getUserBalanceUsd(userId);
  }
  const store = loadStore();
  const prev = store[userId]?.balanceUsd ?? 0;
  const next = roundUsd(prev + deltaUsd);
  store[userId] = { balanceUsd: next, updatedAt: new Date().toISOString() };
  saveStore(store);
  return next;
}

export function debitUserBalanceUsd(
  userId: string,
  deltaUsd: number,
): { ok: boolean; balanceUsd: number } {
  if (!userId || !Number.isFinite(deltaUsd) || deltaUsd <= 0) {
    return { ok: false, balanceUsd: getUserBalanceUsd(userId) };
  }
  const store = loadStore();
  const prev = roundUsd(store[userId]?.balanceUsd ?? 0);
  if (prev + 0.001 < deltaUsd) {
    return { ok: false, balanceUsd: prev };
  }
  const next = roundUsd(Math.max(0, prev - deltaUsd));
  store[userId] = { balanceUsd: next, updatedAt: new Date().toISOString() };
  saveStore(store);
  return { ok: true, balanceUsd: next };
}
