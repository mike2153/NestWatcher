import { useCallback, useEffect, useMemo, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { LayoutDashboard, Router, History, Settings, Layers, BellRing, Gauge, ListCheck, AlignVerticalJustifyEnd, MessageSquare, ShoppingCart, UserRound, LogOut, KeyRound, Rocket } from 'lucide-react';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuItem,
} from '@/components/ui/sidebar';
import { cn } from '@/utils/cn';
import { SettingsModal } from './SettingsModal';
import { ThemeSwitcher } from './ThemeSwitcher';
import { useAuth } from '@/contexts/AuthContext';
import { useSubscriptionAuth } from '@/contexts/SubscriptionAuthContext';

const nav = [
  { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/jobs', label: 'Jobs', icon: ListCheck },
  { to: '/router', label: 'Router', icon: Router },
  { to: '/history', label: 'History', icon: History },
  { to: '/grundner', label: 'Grundner', icon: AlignVerticalJustifyEnd },
  { to: '/allocated-material', label: 'Allocated', icon: Layers },
  { to: '/ordering', label: 'Ordering', icon: ShoppingCart },
  { to: '/telemetry', label: 'Telemetry', icon: Gauge },
  { to: '/messages', label: 'Messages', icon: MessageSquare },
  { to: '/cnc-alarms', label: 'CNC Alarms', icon: BellRing },
];

export function AppSidebar() {
  const [unreadCount, setUnreadCount] = useState(0);
  const [showSettings, setShowSettings] = useState(false);
  const { session, requireLogin, logout } = useAuth();
  const { state: subscriptionState, logout: subscriptionLogout } = useSubscriptionAuth();

  const openNcCatSignIn = useCallback(async () => {
    const res = await window.api.ncCatalyst.open();
    if (!res.ok) {
      // eslint-disable-next-line no-console
      console.error('Failed to open NC Catalyst:', res.error.message);
    }
  }, []);

  const handleSubscriptionSignOut = useCallback(async () => {
    await subscriptionLogout();
  }, [subscriptionLogout]);

  const canManageNcCatalystSubscription = useMemo(() => {
    if (!session) return false;
    if (session.role === 'admin') return true;
    if (!subscriptionState?.authenticated) return true;
    if (!subscriptionState.displayName) return false;
    const normalize = (v: string) => v.trim().toLowerCase().replace(/\s+/g, ' ');
    return normalize(session.displayName) === normalize(subscriptionState.displayName);
  }, [session, subscriptionState?.authenticated, subscriptionState?.displayName]);

  // Note: We don't automatically close NC-Cat after sign-in from AppSidebar
  // because the user may want to use NC-Cat, not just sign in.
  // AuthRequiredPage handles auto-closing when authentication is required.

  useEffect(() => {
    let active = true;
    (async () => {
      const res = await window.api.messages.unreadCount();
      if (!active) return;
      if (res.ok) {
        setUnreadCount(res.value);
      } else {
        setUnreadCount(0);
      }
    })();

    const unsubscribe = window.api.messages.subscribeCount((count) => {
      setUnreadCount(count);
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  return (
    <>
      <Sidebar>
        <SidebarHeader>
          <div className="px-3 font-semibold text-xl">Woodtron</div>
        </SidebarHeader>
        <SidebarContent>
          <SidebarMenu>
            {nav.map((item) => {
              const Icon = item.icon;
              const showBadge = item.to === '/messages' && unreadCount > 0;
              const badgeValue = unreadCount > 99 ? '99+' : unreadCount.toString();
              return (
                <SidebarMenuItem key={item.to}>
                  <NavLink
                    to={item.to}
                    className="flex h-10 w-full items-center gap-3 overflow-hidden rounded-md pl-4 pr-3 text-left text-sm font-medium transition-colors hover:bg-muted hover:text-foreground font-sans [&>span:last-child]:truncate [&>svg]:size-4 [&>svg]:shrink-0"
                    style={({ isActive }) => isActive
                      ? { backgroundColor: 'var(--primary)', color: 'var(--primary-foreground)' }
                      : { color: 'var(--muted-foreground)' }
                    }
                  >
                    <Icon className={cn("transition-colors")} />
                    <span className="truncate">{item.label}</span>
                    {showBadge ? (
                      <span className="ml-auto inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded-full bg-red-500 px-1 text-xs font-semibold leading-none text-white">
                        {badgeValue}
                      </span>
                    ) : null}
                  </NavLink>
                </SidebarMenuItem>
              );
            })}

          </SidebarMenu>
        </SidebarContent>
        <SidebarFooter>
          {/* Subscription Auth Status */}
          <div className="px-4 pb-2 text-xs text-muted-foreground space-y-1">
            <div>
              Signed in as{' '}
              <span className="font-medium text-[var(--foreground)]">
                {session?.displayName || session?.username || 'user'}
              </span>
            </div>
            <div>
              {subscriptionState?.authenticated
                ? `NC Catalyst signed in as ${(() => {
                  const raw = subscriptionState.displayName || subscriptionState.email || 'user';
                  return raw.length > 15 ? `${raw.slice(0, 14)}…` : raw;
                })()}`
                : 'NC Catalyst not signed in'}
            </div>
          </div>
          <SidebarMenu>
            {/* Open NC-Cat window */}
            <SidebarMenuItem>
              <button
                onClick={openNcCatSignIn}
                className="flex h-10 w-full items-center gap-3 overflow-hidden rounded-md pl-4 pr-3 text-left text-sm font-medium transition-colors hover:bg-muted hover:text-foreground font-sans [&>span:last-child]:truncate [&>svg]:size-4 [&>svg]:shrink-0"
                style={{ color: 'var(--muted-foreground)' }}
                title="Open NC Catalyst"
              >
                <Rocket />
                <span className="truncate">Open NC Catalyst</span>
              </button>
            </SidebarMenuItem>
            {/* Subscription Sign In / Sign Out */}
            <SidebarMenuItem>
              {subscriptionState?.authenticated ? (
                <button
                  onClick={handleSubscriptionSignOut}
                  disabled={!canManageNcCatalystSubscription}
                  className="flex h-10 w-full items-center gap-3 overflow-hidden rounded-md pl-4 pr-3 text-left text-sm font-medium transition-colors hover:bg-muted hover:text-foreground font-sans disabled:opacity-60 disabled:hover:bg-transparent"
                  style={{ color: 'var(--muted-foreground)' }}
                  title={canManageNcCatalystSubscription ? 'Sign out of NC Catalyst subscription' : 'Only the subscription owner or an admin can sign out'}
                >
                  <LogOut />
                  <span className="truncate">Sign Out</span>
                </button>
              ) : (
                <button
                  onClick={openNcCatSignIn}
                  className="flex h-10 w-full items-center gap-3 overflow-hidden rounded-md pl-4 pr-3 text-left text-sm font-medium transition-colors hover:bg-muted hover:text-foreground font-sans [&>span:last-child]:truncate [&>svg]:size-4 [&>svg]:shrink-0"
                  style={{ color: 'var(--muted-foreground)' }}
                  title="Sign in to NC Catalyst"
                >
                  <KeyRound />
                  <span className="truncate">Sign In</span>
                </button>
              )}
            </SidebarMenuItem>
            <SidebarMenuItem>
              <ThemeSwitcher />
            </SidebarMenuItem>
            <SidebarMenuItem>
              <button
                onClick={() => (session ? logout() : requireLogin())}
                className="flex h-10 w-full items-center gap-3 overflow-hidden rounded-md pl-4 pr-3 text-left text-sm font-medium transition-colors hover:bg-muted hover:text-foreground font-sans [&>span:last-child]:truncate [&>svg]:size-4 [&>svg]:shrink-0"
                style={{ color: 'var(--muted-foreground)' }}
              >
                {session ? <LogOut /> : <UserRound />}
                <span className="truncate">{session ? 'Logout' : 'Login'}</span>
              </button>
            </SidebarMenuItem>
            {session?.role === 'admin' ? (
              <SidebarMenuItem>
                <button
                  onClick={() => setShowSettings(true)}
                  className="flex h-10 w-full items-center gap-3 overflow-hidden rounded-md pl-4 pr-3 text-left text-sm font-medium transition-colors hover:bg-muted hover:text-foreground font-sans [&>span:last-child]:truncate [&>svg]:size-4 [&>svg]:shrink-0"
                  style={{ color: 'var(--muted-foreground)' }}
                >
                  <Settings />
                  <span className="truncate">Settings</span>
                </button>
              </SidebarMenuItem>
            ) : null}
          </SidebarMenu>
        </SidebarFooter>
      </Sidebar>

      {/* Settings Modal */}
      <SettingsModal isOpen={showSettings} onClose={() => setShowSettings(false)} />
    </>
  );
}
