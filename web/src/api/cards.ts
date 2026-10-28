import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { ActivityEntry, BoardResponse, CardDetail, MoveCardResponse, UpdateCardBody } from '@tt/shared';
import { toast } from '../lib/toast';
import {
  applyBoardOp,
  applyBoardOps,
  applyCardToBoard,
  applyOrders,
  BOARD_ORDER_KEY,
  BOARD_ORDER_SCOPE,
  currentAnchor,
  flushBoardRefetch,
  moveCardLocally,
  opsAfter,
  removeTile,
  setBoard,
  toTile,
  upsertTile,
  wantBoardRefetch,
} from './board';
import { api, isApiError } from './client';
import { conflictCard, errorMessage } from './errors';
import { qk } from './keys';

export const CONFLICT_MESSAGE = 'This card changed on another device — review and save again';

export function useCard(id: number) {
  return useQuery({
    queryKey: qk.card(id),
    queryFn: ({ signal }) => api.get<CardDetail>(`/api/cards/${id}`, signal),
    enabled: id > 0,
    meta: { errorToast: false },
  });
}

export function useCardActivity(id: number) {
  return useQuery({
    queryKey: qk.activity(id),
    queryFn: ({ signal }) => api.get<ActivityEntry[]>(`/api/cards/${id}/activity`, signal),
    enabled: id > 0,
  });
}

/** Puts a full card returned by the server into both the card cache and the board. */
export function applyCardDetail(qc: QueryClient, card: CardDetail): void {
  qc.setQueryData(qk.card(card.id), card);
  setBoard(qc, (b) => applyCardToBoard(b, card));
}

function invalidateActivity(qc: QueryClient, id: number): void {
  void qc.invalidateQueries({ queryKey: qk.activity(id) });
}

/** The server says the card is no longer on the board (Trash, archive) or doesn't exist. */
function isCardGone(err: unknown): boolean {
  return isApiError(err, 'card_deleted') || isApiError(err, 'card_archived') || isApiError(err, 'not_found');
}

/** Takes such a card off the board; its detail view refetches and shows why. */
function dropGoneCard(qc: QueryClient, id: number): void {
  setBoard(qc, (b) => removeTile(b, id));
  void qc.invalidateQueries({ queryKey: qk.card(id) });
}

function goneMessage(err: unknown, title: string | undefined): string {
  const name = title ? `“${title}”` : 'This card';
  if (isApiError(err, 'card_deleted')) return `${name} was moved to Trash (maybe on another device).`;
  if (isApiError(err, 'card_archived')) return `${name} was archived (maybe on another device).`;
  return `${name} no longer exists.`;
}

function cachedTitle(qc: QueryClient, id: number): string | undefined {
  return (
    qc.getQueryData<CardDetail>(qk.card(id))?.title ??
    qc.getQueryData<BoardResponse>(qk.board)?.cards.find((c) => c.id === id)?.title
  );
}

// ---- create ----

export interface CreateCardVars {
  title: string;
  columnId: number;
  /** Negative id of the optimistic tile shown until the server answers. */
  tempId: number;
}

export function useCreateCard() {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: [...BOARD_ORDER_KEY, 'create'],
    mutationFn: (v: CreateCardVars) => api.post<CardDetail>('/api/cards', { title: v.title, columnId: v.columnId }),
    // Shares the board-order queue with moves, so positions are assigned in the order you act.
    scope: BOARD_ORDER_SCOPE,
    onMutate: (v) => {
      void qc.cancelQueries({ queryKey: qk.board }); // an older in-flight refetch would drop the new tile
      setBoard(qc, (b) => applyBoardOp(b, { kind: 'create', vars: v }));
    },
    onSuccess: (card, v) => {
      qc.setQueryData(qk.card(card.id), card);
      setBoard(qc, (b) => {
        const tile = toTile(card);
        const hasTemp = b.cards.some((c) => c.id === v.tempId);
        if (!hasTemp) return upsertTile(b, tile); // a refetch already replaced the list
        return { ...b, cards: b.cards.filter((c) => c.id !== card.id).map((c) => (c.id === v.tempId ? tile : c)) };
      });
    },
    onError: (err, v) => {
      setBoard(qc, (b) => removeTile(b, v.tempId));
      // 400 invalid_target: the column was deleted on another device (the global toast says so).
      if (isApiError(err, 'invalid_target') || isApiError(err, 'validation')) wantBoardRefetch();
    },
    onSettled: (_d, _e, v) => flushBoardRefetch(qc, v),
  });
}

