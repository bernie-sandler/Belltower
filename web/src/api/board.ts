// Board query plus pure helpers that transform the cached BoardResponse. All card ordering on
// the client derives from `position` within each column; helpers keep positions dense (0..n).

import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { BoardResponse, CardDetail, CardTile, Column } from '@tt/shared';
import type { CreateCardVars, MoveVars } from './cards';
import { api } from './client';
import { qk } from './keys';

export function useBoard() {
  const qc = useQueryClient();
  return useQuery({
    queryKey: qk.board,
    // A refetch can land while creates/moves are still queued; keep showing them.
    queryFn: async ({ signal }) => withQueuedBoardOps(qc, await api.get<BoardResponse>('/api/board', signal)),
  });
}

/** Updates the cached board if it is loaded. */
export function setBoard(qc: QueryClient, fn: (b: BoardResponse) => BoardResponse): void {
  qc.setQueryData<BoardResponse>(qk.board, (b) => (b ? fn(b) : b));
}

export function sortedColumns(columns: Column[]): Column[] {
  return [...columns].sort((a, b) => a.position - b.position || a.id - b.id);
}

/** Cards grouped by column id, each list sorted by position. Every column gets a list. */
export function groupCards(board: BoardResponse): Map<number, CardTile[]> {
  const map = new Map<number, CardTile[]>();
  for (const col of board.columns) map.set(col.id, []);
  for (const card of board.cards) {
    let list = map.get(card.columnId);
    if (!list) {
      list = [];
      map.set(card.columnId, list);
    }
    list.push(card);
  }
  for (const list of map.values()) list.sort((a, b) => a.position - b.position || a.id - b.id);
  return map;
}

/** The tile subset of a full card. */
export function toTile(card: CardTile | CardDetail): CardTile {
  return {
    id: card.id,
    columnId: card.columnId,
    title: card.title,
    position: card.position,
    priority: card.priority,
    severity: card.severity,
    dueDate: card.dueDate,
    dueTime: card.dueTime,
    completedAt: card.completedAt,
    labelIds: card.labelIds,
    attachmentCount: card.attachmentCount,
    linkCount: card.linkCount,
    checklistDone: card.checklistDone,
    checklistTotal: card.checklistTotal,
    version: card.version,
  };
}

/** Inserts or replaces a tile. */
export function upsertTile(board: BoardResponse, tile: CardTile): BoardResponse {
  const exists = board.cards.some((c) => c.id === tile.id);
  return {
    ...board,
    cards: exists ? board.cards.map((c) => (c.id === tile.id ? tile : c)) : [...board.cards, tile],
  };
}

export function removeTile(board: BoardResponse, id: number): BoardResponse {
  return { ...board, cards: board.cards.filter((c) => c.id !== id) };
}

/** Reflects a full card in the board: archived/deleted cards leave the board. */
export function applyCardToBoard(board: BoardResponse, card: CardDetail): BoardResponse {
  if (card.archivedAt || card.deletedAt) return removeTile(board, card.id);
  return upsertTile(board, toTile(card));
}

/**
 * Applies the server's authoritative order for the columns a move touched. Returns
 * `consistent: false` when the cache disagrees with the server (cards we don't know about, or
 * cards we think are in a column the server didn't list), so the caller can refetch.
 */
export function applyOrders(
  board: BoardResponse,
  orders: Record<string, number[]>,
  tile?: CardTile,
  /** Cards that queued operations will move again: their placement here is not checked. */
  ignore?: ReadonlySet<number>,
): { board: BoardResponse; consistent: boolean } {
  const byId = new Map(board.cards.map((c) => [c.id, c] as const));
  // Only refresh a card we still show: if it was deleted meanwhile, don't bring it back.
  const current = tile ? byId.get(tile.id) : undefined;
  if (tile && current) byId.set(tile.id, { ...current, ...tile });
  let consistent = true;
  for (const [key, ids] of Object.entries(orders)) {
    const columnId = Number(key);
    const listed = new Set(ids);
    ids.forEach((id, index) => {
      const card = byId.get(id);
      if (!card) {
        consistent = false;
        return;
      }
      byId.set(id, { ...card, columnId, position: index });
    });
    for (const card of byId.values()) {
      if (card.columnId === columnId && !listed.has(card.id) && card.id > 0 && !ignore?.has(card.id)) {
        consistent = false;
      }
    }
  }
  return { board: { ...board, cards: [...byId.values()] }, consistent };
}

/**
 * Local (optimistic) version of POST /api/cards/:id/move: removes the card from its column and
 * inserts it after `afterCardId` (top when null) in the target column, renumbering both.
 */
export function moveCardLocally(
  board: BoardResponse,
  cardId: number,
  toColumnId: number,
  afterCardId: number | null,
): BoardResponse {
  const card = board.cards.find((c) => c.id === cardId);
  if (!card || !board.columns.some((c) => c.id === toColumnId)) return board;
  const groups = groupCards(board);
  const from = (groups.get(card.columnId) ?? []).filter((c) => c.id !== cardId);
  const target = toColumnId === card.columnId ? from : (groups.get(toColumnId) ?? []).filter((c) => c.id !== cardId);
  const anchorIndex = afterCardId === null ? -1 : target.findIndex((c) => c.id === afterCardId);
  const insertAt = afterCardId === null ? 0 : anchorIndex >= 0 ? anchorIndex + 1 : target.length;

  const fromRole = board.columns.find((c) => c.id === card.columnId)?.role ?? null;
  const toRole = board.columns.find((c) => c.id === toColumnId)?.role ?? null;
  // Mirror the server's completion rule so due badges update immediately.
  let completedAt = card.completedAt;
  if (toRole === 'done' && fromRole !== 'done') completedAt = completedAt ?? new Date().toISOString();
  if (toRole !== 'done' && fromRole === 'done') completedAt = null;

  const moved: CardTile = { ...card, columnId: toColumnId, completedAt };
  const nextTarget = [...target.slice(0, insertAt), moved, ...target.slice(insertAt)];

  const updated = new Map<number, CardTile>();
  nextTarget.forEach((c, i) => updated.set(c.id, { ...c, columnId: toColumnId, position: i }));
  if (toColumnId !== card.columnId) from.forEach((c, i) => updated.set(c.id, { ...c, position: i }));

  return { ...board, cards: board.cards.map((c) => updated.get(c.id) ?? c) };
}

