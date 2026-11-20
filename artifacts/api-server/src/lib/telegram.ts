import { createHmac, timingSafeEqual } from 'node:crypto';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';

export function verifyInitData(initData: string, maxAgeSeconds = 86400): { ok: boolean; user?: any; startParam?: string; error?: string } {
  if (!initData || !BOT_TOKEN) return { ok: false, error: 'missing' };

  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return { ok: false, error: 'no hash' };

  params.delete('hash');
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');

  const secret = createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const expected = createHmac('sha256', secret).update(dataCheckString).digest('hex');

  const receivedBuf = Buffer.from(hash, 'hex');
  const expectedBuf = Buffer.from(expected, 'hex');
  if (receivedBuf.length !== expectedBuf.length || !timingSafeEqual(receivedBuf, expectedBuf)) {
    return { ok: false, error: 'bad hash' };
  }

  const authDate = Number(params.get('auth_date'));
  if (!Number.isFinite(authDate) || Date.now() / 1000 - authDate > maxAgeSeconds) {
    return { ok: false, error: 'expired' };
  }

  let user: any = null;
  try {
    const u = params.get('user');
    if (u) user = JSON.parse(u);
  } catch {}

  return { ok: true, user, startParam: params.get('start_param') || undefined };
}

export async function createStarsInvoice(title: string, description: string, amountStars: number, payload: string) {
  if (!BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN missing');
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/createInvoiceLink`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title,
      description,
      payload,
      provider_token: '',
      currency: 'XTR',
      prices: [{ label: title, amount: amountStars }],
    }),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.description || 'invoice failed');
  return data.result as string;
}
