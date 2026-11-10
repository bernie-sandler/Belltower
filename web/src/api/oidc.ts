// Single sign-on: its settings (admins) and linking your own account. Signing in itself is a plain
// link to /api/auth/oidc/start, not a request from here.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { OidcSettingsBody, OidcSettingsInfo, OidcTestBody, OidcTestResult } from '@tt/shared';
import { api } from './client';
import { qk } from './keys';

export function useOidcSettings() {
  return useQuery({
    queryKey: qk.oidc,
    queryFn: ({ signal }) => api.get<OidcSettingsInfo>('/api/settings/oidc', signal),
    // The section shows the error itself (the demo's "not available" notice included).
    meta: { errorToast: false },
    retry: false,
  });
}

export function useSaveOidc() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: OidcSettingsBody) => api.put<OidcSettingsInfo>('/api/settings/oidc', body),
    meta: { errorToast: false },
    onSuccess: (info) => {
      qc.setQueryData(qk.oidc, info);
      // The login button comes from /api/auth/status.
      void qc.invalidateQueries({ queryKey: qk.auth });
    },
  });
}

export function useTestOidc() {
  return useMutation({
    mutationFn: (body: OidcTestBody) => api.post<OidcTestResult>('/api/settings/oidc/test', body),
    meta: { errorToast: false },
  });
}

/** Starts linking: the server answers with the provider's address, and the page goes there. */
export function useLinkSso() {
  return useMutation({
    mutationFn: () => api.post<{ url: string }>('/api/auth/oidc/link'),
    meta: { errorToast: false },
  });
}

export function useUnlinkSso() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.del('/api/auth/oidc/link'),
    meta: { errorToast: false },
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.me }),
  });
}
