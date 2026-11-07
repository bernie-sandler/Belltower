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
  type LinkDirection,
  type TextPreview,
} from '@tt/shared';
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

  // Ticking a box should feel instant: flip it in the cache first, undo on failure.
  const toggle = useMutation({
    scope: { id: `card-${cardId}-checks` },
    mutationFn: (v: { id: number; checked: boolean }) =>
      api.patch<CardDetail>(`/api/checklist-items/${v.id}`, { checked: v.checked }),
    onMutate: (v) => {
      qc.setQueryData<CardDetail>(qk.card(cardId), (c) =>
        c
          ? {
              ...c,
              checklistDone: c.checklistDone + (v.checked ? 1 : -1),
              checklists: c.checklists.map((l) => ({
                ...l,
                items: l.items.map((i) => (i.id === v.id ? { ...i, checked: v.checked } : i)),
              })),
            }
          : c,
      );
    },
    onSuccess: (card) => {
      applyCardDetail(qc, card);
      invalidateActivity(qc, cardId);
    },
    onError: () => {
      void qc.invalidateQueries({ queryKey: qk.card(cardId) });
    },
  });

  return { addList, renameList, deleteList, addItem, editItem, deleteItem, reorderItems, toggle };
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