/**
 * The anchor for "put this card at the bottom of column X": the last visible card there,
 * ignoring the card itself and unsaved (temporary) cards. Null means the column is empty (= top).
 */
export function bottomAnchor(board: BoardResponse, columnId: number, cardId: number): number | null {
  const list = (groupCards(board).get(columnId) ?? []).filter((c) => c.id !== cardId && c.id > 0);
  return list.length ? list[list.length - 1]!.id : null;
}

/** The card currently directly above `cardId` in its column (null = it is first). */
export function currentAnchor(board: BoardResponse, cardId: number): number | null {
  const card = board.cards.find((c) => c.id === cardId);
  if (!card) return null;
  const list = (groupCards(board).get(card.columnId) ?? []).filter((c) => c.id > 0);
  const i = list.findIndex((c) => c.id === cardId);
  return i > 0 ? list[i - 1]!.id : null;
}

// ---- the board-order queue ----
//
// Creates and moves share one mutation scope, so they reach the server one at a time in the order
// you made them, and each one's optimistic change is in the cache at once, stacked on the ones
// before it. Whatever lands in the cache while some are still queued (a response, a rollback, a
// refetch) is followed by re-applying the queued ones, so they never flicker away. Re-applying is
// safe even when the server already did it: a move names a column and an anchor, not an index.

export const BOARD_ORDER_KEY = ['board-order'] as const;
export const BOARD_ORDER_SCOPE = { id: 'board-order' };

export type BoardOp = { kind: 'create'; vars: CreateCardVars } | { kind: 'move'; vars: MoveVars };

/** Queued and in-flight board-order operations, oldest (the one running) first. */
export function queuedBoardOps(qc: QueryClient): BoardOp[] {
  return qc
    .getMutationCache()
    .findAll({ mutationKey: BOARD_ORDER_KEY, status: 'pending' })
    .sort((a, b) => a.mutationId - b.mutationId)
    .flatMap((m): BoardOp[] => {
      const vars = m.state.variables;
      if (vars === undefined) return [];
      return m.options.mutationKey?.[1] === 'create'
        ? [{ kind: 'create', vars: vars as CreateCardVars }]
        : [{ kind: 'move', vars: vars as MoveVars }];
    });
}

/** The operations queued behind `self` (called from `self`'s own callbacks). */
export function opsAfter(qc: QueryClient, self: unknown): BoardOp[] {
  return queuedBoardOps(qc).filter((op) => op.vars !== self);
}

/** The optimistic tile for a card that is being created. */
export function tempTile(board: BoardResponse, v: CreateCardVars): CardTile {
  const list = groupCards(board).get(v.columnId) ?? [];
  const last = list[list.length - 1];
  return {
    id: v.tempId,
    columnId: v.columnId,
    title: v.title,
    position: last ? last.position + 1 : 0,
    priority: null,
    severity: null,
    dueDate: null,
    dueTime: null,
    completedAt: null,
    labelIds: [],
    attachmentCount: 0,
    linkCount: 0,
    checklistDone: 0,
    checklistTotal: 0,
    version: 0,
  };
}

export function applyBoardOp(board: BoardResponse, op: BoardOp): BoardResponse {
  if (op.kind === 'move') return moveCardLocally(board, op.vars.cardId, op.vars.toColumnId, op.vars.afterCardId);
  if (board.cards.some((c) => c.id === op.vars.tempId)) return board;
  return { ...board, cards: [...board.cards, tempTile(board, op.vars)] };
}

export function applyBoardOps(board: BoardResponse, ops: BoardOp[]): BoardResponse {
  return ops.reduce(applyBoardOp, board);
}

/**
 * Fresh server data plus the queued operations. The create that is in flight may already be in
 * the fresh data (a card we didn't know, same column and title); then its temporary tile is left
 * out so it doesn't show twice, and its response swaps in the real card.
 */
export function withQueuedBoardOps(qc: QueryClient, board: BoardResponse): BoardResponse {
  const ops = queuedBoardOps(qc);
  const first = ops[0];
  if (!first) return board;
  if (first.kind === 'create') {
    const known = new Set(qc.getQueryData<BoardResponse>(qk.board)?.cards.map((c) => c.id));
    const arrived = board.cards.some(
      (c) => !known.has(c.id) && c.columnId === first.vars.columnId && c.title === first.vars.title,
    );
    if (arrived) return applyBoardOps(board, ops.slice(1));
  }
  return applyBoardOps(board, ops);
}

/**
 * A full refetch wanted by a failed or inconsistent operation waits until the queue is empty: the
 * operations behind it usually rest on the same stale data, and a refetch mid-queue would briefly
 * drop the create that is in flight. Called from each operation's onSettled.
 */
let boardRefetchWanted = false;

export function wantBoardRefetch(): void {
  boardRefetchWanted = true;
}

export function flushBoardRefetch(qc: QueryClient, self: unknown): void {
  if (!boardRefetchWanted || opsAfter(qc, self).length > 0) return;
  boardRefetchWanted = false;
  void qc.invalidateQueries({ queryKey: qk.board });
}
