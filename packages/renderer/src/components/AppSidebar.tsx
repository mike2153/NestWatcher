import { useEffect, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { LayoutDashboard, Router, History, Settings, Layers, BellRing, Gauge, ListCheck, AlignVerticalJustifyEnd, MessageSquare, ShoppingCart, UserRound, LogOut, Sun, Moon } from 'lucide-react';
import { useTheme } from '@/contexts/ThemeContext';
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
import { useAuth } from '@/contexts/AuthContext';

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
  const { theme, toggleTheme } = useTheme();

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
                  className={({ isActive }) => cn(
                    'flex h-10 w-full items-center gap-3 overflow-hidden rounded-md pl-4 pr-3 text-left text-base font-medium transition-all duration-150 hover:bg-[var(--accent-blue-subtle)] hover:text-sidebar-accent-foreground hover:border-l-2 hover:border-l-[var(--accent-blue)] hover:pl-[14px] [&>span:last-child]:truncate [&>svg]:size-4 [&>svg]:shrink-0',
                    isActive && 'bg-[var(--accent-blue-subtle)] text-sidebar-accent-foreground font-medium border-l-2 border-l-[var(--accent-blue)] pl-[14px]'
                  )}
                >
                  <Icon />
                  <span className="ml-2 text-base font-medium">{item.label}</span>
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
        <div className="px-4 pb-2 text-xs text-muted-foreground">
          {session ? `Signed in as ${session.displayName}` : 'Not signed in'}
        </div>
        <SidebarMenu>
          <SidebarMenuItem>
            <button
              onClick={toggleTheme}
              className="flex h-10 w-full items-center gap-3 overflow-hidden rounded-md pl-4 pr-3 text-left text-base font-medium transition-all duration-150 hover:bg-[var(--accent-blue-subtle)] hover:text-sidebar-accent-foreground hover:border-l-2 hover:border-l-[var(--accent-blue)] hover:pl-[14px] [&>span:last-child]:truncate [&>svg]:size-4 [&>svg]:shrink-0"
              title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
            >
              {theme === 'dark' ? <Sun /> : <Moon />}
              <span className="ml-2 text-base font-medium">{theme === 'dark' ? 'Light Mode' : 'Dark Mode'}</span>
            </button>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <button
              onClick={() => (session ? logout() : requireLogin())}
              className="flex h-10 w-full items-center gap-3 overflow-hidden rounded-md pl-4 pr-3 text-left text-base font-medium transition-all duration-150 hover:bg-[var(--accent-blue-subtle)] hover:text-sidebar-accent-foreground hover:border-l-2 hover:border-l-[var(--accent-blue)] hover:pl-[14px] [&>span:last-child]:truncate [&>svg]:size-4 [&>svg]:shrink-0"
            >
              {session ? <LogOut /> : <UserRound />}
              <span className="ml-2 text-base font-medium">{session ? 'Logout' : 'Login'}</span>
            </button>
          </SidebarMenuItem>
          {session?.role === 'admin' ? (
            <SidebarMenuItem>
              <button
                onClick={() => setShowSettings(true)}
                className="flex h-10 w-full items-center gap-3 overflow-hidden rounded-md pl-4 pr-3 text-left text-base font-medium transition-all duration-150 hover:bg-[var(--accent-blue-subtle)] hover:text-sidebar-accent-foreground hover:border-l-2 hover:border-l-[var(--accent-blue)] hover:pl-[14px] [&>span:last-child]:truncate [&>svg]:size-4 [&>svg]:shrink-0"
              >
                <Settings />
                <span className="ml-2 text-base font-medium">Settings</span>
              </button>
            </SidebarMenuItem>
          ) : null}
          <SidebarMenuItem>
            <button
              className="flex h-10 w-full items-center gap-2 overflow-hidden rounded-md pl-4 pr-3 text-left text-base font-medium transition-all duration-150 hover:bg-[var(--accent-blue-subtle)] hover:text-sidebar-accent-foreground hover:border-l-2 hover:border-l-[var(--accent-blue)] hover:pl-[14px]"
              onClick={async () => {
                const res = await window.api.ncCatalyst.open();
                if (!res.ok) alert(`Failed to open NC Catalyst: ${res.error.message}`);
              }}
              title="Open NC Catalyst in a separate window"
            >
              NC Catalyst
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



