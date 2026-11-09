import { QueryClientProvider } from '@tanstack/react-query';
import { lazy, Suspense } from 'react';
import { BrowserRouter, Route, Routes } from 'react-router';
import { queryClient } from './api/queryClient';
import { AuthGate } from './components/auth/AuthGate';
import { ErrorBoundary } from './components/common/ErrorBoundary';
import { LoadingScreen } from './components/common/Status';
import { Toaster } from './components/common/Toaster';
import { AppShell } from './components/shell/AppShell';

// The public submit page and ticket status links need no sign-in and none of the board's code.
const SubmitPage = lazy(() => import('./components/submit/SubmitPage').then((m) => ({ default: m.SubmitPage })));
const StatusPage = lazy(() => import('./components/submit/StatusPage').then((m) => ({ default: m.StatusPage })));

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ErrorBoundary>
        <BrowserRouter>
          <Routes>
            <Route
              path="/submit/status/:id/:sig"
              element={
                <Suspense fallback={<LoadingScreen />}>
                  <StatusPage />
                </Suspense>
              }
            />
            <Route
              path="/submit/:key"
              element={
                <Suspense fallback={<LoadingScreen />}>
                  <SubmitPage />
                </Suspense>
              }
            />
            <Route
              path="*"
              element={
                <AuthGate>
                  <AppShell />
                </AuthGate>
              }
            />
          </Routes>
        </BrowserRouter>
      </ErrorBoundary>
      <Toaster />
    </QueryClientProvider>
  );
}
