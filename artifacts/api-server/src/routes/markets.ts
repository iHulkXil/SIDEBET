import { Router, type IRouter, type Request, type Response } from "express";
import fs from "fs";
import path from "path";
import { AuthConfigError, AuthError, authenticateRequest } from "../lib/privy-auth";
import {
  creditUserBalanceUsd,
  debitUserBalanceUsd,
  getUserBalanceUsd,
  SOL_USD_RATE,
} from "../lib/balance-ledger";
import {
  bootstrapAdminPasscode,
  getAdminAuthStatus,
  issueAdminSessionToken,
  verifyAdminPasscode,
  verifyAdminRequest,
} from "../lib/admin-auth";

const router: IRouter = Router();

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
  status: "open" | "resolved";
  resolution: "YES" | "NO" | null;
  creator: string;
  icon?: string;
  createdAt: string;
  resolvedAt: string | null;
};

export type Position = {
  id: string;
  userId: string;
  walletAddress?: string;
  marketId: string;
  title: string;
  side: "YES" | "NO";
  amount: number; // in SOL
  odds: number;
  status: "open" | "won" | "lost" | "claimed";
  payout: number;
  payoutUsd?: number;
  creditedAt?: string;
  txSig?: string;
  placedAt: string;
};

// Seed Initial Markets across Politics, Nigerian Politics, Crypto, Sports, Finance, and Lifestyle
// Volume, liquidity, and share skew strictly start at 0 / 50-50 and reflect ONLY real bets played on this site.
const INITIAL_MARKETS: Market[] = [
  // Nigerian Politics
  {
    id: "obi-2027-coalition",
    title: "Will Peter Obi lead a unified opposition coalition ticket ahead of Nigeria's 2027 election?",
    description: "Resolves YES if Peter Obi is formally announced as the joint presidential flagbearer of a registered multi-party coalition before Q4 2026.",
    category: "Nigerian Politics",
    yesShares: 5000,
    noShares: 5000,
    liquidity: 0,
    volume: 0,
    endsAt: "Dec 2026",
    status: "open",
    resolution: null,
    creator: "Sidebet Desk",
    icon: "politics",
    createdAt: new Date().toISOString(),
    resolvedAt: null,
  },
  {
    id: "apc-nass-majority",
    title: "Will APC retain a >60% seat majority in Nigeria's National Assembly through 2026?",
    description: "Resolves YES if official National Assembly clerk seat counts show APC controlling more than 60% of combined Senate and House seats at year-end.",
    category: "Nigerian Politics",
    yesShares: 5000,
    noShares: 5000,
    liquidity: 0,
    volume: 0,
    endsAt: "Dec 31",
    status: "open",
    resolution: null,
    creator: "Sidebet Desk",
    icon: "politics",
    createdAt: new Date().toISOString(),
    resolvedAt: null,
  },
  {
    id: "tinubu-naira-1450",
    title: "Will the official USD/NGN NAFEM rate strengthen below ₦1,450 before Q4 close?",
    description: "Resolves YES if the Central Bank of Nigeria / FMDQ official closing USD/NGN rate prints below 1,450.00 Naira on any trading day before Q4 close.",
    category: "Nigerian Politics",
    yesShares: 5000,
    noShares: 5000,
    liquidity: 0,
    volume: 0,
    endsAt: "Q4",
    status: "open",
    resolution: null,
    creator: "Sidebet Desk",
    icon: "politics",
    createdAt: new Date().toISOString(),
    resolvedAt: null,
  },
  // Global Politics
  {
    id: "us-midterm-house",
    title: "Will the incumbent coalition hold a majority in the upcoming parliamentary vote?",
    description: "Resolves YES if official electoral commission certifications confirm a majority seat hold following the final ballot count.",
    category: "Politics",
    yesShares: 5000,
    noShares: 5000,
    liquidity: 0,
    volume: 0,
    endsAt: "Nov 2026",
    status: "open",
    resolution: null,
    creator: "Sidebet Foundation",
    icon: "politics",
    createdAt: new Date().toISOString(),
    resolvedAt: null,
  },
  {
    id: "global-ai-treaty",
    title: "Will G7 leaders ratify a binding frontier AI safety framework before Q4 close?",
    description: "Resolves YES if an official joint G7 ministerial communiqué ratifies binding compute and safety reporting standards before year-end.",
    category: "Politics",
    yesShares: 5000,
    noShares: 5000,
    liquidity: 0,
    volume: 0,
    endsAt: "Q4",
    status: "open",
    resolution: null,
    creator: "Sidebet Foundation",
    icon: "politics",
    createdAt: new Date().toISOString(),
    resolvedAt: null,
  },
  // Crypto
  {
    id: "btc15",
    title: "BTC price above $92,000 at end of the 4-hour settlement candle?",
    description: "Resolves YES if the Binance / Coinbase 4-hour close price for BTC/USDT prints at or above $92,000.00.",
    category: "Crypto",
    yesShares: 5000,
    noShares: 5000,
    liquidity: 0,
    volume: 0,
    endsAt: "4h",
    status: "open",
    resolution: null,
    creator: "CryptoDesk",
    icon: "btc",
    createdAt: new Date().toISOString(),
    resolvedAt: null,
  },
  {
    id: "sol15",
    title: "SOL price breaks $160 before Friday close?",
    description: "Resolves YES if Pyth Network / Raydium oracle records SOL/USD reaching $160.00 before 23:59 UTC Friday.",
    category: "Crypto",
    yesShares: 5000,
    noShares: 5000,
    liquidity: 0,
    volume: 0,
    endsAt: "48h",
    status: "open",
    resolution: null,
    creator: "CryptoDesk",
    icon: "sol",
    createdAt: new Date().toISOString(),
    resolvedAt: null,
  },
  {
    id: "eth-etf-inflows",
    title: "Will spot ETH ETFs log over $500M in net weekly inflows?",
    description: "Resolves YES if aggregate spot ETH ETF net flows exceed $500,000,000 for the current trading week.",
    category: "Crypto",
    yesShares: 5000,
    noShares: 5000,
    liquidity: 0,
    volume: 0,
    endsAt: "Fri",
    status: "open",
    resolution: null,
    creator: "CryptoDesk",
    icon: "btc",
    createdAt: new Date().toISOString(),
    resolvedAt: null,
  },
  // Sports
  {
    id: "arsenal",
    title: "Will Arsenal win the Premier League 2026/27 title race?",
    description: "Resolves YES if Arsenal Football Club is officially crowned Premier League Champions by the FA.",
    category: "Sports",
    yesShares: 5000,
    noShares: 5000,
    liquidity: 0,
    volume: 0,
    endsAt: "May 2027",
    status: "open",
    resolution: null,
    creator: "SportsDesk",
    icon: "arsenal",
    createdAt: new Date().toISOString(),
    resolvedAt: null,
  },
  {
    id: "super-eagles-wcq",
    title: "Will Nigeria's Super Eagles qualify directly for the 2026 FIFA World Cup?",
    description: "Resolves YES if Nigeria finishes top of their CAF qualifying group or secures direct qualification without playoff elimination.",
    category: "Sports",
    yesShares: 5000,
    noShares: 5000,
    liquidity: 0,
    volume: 0,
    endsAt: "WCQ",
    status: "open",
    resolution: null,
    creator: "SportsDesk",
    icon: "arsenal",
    createdAt: new Date().toISOString(),
    resolvedAt: null,
  },
  {
    id: "ucl-english-winner",
    title: "Will an English Premier League club win the 2026/27 UEFA Champions League?",
    description: "Resolves YES if any Premier League team lifts the 2026/27 UEFA Champions League trophy.",
    category: "Sports",
    yesShares: 5000,
    noShares: 5000,
    liquidity: 0,
    volume: 0,
    endsAt: "May 2027",
    status: "open",
    resolution: null,
    creator: "SportsDesk",
    icon: "arsenal",
    createdAt: new Date().toISOString(),
    resolvedAt: null,
  },
  // Finance
  {
    id: "fed-rate-cut",
    title: "Will the Federal Reserve cut interest rates by 25bps+ at the next FOMC meeting?",
    description: "Resolves YES if the FOMC official statement announces a target federal funds rate reduction of at least 25 basis points.",
    category: "Finance",
    yesShares: 5000,
    noShares: 5000,
    liquidity: 0,
    volume: 0,
    endsAt: "Q4",
    status: "open",
    resolution: null,
    creator: "EconLab",
    icon: "econ",
    createdAt: new Date().toISOString(),
    resolvedAt: null,
  },
  {
    id: "cbn-mpr-cut",
    title: "Will the Central Bank of Nigeria (CBN) cut the MPR below 25% at its next MPC?",
    description: "Resolves YES if the official CBN Monetary Policy Committee communiqué sets the Monetary Policy Rate below 25.00%.",
    category: "Finance",
    yesShares: 5000,
    noShares: 5000,
    liquidity: 0,
    volume: 0,
    endsAt: "MPC",
    status: "open",
    resolution: null,
    creator: "EconLab",
    icon: "econ",
    createdAt: new Date().toISOString(),
    resolvedAt: null,
  },
  // Lifestyle (Celebrity Gossip & Trends)
  {
    id: "davido-burna-tour",
    title: "Will Davido & Burna Boy announce a joint global stadium performance this year?",
    description: "Resolves YES if both artists or their official management announce a co-headlined stadium show or tour date.",
    category: "Lifestyle",
    yesShares: 5000,
    noShares: 5000,
    liquidity: 0,
    volume: 0,
    endsAt: "Dec 31",
    status: "open",
    resolution: null,
    creator: "CultureDesk",
    icon: "lifestyle",
    createdAt: new Date().toISOString(),
    resolvedAt: null,
  },
  {
    id: "regina-trends-viral",
    title: "Will the top celebrity power couple split rumor be officially confirmed this month?",
    description: "Resolves YES if either party publishes an official statement or verified social confirmation ending the relationship.",
    category: "Lifestyle",
    yesShares: 5000,
    noShares: 5000,
    liquidity: 0,
    volume: 0,
    endsAt: "30d",
    status: "open",
    resolution: null,
    creator: "CultureDesk",
    icon: "lifestyle",
    createdAt: new Date().toISOString(),
    resolvedAt: null,
  },
  {
    id: "grammy-afrobeats-trend",
    title: "Will an Afrobeats headline album cross 1B Spotify streams within 60 days of release?",
    description: "Resolves YES if official Spotify chart trackers confirm 1,000,000,000+ cumulative streams within 60 calendar days.",
    category: "Lifestyle",
    yesShares: 5000,
    noShares: 5000,
    liquidity: 0,
    volume: 0,
    endsAt: "60d",
    status: "open",
    resolution: null,
    creator: "CultureDesk",
    icon: "lifestyle",
    createdAt: new Date().toISOString(),
    resolvedAt: null,
  },
];

