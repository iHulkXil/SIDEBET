import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { usePrivy } from '@privy-io/react-auth';
import { useToast } from '@/hooks/use-toast';
import { pushNotification } from '@/lib/notifications';

export type IdDocumentType = 'national_id' | 'passport' | 'drivers_license';
export type CarrierType = 'airtel' | 'other';
export type AirtelBonusStatus =
  | 'locked'
  | 'pending_phone'
  | 'pending_game'
  | 'unlocked'
  | 'claimed';

export interface KycRecord {
  privyUserId: string;
  fullName: string;
  dob: string;
  country: string;
  address: string;
  idType?: IdDocumentType;
  idNumberMasked?: string;
  kycCompleted: boolean;
  kycSubmittedAt?: string;
  kycLevel2Completed: boolean;
  kycLevel2SubmittedAt?: string;
  kycLevel: 0 | 1 | 2;
  phoneNumber?: string;
  maskedPhone?: string;
  carrier: CarrierType | null;
  phoneVerified: boolean;
  phoneVerifiedAt?: string;
  gamesPlayedCount: number;
  lastGamePlayed?: string;
  airtelBonusMb: 200;
  airtelBonusStatus: AirtelBonusStatus;
  airtelBonusClaimedAt?: string;
  airtelVoucherCode?: string;
  updatedAt: string;
}

export interface SubmitKycInput {
  fullName: string;
  dob: string;
  country: string;
  address: string;
}

export interface SubmitLevel2KycInput {
  idType: IdDocumentType;
  idNumber: string;
}

export type OtpChannel = 'whatsapp' | 'sms';

export interface SendOtpResponse {
  ok: boolean;
  maskedPhone: string;
  carrier: CarrierType;
  channel?: OtpChannel;
  provider?: string;
  isAirtel: boolean;
  expiresInSec: number;
  previewOtp?: string;
}

interface KycContextValue {
  record: KycRecord | null;
  loading: boolean;
  isKycComplete: boolean;
  isLevel2Complete: boolean;
  needsKyc: boolean;
  onboardingOpen: boolean;
  setOnboardingOpen: (open: boolean) => void;
  refreshKyc: () => Promise<void>;
  submitKyc: (input: SubmitKycInput) => Promise<KycRecord>;
  submitLevel2Kyc: (input: SubmitLevel2KycInput) => Promise<KycRecord>;
  sendPhoneOtp: (phoneNumber: string, carrier?: CarrierType, channel?: OtpChannel) => Promise<SendOtpResponse>;
  verifyPhoneOtp: (code: string) => Promise<KycRecord>;
  recordGamePlay: (gameName: string) => Promise<void>;
  claimAirtelBonus: () => Promise<KycRecord>;
}

const KycContext = createContext<KycContextValue | null>(null);

const BASE_API = (import.meta.env.VITE_API_BASE_URL ?? '/api').replace(/\/$/, '');

export function detectAirtelNumber(rawPhone: string): boolean {
  const trimmed = rawPhone.trim();
  const digits = trimmed.replace(/\D/g, '');
  if (!digits) return false;

  // Convert local 11-digit 0-prefix Nigerian number to 234...
  const normalizedDigits =
    digits.startsWith('0') && digits.length === 11 ? `234${digits.slice(1)}` : digits;

  // Nigeria (+234)
  if (normalizedDigits.startsWith('234') && normalizedDigits.length >= 13) {
    const local3 = normalizedDigits.slice(3, 6);
    if (['802', '808', '701', '708', '812', '901', '902', '904', '907', '912'].includes(local3)) {
      return true;
    }
  }
  // Kenya (+254)
  if (normalizedDigits.startsWith('254') && normalizedDigits.length >= 12) {
    const local2 = normalizedDigits.slice(3, 5);
    if (['73', '78', '10'].includes(local2)) return true;
  }
  // Uganda (+256)
  if (normalizedDigits.startsWith('256') && normalizedDigits.length >= 12) {
    const local2 = normalizedDigits.slice(3, 5);
    if (['70', '74', '75'].includes(local2)) return true;
  }
  // Tanzania (+255)
  if (normalizedDigits.startsWith('255') && normalizedDigits.length >= 12) {
    const local2 = normalizedDigits.slice(3, 5);
    if (['68', '69', '78', '79'].includes(local2)) return true;
  }
  // Ghana (+233)
  if (normalizedDigits.startsWith('233') && normalizedDigits.length >= 12) {
    const local2 = normalizedDigits.slice(3, 5);
    if (['26', '27', '56', '57'].includes(local2)) return true;
  }
  // India (+91)
  if (normalizedDigits.startsWith('91') && normalizedDigits.length >= 12) {
    const local2 = normalizedDigits.slice(2, 4);
    if (['98', '99', '97', '96', '81', '70'].includes(local2)) return true;
  }

  return false;
}

const KYC_CACHE_PREFIX = 'sidebet_kyc_record_v1:';

