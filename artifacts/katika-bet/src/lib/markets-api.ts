export type Market = {
  id: string;
  title: string;
  description?: string;
  category: string;
  yesShares: number;
  noShares: number;
  liquidity: number;
  volume: number;
  endsAt: string;
  status: 'open' | 'resolved';
  resolution: 'YES' | 'NO' | null;
  creator: string;
  icon?: string;
  createdAt?: string;
  resolvedAt?: string | null;
};

export type Position = {
  id: string;
  userId?: string;
  walletAddress?: string;
  marketId: string;
  title: string;
  side: 'YES' | 'NO';
  amount: number; // in SOL
  odds: number;
  status: 'open' | 'won' | 'lost' | 'claimed';
  payout: number;
  payoutUsd?: number;
  creditedAt?: string;
  txSig?: string;
  placedAt: string;
};

export type PlatformStats = {
  totalMarkets: number;
  openMarkets: number;
  resolvedMarkets: number;
  totalVolume: number;
  totalLiquidity: number;
  totalPositions: number;
  activeTradersCount: number;
};

export type AdminAuthStatus = {
  configured: boolean;
  needsBootstrap: boolean;
  envManaged: boolean;
};

const API_BASE = import.meta.env.VITE_API_BASE || '';

// Calculate probability and decimal odds from AMM shares
export function calcOdds(yes: number, no: number) {
  const total = (yes || 0) + (no || 0) || 1;
  const yesProb = Math.max(0.01, Math.min(0.99, yes / total));
  return {
    yes: (1 / yesProb).toFixed(2),
    no: (1 / (1 - yesProb)).toFixed(2),
    yesPct: Math.round(yesProb * 100),
  };
}

export async function fetchMarkets(category?: string, search?: string): Promise<Market[]> {
  try {
    const params = new URLSearchParams();
    if (category && category !== 'All') params.append('category', category);
    if (search) params.append('search', search);

    const res = await fetch(`${API_BASE}/api/markets?${params.toString()}`);
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data.markets)) {
        try {
          if (!category || category === 'All') {
            localStorage.setItem('sidebet_cached_markets', JSON.stringify(data.markets));
          }
        } catch {}
        return data.markets;
      }
    }
  } catch (err) {
    console.warn('Backend /api/markets unreachable, using cached state:', err);
  }

  // Local storage fallback if offline
  const local = localStorage.getItem('sidebet_cached_markets');
  if (local) {
    try {
      return JSON.parse(local);
    } catch {}
  }
  return [];
}

export async function fetchMarketById(id: string): Promise<{ market: Market; recentOrders: Position[] } | null> {
  try {
    const res = await fetch(`${API_BASE}/api/markets/${encodeURIComponent(id)}`);
    if (res.ok) {
      const data = await res.json();
      return { market: data.market, recentOrders: data.recentOrders || [] };
    }
  } catch (err) {
    console.warn(`Failed to fetch market ${id}:`, err);
  }
  return null;
}

export async function createMarket(input: {
  title: string;
  category: string;
  description?: string;
  initialLiquidity?: number;
  creator?: string;
}): Promise<Market> {
  const res = await fetch(`${API_BASE}/api/markets`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Failed to create market');
  }

  const data = await res.json();
  return data.market;
}

export async function fetchAdminStatus(): Promise<AdminAuthStatus> {
  const res = await fetch(`${API_BASE}/api/admin/status`);
  if (!res.ok) {
    throw new Error('Could not check admin status');
  }
  const data = await res.json();
  return {
    configured: Boolean(data.configured),
    needsBootstrap: Boolean(data.needsBootstrap),
    envManaged: Boolean(data.envManaged),
  };
}

export async function bootstrapAdmin(passcode: string): Promise<string> {
  const res = await fetch(`${API_BASE}/api/admin/bootstrap`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ passcode }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.token) {
    throw new Error(data.error || 'Failed to set admin passcode');
  }
  return data.token;
}

export async function loginAdmin(passcode: string): Promise<string> {
  const res = await fetch(`${API_BASE}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ passcode }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.token) {
    throw new Error(data.error || 'Invalid admin passcode');
  }
  return data.token;
}

export async function resolveMarket(
  marketId: string,
  resolution: 'YES' | 'NO',
  adminToken: string
): Promise<{
  market: Market;
  message?: string;
  stats: {
    settledPositions: number;
    wonPositions: number;
    lostPositions: number;
    totalCreditedUsd?: number;
  };
}> {
  const res = await fetch(`${API_BASE}/api/markets/${encodeURIComponent(marketId)}/resolve`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-admin-token': adminToken,
    },
    body: JSON.stringify({ resolution }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Failed to resolve market');
  }

  return await res.json();
}

export async function fetchPositions(walletAddress?: string, userId?: string): Promise<Position[]> {
  try {
    const params = new URLSearchParams();
    if (walletAddress) params.append('walletAddress', walletAddress);
    if (userId) params.append('userId', userId);

    const res = await fetch(`${API_BASE}/api/positions?${params.toString()}`);
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data.positions)) {
        return data.positions;
      }
    }
  } catch (err) {
    console.warn('Backend /api/positions unreachable:', err);
  }

  const local = localStorage.getItem('sidebet_positions');
  if (local) {
    try {
      return JSON.parse(local);
    } catch {}
  }
  return [];
}

export async function placeStake(
  input: {
    marketId: string;
    side: 'YES' | 'NO';
    amount: number;
    odds: number;
    userId?: string;
    walletAddress?: string;
    txSig?: string;
  },
  accessToken?: string | null
): Promise<{ position: Position; market: Market; balanceUsd?: number }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (accessToken) {
    headers.Authorization = `Bearer ${accessToken}`;
  }

  const res = await fetch(`${API_BASE}/api/positions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(input),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Failed to place stake');
  }

  const data = await res.json();

  // Also cache locally in client positions
  try {
    const raw = localStorage.getItem('sidebet_positions') || '[]';
    const list: Position[] = JSON.parse(raw);
    list.unshift(data.position);
    localStorage.setItem('sidebet_positions', JSON.stringify(list.slice(0, 50)));
  } catch {}

  return data;
}

export async function claimWinnings(
  positionId: string,
  accessToken?: string | null
): Promise<{ claimedAmount: number; claimedUsd?: number; balanceUsd?: number }> {
  const headers: Record<string, string> = {};
  if (accessToken) {
    headers.Authorization = `Bearer ${accessToken}`;
  }

  const res = await fetch(`${API_BASE}/api/positions/${encodeURIComponent(positionId)}/claim`, {
    method: 'POST',
    headers,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Failed to claim position');
  }

  const data = await res.json();
  return {
    claimedAmount: data.claimedAmount,
    claimedUsd: data.claimedUsd,
    balanceUsd: data.balanceUsd,
  };
}

export async function fetchStats(): Promise<PlatformStats> {
  try {
    const res = await fetch(`${API_BASE}/api/stats/overview`);
    if (res.ok) {
      const data = await res.json();
      return data.stats;
    }
  } catch (err) {
    console.warn('Failed to fetch stats:', err);
  }

  return {
    totalMarkets: 0,
    openMarkets: 0,
    resolvedMarkets: 0,
    totalVolume: 0,
    totalLiquidity: 0,
    totalPositions: 0,
    activeTradersCount: 0,
  };
}