// Persistent File Storage Path
const DATA_DIR = path.resolve(process.cwd(), ".data");
const MARKETS_FILE = path.join(DATA_DIR, "sidebet_markets.json");
const POSITIONS_FILE = path.join(DATA_DIR, "sidebet_positions.json");

// In-Memory caches backed by JSON files
let marketsMap = new Map<string, Market>();
let positionsList: Position[] = [];

const INITIAL_MARKET_IDS = new Set(INITIAL_MARKETS.map((m) => m.id));

// Recompute market volume, liquidity, and AMM shares strictly from real bets placed on this site
function reconcileMarketsFromPositions(): boolean {
  let changed = false;

  const statsByMarket = new Map<
    string,
    { volume: number; yesStake: number; noStake: number }
  >();

  for (const pos of positionsList) {
    const stake = Number(pos.amount) || 0;
    if (stake <= 0) continue;
    const entry = statsByMarket.get(pos.marketId) ?? {
      volume: 0,
      yesStake: 0,
      noStake: 0,
    };
    entry.volume += stake;
    if (pos.side === "YES") entry.yesStake += stake;
    else entry.noStake += stake;
    statsByMarket.set(pos.marketId, entry);
  }

  marketsMap.forEach((market, id) => {
    const real = statsByMarket.get(id) ?? { volume: 0, yesStake: 0, noStake: 0 };
    const nextVolume = Number(real.volume.toFixed(6));
    const nextYes = 5000 + real.yesStake * 1000;
    const nextNo = 5000 + real.noStake * 1000;
    const nextLiquidity = INITIAL_MARKET_IDS.has(id)
      ? Number((real.volume * 0.5).toFixed(6))
      : market.volume === nextVolume
      ? market.liquidity
      : Number((real.volume * 0.5).toFixed(6));

    if (
      market.volume !== nextVolume ||
      market.liquidity !== nextLiquidity ||
      market.yesShares !== nextYes ||
      market.noShares !== nextNo
    ) {
      market.volume = nextVolume;
      market.liquidity = nextLiquidity;
      market.yesShares = nextYes;
      market.noShares = nextNo;
      changed = true;
    }
  });

  return changed;
}

