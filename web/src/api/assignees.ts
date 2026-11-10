// Assignees: who a card's assignee is (from the people directory), and "Take it".

import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { BoardResponse, CardDetail, CardTile, UpdateCardBody, UserInfo } from '@tt/shared';
import { useEffect } from 'react';
import { toast } from '../lib/toast';
import { applyCardDetail } from './cards';
import { api } from './client';
import { conflictCard, errorMessage } from './errors';
import { qk } from './keys';
import { usersQuery } from './me';

/** Ids the directory has been reloaded for once already, so someone truly gone doesn't cause a loop. */
const reloadedFor = new Set<number>();

/**
 * A card names someone the directory doesn't list (added on another device since it loaded): load
 * it again, once per id.
 */
export function reloadPeopleFor(qc: QueryClient, id: number): void {
  if (reloadedFor.has(id)) return;
  reloadedFor.add(id);
  void qc.invalidateQueries({ queryKey: qk.users });
}

/** One person from the directory, or undefined while loading or unknown (then the directory reloads once). */
export function usePerson(id: number | null): UserInfo | undefined {
  const qc = useQueryClient();
  const q = useQuery({ ...usersQuery, select: (users) => (id === null ? undefined : users.find((u) => u.id === id)) });
  const missing = id !== null && q.isSuccess && q.data === undefined;
  useEffect(() => {
    if (missing) reloadPeopleFor(qc, id);
  }, [missing, id, qc]);
  return q.data;
}

/** A person's name for a message: from the cache, else a fresh directory (they may be new), else null. */
async function personName(qc: QueryClient, id: number): Promise<string | null> {
  const cached = qc.getQueryData<UserInfo[]>(qk.users)?.find((u) => u.id === id);
  if (cached) return cached.displayName;
  try {
    const users = await qc.fetchQuery({ ...usersQuery, staleTime: 0 });
    return users.find((u) => u.id === id)?.displayName ?? null;
  } catch {
    return null;
  }
}

/** The newest version the client knows for a card: the one the next PATCH must name. */
function knownVersion(qc: QueryClient, tile: CardTile): number {
  const detail = qc.getQueryData<CardDetail>(qk.card(tile.id))?.version ?? -1;
  const onBoard = qc.getQueryData<BoardResponse>(qk.board)?.cards.find((c) => c.id === tile.id)?.version ?? -1;
  return Math.max(detail, onBoard, tile.version);
}

/**
 * "Take it": assigns the card to me, but only if it hasn't changed since I saw it (expectedVersion),
 * so two people grabbing the same card can't both get it. The loser sees who won and the lists
 * catch up. Queued with the card's other edits (same scope as useUpdateCard).
 */
export function useTakeCard(tile: CardTile, meId: number) {
  const qc = useQueryClient();
  return useMutation({
    scope: { id: `card-${tile.id}` },
    meta: { errorToast: false },
    mutationFn: () => {
      const body: UpdateCardBody = { assigneeId: meId, expectedVersion: knownVersion(qc, tile) };
      return api.patch<CardDetail>(`/api/cards/${tile.id}`, body);
    },
    onSuccess: (card) => {
      applyCardDetail(qc, card);
      void qc.invalidateQueries({ queryKey: qk.activity(card.id) });
      toast(`You took “${card.title}”`, { kind: 'success', durationMs: 2500 });
    },
    onError: async (err) => {
      void qc.invalidateQueries({ queryKey: qk.board });
      const server = conflictCard(err);
      if (!server) {
        toast(errorMessage(err), { kind: 'error' });
        return;
      }
      applyCardDetail(qc, server);
      if (server.assigneeId === meId) {
        toast(`“${server.title}” is already yours`, { kind: 'info' });
      } else if (server.assigneeId !== null) {
        const winner = await personName(qc, server.assigneeId);
        toast(`Someone else took it${winner ? `: ${winner}` : ''}`, { kind: 'warning' });
      } else {
        toast(`“${server.title}” changed meanwhile; check it and try again`, { kind: 'warning' });
      }
    },
  });
}
