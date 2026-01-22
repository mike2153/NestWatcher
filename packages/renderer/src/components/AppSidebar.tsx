import { useCallback, useEffect, useRef, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { LayoutDashboard, History, Settings, Layers, BellRing, Gauge, ListCheck, AlignVerticalJustifyEnd, MessageSquare, ShoppingCart, UserRound, LogOut, Rocket, Fan } from 'lucide-react';
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
import woodtronLogo from '@/assets/woodtron.png';
import type { DbStatus } from '../../../shared/src';

const nav = [
  { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/jobs', label: 'Jobs', icon: ListCheck },
  { to: '/router', label: 'Router', icon: Fan },
  { to: '/history', label: 'History', icon: History },
  { to: '/grundner', label: 'Grundner', icon: AlignVerticalJustifyEnd },
  { to: '/allocated-material', label: 'Allocated', icon: Layers },
  { to: '/ordering', label: 'Ordering', icon: ShoppingCart },
  { to: '/telemetry', label: 'Telemetry', icon: Gauge },
  { to: '/messages', label: 'Messages', icon: MessageSquare },
  { to: '/cnc-alarms', label: 'CNC Alarms', icon: BellRing },
];

const sidebarItemBase =
  'flex h-10 w-full items-center gap-3 overflow-hidden rounded-md pl-4 pr-3 text-left text-sm font-medium transition-colors font-sans [&>span:last-child]:truncate [&>svg]:size-4 [&>svg]:shrink-0';
const sidebarItemCollapsible = 'group-data-[collapsible=icon]/sidebar-wrapper:justify-center group-data-[collapsible=icon]/sidebar-wrapper:px-2';
// Match table row hover/selected highlight color across themes.
const sidebarItemInactive = 'text-[var(--muted-foreground)] hover:bg-[var(--accent-blue-subtle)] hover:text-[var(--foreground)]';
const sidebarItemActive = 'bg-[var(--primary)] text-[var(--primary-foreground)]';

export function AppSidebar() {
  const [unreadCount, setUnreadCount] = useState(0);
  const [showSettings, setShowSettings] = useState(false);
  const { session, requireLogin, logout } = useAuth();
  const [dbOfflineTooLong, setDbOfflineTooLong] = useState(false);
  const dbOfflineTimerRef = useRef<number | null>(null);

  const openNcCatSignIn = useCallback(async () => {
    const res = await window.api.ncCatalyst.open();
    if (!res.ok) {
      // eslint-disable-next-line no-console
      console.error('Failed to open NC Catalyst:', res.error.message);
    }
  }, []);

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

  useEffect(() => {
    const handleDbStatus = (status: DbStatus) => {
      if (status.online) {
        setDbOfflineTooLong(false);
        if (dbOfflineTimerRef.current != null) {
          window.clearTimeout(dbOfflineTimerRef.current);
          dbOfflineTimerRef.current = null;
        }
        return;
      }

      // Keep the dot green for the first 5 seconds of an outage, then turn red.
      if (dbOfflineTimerRef.current == null) {
        dbOfflineTimerRef.current = window.setTimeout(() => {
          dbOfflineTimerRef.current = null;
          setDbOfflineTooLong(true);
        }, 5000);
      }
    };

    let cancelled = false;
    window.api.db.getStatus()
      .then((res) => {
        if (cancelled) return;
        if (res.ok) handleDbStatus(res.value);
      })
      .catch(() => {});

    const unsubscribe = window.api.db.subscribeStatus((status) => handleDbStatus(status));

    return () => {
      cancelled = true;
      unsubscribe?.();
      if (dbOfflineTimerRef.current != null) {
        window.clearTimeout(dbOfflineTimerRef.current);
        dbOfflineTimerRef.current = null;
      }
    };
  }, []);

  return (
    <>
      <Sidebar>
        <SidebarHeader>
          <div className="px-3 font-semibold text-xl flex items-center gap-2 group-data-[collapsible=icon]/sidebar-wrapper:justify-center">
            <img
              src={woodtronLogo}
              alt="Woodtron"
              className="h-7 w-7 shrink-0"
              draggable={false}
            />
            <span className="group-data-[collapsible=icon]/sidebar-wrapper:hidden">Woodtron</span>
          </div>
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
                    className={({ isActive }) =>
                      cn(sidebarItemBase, sidebarItemCollapsible, isActive ? sidebarItemActive : sidebarItemInactive)
                    }
                    title={showBadge ? `${item.label} (${badgeValue})` : item.label}
                  >
                    <Icon className={cn("transition-colors")} />
                    <span className="truncate group-data-[collapsible=icon]/sidebar-wrapper:hidden">{item.label}</span>
                    {showBadge ? (
                      <span className="ml-auto inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded-full bg-red-500 px-1 text-xs font-semibold leading-none text-white group-data-[collapsible=icon]/sidebar-wrapper:hidden">
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
          <div className="group-data-[collapsible=icon]/sidebar-wrapper:hidden">
            
          </div>
          <SidebarMenu>
            {/* Open NC-Cat window */}
            <SidebarMenuItem>
                <button
                  onClick={openNcCatSignIn}
                  className={cn(
                    sidebarItemBase,
                    sidebarItemCollapsible,
                    sidebarItemInactive
                  )}
                  title="Open NC Catalyst"
                >
                  <Rocket />
                  <span className="truncate group-data-[collapsible=icon]/sidebar-wrapper:hidden">Open NC Catalyst</span>
                </button>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <ThemeSwitcher />
            </SidebarMenuItem>
            {session?.role === 'admin' ? (
              <SidebarMenuItem>
                <button
                  onClick={() => setShowSettings(true)}
                  className={cn(
                    sidebarItemBase,
                    sidebarItemCollapsible,
                    sidebarItemInactive
                  )}
                  title="Settings"
                >
                  <Settings />
                  <span className="truncate group-data-[collapsible=icon]/sidebar-wrapper:hidden">Settings</span>
                </button>
              </SidebarMenuItem>
            ) : null}
            <div className={cn(sidebarItemBase, 'cursor-default select-none text-[var(--muted-foreground)]')}>
              {session ? (
                <span
                  aria-label={dbOfflineTooLong ? 'Database disconnected' : 'Authenticated'}
                  title={dbOfflineTooLong ? 'Database disconnected' : 'Authenticated'}
                  className={cn(
                    'inline-block size-2 rounded-full motion-reduce:animate-none animate-pulse',
                    dbOfflineTooLong ? 'bg-red-500' : 'bg-emerald-500'
                  )}
                  style={{
                    boxShadow: dbOfflineTooLong
                      ? '0 0 10px rgba(239, 68, 68, 0.9)'
                      : '0 0 10px rgba(16, 185, 129, 0.9)'
                  }}
                />
              ) : null}
              <span>Signed in as {session?.displayName || session?.username || 'user'}</span>
            </div>
            <SidebarMenuItem>
              <button
                onClick={() => (session ? logout() : requireLogin())}
                className={cn(
                  sidebarItemBase,
                  sidebarItemCollapsible,
                  sidebarItemInactive
                )}
                title={session ? 'Logout' : 'Login'}
              >
                {session ? <LogOut /> : <UserRound />}
                <span className="truncate group-data-[collapsible=icon]/sidebar-wrapper:hidden">{session ? 'Logout' : 'Login'}</span>
              </button>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>
      </Sidebar>

      {/* Settings Modal */}
      <SettingsModal isOpen={showSettings} onClose={() => setShowSettings(false)} />
    </>
  );
}
