import '@fontsource-variable/geist';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { createBrowserRouter, createHashRouter, RouterProvider } from 'react-router-dom';
import './index.css';
import { installRendererConsoleForwarding } from './setupLogger';
import { AppLayout } from './shell/AppLayout';
import { DashboardPage } from './pages/DashboardPage';
import { JobsPage } from './pages/JobsPage';
import { RouterPage } from './pages/RouterPage';
import { HistoryPage } from './pages/HistoryPage';
import { MachinesPage } from './pages/MachinesPage';
import { TelemetryPage } from './pages/TelemetryPage';
import { CncAlarmsPage } from './pages/CncAlarmsPage';
import { GrundnerPage } from './pages/GrundnerPage';
import { AllocatedMaterialPage } from './pages/AllocatedMaterialPage';
import { MessagesPage } from './pages/MessagesPage';
import { OrderingPage } from './pages/OrderingPage';
import { AuthProvider } from './contexts/AuthContext';
import { ThemeProvider } from './contexts/ThemeContext';

// Use BrowserRouter in dev for nicer URLs; HashRouter in production for file:// packaging
const makeRoutes = () => ([
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
      { path: '/messages', element: <MessagesPage /> },
      { path: '/grundner', element: <GrundnerPage /> },
      { path: '/allocated-material', element: <AllocatedMaterialPage /> },
      { path: '/ordering', element: <OrderingPage /> },
      { path: '/machines', element: <MachinesPage /> },
      { index: true, element: <DashboardPage /> }
    ]
  }
]);

const router = import.meta.env?.DEV
  ? createBrowserRouter(makeRoutes())
  : createHashRouter(makeRoutes());

// Forward console.* and uncaught errors to main logger
installRendererConsoleForwarding();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ThemeProvider>
      <AuthProvider>
        <RouterProvider router={router} />
      </AuthProvider>
    </ThemeProvider>
  </React.StrictMode>
);
