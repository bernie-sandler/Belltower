// Personal notifications (1.5): the bell's list, read marks, watching a card, and your own channels
// under Account → Notifications. The bell polls with plain fetch (through api/client), so the
// browser-only demo answers it too.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import type { CardDetail, NotificationItem, NotificationsResponse, PersonalNotifyBody, PersonalNotifySettings, PersonalTestResult } from '@tt/shared';
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

type ReadBody = { ids: number[] } | { cardId: number } | { all: true };

/** Marks some (ids), a card's, or all of your notifications read, in the cache straight away. */
export function useMarkNotificationsRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ReadBody) => api.post<{ unread: number }>('/api/notifications/read', body),
    meta: { errorToast: false },
    onMutate: (body) => {
      const now = new Date().toISOString();
      qc.setQueryData<NotificationsResponse>(qk.notifications, (old) => {
        if (!old) return old;
        const hits = (n: NotificationItem) => ('all' in body ? true : 'cardId' in body ? n.cardId === body.cardId : body.ids.includes(n.id));
        let changed = 0;
        const items = old.items.map((n) => {
          if (n.readAt || !hits(n)) return n;
          changed++;
          return { ...n, readAt: now };
        });
        return { ...old, items, unread: 'all' in body ? 0 : Math.max(0, old.unread - changed) };
      });
    },
    onSuccess: ({ unread }) => {
      qc.setQueryData<NotificationsResponse>(qk.notifications, (old) => (old ? { ...old, unread } : old));
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: qk.notifications }),
  });
}

/**
 * Opening a card marks your notifications about it read. Asks the server only when there may be
 * some: an unread one about this card in the bell's list, or more unread than the list shows.
 * Once per card opened (not again while it stays open).
 */
export function useMarkCardSeen(cardId: number) {
  const { data } = useNotifications();
  const markRead = useMarkNotificationsRead();
  const done = useRef<number | null>(null);
  const { mutate } = markRead;
  useEffect(() => {
    if (!data || cardId <= 0 || done.current === cardId) return;
    done.current = cardId;
    const listedUnread = data.items.filter((n) => !n.readAt);
    if (listedUnread.some((n) => n.cardId === cardId) || data.unread > listedUnread.length) mutate({ cardId });
  }, [data, cardId, mutate]);
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
