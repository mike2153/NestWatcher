import '@fontsource-variable/geist';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { createBrowserRouter, createHashRouter, RouterProvider } from 'react-router-dom';
import './index.css';
import { installRendererConsoleForwarding } from './setupLogger';
import { AppLayout } from './shell/AppLayout';
import { SubscriptionGateLayout } from './shell/SubscriptionGateLayout';
import { StartupLoadingScreen } from './components/StartupLoadingScreen';
import { BootSplashGate } from './shell/BootSplashGate';
import { DashboardPage } from './pages/DashboardPage';
import { JobsPage } from './pages/JobsPage';
import { RouterPage } from './pages/RouterPage';
import { HistoryPage } from './pages/HistoryPage';
import { MachinesPage } from './pages/MachinesPage';
import { TelemetryPage } from './pages/TelemetryPage';
import { CncAlarmsPage } from './pages/CncAlarmsPage';
import { GrundnerPage } from './pages/GrundnerPage';
import { MessagesPage } from './pages/MessagesPage';
import { AdminToolsPage } from './pages/AdminToolsPage';
import { OrderingPage } from './pages/OrderingPage';
import { AuthProvider } from './contexts/AuthContext';
import { ThemeProvider } from './contexts/ThemeContext';
import { SubscriptionAuthProvider } from './contexts/SubscriptionAuthContext';
import { AuthRequiredPage } from './pages/AuthRequiredPage';

// Dev-only preview modes for startup loading screens.
//
// Why: the real splash screens are visible for <1s during normal boot, which makes
// it painful to iterate on styling.
//
// Usage (renderer-only, opens in a normal browser):
// - http://localhost:5180/?wlPreview=react   -> renders the React loading screen
//
// Note: we intentionally don't keep a "preload HTML splash" preview anymore.
// The real app keeps the BrowserWindow hidden until React paints the splash.
const wlPreview = (() => {
  if (!import.meta.env.DEV) return null;
  try {
    return new URLSearchParams(window.location.search).get('wlPreview');
  } catch {
    return null;
  }
})();

// Use BrowserRouter in dev for nicer URLs; HashRouter in production for file:// packaging
const makeRoutes = () => ([
  {
    element: <SubscriptionGateLayout />,
    children: [
      { path: '/auth-required', element: <AuthRequiredPage /> },
      {
        path: '/',
        element: (
          <AuthProvider>
            <AppLayout />
          </AuthProvider>
        ),
        children: [
          { path: '/dashboard', element: <DashboardPage /> },
          { path: '/jobs', element: <JobsPage /> },
          { path: '/router', element: <RouterPage /> },
          { path: '/history', element: <HistoryPage /> },
          { path: '/telemetry', element: <TelemetryPage /> },
          { path: '/cnc-alarms', element: <CncAlarmsPage /> },
          { path: '/messages', element: <MessagesPage /> },
          { path: '/admin-tools', element: <AdminToolsPage /> },
          { path: '/grundner', element: <GrundnerPage /> },
          { path: '/ordering', element: <OrderingPage /> },
          { path: '/machines', element: <MachinesPage /> },
          { index: true, element: <DashboardPage /> },
        ]
      }
    ]
  }
]);

const router = import.meta.env?.DEV
  ? createBrowserRouter(makeRoutes())
  : createHashRouter(makeRoutes());

// Forward console.* and uncaught errors to main logger
installRendererConsoleForwarding();

if (wlPreview === 'react') {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <ThemeProvider>
        <StartupLoadingScreen
          status="Starting application..."
          statusCompleteAtMs={4000}
          steps={[
            'Connecting to database',
            'Checking user authentication',
            'Loading machine profiles',
          ]}
          durationMs={6000}
        />
      </ThemeProvider>
    </React.StrictMode>
  );
} else {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <ThemeProvider>
        <SubscriptionAuthProvider>
          <BootSplashGate>
            <RouterProvider router={router} />
          </BootSplashGate>
        </SubscriptionAuthProvider>
      </ThemeProvider>
    </React.StrictMode>
  );
}
