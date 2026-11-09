// Settings page: general options, submit page and request types, API tokens, notifications.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ApiTokenBody,
  ApiTokenInfo,
  DiscordSettingsBody,
  GeneralSettingsBody,
  NotifyAlertsBody,
  NotifyChannel,
  NotifyChannelBody,
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
      // Turning the submit page on or off, or resetting links, changes cards' status links.
      void qc.invalidateQueries({ queryKey: qk.statusLinks });
    },
  });
}

export const useSaveGeneral = () => useSettingsMutation<GeneralSettingsBody>('put', '/api/settings/general');
export const useSaveSubmit = () => useSettingsMutation<SubmitSettingsBody>('put', '/api/settings/submit');
export const useNewSubmitLink = () => useSettingsMutation<void>('post', '/api/settings/submit/new-link');
/** Cuts off every ticket status link handed out so far. */
export const useResetStatusLinks = () => useSettingsMutation<void>('post', '/api/settings/submit/reset-status-links');
export const useSaveResolutions = () => useSettingsMutation<ResolutionReasonsBody>('put', '/api/settings/resolutions');
export const useSaveDiscord = () => useSettingsMutation<DiscordSettingsBody>('put', '/api/settings/discord');
/** What counts as urgent, and when the daily summary goes out (every channel). */
export const useSaveAlerts = () => useSettingsMutation<NotifyAlertsBody>('put', '/api/settings/notify');
export const useSaveChannel = (channel: NotifyChannel) => useSettingsMutation<NotifyChannelBody>('put', `/api/settings/notify/${channel}`);

export type AnyChannel = 'discord' | NotifyChannel;

/** Send test / Send summary now, for one channel. */
export function useChannelAction(channel: AnyChannel, action: 'test' | 'digest-now') {
  const qc = useQueryClient();
  const base = channel === 'discord' ? '/api/settings/discord' : `/api/settings/notify/${channel}`;
  return useMutation({
    mutationFn: () => api.post<{ ok: boolean; message: string; settings: SettingsResponse }>(`${base}/${action}`),
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
