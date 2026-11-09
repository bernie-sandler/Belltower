// Phase 3: search, calendar, recurring templates.

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CalendarItem, CardDetail, RecurringTemplate, SearchResult, SimilarTicket, TemplateBody } from '@tt/shared';
import { applyCardDetail } from './cards';
import { api } from './client';
import { qk } from './keys';

export interface SearchParams {
  q: string;
  labelIds: number[];
  columnIds: number[];
  priorities: string[];
  severities: string[];
  status: 'all' | 'board' | 'archived';
  from: string;
  to: string;
}

export function searchQueryString(p: SearchParams): string {
  const s = new URLSearchParams();
  if (p.q.trim()) s.set('q', p.q.trim());
  if (p.labelIds.length) s.set('labelIds', p.labelIds.join(','));
  if (p.columnIds.length) s.set('columnIds', p.columnIds.join(','));
  if (p.priorities.length) s.set('priorities', p.priorities.join(','));
  if (p.severities.length) s.set('severities', p.severities.join(','));
  if (p.status !== 'all') s.set('status', p.status);
  if (p.from) s.set('from', p.from);
  if (p.to) s.set('to', p.to);
  return s.toString();
}

export function useSearch(p: SearchParams) {
  const qs = searchQueryString(p);
  const status = p.status !== 'all' ? `status=${p.status}` : '';
  return useQuery({
    queryKey: qk.search(qs),
    queryFn: ({ signal }) => api.get<SearchResult[]>(`/api/search?${qs}&limit=100`, signal),
    // Nothing to search for: status alone isn't a filter.
    enabled: qs !== '' && qs !== status,
    placeholderData: keepPreviousData,
  });
}

/**
 * "Seen this before?" for a card: finished tickets like it. Keyed on updatedAt so editing the
 * title or description asks again.
 */
export function useSimilarForCard(card: Pick<CardDetail, 'id' | 'updatedAt'>, enabled: boolean) {
  return useQuery({
    queryKey: qk.similarForCard(card.id, card.updatedAt),
    queryFn: ({ signal }) => api.get<SimilarTicket[]>(`/api/cards/${card.id}/similar`, signal),
    enabled,
    staleTime: 60_000,
    placeholderData: keepPreviousData,
    meta: { errorToast: false },
  });
}

/** "Seen this before?" while a ticket is being written (Add ticket). Pass already-debounced text. */
export function useSimilarForText(title: string, description: string, enabled: boolean) {
  return useQuery({
    queryKey: qk.similarForText(title, description),
    queryFn: ({ signal }) =>
      api.get<SimilarTicket[]>(`/api/similar?${new URLSearchParams({ title, description }).toString()}`, signal),
    enabled,
    staleTime: 60_000,
    placeholderData: keepPreviousData,
    meta: { errorToast: false },
  });
}

export function useCalendar(from: string, to: string) {
  return useQuery({
    queryKey: qk.calendar(from, to),
    queryFn: ({ signal }) => api.get<CalendarItem[]>(`/api/calendar?from=${from}&to=${to}`, signal),
    placeholderData: keepPreviousData,
  });
}

export function useTemplates() {
  return useQuery({
    queryKey: qk.templates,
    queryFn: ({ signal }) => api.get<RecurringTemplate[]>('/api/templates', signal),
  });
}

export function useTemplateActions() {
  const qc = useQueryClient();
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: qk.templates });
    // A save can create a card right away (template due today).
    void qc.invalidateQueries({ queryKey: qk.board });
  };
  const create = useMutation({
    mutationFn: (body: TemplateBody) => api.post<RecurringTemplate>('/api/templates', body),
    onSuccess: refresh,
  });
  const update = useMutation({
    mutationFn: (v: { id: number; patch: Partial<TemplateBody> }) =>
      api.patch<RecurringTemplate>(`/api/templates/${v.id}`, v.patch),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: (id: number) => api.del(`/api/templates/${id}`),
    onSuccess: refresh,
  });
  const runNow = useMutation({
    mutationFn: (v: { id: number; force?: boolean }) =>
      api.post<CardDetail>(`/api/templates/${v.id}/run${v.force ? '?force=1' : ''}`),
    meta: { errorToast: false },
    onSuccess: (card) => {
      applyCardDetail(qc, card);
      refresh();
    },
  });
  return { create, update, remove, runNow };
}
