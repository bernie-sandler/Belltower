// Personal notifications (1.5): the bell's list, read marks, watching a card, and your own channels
// under Account → Notifications. The bell polls with plain fetch (through api/client), so the
// browser-only demo answers it too.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CardDetail, NotificationsResponse, PersonalNotifyBody, PersonalNotifySettings, PersonalTestResult } from '@tt/shared';
import { api } from './client';
import { qk } from './keys';

/** How often the bell asks for news. Background tabs too, so a sound can play while you're elsewhere. */
export const BELL_POLL_MS = 30_000;

export function useNotifications() {
  return useQuery({
    queryKey: qk.notifications,
    queryFn: ({ signal }) => api.get<NotificationsResponse>('/api/notifications?limit=30', signal),
    refetchInterval: BELL_POLL_MS,
    refetchIntervalInBackground: true,
    refetchOnWindowFocus: true,
    staleTime: 5_000,
    // A missed poll isn't worth a toast every 30 seconds; the next one tries again.
    meta: { errorToast: false },
  });
}

/** Marks some (ids) or all of your notifications read, in the cache straight away. */
export function useMarkNotificationsRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { ids: number[] } | { all: true }) => api.post<{ unread: number }>('/api/notifications/read', body),
    meta: { errorToast: false },
    onMutate: (body) => {
      const now = new Date().toISOString();
      qc.setQueryData<NotificationsResponse>(qk.notifications, (old) => {
        if (!old) return old;
        const ids = 'all' in body ? null : new Set(body.ids);
        let changed = 0;
        const items = old.items.map((n) => {
          if (n.readAt || (ids && !ids.has(n.id))) return n;
          changed++;
          return { ...n, readAt: now };
        });
        return { ...old, items, unread: ids ? Math.max(0, old.unread - changed) : 0 };
      });
    },
    onSuccess: ({ unread }) => {
      qc.setQueryData<NotificationsResponse>(qk.notifications, (old) => (old ? { ...old, unread } : old));
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: qk.notifications }),
  });
}

/** Watch (true) or stop watching (false) a card. */
export function useWatchCard(cardId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (watch: boolean) =>
      watch ? api.put<{ watching: boolean }>(`/api/cards/${cardId}/watch`) : api.del<{ watching: boolean }>(`/api/cards/${cardId}/watch`),
    onSuccess: ({ watching }) => {
      qc.setQueryData<CardDetail>(qk.card(cardId), (old) => (old ? { ...old, watching } : old));
    },
  });
}

export function usePersonalNotify() {
  return useQuery({
    queryKey: qk.personalNotify,
    queryFn: ({ signal }) => api.get<PersonalNotifySettings>('/api/me/notifications', signal),
  });
}

export function useSavePersonalNotify() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: PersonalNotifyBody) => api.put<PersonalNotifySettings>('/api/me/notifications', body),
    meta: { errorToast: false },
    onSuccess: (data) => qc.setQueryData(qk.personalNotify, data),
  });
}

export function useSendPersonalTest() {
  return useMutation({
    mutationFn: () => api.post<PersonalTestResult>('/api/me/notifications/test'),
    meta: { errorToast: false },
  });
}
