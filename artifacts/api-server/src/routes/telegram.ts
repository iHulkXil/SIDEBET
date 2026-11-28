import { Router } from 'express';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { createStarsInvoice, verifyInitData } from '../lib/telegram';
import { authenticateRequest } from '../lib/privy-auth';
import { creditUserBalanceUsd, getUserBalanceUsd } from '../lib/balance-ledger';

const router = Router();

const DATA_DIR = path.resolve(process.cwd(), '.data');
const CREDITS_FILE = path.join(DATA_DIR, 'sidebet_stars_credits.json');
const CHARGES_FILE = path.join(DATA_DIR, 'sidebet_stars_charges.json');

type CreditLedger = Record<string, number>; // telegramUserId -> usd credit

function loadCredits(): CreditLedger {
  try {
    if (fs.existsSync(CREDITS_FILE)) {
      return JSON.parse(fs.readFileSync(CREDITS_FILE, 'utf-8'));
    }
  } catch {}
  return {};
}

function saveCredits(ledger: CreditLedger) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(CREDITS_FILE, JSON.stringify(ledger, null, 2));
  } catch (err) {
    console.error('Failed to save credits', err);
  }
}

function loadCharges(): Set<string> {
  try {
    if (fs.existsSync(CHARGES_FILE)) {
      const arr = JSON.parse(fs.readFileSync(CHARGES_FILE, 'utf-8'));
      return new Set(arr);
    }
  } catch {}
  return new Set();
}

function saveCharges(charges: Set<string>) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(CHARGES_FILE, JSON.stringify([...charges]));
  } catch (err) {
    console.error('Failed to save charges', err);
  }
}

function verifyWebhookSecret(headerToken: string | undefined): boolean {
  const expected = (process.env.TELEGRAM_WEBHOOK_SECRET || '').trim();
  if (!expected) return true; // Optional until configured on Render + setWebhook
  const received = (headerToken || '').trim();
  const a = Buffer.from(received, 'utf-8');
  const b = Buffer.from(expected, 'utf-8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';

async function answerPreCheckout(queryId: string, ok: boolean, errorMessage?: string) {
  if (!BOT_TOKEN) return;
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerPreCheckoutQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      pre_checkout_query_id: queryId,
      ok,
      ...(errorMessage ? { error_message: errorMessage } : {}),
    }),
  });
}

// Create Stars invoice for depositing credit (100 Stars ≈ $1)
router.post('/stars/invoice', async (req, res) => {
  try {
    const { amountStars = 100, description = 'SIDEBET wallet credit' } = req.body ?? {};
    const parsedStars = Math.floor(Number(amountStars));
    if (!Number.isFinite(parsedStars) || parsedStars < 10 || parsedStars > 100000) {
      return res.status(400).json({ error: 'amountStars must be between 10 and 100000' });
    }

    const safeDesc =
      typeof description === 'string' && description.trim().length > 0
        ? description.trim().slice(0, 180)
        : 'SIDEBET wallet credit';

    const initData = (req.headers['x-telegram-init-data'] as string) || '';
    const verified = verifyInitData(initData);
    if (!verified.ok || !verified.user) {
      return res.status(401).json({ error: 'invalid init data' });
    }

    const payload = JSON.stringify({
      userId: verified.user.id,
      amountStars: parsedStars,
      ts: Date.now(),
    });

    const invoiceUrl = await createStarsInvoice(
      'SIDEBET Credit',
      safeDesc,
      parsedStars,
      payload
    );

    res.json({ invoiceUrl, amountStars: parsedStars });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'invoice failed' });
  }
});

// Claim pending credit into server-side user balance ledger (called after successful openInvoice)
router.post('/stars/claim', async (req, res) => {
  try {
    const initData = (req.headers['x-telegram-init-data'] as string) || '';
    const verified = verifyInitData(initData);
    if (!verified.ok || !verified.user) {
      return res.status(401).json({ error: 'invalid init data' });
    }

    let privyUserId: string | null = null;
    if (typeof req.headers.authorization === 'string' && req.headers.authorization.startsWith('Bearer ')) {
      try {
        const identity = await authenticateRequest(req);
        privyUserId = identity.privyUserId;
      } catch {
        // Proceed with Telegram-only fallback if Privy token is missing/invalid
      }
    }

    const tgUserId = String(verified.user.id);
    const ledger = loadCredits();
    const credit = Number((ledger[tgUserId] || 0).toFixed(2));
    if (credit > 0) {
      ledger[tgUserId] = 0;
      saveCredits(ledger);
    }

    let balanceUsd: number | undefined;
    if (privyUserId) {
      balanceUsd =
        credit > 0
          ? creditUserBalanceUsd(privyUserId, credit)
          : getUserBalanceUsd(privyUserId);
    }

    res.json({ creditUsd: credit, ...(balanceUsd !== undefined ? { balanceUsd } : {}) });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'claim failed' });
  }
});

// Webhook: pre_checkout_query + successful_payment
router.post('/stars/webhook', (req, res) => {
  const secretHeader = req.headers['x-telegram-bot-api-secret-token'] as string | undefined;
  if (!verifyWebhookSecret(secretHeader)) {
    return res.status(401).json({ error: 'invalid webhook secret' });
  }

  const update = req.body;
  console.log('Telegram webhook update type:', Object.keys(update || {}).join(','));

  // Pre-checkout: always approve for MVP
  if (update?.pre_checkout_query) {
    const q = update.pre_checkout_query;
    void answerPreCheckout(q.id, true).catch(console.error);
    return res.sendStatus(200);
  }

  // Successful payment
  const payment = update?.message?.successful_payment;
  if (payment && payment.currency === 'XTR') {
    try {
      const payload = JSON.parse(payment.invoice_payload || '{}');
      const userId = String(payload.userId || update.message?.from?.id || '');
      const chargeId = payment.telegram_payment_charge_id;
      const stars = Number(payment.total_amount) || 0;

      if (!userId || !chargeId || stars <= 0) {
        return res.sendStatus(200);
      }

      const charges = loadCharges();
      if (charges.has(chargeId)) {
        return res.sendStatus(200); // idempotent
      }

      // 100 Stars = $1
      const usd = Number((stars / 100).toFixed(2));
      const ledger = loadCredits();
      ledger[userId] = Number(((ledger[userId] || 0) + usd).toFixed(2));
      saveCredits(ledger);

      charges.add(chargeId);
      saveCharges(charges);

      console.log(`Credited ${usd} USD to Telegram user ${userId} (charge ${chargeId})`);
    } catch (err) {
      console.error('Failed to process successful_payment', err);
    }
  }

  res.sendStatus(200);
});

export default router;