// Load state from file or seed (and ensure new seed categories are backfilled)
function initStore() {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }

    if (fs.existsSync(MARKETS_FILE)) {
      const data = JSON.parse(fs.readFileSync(MARKETS_FILE, "utf-8"));
      if (Array.isArray(data) && data.length > 0) {
        marketsMap = new Map(data.map((m: Market) => [m.id, m]));
      }
    }

    let modified = false;
    INITIAL_MARKETS.forEach((m) => {
      if (!marketsMap.has(m.id)) {
        marketsMap.set(m.id, m);
        modified = true;
      }
    });

    if (fs.existsSync(POSITIONS_FILE)) {
      const data = JSON.parse(fs.readFileSync(POSITIONS_FILE, "utf-8"));
      if (Array.isArray(data)) {
        positionsList = data;
      }
    }

    if (reconcileMarketsFromPositions()) {
      modified = true;
    }

    if (modified) {
      persistMarkets();
    }
  } catch (err) {
    console.error("Error initializing market store:", err);
    INITIAL_MARKETS.forEach((m) => marketsMap.set(m.id, m));
  }
}

function persistMarkets() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(MARKETS_FILE, JSON.stringify(Array.from(marketsMap.values()), null, 2));
  } catch (err) {
    console.error("Failed to persist markets:", err);
  }
}

