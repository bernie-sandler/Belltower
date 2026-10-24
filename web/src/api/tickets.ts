import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AiStatus, CardDetail, CreateTicketBody, TicketDraft } from '@tt/shared';
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

export function useCreateTicket() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateTicketBody) => api.post<CardDetail>('/api/tickets', body),
    meta: { errorToast: false },
    onSuccess: (card) => {
      applyCardDetail(qc, card);
      void qc.invalidateQueries({ queryKey: qk.board });
    },
  });
}
