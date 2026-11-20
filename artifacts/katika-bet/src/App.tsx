import { type ReactNode, useEffect } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { usePrivy } from '@privy-io/react-auth';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import { MarketsHome } from '@/components/markets-home';
import { DiscoverPage } from '@/components/discover-page';
import { ProfilePage } from '@/components/profile-page';
import { MyBets } from '@/components/my-bets';
import { LayoutShell } from '@/components/layout-shell';
import { CryptoWalletDashboard } from '@/components/crypto-wallet-dashboard';
import { PvPLobby } from '@/components/pvp-lobby';
import { PoolGamePage } from '@/components/pool-game';
import { PotWheelGamePage } from '@/components/pot-wheel-game';
import { PenaltyShootoutPage } from '@/components/penalty-shootout';
import { GlobalChatPage } from '@/components/global-chat';
import { KycOnboardingModal } from '@/components/kyc-onboarding-modal';
import { KycProvider, useKyc } from '@/lib/kyc';
import { Link, Route, Switch, Router as WouterRouter, useLocation } from 'wouter';
import { initTelegramWebApp } from '@/lib/telegram';

const queryClient = new QueryClient();

function Discover() {
  return <DiscoverPage />;
}

function Markets() {
  return <MarketsHome />;
}

function WalletPortfolio() {
  return <CryptoWalletDashboard />;
}

function GlobalChat() {
  return <GlobalChatPage />;
}

function NotFoundPage() {
  return (
    <div className="px-3 pt-16 text-center">
      <p className="text-sm text-slate-400">Page not found</p>
      <Link href="/" className="mt-2 inline-block text-sm text-emerald-400 underline">Return Home</Link>
    </div>
  );
}

function Router() {
  const { ready, authenticated } = usePrivy();
  const { isKycComplete, loading: kycLoading } = useKyc();
  const [location, setLocation] = useLocation();

  const unlocked = Boolean(authenticated && isKycComplete);

  useEffect(() => {
    initTelegramWebApp();
  }, []);

  useEffect(() => {
    if (ready && !kycLoading && !unlocked && location !== '/') {
      setLocation('/');
    }
  }, [ready, kycLoading, unlocked, location, setLocation]);

  // Until signed in and KYC verified, users remain strictly on the Discover page showing Markets + PvP
  if (!unlocked) {
    return (
      <ErrorRouted>
        <Discover />
      </ErrorRouted>
    );
  }

  return (
    <ErrorRouted>
      <Switch>
        <Route path="/" component={Discover} />
        <Route path="/dashboard" component={Discover} />
        <Route path="/markets" component={Markets} />
        <Route path="/pvp" component={PvPLobby} />
        <Route path="/games/pool" component={PoolGamePage} />
        <Route path="/pvp/pool" component={PoolGamePage} />
        <Route path="/pvp/pool/:id" component={PoolGamePage} />
        <Route path="/games/wheel" component={PotWheelGamePage} />
        <Route path="/pvp/wheel" component={PotWheelGamePage} />
        <Route path="/pvp/wheel/:id" component={PotWheelGamePage} />
        <Route path="/games/penalty" component={PenaltyShootoutPage} />
        <Route path="/pvp/penalty" component={PenaltyShootoutPage} />
        <Route path="/pvp/penalty/:id" component={PenaltyShootoutPage} />
        <Route path="/trending">{() => <MarketsHome defaultCategory="All" />}</Route>
        <Route path="/sports">{() => <MarketsHome defaultCategory="Sports" />}</Route>
        <Route path="/crypto">{() => <MarketsHome defaultCategory="Crypto" />}</Route>
        <Route path="/politics">{() => <MarketsHome defaultCategory="Politics" />}</Route>
        <Route path="/nigerian-politics">{() => <MarketsHome defaultCategory="Nigerian Politics" />}</Route>
        <Route path="/finance">{() => <MarketsHome defaultCategory="Finance" />}</Route>
        <Route path="/lifestyle">{() => <MarketsHome defaultCategory="Lifestyle" />}</Route>
        <Route path="/my-bets" component={MyBets} />
        <Route path="/portfolio" component={WalletPortfolio} />
        <Route path="/wallet" component={WalletPortfolio} />
        <Route path="/cashier" component={WalletPortfolio} />
        <Route path="/chat" component={GlobalChat} />
        <Route path="/leaderboard" component={GlobalChat} />
        <Route path="/profile" component={ProfilePage} />
        <Route component={NotFoundPage} />
      </Switch>
    </ErrorRouted>
  );
}

function ErrorRouted({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <KycProvider>
          <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
            <LayoutShell>
              <Router />
            </LayoutShell>
            <KycOnboardingModal />
          </WouterRouter>
          <Toaster />
        </KycProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
