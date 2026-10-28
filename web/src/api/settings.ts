// Settings page: general options, submit page and request types, API tokens, Discord.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ApiTokenBody,
  ApiTokenInfo,
  DiscordSettingsBody,
  GeneralSettingsBody,
  ResolutionReasonsBody,
  RequestType,
  RequestTypeBody,
  SettingsResponse,
  SubmitSettingsBody,
} from '@tt/shared';
import { api } from './client';
import { qk } from './keys';

export function useSettings() {
  return useQuery({ queryKey: qk.settings, queryFn: ({ signal }) => api.get<SettingsResponse>('/api/settings', signal) });
}

/** A PUT/POST that returns the whole settings object, which replaces the cached one. */
function useSettingsMutation<V>(method: 'put' | 'post', path: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: V) => (method === 'put' ? api.put<SettingsResponse>(path, body) : api.post<SettingsResponse>(path, body)),
    meta: { errorToast: false },
    onSuccess: (s) => {
      qc.setQueryData(qk.settings, s);
      // The ticket format or blocked column may change what the board shows.
      void qc.invalidateQueries({ queryKey: qk.board });
    },
  });
}

export const useSaveGeneral = () => useSettingsMutation<GeneralSettingsBody>('put', '/api/settings/general');
export const useSaveSubmit = () => useSettingsMutation<SubmitSettingsBody>('put', '/api/settings/submit');
export const useNewSubmitLink = () => useSettingsMutation<void>('post', '/api/settings/submit/new-link');
export const useSaveResolutions = () => useSettingsMutation<ResolutionReasonsBody>('put', '/api/settings/resolutions');
export const useSaveDiscord = () => useSettingsMutation<DiscordSettingsBody>('put', '/api/settings/discord');

export function useTestDiscord() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<{ ok: boolean; message: string; settings: SettingsResponse }>('/api/settings/discord/test'),
    meta: { errorToast: false },
    onSuccess: (r) => qc.setQueryData(qk.settings, r.settings),
  });
}

/** Settings → Send summary now: today's summary straight away (ignores the time and whether it was sent). */
export function useSendDigestNow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<{ ok: boolean; message: string; settings: SettingsResponse }>('/api/settings/discord/digest-now'),
    meta: { errorToast: false },
    onSuccess: (r) => qc.setQueryData(qk.settings, r.settings),
  });
}

// ---- request types ----

export function useRequestTypes() {
  return useQuery({ queryKey: qk.requestTypes, queryFn: ({ signal }) => api.get<RequestType[]>('/api/request-types', signal) });
}

export function useRequestTypeActions() {
  const qc = useQueryClient();
  const refresh = () => void qc.invalidateQueries({ queryKey: qk.requestTypes });
  const opts = { meta: { errorToast: false }, onSuccess: refresh };
  return {
    create: useMutation({ mutationFn: (body: RequestTypeBody) => api.post<RequestType>('/api/request-types', body), ...opts }),
    update: useMutation({
      mutationFn: (v: { id: number; body: RequestTypeBody }) => api.put<RequestType>(`/api/request-types/${v.id}`, v.body),
      ...opts,
    }),
    remove: useMutation({ mutationFn: (id: number) => api.del(`/api/request-types/${id}`), ...opts }),
    reorder: useMutation({ mutationFn: (ids: number[]) => api.put<RequestType[]>('/api/request-types/order', { ids }), ...opts }),
  };
}

// ---- API tokens ----

export function useTokens() {
  return useQuery({ queryKey: qk.tokens, queryFn: ({ signal }) => api.get<ApiTokenInfo[]>('/api/tokens', signal) });
}

export function useTokenActions() {
  const qc = useQueryClient();
  const refresh = () => void qc.invalidateQueries({ queryKey: qk.tokens });
  return {
    create: useMutation({
      mutationFn: (body: ApiTokenBody) => api.post<{ token: string; info: ApiTokenInfo }>('/api/tokens', body),
      meta: { errorToast: false },
      onSuccess: refresh,
    }),
    revoke: useMutation({ mutationFn: (id: number) => api.del(`/api/tokens/${id}`), onSuccess: refresh }),
  };
}