function persistPositions() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(POSITIONS_FILE, JSON.stringify(positionsList, null, 2));
  } catch (err) {
    console.error("Failed to persist positions:", err);
  }
}

initStore();

/* ==========================================================================
   MARKET ROUTES
   ========================================================================== */

// 1. GET /api/markets
router.get("/markets", (req: Request, res: Response) => {
  const { category, status, search } = req.query;
  let all = Array.from(marketsMap.values());

  if (category && category !== "All") {
    all = all.filter((m) => m.category.toLowerCase() === String(category).toLowerCase());
  }

  if (status) {
    all = all.filter((m) => m.status === status);
  }

  if (search) {
    const q = String(search).toLowerCase();
    all = all.filter((m) => m.title.toLowerCase().includes(q) || m.category.toLowerCase().includes(q));
  }

  return res.json({
    success: true,
    total: all.length,
    markets: all,
  });
});

// 2. GET /api/markets/:id
router.get("/markets/:id", (req: Request, res: Response) => {
  const market = marketsMap.get(String(req.params.id));
  if (!market) {
    return res.status(404).json({ error: "Market not found" });
  }

  // Get recent trades / positions for this market
  const marketPositions = positionsList
    .filter((p) => p.marketId === market.id)
    .slice(0, 20);

  return res.json({
    success: true,
    market,
    recentOrders: marketPositions,
  });
});

