// Phase 2 card parts: checklists, links, attachments, the work log, card lists (link picker,
// Archive, Trash). Every server call that changes a card returns the full CardDetail, which is
// written to the card cache and the board in one go.

import { keepPreviousData, useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import {
  CSRF_HEADER,
  CSRF_VALUE,
  type ActivityEntry,
  type ActivityRevision,
  type CardDetail,
  type CardKind,
  type CardSummary,
  type ChecklistItem,
  type ChecklistItemState,
  type LinkDirection,
  type TextPreview,
} from '@tt/shared';
import { useEffect, useRef, useState } from 'react';
import { itemStateIn, nextState, withItemState } from '../lib/checkState';
import { applyCardDetail } from './cards';
import { api, ApiError } from './client';
import { qk } from './keys';

function invalidateActivity(qc: QueryClient, cardId: number): void {
  void qc.invalidateQueries({ queryKey: qk.activity(cardId) });
}

/** A mutation whose response is the updated card. */
function useCardChange<V>(cardId: number, fn: (v: V) => Promise<CardDetail>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (card) => {
      applyCardDetail(qc, card);
      invalidateActivity(qc, cardId);
    },
    onError: () => {
      void qc.invalidateQueries({ queryKey: qk.card(cardId) });
    },
  });
}

// ---- checklists ----

/** How long an item has to rest after a click before its mark is saved. */
export const MARK_SAVE_DELAY_MS = 600;

interface Mark {
  /** The mark the user picked last. */
  state: ChecklistItemState;
  /** Unfinished work for the item: a burst waiting for its timer, plus saves not yet answered. */
  pending: number;
}

interface Burst {
  /** The mark the item had before the burst's first click. */
  from: ChecklistItemState;
  timer: ReturnType<typeof setTimeout>;
}

export function useChecklistActions(cardId: number) {
  const qc = useQueryClient();
  const addList = useCardChange(cardId, (title: string) => api.post<CardDetail>(`/api/cards/${cardId}/checklists`, { title }));
  const renameList = useCardChange(cardId, (v: { id: number; title: string }) =>
    api.patch<CardDetail>(`/api/checklists/${v.id}`, { title: v.title }),
  );
  const deleteList = useCardChange(cardId, (id: number) => api.del<CardDetail>(`/api/checklists/${id}`));
  const addItem = useCardChange(cardId, (v: { listId: number; text: string }) =>
    api.post<CardDetail>(`/api/checklists/${v.listId}/items`, { text: v.text }),
  );
  const editItem = useCardChange(cardId, (v: { id: number; text: string }) =>
    api.patch<CardDetail>(`/api/checklist-items/${v.id}`, { text: v.text }),
  );
  const deleteItem = useCardChange(cardId, (id: number) => api.del<CardDetail>(`/api/checklist-items/${id}`));
  const reorderItems = useCardChange(cardId, (v: { listId: number; ids: number[] }) =>
    api.put<CardDetail>(`/api/checklists/${v.listId}/items/order`, { ids: v.ids }),
  );

  // Clicking an item cycles its mark (open, ✓, ✗, ~). Each click shows at once, but the mark is
  // saved only after the item rests for MARK_SAVE_DELAY_MS, and not at all if it ended where it
  // started: the activity log is append-only, so clicking through ✓ ✗ ~ mustn't leave three
  // entries. Saves flushed on unmount still settle into these maps after the component is gone.
  const [marks] = useState(() => new Map<number, Mark>());
  const [bursts] = useState(() => new Map<number, Burst>());

  /** The server's card with the marks it hasn't confirmed yet laid over it, so they don't flicker back. */
  const withMarks = (card: CardDetail) => {
    let c = card;
    for (const [id, m] of marks) c = withItemState(c, id, m.state);
    return c;
  };

  const settle = (id: number) => {
    const m = marks.get(id);
    if (m && --m.pending <= 0) marks.delete(id);
  };

  // One scope keeps the saves in click order.
  const saveMark = useMutation({
    scope: { id: `card-${cardId}-checks` },
    mutationFn: (v: { id: number; state: ChecklistItemState }) =>
      api.patch<CardDetail>(`/api/checklist-items/${v.id}`, { state: v.state }),
    onSuccess: (card, v) => {
      settle(v.id);
      applyCardDetail(qc, withMarks(card));
      invalidateActivity(qc, cardId);
    },
    onError: (_err, v) => {
      settle(v.id);
      void qc.invalidateQueries({ queryKey: qk.card(cardId) });
    },
  });

  const flush = (id: number) => {
    const burst = bursts.get(id);
    if (!burst) return;
    clearTimeout(burst.timer);
    bursts.delete(id);
    const m = marks.get(id);
    if (!m) return;
    if (m.state === burst.from) settle(id);
    else saveMark.mutate({ id, state: m.state });
  };

  const cycle = (item: ChecklistItem) => {
    const current = itemStateIn(qc.getQueryData<CardDetail>(qk.card(cardId)), item.id) ?? item.state;
    const state = nextState(current);
    qc.setQueryData<CardDetail>(qk.card(cardId), (c) => (c ? withItemState(c, item.id, state) : c));
    const burst = bursts.get(item.id);
    if (burst) clearTimeout(burst.timer);
    const m = marks.get(item.id) ?? { state, pending: 0 };
    m.state = state;
    if (!burst) m.pending++;
    marks.set(item.id, m);
    bursts.set(item.id, { from: burst?.from ?? current, timer: setTimeout(() => flush(item.id), MARK_SAVE_DELAY_MS) });
  };

  // Closing the card saves waiting marks right away. A flushed burst is gone, so an extra cleanup
  // (StrictMode, Fast Refresh) can only save early: it can't send twice or lose a mark.
  const flushRef = useRef(flush);
  useEffect(() => {
    flushRef.current = flush;
  });
  useEffect(() => () => [...bursts.keys()].forEach((id) => flushRef.current(id)), [bursts]);

  return { addList, renameList, deleteList, addItem, editItem, deleteItem, reorderItems, cycle };
}

