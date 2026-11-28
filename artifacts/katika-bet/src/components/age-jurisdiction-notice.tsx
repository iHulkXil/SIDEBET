import { useState, useEffect } from 'react';
import { ShieldAlert, CheckCircle2 } from 'lucide-react';

const ACK_STORAGE_KEY = 'sidebet_age_jurisdiction_ack_v1';

export function AgeJurisdictionNotice() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    try {
      const ack = localStorage.getItem(ACK_STORAGE_KEY);
      if (!ack) {
        setVisible(true);
      }
    } catch {
      setVisible(true);
    }
  }, []);

  const handleConfirm = () => {
    try {
      localStorage.setItem(ACK_STORAGE_KEY, new Date().toISOString());
    } catch {}
    setVisible(false);
  };

  if (!visible) return null;

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/85 backdrop-blur-md p-4">
      <div className="w-full max-w-md rounded-3xl border border-emerald-500/25 bg-[#0D1217] p-6 shadow-2xl space-y-4">
        <div className="flex items-center gap-3">
          <div className="grid h-10 w-10 shrink-0 place-items-center rounded-2xl border border-emerald-500/30 bg-[#22c55e]/15 text-[#4ade80]">
            <ShieldAlert size={20} />
          </div>
          <div>
            <h2 className="text-base font-bold font-display text-white">Age &amp; Jurisdiction Notice</h2>
            <p className="text-[11px] font-mono text-[#4ade80]">SIDEBET · Soft Launch Access</p>
          </div>
        </div>

        <div className="rounded-2xl border border-white/[0.07] bg-[#080C0F] p-4 space-y-2.5 text-xs text-slate-300 leading-relaxed">
          <p>
            By entering SIDEBET, you confirm that you are at least <strong className="text-white">18 years old</strong> (or the legal age of majority in your jurisdiction).
          </p>
          <p>
            Prediction markets and PvP wagers involve real financial risk and are only available where permitted by applicable local law. Please participate responsibly and do not wager if restricted in your region.
          </p>
        </div>

        <button
          type="button"
          onClick={handleConfirm}
          className="w-full rounded-2xl bg-[#22c55e] hover:bg-[#16a34a] py-3 text-xs font-bold text-black shadow-[0_0_20px_rgba(34,197,94,0.25)] transition-all active:scale-[0.99] inline-flex items-center justify-center gap-2"
        >
          <CheckCircle2 size={15} />
          <span>I Confirm (18+ &amp; Eligible)</span>
        </button>
      </div>
    </div>
  );
}