// 3. POST /api/markets
router.post("/markets", (req: Request, res: Response) => {
  const { title, description, category, initialLiquidity, creator, endsAt } = req.body;

  if (!title || typeof title !== "string" || !title.trim()) {
    return res.status(400).json({ error: "Market title is required" });
  }

  const cat = category || "Politics";
  const icon =
    cat === "Crypto"
      ? "btc"
      : cat === "Sports"
      ? "arsenal"
      : cat === "Lifestyle"
      ? "lifestyle"
      : cat === "Finance"
      ? "econ"
      : "politics";

  const id = `mkt-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
  const newMarket: Market = {
    id,
    title: title.trim(),
    description: description || "Decentralized prediction event contract settled via Sidebet onchain oracle.",
    category: cat,
    yesShares: 5000,
    noShares: 5000,
    liquidity: Number(initialLiquidity) || 10,
    volume: 0,
    endsAt: endsAt || "7d",
    status: "open",
    resolution: null,
    creator: creator || "Community User",
    icon,
    createdAt: new Date().toISOString(),
    resolvedAt: null,
  };

  marketsMap.set(id, newMarket);
  persistMarkets();

  return res.status(201).json({
    success: true,
    market: newMarket,
  });
});

/* ==========================================================================
   ADMIN AUTHENTICATION ROUTES (FOR MARKET SETTLEMENT)
   ========================================================================== */

router.get("/admin/status", (_req: Request, res: Response) => {
  return res.json({
    success: true,
    ...getAdminAuthStatus(),
  });
});

router.post("/admin/bootstrap", (req: Request, res: Response) => {
  const { passcode } = req.body ?? {};
  if (typeof passcode !== "string") {
    return res.status(400).json({ error: "Passcode is required" });
  }
  const result = bootstrapAdminPasscode(passcode);
  if (!result.ok) {
    return res.status(400).json({ error: result.error });
  }
  const token = issueAdminSessionToken();
  return res.status(201).json({ success: true, token });
});

router.post("/admin/login", (req: Request, res: Response) => {
  const { passcode } = req.body ?? {};
  if (typeof passcode !== "string" || !verifyAdminPasscode(passcode)) {
    return res.status(401).json({ error: "Invalid admin passcode" });
  }
  const token = issueAdminSessionToken();
  return res.json({ success: true, token });
});

// 4. POST /api/markets/:id/resolve (Server-verified Admin Resolver + Auto Winner Payout)
router.post("/markets/:id/resolve", (req: Request, res: Response) => {
  if (!verifyAdminRequest(req)) {
    return res.status(401).json({ error: "Admin authentication required to resolve markets" });
  }

  const { resolution } = req.body ?? {}; // "YES" | "NO"
  const market = marketsMap.get(String(req.params.id));

  if (!market) {
    return res.status(404).json({ error: "Market not found" });
  }

  if (market.status === "resolved") {
    return res.status(400).json({ error: "Market is already resolved" });
  }

  if (resolution !== "YES" && resolution !== "NO") {
    return res.status(400).json({ error: "Resolution must be 'YES' or 'NO'" });
  }

  // Resolve Market
  market.status = "resolved";
  market.resolution = resolution;
  market.resolvedAt = new Date().toISOString();
  persistMarkets();

  // Settle all related open positions and automatically credit winners' server USD balances
  let updatedCount = 0;
  let wonCount = 0;
  let lostCount = 0;
  let totalCreditedUsd = 0;
  const nowIso = new Date().toISOString();

  positionsList.forEach((pos) => {
    if (pos.marketId === market.id && pos.status === "open") {
      updatedCount++;
      if (pos.side === resolution) {
        const payoutSol = Number((pos.amount * pos.odds).toFixed(6));
        const payoutUsd = Number((payoutSol * SOL_USD_RATE).toFixed(2));
        pos.payout = payoutSol;
        pos.payoutUsd = payoutUsd;
        wonCount++;

        if (pos.userId && pos.userId !== "guest-user") {
          creditUserBalanceUsd(pos.userId, payoutUsd);
          pos.status = "claimed";
          pos.creditedAt = nowIso;
          totalCreditedUsd = Number((totalCreditedUsd + payoutUsd).toFixed(2));
        } else {
          pos.status = "won";
        }
      } else {
        pos.status = "lost";
        pos.payout = 0;
        pos.payoutUsd = 0;
        lostCount++;
      }
    }
  });

  persistPositions();

  return res.json({
    success: true,
    message: `Market resolved to ${resolution}. ${updatedCount} positions settled ($${totalCreditedUsd.toFixed(2)} credited).`,
    market,
    stats: {
      settledPositions: updatedCount,
      wonPositions: wonCount,
      lostPositions: lostCount,
      totalCreditedUsd,
    },
  });
});

/* ==========================================================================
   POSITION & STAKING ROUTES
   ========================================================================== */

// 5. GET /api/positions
router.get("/positions", (req: Request, res: Response) => {
  const { userId, walletAddress, marketId } = req.query;
  let list = [...positionsList];

  const addr = walletAddress ? String(walletAddress).toLowerCase() : "";
  const uid = userId ? String(userId) : "";

  if (addr && uid) {
    list = list.filter(
      (p) => p.walletAddress?.toLowerCase() === addr || p.userId === uid,
    );
  } else if (addr) {
    list = list.filter((p) => p.walletAddress?.toLowerCase() === addr);
  } else if (uid) {
    list = list.filter((p) => p.userId === uid);
  }

  if (marketId) {
    list = list.filter((p) => p.marketId === String(marketId));
  }

  return res.json({
    success: true,
    total: list.length,
    positions: list,
  });
});

// 6. POST /api/positions (Stake on a market)
router.post("/positions", async (req: Request, res: Response) => {
  const { marketId, side, amount, userId, walletAddress, txSig } = req.body ?? {};

  if (!marketId || !side || !amount) {
    return res.status(400).json({ error: "marketId, side, and amount are required" });
  }

  if (side !== "YES" && side !== "NO") {
    return res.status(400).json({ error: "side must be 'YES' or 'NO'" });
  }

  const market = marketsMap.get(String(marketId));
  if (!market) {
    return res.status(404).json({ error: "Market not found" });
  }

  if (market.status !== "open") {
    return res.status(400).json({ error: "Cannot stake on a resolved market" });
  }

  const stakeAmount = Number(amount);
  if (!Number.isFinite(stakeAmount) || stakeAmount <= 0 || stakeAmount > 1000) {
    return res.status(400).json({ error: "Invalid stake amount" });
  }

  // Prefer server-verified Privy identity when Authorization header is provided
  let resolvedUserId = typeof userId === "string" && userId.trim() ? userId.trim() : "guest-user";
  let authenticatedPrivyUserId: string | null = null;
  if (typeof req.headers.authorization === "string" && req.headers.authorization.startsWith("Bearer ")) {
    try {
      const identity = await authenticateRequest(req);
      authenticatedPrivyUserId = identity.privyUserId;
      resolvedUserId = identity.privyUserId;
    } catch {
      // Allow graceful fallback if Privy config isn't active in local dev
    }
  }

  // Compute server-side odds from current AMM shares BEFORE applying this stake
  const totalShares = (market.yesShares || 0) + (market.noShares || 0) || 1;
  const yesProb = Math.max(0.01, Math.min(0.99, market.yesShares / totalShares));
  const serverOdds = Number((1 / (side === "YES" ? yesProb : 1 - yesProb)).toFixed(2));

  // If staked from off-chain server USD balance (no Solana txSig), debit server ledger when available
  let updatedBalanceUsd: number | undefined;
  if (!txSig && authenticatedPrivyUserId) {
    const stakeUsd = Number((stakeAmount * SOL_USD_RATE).toFixed(2));
    const currentServerBal = getUserBalanceUsd(authenticatedPrivyUserId);
    if (currentServerBal >= stakeUsd) {
      const debit = debitUserBalanceUsd(authenticatedPrivyUserId, stakeUsd);
      updatedBalanceUsd = debit.balanceUsd;
    } else {
      updatedBalanceUsd = currentServerBal;
    }
  } else if (authenticatedPrivyUserId) {
    updatedBalanceUsd = getUserBalanceUsd(authenticatedPrivyUserId);
  }

  // Update market AMM shares & volume
  const shareDelta = stakeAmount * 1000;
  if (side === "YES") {
    market.yesShares += shareDelta;
  } else {
    market.noShares += shareDelta;
  }
  market.volume = Number((market.volume + stakeAmount).toFixed(6));
  market.liquidity = Number((market.liquidity + stakeAmount * 0.5).toFixed(6));
  persistMarkets();

  // Create new position
  const position: Position = {
    id: `pos-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
    userId: resolvedUserId,
    walletAddress: typeof walletAddress === "string" && walletAddress.trim() ? walletAddress.trim() : undefined,
    marketId: market.id,
    title: market.title,
    side,
    amount: stakeAmount,
    odds: serverOdds,
    status: "open",
    payout: 0,
    txSig: typeof txSig === "string" && txSig.trim() ? txSig.trim() : undefined,
    placedAt: new Date().toISOString(),
  };

  positionsList.unshift(position);
  persistPositions();

  return res.status(201).json({
    success: true,
    position,
    market,
    ...(updatedBalanceUsd !== undefined ? { balanceUsd: updatedBalanceUsd } : {}),
  });
});