// ---- links ----

export function useLinkActions(cardId: number) {
  const qc = useQueryClient();
  const refreshOther = (otherId: number) => void qc.invalidateQueries({ queryKey: qk.card(otherId) });
  const link = useMutation({
    mutationFn: (v: { otherCardId: number; direction: LinkDirection }) =>
      api.post<CardDetail>(`/api/cards/${cardId}/links`, v),
    onSuccess: (card, v) => {
      applyCardDetail(qc, card);
      invalidateActivity(qc, cardId);
      refreshOther(v.otherCardId);
      void qc.invalidateQueries({ queryKey: qk.board }); // link counts, and a newly blocked card may have moved
    },
  });
  const unlink = useMutation({
    mutationFn: (v: { linkId: number; otherCardId: number }) =>
      api.del<CardDetail>(`/api/cards/${cardId}/links/${v.linkId}`),
    onSuccess: (card, v) => {
      applyCardDetail(qc, card);
      invalidateActivity(qc, cardId);
      refreshOther(v.otherCardId);
      void qc.invalidateQueries({ queryKey: qk.board });
    },
  });
  return { link, unlink };
}

// ---- card lists ----

export type CardListStatus = 'board' | 'archived' | 'trashed' | 'live';

export function useCardList(status: CardListStatus, q = '', enabled = true, kind?: CardKind) {
  const params = new URLSearchParams({ status, limit: '200' });
  if (q.trim()) params.set('q', q.trim());
  if (kind) params.set('kind', kind);
  return useQuery({
    queryKey: [...qk.cardList(status, q.trim()), kind ?? 'all'],
    queryFn: ({ signal }) => api.get<CardSummary[]>(`/api/cards?${params}`, signal),
    enabled,
    placeholderData: keepPreviousData,
  });
}

export function useArchiveAllDone() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<{ archived: number }>('/api/cards/archive-done'),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.board });
      void qc.invalidateQueries({ queryKey: qk.cardLists });
      void qc.invalidateQueries({ queryKey: qk.cards });
    },
  });
}

