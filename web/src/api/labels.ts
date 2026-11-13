import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { BoardResponse, CardDetail, Label, LabelBody, UpdateLabelBody } from '@tt/shared';
import { setBoard } from './board';
import { api, isApiError } from './client';
import { qk } from './keys';

export function sortedLabels(labels: Label[]): Label[] {
  return [...labels].sort((a, b) => a.position - b.position || a.id - b.id);
}

export function useCreateLabel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: LabelBody) => api.post<Label>('/api/labels', body),
    meta: { errorToast: false },
    onSuccess: (label) => setBoard(qc, (b) => ({ ...b, labels: [...b.labels.filter((l) => l.id !== label.id), label] })),
  });
}

export function useUpdateLabel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: number; patch: UpdateLabelBody }) => api.patch<Label>(`/api/labels/${v.id}`, v.patch),
    meta: { errorToast: false },
    onSuccess: (label) => setBoard(qc, (b) => ({ ...b, labels: b.labels.map((l) => (l.id === label.id ? label : l)) })),
    onError: (err) => {
      if (isApiError(err, 'not_found')) void qc.invalidateQueries({ queryKey: qk.board });
    },
  });
}

/** Deleting a label also removes it from every card (and logs that on each card). */
export function useDeleteLabel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.del(`/api/labels/${id}`),
    onSuccess: (_d, id) => {
      setBoard(qc, (b) => ({
        ...b,
        labels: b.labels.filter((l) => l.id !== id),
        cards: b.cards.map((c) => (c.labelIds.includes(id) ? { ...c, labelIds: c.labelIds.filter((x) => x !== id) } : c)),
      }));
      qc.setQueriesData<CardDetail>({ queryKey: qk.cards }, (c) =>
        c && c.labelIds.includes(id) ? { ...c, labelIds: c.labelIds.filter((x) => x !== id) } : c,
      );
      // Card versions/activity changed server-side; refresh whatever is on screen.
      void qc.invalidateQueries({ queryKey: qk.board });
      void qc.invalidateQueries({ queryKey: qk.cards });
      void qc.invalidateQueries({ queryKey: qk.activities });
      // The server also took it off every request type.
      void qc.invalidateQueries({ queryKey: qk.requestTypes });
    },
    onError: (err) => {
      if (isApiError(err, 'not_found')) void qc.invalidateQueries({ queryKey: qk.board });
    },
  });
}

const REORDER_LABELS_KEY = ['reorderLabels'] as const;

/** PUT /api/labels/order with every label id in the new order. */
export function useReorderLabels() {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: REORDER_LABELS_KEY,
    mutationFn: (ids: number[]) => api.put<Label[]>('/api/labels/order', { ids }),
    scope: { id: 'label-order' },
    onMutate: (ids) => {
      const prev = qc.getQueryData<BoardResponse>(qk.board)?.labels.map((l) => [l.id, l.position] as const);
      setBoard(qc, (b) => ({
        ...b,
        labels: b.labels.map((l) => {
          const i = ids.indexOf(l.id);
          return i < 0 ? l : { ...l, position: i };
        }),
      }));
      return { prev };
    },
    onError: (err, _ids, ctx) => {
      // Revert positions only; a stale label list (400 validation) refetches the board.
      if (ctx?.prev) {
        const prev = new Map(ctx.prev);
        setBoard(qc, (b) => ({ ...b, labels: b.labels.map((l) => ({ ...l, position: prev.get(l.id) ?? l.position })) }));
      }
      if (isApiError(err, 'validation')) void qc.invalidateQueries({ queryKey: qk.board });
    },
    onSuccess: (labels) => {
      // A later reorder is queued behind this one: keep showing it; its response wins.
      if (qc.isMutating({ mutationKey: REORDER_LABELS_KEY }) > 1) return;
      setBoard(qc, (b) => ({ ...b, labels }));
    },
  });
}
