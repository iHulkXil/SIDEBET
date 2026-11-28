import { useState, useEffect, useCallback } from 'react';
import { Link } from 'wouter';
import { usePrivy, useWallets as useEvmWallets } from '@privy-io/react-auth';
import { useWallets } from '@privy-io/react-auth/solana';
import { ArrowUpRight, Copy, Check, Plus, LayoutGrid, Star } from 'lucide-react';
import { MainnetDepositWithdrawModal } from '@/components/mainnet-deposit-modal';
import { NotificationsMenu } from '@/components/notifications-menu';
import { MyBets } from '@/components/my-bets';
import { fetchPositions, type Position } from '@/lib/markets-api';
import { useUserAvatar } from '@/lib/avatar';
import { useUserWalletBalance } from '@/lib/balance';
import {
  getTelegramWebApp,
  openStarsInvoice,
  isTelegramWebApp,
  triggerHaptic,
  triggerHapticNotification,
} from '@/lib/telegram';
import { useToast } from '@/hooks/use-toast';

const API_BASE = import.meta.env.VITE_API_BASE || '';

export function CryptoWalletDashboard() {
  const { authenticated, user, getAccessToken } = usePrivy();
  const { wallets } = useWallets();
  const { wallets: evmWallets } = useEvmWallets();
  const { avatarUrl } = useUserAvatar();
  const { balance, setBalance, refreshBalance } = useUserWalletBalance();
  const { toast } = useToast();

  const [modalOpen, setModalOpen] = useState(false);
  const [modalMode, setModalMode] = useState<'deposit' | 'withdraw'>('deposit');
  const [copied, setCopied] = useState(false);
  const [positions, setPositions] = useState<Position[]>([]);
  const [starsLoading, setStarsLoading] = useState(false);

  const activeSolAddr = wallets?.[0]?.address;
  const activeEvmAddr = evmWallets?.[0]?.address || user?.wallet?.address;
  const walletAddress = activeSolAddr || activeEvmAddr || '';
  const inTelegram = isTelegramWebApp();

  const claimPendingStars = useCallback(
    async (silent = false): Promise<number> => {
      const tg = getTelegramWebApp();
      if (!tg?.initData) return 0;

      const headers: Record<string, string> = {
        'x-telegram-init-data': tg.initData,
      };
      if (authenticated) {
        const token = await getAccessToken().catch(() => null);
        if (token) {
          headers.Authorization = `Bearer ${token}`;
        }
      }

      const claim = await fetch(`${API_BASE}/api/telegram/stars/claim`, {
        method: 'POST',
        headers,
      });
      if (!claim.ok) return 0;

      const payload = await claim.json();
      const creditUsd = Number(payload?.creditUsd) || 0;
      if (typeof payload?.balanceUsd === 'number') {
        setBalance(payload.balanceUsd, true);
      } else if (creditUsd > 0) {
        setBalance(balance + creditUsd);
      }

      if (creditUsd > 0 && !silent) {
        toast({
          title: 'Credit added',
          description: `+$${creditUsd.toFixed(2)} from Telegram Stars`,
        });
        triggerHapticNotification('success');
      }
      return creditUsd;
    },
    [authenticated, getAccessToken, balance, setBalance, toast]
  );

  useEffect(() => {
    let mounted = true;
    const queryAddr = activeSolAddr || activeEvmAddr;
    if (!authenticated || (!queryAddr && !user?.id)) {
      setPositions([]);
      return;
    }
    void fetchPositions(queryAddr, user?.id).then((list) => {
      if (mounted) setPositions(list);
    });
    return () => {
      mounted = false;
    };
  }, [authenticated, activeSolAddr, activeEvmAddr, user?.id]);

  // Sweep any pending Stars credits that arrived via webhook when opening Wallet in Telegram
  useEffect(() => {
    if (inTelegram && authenticated) {
      void claimPendingStars(true);
    }
  }, [inTelegram, authenticated, claimPendingStars]);

  const openCount = positions.filter((p) => p.status === 'open').length;
  const totalStakedSOL = positions.reduce((acc, p) => acc + (p.amount || 0), 0);

  const openCashier = (mode: 'deposit' | 'withdraw') => {
    setModalMode(mode);
    setModalOpen(true);
  };

  const copyAddress = () => {
    if (!walletAddress) return;
    navigator.clipboard.writeText(walletAddress);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const buyWithStars = async (amountStars: number) => {
    const tg = getTelegramWebApp();
    if (!tg?.initData) {
      toast({ title: 'Open in Telegram', description: 'Stars payments only work inside the Telegram Mini App.' });
      return;
    }
    setStarsLoading(true);
    triggerHaptic('light');
    try {
      const res = await fetch(`${API_BASE}/api/telegram/stars/invoice`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-telegram-init-data': tg.initData,
        },
        body: JSON.stringify({ amountStars, description: `${amountStars} Stars → $${(amountStars / 100).toFixed(2)} credit` }),
      });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();

      const status = await openStarsInvoice(data.invoiceUrl);
      if (status === 'paid') {
        // Retry claim up to 5 times in case Telegram webhook arrives slightly after client callback
        let credited = 0;
        for (let attempt = 0; attempt < 5; attempt++) {
          credited = await claimPendingStars(false);
          if (credited > 0) break;
          await new Promise((r) => setTimeout(r, 1200));
        }
        if (credited === 0) {
          await refreshBalance();
          toast({
            title: 'Payment received',
            description: 'Your Stars credit is syncing—reopen Wallet in a moment if it does not appear immediately.',
          });
        }
      } else if (status === 'cancelled') {
        toast({ title: 'Cancelled', description: 'Payment was cancelled.' });
      }
    } catch (err: any) {
      toast({ title: 'Stars payment failed', description: err.message || 'Try again', variant: 'destructive' });
    } finally {
      setStarsLoading(false);
    }
  };

  return (
    <div className="relative min-h-screen text-[#F3F4F6] p-4 lg:p-6 overflow-hidden">
      <div
        className="pointer-events-none absolute -top-40 -left-40 h-[600px] w-[600px] rounded-full blur-[140px] opacity-20"
        style={{
          background: 'radial-gradient(circle, rgba(34,197,94,0.4) 0%, rgba(16,185,129,0.1) 60%, transparent 100%)',
        }}
      />

      <div className="relative mx-auto max-w-[900px] space-y-6">
        <header className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-2xl lg:text-3xl font-extrabold tracking-tight font-display text-white">Wallet</h1>
            <p className="text-xs text-slate-400 mt-0.5">Your balance and open positions.</p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <button
              onClick={() => openCashier('deposit')}
              className="inline-flex items-center gap-1.5 rounded-full bg-[#22c55e] hover:bg-[#16a34a] px-4 py-2 text-xs font-bold text-black shadow-[0_0_20px_rgba(34,197,94,0.3)] transition-all"
            >
              <Plus size={14} />
              <span>Deposit</span>
            </button>

            <button
              onClick={() => openCashier('withdraw')}
              className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-[#121820] hover:bg-[#18212b] px-4 py-2 text-xs font-semibold text-slate-200 transition-all"
            >
              <ArrowUpRight size={14} />
              <span>Withdraw</span>
            </button>

            <NotificationsMenu size="md" />

            <Link
              href="/pvp"
              title="PvP Games"
              className="grid h-10 w-10 place-items-center rounded-full border border-white/10 bg-[#121820] text-slate-300 hover:text-white transition-colors"
            >
              <LayoutGrid size={16} />
            </Link>

            {authenticated && avatarUrl && (
              <Link href="/profile" className="relative group cursor-pointer">
                <div className="h-10 w-10 overflow-hidden rounded-full border-2 border-[#22c55e]/40 p-0.5 ring-2 ring-black/40">
                  <img src={avatarUrl} alt="Profile" className="h-full w-full rounded-full object-cover" />
                </div>
              </Link>
            )}
          </div>
        </header>

        {/* My Balance */}
        <section className="relative overflow-hidden rounded-3xl border border-emerald-900/40 bg-gradient-to-br from-[#0B1A14] via-[#091510] to-[#060D0A] p-6 shadow-xl">
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold tracking-wide text-white">My Balance</span>
            <button
              type="button"
              onClick={() => openCashier('deposit')}
              className="grid h-7 w-7 place-items-center rounded-full bg-white/10 hover:bg-white/20 text-white transition-colors"
            >
              <Plus size={16} />
            </button>
          </div>

          <div className="mt-4 text-4xl font-black font-mono text-white tabular-nums">
            ${balance.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </div>

          {totalStakedSOL > 0 && (
            <div className="mt-2 text-xs font-mono text-[#4ade80]">
              {totalStakedSOL.toFixed(3)} SOL staked in markets · {openCount} open positions
            </div>
          )}

          {walletAddress && (
            <div className="mt-4 flex items-center gap-2 rounded-2xl border border-white/10 bg-black/30 px-3 py-2">
              <span className="text-[10px] text-slate-400 uppercase tracking-wider">Deposit Address</span>
              <span className="font-mono text-xs text-slate-200 truncate flex-1">
                {walletAddress.slice(0, 8)}...{walletAddress.slice(-6)}
              </span>
              <button
                type="button"
                onClick={copyAddress}
                className="grid h-7 w-7 place-items-center rounded-lg bg-white/10 hover:bg-white/20 text-white"
              >
                {copied ? <Check size={14} className="text-[#4ade80]" /> : <Copy size={14} />}
              </button>
            </div>
          )}

          {/* Telegram Stars top-up */}
          {inTelegram && (
            <div className="mt-5 space-y-2">
              <p className="text-[11px] text-slate-400">Top up with Telegram Stars</p>
              <div className="flex flex-wrap gap-2">
                {[100, 500, 1000].map((stars) => (
                  <button
                    key={stars}
                    disabled={starsLoading}
                    onClick={() => buyWithStars(stars)}
                    className="inline-flex items-center gap-1.5 rounded-full border border-amber-400/40 bg-amber-500/10 hover:bg-amber-500/20 px-3 py-1.5 text-xs font-semibold text-amber-300 disabled:opacity-50"
                  >
                    <Star size={12} className="fill-amber-400 text-amber-400" />
                    {stars} Stars
                    <span className="text-[10px] text-amber-200/70">(${(stars / 100).toFixed(2)})</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </section>

        {/* Open Positions */}
        <section className="rounded-3xl border border-white/[0.08] bg-[#0E1318] p-6 shadow-lg">
          <h2 className="text-sm font-semibold tracking-wide text-white mb-4">Open Positions</h2>
          <MyBets />
        </section>
      </div>

      <MainnetDepositWithdrawModal
        isOpen={modalOpen}
        onClose={() => setModalOpen(false)}
        initialMode={modalMode}
        onBalanceUpdated={(newBal) => setBalance(newBal)}
      />
    </div>
  );
}
