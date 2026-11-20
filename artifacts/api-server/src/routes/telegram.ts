import { Router } from 'express';
import { createStarsInvoice, verifyInitData } from '../lib/telegram';

const router = Router();

// Create Stars invoice for depositing credit (e.g. 100 Stars = $1 credit)
router.post('/stars/invoice', async (req, res) => {
  try {
    const { amountStars = 100, description = 'SIDEBET credit' } = req.body;
    const initData = req.headers['x-telegram-init-data'] as string || '';
    const verified = verifyInitData(initData);
    if (!verified.ok || !verified.user) {
      return res.status(401).json({ error: 'invalid init data' });
    }

    const payload = JSON.stringify({
      userId: verified.user.id,
      amountStars,
      ts: Date.now(),
    });

    const invoiceUrl = await createStarsInvoice(
      'SIDEBET Credit',
      description,
      amountStars,
      payload
    );

    res.json({ invoiceUrl, amountStars });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'invoice failed' });
  }
});

// Simple webhook endpoint for successful payments (point BotFather webhook here)
router.post('/stars/webhook', express.json(), (req, res) => {
  // Telegram sends updates here. For production, verify and credit user on successful_payment
  console.log('Telegram webhook:', JSON.stringify(req.body).slice(0, 500));
  res.sendStatus(200);
});

export default router;
