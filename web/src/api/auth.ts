import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AuthStatus, ChangePasswordBody, LoginBody, SetupBody } from '@tt/shared';
import { api } from './client';
import { qk } from './keys';
import { clearPrivateData } from './queryClient';

export function useAuthStatus() {
  return useQuery({
    queryKey: qk.auth,
    queryFn: ({ signal }) => api.get<AuthStatus>('/api/auth/status', signal),
    staleTime: 30_000,
    meta: { errorToast: false },
  });
}

function useMarkAuthenticated() {
  const qc = useQueryClient();
  return async () => {
    clearPrivateData(); // never show a previous session's cached data
    qc.setQueryData<AuthStatus>(qk.auth, (s) =>
      s ? { ...s, authenticated: true, setupRequired: false } : s,
    );
    await qc.invalidateQueries({ queryKey: qk.auth });
  };
}

export function useLogin() {
  const markAuthenticated = useMarkAuthenticated();
  return useMutation({
    mutationFn: (body: LoginBody) => api.post<void>('/api/auth/login', body),
    meta: { errorToast: false },
    onSuccess: markAuthenticated,
  });
}

export function useSetup() {
  const markAuthenticated = useMarkAuthenticated();
  return useMutation({
    mutationFn: (body: SetupBody) => api.post<void>('/api/auth/setup', body),
    meta: { errorToast: false },
    onSuccess: markAuthenticated,
  });
}

export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<void>('/api/auth/logout'),
    onSettled: () => {
      qc.setQueryData<AuthStatus>(qk.auth, (s) => (s ? { ...s, authenticated: false } : s));
      clearPrivateData();
      void qc.invalidateQueries({ queryKey: qk.auth });
    },
  });
}

export function useChangePassword() {
  return useMutation({
    mutationFn: (body: ChangePasswordBody) => api.post<void>('/api/auth/password', body),
    meta: { errorToast: false },
  });
}
