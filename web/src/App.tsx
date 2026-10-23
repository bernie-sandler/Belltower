import { QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router';
import { queryClient } from './api/queryClient';
import { AuthGate } from './components/auth/AuthGate';
import { ErrorBoundary } from './components/common/ErrorBoundary';
import { Toaster } from './components/common/Toaster';
import { AppShell } from './components/shell/AppShell';

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ErrorBoundary>
        <BrowserRouter>
          <AuthGate>
            <AppShell />
          </AuthGate>
        </BrowserRouter>
      </ErrorBoundary>
      <Toaster />
    </QueryClientProvider>
  );
}