// ---- update (PATCH) ----

export type CardPatch = Omit<UpdateCardBody, 'expectedVersion'>;

/** Fields that are safe to show optimistically (small, and the editor closes on save). */
function optimisticFields(patch: CardPatch): Partial<CardDetail> {
  const out: Partial<CardDetail> = {};
  if (patch.title !== undefined) out.title = patch.title.trim();
  if (patch.labelIds !== undefined) out.labelIds = patch.labelIds;
  return out;
}

/**
 * PATCH /api/cards/:id. Updates for one card run one at a time (mutation scope), and each sends
 * the latest version the client has seen as expectedVersion. A 409 replaces the cached card with
 * the server's copy; editors keep their drafts and the user can review and save again.
 */
export function useUpdateCard(id: number) {
  const qc = useQueryClient();
  const mutationKey = ['updateCard', id] as const;
  return useMutation({
    mutationKey,
    scope: { id: `card-${id}` },
    meta: { errorToast: false },
    mutationFn: (patch: CardPatch) => {
      const current =
        qc.getQueryData<CardDetail>(qk.card(id)) ??
        qc.getQueryData<BoardResponse>(qk.board)?.cards.find((c) => c.id === id);
      const body: UpdateCardBody = { ...patch, expectedVersion: current?.version ?? 0 };
      return api.patch<CardDetail>(`/api/cards/${id}`, body);
    },
    onMutate: (patch) => {
      const fields = optimisticFields(patch);
      if (Object.keys(fields).length === 0) return;
      qc.setQueryData<CardDetail>(qk.card(id), (c) => (c ? { ...c, ...fields } : c));
      setBoard(qc, (b) => ({ ...b, cards: b.cards.map((c) => (c.id === id ? { ...c, ...fields } : c)) }));
    },
    onSuccess: (card, patch) => {
      if (patch.parentId !== undefined || patch.kind !== undefined) {
        // Filing under (or out of) a work card changes that card's ticket list and the board groups.
        void qc.invalidateQueries({ queryKey: qk.cards });
        void qc.invalidateQueries({ queryKey: qk.activities });
        void qc.invalidateQueries({ queryKey: qk.board });
      }
      // If more edits to this card are queued, keep their optimistic values and only take the
      // new version (the next request needs it); the last response wins in full.
      const pending = qc.isMutating({ mutationKey });
      if (pending > 1) {
        qc.setQueryData<CardDetail>(qk.card(id), (c) => (c ? { ...c, version: card.version } : card));
        setBoard(qc, (b) => ({ ...b, cards: b.cards.map((c) => (c.id === id ? { ...c, version: card.version } : c)) }));
      } else {
        applyCardDetail(qc, card);
      }
    },
    onError: (err) => {
      const serverCard = conflictCard(err);
      if (serverCard) {
        applyCardDetail(qc, serverCard);
        toast(CONFLICT_MESSAGE, { kind: 'warning' });
        return;
      }
      if (isApiError(err, 'unauthenticated')) return; // the login page takes over
      if (isCardGone(err)) {
        // 409 card_deleted (it is in Trash) or 404.
        const title = cachedTitle(qc, id);
        dropGoneCard(qc, id);
        toast(goneMessage(err, title), { kind: 'warning' });
        return;
      }
      // Undo optimistic values by refetching the truth.
      void qc.invalidateQueries({ queryKey: qk.card(id) });
      void qc.invalidateQueries({ queryKey: qk.board });
      toast(errorMessage(err), { kind: 'error' });
    },
    onSettled: () => invalidateActivity(qc, id),
  });
}

// ---- move ----

export interface MoveVars {
  cardId: number;
  toColumnId: number;
  /** The visible card directly above the destination; null = top. */
  afterCardId: number | null;
}

/** Where a card was before a move: its server-side place, as far as the client knows. */
interface MoveOrigin {
  columnId: number;
  afterCardId: number | null;
  completedAt: string | null;
  title: string;
}

const moveOrigins = new WeakMap<MoveVars, MoveOrigin>();

/** Codes that mean the client's board is out of date: refetch it. */
function isStaleBoard(err: unknown): boolean {
  return isApiError(err, 'anchor_not_found') || isApiError(err, 'invalid_target') || isApiError(err, 'validation');
}

