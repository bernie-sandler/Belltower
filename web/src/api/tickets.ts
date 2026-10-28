import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AiStatus, BulkDraft, CardDetail, CreateTicketBody, ImportPreview, TicketDraft } from '@tt/shared';
import { applyCardDetail } from './cards';
import { api } from './client';
import { qk } from './keys';

/** Whether Add ticket can draft with Claude (ANTHROPIC_API_KEY is set on the server). */
export function useAiStatus() {
  return useQuery({
    queryKey: qk.aiStatus,
    queryFn: ({ signal }) => api.get<AiStatus>('/api/ai/status', signal),
    // Only changes when the container restarts with a different .env.
    staleTime: Infinity,
  });
}

export function useDraftTicket() {
  return useMutation({
    mutationFn: (text: string) => api.post<TicketDraft>('/api/ai/draft', { text }),
    // The dialog shows the error itself and falls back to the manual form.
    meta: { errorToast: false },
  });
}

/** "Describe several issues": Claude's cards plus the import preview (nothing saved yet). */
export function useDraftMany() {
  return useMutation({
    mutationFn: (text: string) => api.post<BulkDraft>('/api/ai/draft-many', { text }),
    meta: { errorToast: false },
  });
}

/** Creates the reviewed cards from a bulk draft: an ordinary card import. */
export function useCreateDrafted() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (cards: Record<string, unknown>[]) => api.post<ImportPreview>('/api/import/cards', { data: { cards }, dryRun: false }),
    meta: { errorToast: false },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.board });
      void qc.invalidateQueries({ queryKey: qk.cards });
    },
  });
}

export function useCreateTicket() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateTicketBody) => api.post<CardDetail>('/api/tickets', body),
    meta: { errorToast: false },
    onSuccess: (card) => {
      applyCardDetail(qc, card);
      void qc.invalidateQueries({ queryKey: qk.board });
      if (card.parentId !== null) {
        // The work card's ticket list and history changed too.
        void qc.invalidateQueries({ queryKey: qk.card(card.parentId) });
        void qc.invalidateQueries({ queryKey: qk.activity(card.parentId) });
      }
    },
  });
}
