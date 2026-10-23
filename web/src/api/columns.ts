import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { BoardResponse, Column } from '@tt/shared';
import { setBoard } from './board';
import { api, isApiError } from './client';
import { qk } from './keys';

/** The column (or its target) is gone, or the column list is stale: refetch the board. */
function refetchIfStale(qc: QueryClient, err: unknown): void {
  if (isApiError(err, 'not_found') || isApiError(err, 'invalid_target') || isApiError(err, 'validation')) {
    void qc.invalidateQueries({ queryKey: qk.board });
  }
}

export function useCreateColumn() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => api.post<Column>('/api/columns', { name }),
    onSuccess: (col) => setBoard(qc, (b) => ({ ...b, columns: [...b.columns.filter((c) => c.id !== col.id), col] })),
  });
}

export function useRenameColumn() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: number; name: string }) => api.patch<Column>(`/api/columns/${v.id}`, { name: v.name }),
    // One at a time, so the last rename you made is the one that sticks.
    scope: { id: 'column-rename' },
    onMutate: (v) => {
      const prev = qc.getQueryData<BoardResponse>(qk.board)?.columns.find((c) => c.id === v.id)?.name;
      setBoard(qc, (b) => ({ ...b, columns: b.columns.map((c) => (c.id === v.id ? { ...c, name: v.name.trim() } : c)) }));
      return { prev };
    },
    onError: (err, v, ctx) => {
      // Revert only this column's name (a whole-board snapshot would undo unrelated changes).
      const prev = ctx?.prev;
      if (prev !== undefined) {
        setBoard(qc, (b) => ({ ...b, columns: b.columns.map((c) => (c.id === v.id ? { ...c, name: prev } : c)) }));
      }
      refetchIfStale(qc, err);
    },
    onSuccess: (col) => setBoard(qc, (b) => ({ ...b, columns: b.columns.map((c) => (c.id === col.id ? col : c)) })),
  });
}

const REORDER_COLUMNS_KEY = ['reorderColumns'] as const;

/** PUT /api/columns/order with every column id in the new left-to-right order. */
export function useReorderColumns() {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: REORDER_COLUMNS_KEY,
    mutationFn: (ids: number[]) => api.put<Column[]>('/api/columns/order', { ids }),
    scope: { id: 'column-order' },
    onMutate: (ids) => {
      void qc.cancelQueries({ queryKey: qk.board });
      const prev = qc.getQueryData<BoardResponse>(qk.board)?.columns.map((c) => [c.id, c.position] as const);
      setBoard(qc, (b) => ({
        ...b,
        columns: b.columns.map((c) => {
          const i = ids.indexOf(c.id);
          return i < 0 ? c : { ...c, position: i };
        }),
      }));
      return { prev };
    },
    onError: (err, _ids, ctx) => {
      // Revert positions only; a stale column list (400 validation) refetches the board.
      if (ctx?.prev) {
        const prev = new Map(ctx.prev);
        setBoard(qc, (b) => ({ ...b, columns: b.columns.map((c) => ({ ...c, position: prev.get(c.id) ?? c.position })) }));
      }
      refetchIfStale(qc, err);
    },
    onSuccess: (columns) => {
      // A later reorder is queued behind this one: keep showing it; its response wins.
      if (qc.isMutating({ mutationKey: REORDER_COLUMNS_KEY }) > 1) return;
      setBoard(qc, (b) => ({ ...b, columns }));
    },
  });
}

/**
 * DELETE /api/columns/:id. Its cards (including archived/deleted ones the board doesn't show)
 * move to the bottom of `targetColumnId`, so the board is refetched afterwards.
 */
export function useDeleteColumn() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: number; targetColumnId: number | null }) =>
      api.del(`/api/columns/${v.id}${v.targetColumnId ? `?targetColumnId=${v.targetColumnId}` : ''}`),
    meta: { errorToast: false },
    onSuccess: async (_d, v) => {
      setBoard(qc, (b) => ({ ...b, columns: b.columns.filter((c) => c.id !== v.id) }));
      await qc.invalidateQueries({ queryKey: qk.board });
      void qc.invalidateQueries({ queryKey: qk.cards });
      void qc.invalidateQueries({ queryKey: qk.activities });
    },
    // 404 (already deleted elsewhere) / 400 invalid_target (the target was): the dialog shows the
    // message; the refetch shows the current columns.
    onError: (err) => refetchIfStale(qc, err),
  });
}
