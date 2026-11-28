import { Router, type IRouter, type Request, type Response } from "express";
import { AuthConfigError, AuthError, authenticateRequest } from "../lib/privy-auth";
import { getUserBalanceUsd, SOL_USD_RATE } from "../lib/balance-ledger";

const router: IRouter = Router();

// GET /api/balance - Server-side source of truth for authenticated user's USD balance
router.get("/balance", async (req: Request, res: Response) => {
  try {
    const identity = await authenticateRequest(req);
    const balanceUsd = getUserBalanceUsd(identity.privyUserId);
    return res.json({
      success: true,
      userId: identity.privyUserId,
      balanceUsd,
      solUsdRate: SOL_USD_RATE,
    });
  } catch (error) {
    if (error instanceof AuthConfigError) {
      return res.status(503).json({ error: error.message });
    }
    if (error instanceof AuthError) {
      return res.status(401).json({ error: error.message });
    }
    return res.status(500).json({ error: "Failed to fetch balance" });
  }
});

export default router;