// 7. POST /api/positions/:id/claim (Fallback manual claim for uncredited 'won' positions)
router.post("/positions/:id/claim", async (req: Request, res: Response) => {
  try {
    const identity = await authenticateRequest(req);
    const pos = positionsList.find((p) => p.id === req.params.id);
    if (!pos) {
      return res.status(404).json({ error: "Position not found" });
    }

    if (pos.userId && pos.userId !== "guest-user" && pos.userId !== identity.privyUserId) {
      return res.status(403).json({ error: "You do not own this position" });
    }

    if (pos.status !== "won") {
      return res.status(400).json({ error: "Position is not in a claimable winning state" });
    }

    const payoutUsd = Number((pos.payoutUsd ?? pos.payout * SOL_USD_RATE).toFixed(2));
    const balanceUsd = creditUserBalanceUsd(identity.privyUserId, payoutUsd);
    pos.status = "claimed";
    pos.payoutUsd = payoutUsd;
    pos.creditedAt = new Date().toISOString();
    persistPositions();

    return res.json({
      success: true,
      claimedAmount: pos.payout,
      claimedUsd: payoutUsd,
      balanceUsd,
      position: pos,
    });
  } catch (error) {
    if (error instanceof AuthConfigError) {
      return res.status(503).json({ error: error.message });
    }
    if (error instanceof AuthError) {
      return res.status(401).json({ error: error.message });
    }
    return res.status(500).json({ error: "Failed to claim position" });
  }
});

// 8. GET /api/stats/overview
router.get("/stats/overview", (_req: Request, res: Response) => {
  const allMarkets = Array.from(marketsMap.values());
  const totalVolume = Number(
    allMarkets.reduce((acc, m) => acc + (m.volume || 0), 0).toFixed(6),
  );
  const totalLiquidity = Number(
    allMarkets.reduce((acc, m) => acc + (m.liquidity || 0), 0).toFixed(6),
  );
  const openCount = allMarkets.filter((m) => m.status === "open").length;
  const resolvedCount = allMarkets.filter((m) => m.status === "resolved").length;
  const uniqueTraders = new Set(
    positionsList
      .map((p) => p.walletAddress || p.userId)
      .filter((id): id is string => Boolean(id && id.trim())),
  );

  return res.json({
    success: true,
    stats: {
      totalMarkets: allMarkets.length,
      openMarkets: openCount,
      resolvedMarkets: resolvedCount,
      totalVolume,
      totalLiquidity,
      totalPositions: positionsList.length,
      activeTradersCount: uniqueTraders.size,
    },
  });
});

export default router;
