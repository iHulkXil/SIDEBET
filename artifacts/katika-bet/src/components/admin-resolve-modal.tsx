import { useState, useEffect, useCallback } from 'react';
import { ShieldCheck, Lock, X, Loader2, CheckCircle2, RefreshCw } from 'lucide-react';
import {
  fetchAdminStatus,
  bootstrapAdmin,
  loginAdmin,
  fetchMarkets,
  resolveMarket,
  calcOdds,
  type Market,
  type AdminAuthStatus,
} from '@/lib/markets-api';
import { useToast } from '@/hooks/use-toast';

export function AdminResolveModal({
  isOpen,
  onClose,
  onResolved,
}: {
  isOpen: boolean;
  onClose: () => void;
  onResolved?: () => void;
}) {
  const { toast } = useToast();
  const [status, setStatus] = useState<AdminAuthStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(false);

  // Kept strictly in React memory (never localStorage/sessionStorage)
  const [adminToken, setAdminToken] = useState<string | null>(null);
  const [passcode, setPasscode] = useState('');
  const [authSubmitting, setAuthSubmitting] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  const [markets, setMarkets] = useState<Market[]>([]);
  const [marketsLoading, setMarketsLoading] = useState(false);
  const [filter, setFilter] = useState<'open' | 'resolved' | 'all'>('open');
  const [confirming, setConfirming] = useState<{ marketId: string; side: 'YES' | 'NO' } | null>(null);
  const [resolvingId, setResolvingId] = useState<string | null>(null);

  const loadStatusAndMarkets = useCallback(async () => {
    setStatusLoading(true);
    try {
      const s = await fetchAdminStatus();
      setStatus(s);
    } catch {
      setStatus({ configured: true, needsBootstrap: false, envManaged: false });
    } finally {
      setStatusLoading(false);
    }

    setMarketsLoading(true);
    try {
      const all = await fetchMarkets('All');
      setMarkets(all);
    } finally {
      setMarketsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isOpen) {
      setAuthError(null);
      setConfirming(null);
      void loadStatusAndMarkets();
    }
  }, [isOpen, loadStatusAndMarkets]);

  if (!isOpen) return null;

  const handleAuthSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!passcode.trim()) return;
    setAuthSubmitting(true);
    setAuthError(null);
    try {
      const token = status?.needsBootstrap
        ? await bootstrapAdmin(passcode.trim())
        : await loginAdmin(passcode.trim());
      setAdminToken(token);
      setPasscode('');
      setStatus((prev) => (prev ? { ...prev, configured: true, needsBootstrap: false } : prev));
      toast({
        title: status?.needsBootstrap ? 'Admin Passcode Configured' : 'Admin Unlocked',
        description: 'You can now settle open markets and auto-credit winners.',
      });
    } catch (err: any) {
      setAuthError(err.message || 'Authentication failed');
    } finally {
      setAuthSubmitting(false);
    }
  };

  const handleResolve = async (market: Market, outcome: 'YES' | 'NO') => {
    if (!adminToken) return;
    setResolvingId(market.id);
    try {
      const res = await resolveMarket(market.id, outcome, adminToken);
      setMarkets((prev) => prev.map((m) => (m.id === market.id ? res.market : m)));
      setConfirming(null);

      const credited = res.stats?.totalCreditedUsd ?? 0;
      toast({
        title: `Market Resolved: ${outcome}`,
        description: `${res.stats?.settledPositions ?? 0} positions settled · ${res.stats?.wonPositions ?? 0} won ($${credited.toFixed(2)} credited).`,
      });
      onResolved?.();
    } catch (err: any) {
      const msg = err.message || 'Failed to resolve market';
      if (msg.toLowerCase().includes('admin authentication')) {
        setAdminToken(null);
      }
      toast({
        title: 'Resolution Failed',
        description: msg,
        variant: 'destructive',
      });
    } finally {
      setResolvingId(null);
    }
  };

  const visibleMarkets = markets.filter((m) => {
    if (filter === 'open') return m.status === 'open';
    if (filter === 'resolved') return m.status === 'resolved';
    return true;
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 backdrop-blur-md p-4 animate-in fade-in">
      <div className="w-full max-w-2xl rounded-3xl border border-white/[0.1] bg-[#0D1217] p-6 shadow-2xl max-h-[88vh] flex flex-col gap-4">
        <div className="flex items-start justify-between gap-3 border-b border-white/[0.06] pb-4">
          <div className="flex items-center gap-2.5">
            <div className="grid h-9 w-9 place-items-center rounded-2xl border border-emerald-500/30 bg-[#22c55e]/15 text-[#4ade80]">
              <ShieldCheck size={18} />
            </div>
            <div>
              <h3 className="text-base font-bold font-display text-white">Admin Market Settlement</h3>
              <p className="text-[11px] text-slate-400">
                Resolve markets to YES or NO and automatically credit winners&apos; balances.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {adminToken && (
              <button
                type="button"
                onClick={() => {
                  setAdminToken(null);
                  setConfirming(null);
                }}
                className="inline-flex items-center gap-1 rounded-full border border-white/10 bg-[#121820] px-2.5 py-1 text-[11px] font-mono text-slate-300 hover:text-white"
              >
                <Lock size={11} /> Lock
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className="grid h-8 w-8 place-items-center rounded-full border border-white/10 text-slate-400 hover:text-white"
            >
              <X size={15} />
            </button>
          </div>
        </div>

        {!adminToken ? (
          <form onSubmit={handleAuthSubmit} className="space-y-4 py-2">
            {statusLoading ? (
              <div className="flex items-center justify-center py-8 text-xs text-slate-400 gap-2">
                <Loader2 size={15} className="animate-spin text-[#4ade80]" />
                Checking admin status...
              </div>
            ) : (
              <>
                <div className="rounded-2xl border border-white/[0.08] bg-[#080C0F] p-4 space-y-1.5">
                  <p className="text-xs font-semibold text-white">
                    {status?.needsBootstrap ? 'First-Run Admin Setup' : 'Enter Admin Passcode'}
                  </p>
                  <p className="text-[11px] text-slate-400 leading-relaxed">
                    {status?.needsBootstrap
                      ? 'Set a strong admin passcode (min 6 characters) to protect market settlement. You can also manage this via ADMIN_PASSCODE on Render.'
                      : 'Verify your server admin passcode to unlock market resolution for this session.'}
                  </p>
                </div>

                <div>
                  <label className="text-xs text-slate-300 font-medium">
                    {status?.needsBootstrap ? 'Create Admin Passcode' : 'Admin Passcode'}
                  </label>
                  <input
                    type="password"
                    value={passcode}
                    onChange={(e) => setPasscode(e.target.value)}
                    placeholder="Enter passcode..."
                    autoFocus
                    className="mt-1.5 w-full rounded-xl border border-white/10 bg-[#121820] px-3.5 py-2.5 text-sm font-mono text-white focus:border-[#4ade80] focus:outline-none"
                  />
                  {authError && <p className="mt-1.5 text-xs text-rose-400">{authError}</p>}
                </div>

                <div className="flex gap-3 pt-1">
                  <button
                    type="button"
                    onClick={onClose}
                    className="flex-1 rounded-xl border border-white/10 py-2.5 text-xs font-semibold text-slate-300 hover:bg-white/5"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={authSubmitting || passcode.trim().length < 4}
                    className="flex-1 rounded-xl bg-[#22c55e] hover:bg-[#16a34a] py-2.5 text-xs font-bold text-black disabled:opacity-50 flex items-center justify-center gap-2"
                  >
                    {authSubmitting && <Loader2 size={13} className="animate-spin" />}
                    <span>{status?.needsBootstrap ? 'Set Passcode & Unlock' : 'Unlock Settlement'}</span>
                  </button>
                </div>
              </>
            )}
          </form>
        ) : (
          <>
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1 rounded-xl bg-[#080C0F] p-1 border border-white/[0.08]">
                {(['open', 'resolved', 'all'] as const).map((tab) => (
                  <button
                    key={tab}
                    type="button"
                    onClick={() => setFilter(tab)}
                    className={`rounded-lg px-3 py-1 text-xs font-semibold capitalize transition-colors ${
                      filter === tab ? 'bg-[#22c55e] text-black' : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    {tab}
                  </button>
                ))}
              </div>

              <button
                type="button"
                onClick={() => void loadStatusAndMarkets()}
                disabled={marketsLoading}
                className="inline-flex items-center gap-1.5 rounded-xl border border-white/10 bg-[#121820] px-3 py-1.5 text-xs text-slate-300 hover:text-white"
              >
                <RefreshCw size={12} className={marketsLoading ? 'animate-spin' : ''} />
                Refresh
              </button>
            </div>

            <div className="overflow-y-auto space-y-2.5 pr-1 flex-1">
              {visibleMarkets.length === 0 ? (
                <div className="rounded-2xl border border-white/[0.06] bg-[#080C0F] py-10 text-center text-xs text-slate-400">
                  No markets in this view.
                </div>
              ) : (
                visibleMarkets.map((m) => {
                  const { yesPct } = calcOdds(m.yesShares, m.noShares);
                  const isConfirmYes = confirming?.marketId === m.id && confirming.side === 'YES';
                  const isConfirmNo = confirming?.marketId === m.id && confirming.side === 'NO';
                  const isBusy = resolvingId === m.id;

                  return (
                    <div
                      key={m.id}
                      className="rounded-2xl border border-white/[0.08] bg-[#080C0F] p-3.5 space-y-2.5"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 text-[10px] font-mono text-slate-400">
                            <span className="text-[#4ade80]">{m.category}</span>
                            <span>·</span>
                            <span>Vol: {Number(m.volume || 0).toFixed(2)} SOL</span>
                            <span>·</span>
                            <span>{yesPct}% YES</span>
                          </div>
                          <p className="mt-1 text-xs font-semibold text-white leading-snug">{m.title}</p>
                        </div>

                        {m.status === 'resolved' && (
                          <span className="shrink-0 inline-flex items-center gap-1 rounded-full border border-emerald-500/30 bg-[#22c55e]/15 px-2.5 py-0.5 text-[10px] font-mono font-bold text-[#4ade80]">
                            <CheckCircle2 size={11} />
                            {m.resolution}
                          </span>
                        )}
                      </div>

                      {m.status === 'open' && (
                        <div className="flex items-center gap-2 pt-1">
                          {isConfirmYes ? (
                            <button
                              type="button"
                              disabled={isBusy}
                              onClick={() => void handleResolve(m, 'YES')}
                              className="flex-1 rounded-xl bg-[#22c55e] hover:bg-[#16a34a] py-2 text-xs font-bold text-black flex items-center justify-center gap-1.5"
                            >
                              {isBusy && <Loader2 size={12} className="animate-spin" />}
                              Confirm Resolve YES
                            </button>
                          ) : (
                            <button
                              type="button"
                              disabled={isBusy}
                              onClick={() => setConfirming({ marketId: m.id, side: 'YES' })}
                              className="flex-1 rounded-xl border border-emerald-500/35 bg-[#121B16] hover:bg-[#16271F] py-2 text-xs font-mono font-bold text-[#4ade80]"
                            >
                              Resolve YES
                            </button>
                          )}

                          {isConfirmNo ? (
                            <button
                              type="button"
                              disabled={isBusy}
                              onClick={() => void handleResolve(m, 'NO')}
                              className="flex-1 rounded-xl bg-[#ec4899] hover:bg-[#db2777] py-2 text-xs font-bold text-white flex items-center justify-center gap-1.5"
                            >
                              {isBusy && <Loader2 size={12} className="animate-spin" />}
                              Confirm Resolve NO
                            </button>
                          ) : (
                            <button
                              type="button"
                              disabled={isBusy}
                              onClick={() => setConfirming({ marketId: m.id, side: 'NO' })}
                              className="flex-1 rounded-xl border border-pink-500/35 bg-[#1E1118] hover:bg-[#2A1622] py-2 text-xs font-mono font-bold text-[#f472b6]"
                            >
                              Resolve NO
                            </button>
                          )}

                          {(isConfirmYes || isConfirmNo) && !isBusy && (
                            <button
                              type="button"
                              onClick={() => setConfirming(null)}
                              className="rounded-xl border border-white/10 px-2.5 py-2 text-xs text-slate-400 hover:text-white"
                            >
                              Cancel
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
