# SIDEBET Telegram Mini App Guide

## Required Environment Variables (Render)

```env
TELEGRAM_BOT_TOKEN=your_bot_token_from_BotFather
TELEGRAM_WEBHOOK_SECRET=your_random_webhook_secret
ADMIN_PASSCODE=your_strong_admin_settlement_passcode
```

## BotFather & Webhook Setup

1. Open **@BotFather** → `/mybots` → select your bot → **Bot Settings** → **Menu Button** → **Configure menu button** → set Web App URL to your live Vercel origin (e.g. `https://your-app.vercel.app`).
2. Configure the Telegram webhook (include `secret_token` matching `TELEGRAM_WEBHOOK_SECRET` on Render):

```bash
curl -X POST "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://katika-w8bs.onrender.com/api/telegram/stars/webhook",
    "secret_token": "'"$TELEGRAM_WEBHOOK_SECRET"'"
  }'
```

3. Verify webhook status:

```bash
curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getWebhookInfo"
```

## Market Deep Links

Share any prediction market directly in Telegram chats or channels:

```text
https://t.me/YOUR_BOT_USERNAME/app?startapp=market_<marketId>
```

Example:

```text
https://t.me/sidebetbot/app?startapp=market_obi-2027-coalition
```

- If the user is already signed in and verified, SIDEBET opens `/markets?open=<marketId>` immediately.
- If the user still needs to sign in or finish KYC, the pending market ID is preserved in `sessionStorage` and automatically opens right after onboarding completes.

## Telegram Stars Payments & Balance Sync

1. Inside Telegram, the **Wallet** page displays Stars top-up buttons (`100 / 500 / 1000 Stars`; `100 Stars = $1.00 USD`).
2. `POST /api/telegram/stars/invoice` verifies `x-telegram-init-data` and creates a Stars invoice (`XTR`).
3. Telegram sends `pre_checkout_query` and `successful_payment` updates to `POST /api/telegram/stars/webhook`, which records the USD credit idempotently by `telegram_payment_charge_id`.
4. After `openStarsInvoice()` resolves with `paid`, the client polls `POST /api/telegram/stars/claim` (sending both `x-telegram-init-data` and the Privy Bearer token) to credit the user's server-side balance ledger (`.data/sidebet_balances.json`).
5. On app load or across devices, `GET /api/balance` syncs the server-side USD balance with localStorage caching.

## Admin Market Settlement

- Open `/admin` or click **Settle** in the Markets header.
- Authenticate with `ADMIN_PASSCODE` (kept in memory only).
- Resolve any open market to **YES** or **NO** — the backend marks positions `won`/`lost` and automatically credits winning users' server-side USD balances.