/**
 * POST /api/cards/:id/move with an optimistic board update. Moves (and creates) share one queue,
 * so rapid drags reach the server in order. Each response's authoritative orders are written back
 * without a refetch, and the moves still queued behind it are re-applied on top.
 */
export function useMoveCard() {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: [...BOARD_ORDER_KEY, 'move'],
    scope: BOARD_ORDER_SCOPE,
    meta: { errorToast: false },
    mutationFn: (v: MoveVars) =>
      api.post<MoveCardResponse>(`/api/cards/${v.cardId}/move`, {
        toColumnId: v.toColumnId,
        afterCardId: v.afterCardId,
      }),
    // Runs synchronously inside mutate() (even when queued), so the cache already holds the new
    // order when the drop renders.
    onMutate: (v) => {
      void qc.cancelQueries({ queryKey: qk.board });
      const board = qc.getQueryData<BoardResponse>(qk.board);
      const tile = board?.cards.find((c) => c.id === v.cardId);
      if (!board || !tile) return;
      moveOrigins.set(v, {
        columnId: tile.columnId,
        afterCardId: currentAnchor(board, v.cardId),
        completedAt: tile.completedAt,
        title: tile.title,
      });
      qc.setQueryData(qk.board, moveCardLocally(board, v.cardId, v.toColumnId, v.afterCardId));
    },
    onSuccess: (res, v) => {
      const later = opsAfter(qc, v);
      const movedAgain = new Set(later.flatMap((op) => (op.kind === 'move' ? [op.vars.cardId] : [])));
      let consistent = true;
      setBoard(qc, (b) => {
        const result = applyOrders(b, res.orders, res.card, movedAgain);
        consistent = result.consistent;
        return applyBoardOps(result.board, later);
      });
      if (!movedAgain.has(v.cardId)) {
        qc.setQueryData<CardDetail>(qk.card(v.cardId), (c) => (c ? { ...c, ...res.card } : c));
      }
      if (!consistent) wantBoardRefetch(); // the cache disagreed with the server (another device?)
      if (res.card.linkCount > 0) {
        // Finishing (or reopening) a blocker changes the "blocked" state of the cards it blocks.
        wantBoardRefetch();
        void qc.invalidateQueries({ queryKey: qk.cards });
      }
    },
    onError: (err, v) => {
      const later = opsAfter(qc, v);
      const gone = isCardGone(err);
      const origin = moveOrigins.get(v);
      // Put just this card back where the server still has it, then re-apply the queued moves.
      // (Restoring a whole-board snapshot would also undo the moves queued behind this one, or
      // re-apply a failed earlier one, and anything else that changed meanwhile.)
      setBoard(qc, (b) => {
        let next = b;
        if (gone) {
          next = removeTile(next, v.cardId);
        } else if (origin) {
          next = moveCardLocally(next, v.cardId, origin.columnId, origin.afterCardId);
          next = {
            ...next,
            cards: next.cards.map((c) => (c.id === v.cardId ? { ...c, completedAt: origin.completedAt } : c)),
          };
        }
        return applyBoardOps(next, later);
      });
      // Queued moves of the same card started from where this one would have left it.
      if (origin) {
        for (const op of later) if (op.kind === 'move' && op.vars.cardId === v.cardId) moveOrigins.set(op.vars, origin);
      }

      if (isApiError(err, 'unauthenticated')) return; // the login page takes over
      if (gone) {
        // 409 card_deleted / card_archived (another device), 404 not_found.
        void qc.invalidateQueries({ queryKey: qk.card(v.cardId) });
        wantBoardRefetch();
        toast(goneMessage(err, origin?.title), { kind: 'warning' });
      } else if (isApiError(err, 'blocked')) {
        // 409 blocked: a blocker is still open (the board may not have known yet).
        wantBoardRefetch();
        toast(errorMessage(err), { kind: 'warning' });
      } else if (isStaleBoard(err)) {
        // 400 anchor_not_found / invalid_target.
        wantBoardRefetch();
        toast('Move failed: the board was out of date and has been refreshed.', { kind: 'error' });
      } else {
        toast(`Move failed. ${errorMessage(err)}`, { kind: 'error' });
      }
    },
    onSettled: (_d, _e, v) => {
      invalidateActivity(qc, v.cardId);
      flushBoardRefetch(qc, v);
    },
  });
}

// ---- work cards ----

export interface StuckCard {
  id: number;
  ticketNo: string | null;
  title: string;
  blockers: { id: number; title: string }[];
}

