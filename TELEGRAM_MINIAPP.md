# Telegram Mini App MVP notes

## Required env on Render
TELEGRAM_BOT_TOKEN=your_bot_token_from_BotFather

## BotFather setup
1. /mybots → Bot Settings → Menu Button → Configure → set Web App URL to your Vercel origin
2. Or use /newapp

## Deep links
Share a market with:
```
t.me/YOUR_BOT_USERNAME/app?startapp=market_<marketId>
```
Example:
```
t.me/sidebetbot/app?startapp=market_obi-2027-coalition
```
The app opens and auto-loads that market detail.

## Stars payments
- POST /api/telegram/stars/invoice { amountStars }
- Header: x-telegram-init-data
- Frontend calls openStarsInvoice(invoiceUrl)
- Webhook: POST /api/telegram/stars/webhook (set in BotFather)

## Next
- Credit user balance on successful_payment webhook (done)
- Deep link to market detail on start_param (done)
- Mobile layout polish already present in layout-shell