function readCachedKyc(userId?: string): KycRecord | null {
  if (!userId) return null;
  try {
    const raw = localStorage.getItem(`${KYC_CACHE_PREFIX}${userId}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as KycRecord;
    return parsed && typeof parsed === 'object' && parsed.kycCompleted ? parsed : null;
  } catch {
    return null;
  }
}

function writeCachedKyc(userId: string | undefined, rec: KycRecord | null) {
  if (!userId || !rec) return;
  try {
    if (rec.kycCompleted) {
      localStorage.setItem(`${KYC_CACHE_PREFIX}${userId}`, JSON.stringify(rec));
    }
  } catch {
    // ignore storage quota errors
  }
}

export function KycProvider({ children }: { children: ReactNode }) {
  const { ready, authenticated, user, getAccessToken } = usePrivy();
  const { toast } = useToast();
  const [record, setRecord] = useState<KycRecord | null>(null);
  const [loading, setLoading] = useState(false);
  const [resolvedUserId, setResolvedUserId] = useState<string | null>(null);
  const [onboardingOpen, setOnboardingOpen] = useState(false);

  const getTokenWithRetry = useCallback(async (): Promise<string | null> => {
    const delays = [0, 200, 400, 700, 1100];
    for (const delay of delays) {
      if (delay > 0) {
        await new Promise((r) => setTimeout(r, delay));
      }
      try {
        const token = await getAccessToken();
        if (token) return token;
      } catch {
        // continue retrying while Privy finishes session hydration
      }
    }
    return null;
  }, [getAccessToken]);

  const authFetch = useCallback(
    async <T,>(path: string, init?: RequestInit): Promise<T> => {
      const token = await getTokenWithRetry();
      if (!token) {
        throw new Error('Authentication token unavailable. Please sign in again.');
      }
      const res = await fetch(`${BASE_API}${path}`, {
        ...init,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          ...(init?.headers ?? {}),
        },
        credentials: 'include',
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error((body as { error?: string }).error || `Request failed (${res.status})`);
      }
      return body as T;
    },
    [getTokenWithRetry],
  );

  const refreshKyc = useCallback(async () => {
    if (!ready || !authenticated || !user?.id) {
      setRecord(null);
      setResolvedUserId(null);
      setLoading(false);
      setOnboardingOpen(false);
      return;
    }

    const currentUserId = user.id;
    const cached = readCachedKyc(currentUserId);
    if (cached) {
      setRecord(cached);
      setOnboardingOpen(false);
    }

    setLoading(true);
    try {
      const data = await authFetch<KycRecord>('/kyc');
      if (data.kycCompleted) {
        setRecord(data);
        writeCachedKyc(currentUserId, data);
        setOnboardingOpen(false);
      } else if (cached?.kycCompleted && cached.fullName && cached.dob && cached.country && cached.address) {
        // Backend store was empty (e.g. after server restart) while user already completed Level 1 KYC on this device;
        // silently re-sync their profile to the server instead of prompting again.
        try {
          const synced = await authFetch<KycRecord>('/kyc/submit', {
            method: 'POST',
            body: JSON.stringify({
              fullName: cached.fullName,
              dob: cached.dob,
              country: cached.country,
              address: cached.address,
            }),
          });
          setRecord(synced);
          writeCachedKyc(currentUserId, synced);
          setOnboardingOpen(false);
        } catch {
          setRecord(cached);
          setOnboardingOpen(false);
        }
      } else {
        setRecord(data);
        setOnboardingOpen(true);
      }
    } catch (err) {
      console.warn('Failed to fetch KYC status:', err);
      if (cached) {
        setRecord(cached);
        setOnboardingOpen(false);
      }
    } finally {
      setResolvedUserId(currentUserId);
      setLoading(false);
    }
  }, [ready, authenticated, user?.id, authFetch]);

  useEffect(() => {
    void refreshKyc();
  }, [refreshKyc]);

  const submitKyc = useCallback(
    async (input: SubmitKycInput) => {
      const updated = await authFetch<KycRecord>('/kyc/submit', {
        method: 'POST',
        body: JSON.stringify(input),
      });
      setRecord(updated);
      writeCachedKyc(user?.id, updated);
      setOnboardingOpen(false);
      localStorage.setItem('sidebet_terms_accepted', 'true');
      pushNotification({
        id: `kyc-verified-${updated.privyUserId}`,
        title: 'Level 1 KYC Verified',
        message: 'Welcome to SIDEBET! Verify your Airtel number & play any game to claim 200MB free data, or add ID verification in Profile.',
        type: 'system',
        href: '/profile',
        userId: user?.id,
      });
      return updated;
    },
    [authFetch, user?.id],
  );

  const submitLevel2Kyc = useCallback(
    async (input: SubmitLevel2KycInput) => {
      const updated = await authFetch<KycRecord>('/kyc/level2', {
        method: 'POST',
        body: JSON.stringify(input),
      });
      setRecord(updated);
      writeCachedKyc(user?.id, updated);
      pushNotification({
        id: `kyc-level2-${updated.privyUserId}`,
        title: 'Level 2 KYC Verified',
        message: 'Your government ID document has been verified under Profile KYC.',
        type: 'system',
        href: '/profile',
        userId: user?.id,
      });
      return updated;
    },
    [authFetch, user?.id],
  );

  const sendPhoneOtp = useCallback(
    async (phoneNumber: string, carrier?: CarrierType, channel: OtpChannel = 'whatsapp') => {
      return authFetch<SendOtpResponse>('/kyc/send-otp', {
        method: 'POST',
        body: JSON.stringify({ phoneNumber, carrier, channel }),
      });
    },
    [authFetch],
  );

  const verifyPhoneOtp = useCallback(
    async (code: string) => {
      const updated = await authFetch<KycRecord>('/kyc/verify-otp', {
        method: 'POST',
        body: JSON.stringify({ code }),
      });
      setRecord(updated);
      writeCachedKyc(user?.id, updated);

      if (updated.carrier === 'airtel') {
        if (updated.airtelBonusStatus === 'unlocked') {
          pushNotification({
            id: `airtel-unlocked-${updated.privyUserId}`,
            title: '200MB Airtel Bonus Unlocked!',
            message: 'Your Airtel number is verified and you played a game. Claim your 200MB data in Profile.',
            type: 'win',
            href: '/profile',
            userId: user?.id,
          });
        } else {
          pushNotification({
            id: `airtel-phone-verified-${updated.privyUserId}`,
            title: 'Airtel Number Verified',
            message: 'Play any game (Pool, Wheel of Fortune, or Markets) to unlock your 200MB free Airtel data!',
            type: 'system',
            href: '/pvp',
            userId: user?.id,
          });
        }
      }
      return updated;
    },
    [authFetch, user?.id],
  );

  const recordGamePlay = useCallback(
    async (gameName: string) => {
      if (!authenticated) return;
      try {
        const res = await authFetch<{ record: KycRecord; justUnlocked: boolean }>(
          '/kyc/record-game',
          {
            method: 'POST',
            body: JSON.stringify({ game: gameName }),
          },
        );
        setRecord(res.record);
        writeCachedKyc(user?.id, res.record);
        if (res.justUnlocked) {
          pushNotification({
            id: `airtel-200mb-unlocked-${res.record.privyUserId}`,
            title: '200MB Airtel Data Bonus Unlocked!',
            message: `You verified your Airtel number and played ${gameName}. Claim your 200MB bonus in Profile!`,
            type: 'win',
            href: '/profile',
            userId: user?.id,
          });
          toast({
            title: '200MB Airtel Data Bonus Unlocked!',
            description: `Thanks for playing ${gameName}. Visit Profile to claim your 200MB Airtel voucher!`,
          });
        }
      } catch (err) {
        console.warn('Could not record game play for Airtel bonus:', err);
      }
    },
    [authenticated, authFetch, toast, user?.id],
  );

  const claimAirtelBonus = useCallback(async () => {
    const updated = await authFetch<KycRecord>('/kyc/claim-bonus', {
      method: 'POST',
    });
    setRecord(updated);
    writeCachedKyc(user?.id, updated);
    pushNotification({
      id: `airtel-200mb-claimed-${updated.privyUserId}`,
      title: '200MB Airtel Data Claimed',
      message: `Voucher ${updated.airtelVoucherCode || 'AIRTEL-200MB'} issued for ${updated.maskedPhone || 'your Airtel line'}.`,
      type: 'win',
      href: '/profile',
      userId: user?.id,
    });
    return updated;
  }, [authFetch, user?.id]);

  const isKycComplete = Boolean(record?.kycCompleted);
  const isLevel2Complete = Boolean(record?.kycLevel2Completed || record?.idNumberMasked);
  const awaitingInitialResolve = Boolean(
    ready && authenticated && user?.id && resolvedUserId !== user.id && !isKycComplete,
  );
  const effectiveLoading = loading || awaitingInitialResolve;
  const needsKyc = Boolean(ready && authenticated && !effectiveLoading && !isKycComplete);

  const value = useMemo<KycContextValue>(
    () => ({
      record,
      loading: effectiveLoading,
      isKycComplete,
      isLevel2Complete,
      needsKyc,
      onboardingOpen,
      setOnboardingOpen,
      refreshKyc,
      submitKyc,
      submitLevel2Kyc,
      sendPhoneOtp,
      verifyPhoneOtp,
      recordGamePlay,
      claimAirtelBonus,
    }),
    [
      record,
      effectiveLoading,
      isKycComplete,
      isLevel2Complete,
      needsKyc,
      onboardingOpen,
      refreshKyc,
      submitKyc,
      submitLevel2Kyc,
      sendPhoneOtp,
      verifyPhoneOtp,
      recordGamePlay,
      claimAirtelBonus,
    ],
  );

  return <KycContext.Provider value={value}>{children}</KycContext.Provider>;
}

export function useKyc(): KycContextValue {
  const ctx = useContext(KycContext);
  if (!ctx) {
    throw new Error('useKyc must be used within a KycProvider');
  }
  return ctx;
}
