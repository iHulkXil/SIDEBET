import { useCallback, useEffect, useState } from 'react';
import { usePrivy } from '@privy-io/react-auth';

export const WALLET_BALANCE_EVENT = 'sidebet:balance-updated';
export const SOL_USD_RATE = 148.5;

const API_BASE = import.meta.env.VITE_API_BASE || '';

function balanceStorageKey(userId: string) {
  return `sidebet_balance:${userId}`;
}

function serverSyncedKey(userId: string) {
  return `sidebet_balance_synced:${userId}`;
}

export function getWalletBalance(userId?: string | null): number {
  if (!userId) return 0;
  try {
    const raw = localStorage.getItem(balanceStorageKey(userId));
    if (raw === null) return 0;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 0) return 0;
    return parsed;
  } catch {
    return 0;
  }
}

export function setWalletBalance(
  userId: string | undefined | null,
  amount: number,
  markServerSynced = false
): number {
  const safe = Number.isFinite(amount) ? Math.max(0, Number(amount.toFixed(2))) : 0;
  if (!userId) return 0;
  try {
    localStorage.setItem(balanceStorageKey(userId), safe.toFixed(2));
    if (markServerSynced) {
      localStorage.setItem(serverSyncedKey(userId), '1');
    }
    window.dispatchEvent(new Event(WALLET_BALANCE_EVENT));
    window.dispatchEvent(new Event('storage'));
  } catch (err) {
    console.error('Failed to persist wallet balance:', err);
  }
  return safe;
}

export async function syncServerBalance(
  userId: string | undefined | null,
  getAccessToken: () => Promise<string | null>
): Promise<number | null> {
  if (!userId) return null;
  try {
    const token = await getAccessToken();
    if (!token) return null;
    const res = await fetch(`${API_BASE}/api/balance`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (typeof data?.balanceUsd !== 'number' || !Number.isFinite(data.balanceUsd)) {
      return null;
    }

    const serverBal = Math.max(0, Number(data.balanceUsd.toFixed(2)));
    const localBal = getWalletBalance(userId);
    const alreadySynced = localStorage.getItem(serverSyncedKey(userId)) === '1';

    // Server is authoritative whenever it holds a balance, or once the account has synced with server.
    // Preserves legacy pre-migration localStorage balance if server has never been credited yet.
    if (serverBal > 0 || alreadySynced || localBal === 0) {
      setWalletBalance(userId, serverBal, true);
      return serverBal;
    }
    return localBal;
  } catch {
    return null;
  }
}

export function useUserWalletBalance() {
  const { ready, authenticated, user, getAccessToken } = usePrivy();
  const userId = authenticated ? user?.id : undefined;

  const [balance, setLocalBalance] = useState<number>(() => getWalletBalance(userId));

  const refreshBalance = useCallback(async () => {
    if (!authenticated || !userId) return 0;
    const synced = await syncServerBalance(userId, getAccessToken);
    if (synced !== null) {
      setLocalBalance(synced);
      return synced;
    }
    const local = getWalletBalance(userId);
    setLocalBalance(local);
    return local;
  }, [authenticated, userId, getAccessToken]);

  useEffect(() => {
    const syncLocal = () => {
      setLocalBalance(getWalletBalance(userId));
    };
    syncLocal();
    window.addEventListener(WALLET_BALANCE_EVENT, syncLocal);
    window.addEventListener('storage', syncLocal);
    return () => {
      window.removeEventListener(WALLET_BALANCE_EVENT, syncLocal);
      window.removeEventListener('storage', syncLocal);
    };
  }, [userId]);

  useEffect(() => {
    if (ready && authenticated && userId) {
      void refreshBalance();
    }
  }, [ready, authenticated, userId, refreshBalance]);

  const updateBalance = useCallback(
    (nextAmount: number, markServerSynced = false) => {
      const saved = setWalletBalance(userId, nextAmount, markServerSynced);
      setLocalBalance(saved);
      return saved;
    },
    [userId]
  );

  return {
    balance: authenticated && userId ? balance : 0,
    setBalance: updateBalance,
    refreshBalance,
    ready,
    authenticated,
    userId,
  };
}