// ---- work log ----

export function useWorklogActions(cardId: number) {
  const qc = useQueryClient();
  const settle = () => {
    invalidateActivity(qc, cardId);
    void qc.invalidateQueries({ queryKey: qk.card(cardId) }); // updatedAt
  };
  const add = useMutation({
    mutationFn: (v: { bodyMd: string; occurredAt?: string }) =>
      api.post<ActivityEntry>(`/api/cards/${cardId}/worklog`, v),
    onSuccess: (entry) => {
      qc.setQueryData<ActivityEntry[]>(qk.activity(cardId), (list) =>
        list ? [entry, ...list].sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || b.id - a.id) : list,
      );
      settle();
    },
  });
  const update = useMutation({
    mutationFn: (v: { id: number; bodyMd?: string; occurredAt?: string; retracted?: boolean }) => {
      const { id, ...body } = v;
      return api.patch<ActivityEntry>(`/api/activity/${id}`, body);
    },
    onSuccess: (entry) => {
      qc.setQueryData<ActivityEntry[]>(qk.activity(cardId), (list) =>
        list ? list.map((e) => (e.id === entry.id ? entry : e)) : list,
      );
      void qc.invalidateQueries({ queryKey: qk.revisions(entry.id) });
      settle();
    },
  });
  return { add, update };
}

export function useRevisions(activityId: number, enabled: boolean) {
  return useQuery({
    queryKey: qk.revisions(activityId),
    queryFn: ({ signal }) => api.get<ActivityRevision[]>(`/api/activity/${activityId}/revisions`, signal),
    enabled,
  });
}

// ---- attachments ----

export function attachmentUrl(id: number, download = false): string {
  return `/api/attachments/${id}${download ? '?download=1' : ''}`;
}

export function useTextPreview(id: number, mode: 'head' | 'tail' | 'full') {
  return useQuery({
    queryKey: qk.textPreview(id, mode),
    queryFn: ({ signal }) => api.get<TextPreview>(`/api/attachments/${id}/text?mode=${mode}`, signal),
    staleTime: Infinity, // an attachment never changes
    meta: { errorToast: false },
  });
}

export function useDeleteAttachment(cardId: number) {
  return useCardChange(cardId, (id: number) => api.del<CardDetail>(`/api/attachments/${id}`));
}

/**
 * Uploads files with XMLHttpRequest (fetch has no upload progress, and a 20 MB photo over Tailscale
 * shouldn't look frozen). Resolves with the updated card.
 */
export function uploadAttachments(
  cardId: number,
  files: File[],
  onProgress: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<CardDetail> {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    for (const f of files) form.append('file', f, f.name);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/cards/${cardId}/attachments`);
    xhr.setRequestHeader(CSRF_HEADER, CSRF_VALUE);
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      let body: unknown = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        body = xhr.responseText;
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(body as CardDetail);
        return;
      }
      const b = body as { error?: string; message?: string } | null;
      reject(new ApiError(xhr.status, b?.error ?? `http_${xhr.status}`, b?.message ?? 'Upload failed', body));
    };
    xhr.onerror = () => reject(new ApiError(0, 'network', "Can't reach Belltower. Check your connection.", null));
    xhr.onabort = () => reject(new DOMException('Upload cancelled', 'AbortError'));
    signal?.addEventListener('abort', () => xhr.abort());
    xhr.send(form);
  });
}

export function useUploadAttachments(cardId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { files: File[]; onProgress: (f: number) => void }) => uploadAttachments(cardId, v.files, v.onProgress),
    onSuccess: (card) => {
      applyCardDetail(qc, card);
      invalidateActivity(qc, cardId);
    },
  });
}

// ---- archive ----

export function useArchiveCard() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.post<CardDetail>(`/api/cards/${id}/archive`),
    onSuccess: (card) => {
      applyCardDetail(qc, card);
      invalidateActivity(qc, card.id);
      void qc.invalidateQueries({ queryKey: qk.cardLists });
    },
  });
}
