import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query';
import type { AuthStatus } from '@tt/shared';
import { isDragging } from '../lib/dragging';
import { toast } from '../lib/toast';
import { ApiError, setUnauthenticatedHandler } from './client';
import { errorMessage } from './errors';
import { qk } from './keys';
import { endQuietRefetch, isQuietRefetch } from './liveRefresh';

declare module '@tanstack/react-query' {
  interface Register {
    mutationMeta: {
      /** false = the mutation shows its own error feedback; skip the global toast. */
      errorToast?: boolean;
    };
    queryMeta: {
      errorToast?: boolean;
    };
  }
}

function isUnauthenticated(err: unknown): boolean {
  return err instanceof ApiError && err.status === 401 && err.code === 'unauthenticated';
}

/** A 403 may mean your role changed meanwhile (an admin made you a member): reload who you are. */
function refreshRoleOnForbidden(err: unknown): void {
  if (err instanceof ApiError && err.status === 403 && err.code === 'forbidden') void queryClient.invalidateQueries({ queryKey: qk.me });
}

export const queryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: (err, query) => {
      refreshRoleOnForbidden(err);
      // A live refresh is a poll: the next one tries again, so its failure doesn't toast.
      if (isUnauthenticated(err) || query.meta?.errorToast === false || isQuietRefetch(query)) return;
      // First-load failures are shown inline by the page; only background refetch failures toast.
      if (query.state.data !== undefined) toast(errorMessage(err), { kind: 'error' });
    },
    onSettled: (_data, _err, query) => endQuietRefetch(query),
  }),
  mutationCache: new MutationCache({
    onError: (err, _vars, _ctx, mutation) => {
      refreshRoleOnForbidden(err);
      if (isUnauthenticated(err) || mutation.meta?.errorToast === false) return;
      toast(errorMessage(err), { kind: 'error' });
    },
  }),
  defaultOptions: {
    queries: {
      // Keeps phone and desktop in sync, but never mid-drag.
      refetchOnWindowFocus: () => !isDragging(),
      retry: (failureCount, err) =>
        err instanceof ApiError && (err.status === 0 || err.status >= 500) && failureCount < 2,
    },
    mutations: {
      retry: false,
    },
  },
});

// Any 401 'unauthenticated' from the API: flip auth state so the gate shows the login page
// (no full reload), then confirm with the server.
setUnauthenticatedHandler(() => {
  const status = queryClient.getQueryData<AuthStatus>(qk.auth);
  if (status?.authenticated) {
    queryClient.setQueryData<AuthStatus>(qk.auth, { ...status, authenticated: false });
    toast('Your session has ended. Please log in again.', { kind: 'warning' });
  }
  void queryClient.invalidateQueries({ queryKey: qk.auth });
});

/** Drops everything except auth status (after logout or session expiry). */
export function clearPrivateData(): void {
  void queryClient.cancelQueries({ predicate: (q) => q.queryKey[0] !== 'auth' });
  queryClient.removeQueries({ predicate: (q) => q.queryKey[0] !== 'auth' });
}