/** Cards a 409 `blocked` from /complete says couldn't be completed (and why). */
export function stuckCards(err: unknown): StuckCard[] | null {
  if (!isApiError(err, 'blocked')) return null;
  const stuck = (err.body as { stuck?: StuckCard[] } | null)?.stuck;
  return Array.isArray(stuck) ? stuck : null;
}

/** Mark done, optionally with every open ticket filed under the work card. */
export function useCompleteCard() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: number; includeChildren: boolean; resolution?: { reason: string; note: string } }) =>
      api.post<{ card: CardDetail; orders: Record<string, number[]>; completed: number[] }>(`/api/cards/${v.id}/complete`, {
        includeChildren: v.includeChildren,
        ...(v.resolution ? { resolution: v.resolution } : {}),
      }),
    meta: { errorToast: false },
    onSuccess: (res) => {
      applyCardDetail(qc, res.card);
      for (const id of res.completed) invalidateActivity(qc, id);
      void qc.invalidateQueries({ queryKey: qk.board });
      void qc.invalidateQueries({ queryKey: qk.cards });
    },
  });
}

/**
 * Sets (or with null clears) how a done card was resolved. Opened from a toast or the card view,
 * so it reads the card's current version first.
 */
export function useSetResolution() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: { cardId: number; resolution: { reason: string; note: string } | null }) => {
      const current = await api.get<CardDetail>(`/api/cards/${v.cardId}`);
      return api.patch<CardDetail>(`/api/cards/${v.cardId}`, { expectedVersion: current.version, resolution: v.resolution });
    },
    meta: { errorToast: false },
    onSuccess: (card) => {
      applyCardDetail(qc, card);
      invalidateActivity(qc, card.id);
      void qc.invalidateQueries({ queryKey: qk.cards });
    },
  });
}

/**
 * Files a card under a work card (or takes it out with null). Used from the other card's view, so
 * it reads that card's current version first instead of relying on a cached copy.
 */
export function useSetParent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: { cardId: number; parentId: number | null }) => {
      const current = await api.get<CardDetail>(`/api/cards/${v.cardId}`);
      return api.patch<CardDetail>(`/api/cards/${v.cardId}`, { expectedVersion: current.version, parentId: v.parentId });
    },
    onSuccess: (card, v) => {
      applyCardDetail(qc, card);
      invalidateActivity(qc, card.id);
      if (v.parentId !== null) invalidateActivity(qc, v.parentId);
      void qc.invalidateQueries({ queryKey: qk.board });
      void qc.invalidateQueries({ queryKey: qk.cards });
    },
  });
}

// ---- delete / restore ----

export function useDeleteCard() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.del(`/api/cards/${id}`),
    onSuccess: (_d, id) => {
      const linked = (qc.getQueryData<BoardResponse>(qk.board)?.cards.find((c) => c.id === id)?.linkCount ?? 0) > 0;
      setBoard(qc, (b) => removeTile(b, id));
      // A trashed blocker no longer blocks anything.
      if (linked) void qc.invalidateQueries({ queryKey: qk.board });
      qc.setQueryData<CardDetail>(qk.card(id), (c) => (c ? { ...c, deletedAt: new Date().toISOString() } : c));
      void qc.invalidateQueries({ queryKey: qk.card(id) }); // the server's deletedAt
      void qc.invalidateQueries({ queryKey: qk.cardLists });
      invalidateActivity(qc, id);
    },
    onError: (err, id) => {
      // 404: it no longer exists at all (the global toast says so).
      if (isApiError(err, 'not_found')) {
        dropGoneCard(qc, id);
        void qc.invalidateQueries({ queryKey: qk.board });
      }
    },
  });
}

/** POST /api/cards/:id/undelete (out of Trash) or /restore (out of the archive). */
export function useRestoreCard(kind: 'undelete' | 'restore') {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.post<CardDetail>(`/api/cards/${id}/${kind}`),
    onSuccess: (card) => {
      applyCardDetail(qc, card);
      invalidateActivity(qc, card.id);
      void qc.invalidateQueries({ queryKey: qk.cardLists });
      if (card.linkCount > 0) void qc.invalidateQueries({ queryKey: qk.board }); // it may block cards again
    },
    onError: (_err, id) => {
      // e.g. 409 card_deleted when restoring from the archive: show the card's real state.
      void qc.invalidateQueries({ queryKey: qk.card(id) });
      void qc.invalidateQueries({ queryKey: qk.board });
    },
  });
}
