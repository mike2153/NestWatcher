import React from 'react';
import ReactDOM from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import './index.css';
import { installRendererConsoleForwarding } from './setupLogger';
import { AppLayout } from './shell/AppLayout';
import { DashboardPage } from './pages/DashboardPage';
import { JobsPage } from './pages/JobsPage';
import { RouterPage } from './pages/RouterPage';
import { HistoryPage } from './pages/HistoryPage';
import { SettingsPage } from './pages/SettingsPage';
import { MachinesPage } from './pages/MachinesPage';
import ThemeShowcase from './pages/ThemeShowcase';
import TelemetryPage from './pages/TelemetryPage';
import CncAlarmsPage from './pages/CncAlarmsPage';

const router = createBrowserRouter([
  {
    path: '/',
    element: <AppLayout />,
    children: [
      { path: '/dashboard', element: <DashboardPage /> },
      { path: '/jobs', element: <JobsPage /> },
      { path: '/router', element: <RouterPage /> },
      { path: '/history', element: <HistoryPage /> },
      { path: '/telemetry', element: <TelemetryPage /> },
      { path: '/cnc-alarms', element: <CncAlarmsPage /> },
      { path: '/settings', element: <SettingsPage /> },
      { path: '/settings/machines', element: <MachinesPage /> },
      { path: '/theme', element: <ThemeShowcase /> },
      { index: true, element: <DashboardPage /> }
    ]
  }
]);

// Forward console.* and uncaught errors to main logger
installRendererConsoleForwarding();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>
);
