import { useEffect, type ReactNode } from 'react';
import { useAuthStatus } from '../../api/auth';
import { errorMessage } from '../../api/errors';
import { clearPrivateData } from '../../api/queryClient';
import { ErrorScreen, LoadingScreen } from '../common/Status';
import { LoginPage } from './LoginPage';
import { SetupPage } from './SetupPage';

/** Chooses between first-run setup, login, and the app, from GET /api/auth/status. */
export function AuthGate({ children }: { children: ReactNode }) {
  const { data, error, isPending, refetch } = useAuthStatus();
  const signedOut = data !== undefined && !data.authenticated;

  // Drop the previous session's cached board/cards whenever we land on a signed-out screen.
  useEffect(() => {
    if (signedOut) clearPrivateData();
  }, [signedOut]);

  if (isPending) return <LoadingScreen />;
  if (!data) {
    return (
      <ErrorScreen
        title="Can't reach Tower Tracker"
        message={errorMessage(error)}
        onRetry={() => void refetch()}
      />
    );
  }
  if (data.setupRequired) return <SetupPage />;
  if (!data.authenticated) return <LoginPage />;
  return <>{children}</>;
}
