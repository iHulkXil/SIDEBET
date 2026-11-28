# SIDEBET Soft Launch Guide

SIDEBET is a Yes/No prediction markets and PvP platform launching primarily as a Telegram Mini App.

## Architecture

- **Frontend (`artifacts/katika-bet`)**: Vite + React deployed on Vercel (`vercel.json` proxies `/api/*` to Render).
- **Backend (`artifacts/api-server`)**: Express API deployed on Render (`https://katika-w8bs.onrender.com`).
- **Auth**: Privy (Email, Google, Solana/EVM wallets).
- **Persistence**: Markets, positions, server-side USD balances, Telegram Stars credits, and admin auth state persist in JSON files under `.data/`.
- **Payments**:
  - **Telegram Stars**: `100 Stars = $1.00 USD` credit via `POST /api/telegram/stars/invoice`, webhook `POST /api/telegram/stars/webhook`, and claim `POST /api/telegram/stars/claim`.
  - **Solana Treasury**: Direct SOL transfers to `7MYUSRzd7hJEmW1zDVafw4BNuYFt84tKAz5evM8i8fs3` with server-side USD balance fallback.

## Required Environment Variables (Render)

Set these on the Render service before public launch:

- `PRIVY_APP_ID` / `PRIVY_APP_SECRET`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_WEBHOOK_SECRET` (recommended — match with `secret_token` in Telegram `setWebhook`)
- `ADMIN_PASSCODE` (recommended — protects `POST /api/markets/:id/resolve`; if unset, first-run bootstrap via `/admin` claims a salted hash)

## Deployment Checks

1. Deploy backend on Render and verify:
   - `GET https://katika-w8bs.onrender.com/api/health` → `{ "status": "ok" }`
   - `GET https://katika-w8bs.onrender.com/api/healthz` → `{ "status": "ok" }`
   - `GET https://katika-w8bs.onrender.com/api/markets` → returns seeded markets (Nigerian Politics, Politics, Crypto, Sports, Finance, Lifestyle) starting at `0` volume until real wagers are placed.
2. Deploy frontend on Vercel and confirm `/api/markets` resolves through the Vercel rewrite.
3. Confirm BotFather Menu Button / Web App URL points to the live Vercel origin.

## Core Soft-Launch User Flow

1. Open SIDEBET in Telegram (directly or via `t.me/YOUR_BOT/app?startapp=market_<marketId>`).
2. Confirm the first-open **18+ & Jurisdiction Notice**, sign in via Privy, and complete basic KYC.
3. Browse or open a market, click **Yes** or **No** to open the order ticket, choose or edit a stake amount (`0.05 / 0.1 / 0.25 / 0.5 / 1 SOL` or custom decimal with live USD estimate), and submit.
4. Top up balance with **Telegram Stars** (`100 / 500 / 1000 Stars`) on the Wallet page if needed; credits sync into the server-side balance ledger across devices.
5. Track open and settled wagers under **My Bets**.
6. Settle markets via the **Settle / Admin** modal (or `/admin` route) using the admin passcode — winning positions automatically credit winners' server-side USD balances.

## Launch Checklist

- [ ] `/api/health` and `/api/healthz` return `ok`
- [ ] `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, and `ADMIN_PASSCODE` set on Render
- [ ] Telegram webhook registered and returning `200`
- [ ] Deep link `?startapp=market_obi-2027-coalition` opens target market (even after sign-in/KYC)
- [ ] Order ticket opens cleanly on Yes/No click with editable SOL input, quick chips, and USD estimate
- [ ] Stars purchase → webhook credit → claim → server balance updates across reloads
- [ ] Admin resolves a test market → winner balance increases automatically and position shows `WON · CREDITED`
