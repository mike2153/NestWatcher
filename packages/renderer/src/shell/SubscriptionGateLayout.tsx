import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useSubscriptionAuth } from '@/contexts/SubscriptionAuthContext';

function isSubscriptionSatisfied(state: ReturnType<typeof useSubscriptionAuth>['state']): boolean {
  if (!state) return false;
  if (!state.authenticated) return false;
  if (state.isAdmin) return true;
  return state.subscriptionStatus === 'active' || state.subscriptionStatus === 'grace_period';
}

export function SubscriptionGateLayout() {
  const location = useLocation();
  const { state, loading } = useSubscriptionAuth();
  const requireAuth = typeof window !== 'undefined' && !!window.api;
  const requireSubscription = import.meta.env.VITE_REQUIRE_SUBSCRIPTION_AUTH === 'true';

  if (!requireAuth) {
    return <Outlet />;
  }

  if (loading) {
    return (
      <div className="grid h-[100dvh] w-[100dvw] place-items-center bg-background text-foreground">
        <div className="text-sm text-muted-foreground">Loading…</div>
      </div>
    );
  }

  const ok = requireSubscription ? isSubscriptionSatisfied(state) : Boolean(state?.authenticated);
  if (ok) {
    return <Outlet />;
  }

  if (location.pathname === '/auth-required') {
    return <Outlet />;
  }

  return <Navigate to="/auth-required" replace />;
}
