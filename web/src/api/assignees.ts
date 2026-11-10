// Assignees: who a card's assignee is (from the people directory), and "Take it".

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { BoardResponse, CardDetail, CardTile, UpdateCardBody, UserInfo } from '@tt/shared';
import { toast } from '../lib/toast';
import { applyCardDetail } from './cards';
import { api } from './client';
import { conflictCard, errorMessage } from './errors';
import { qk } from './keys';

/** One person from the directory (the same query as useUsers), or undefined while loading or unknown. */
export function usePerson(id: number | null): UserInfo | undefined {
  return useQuery({
    queryKey: qk.users,
    queryFn: ({ signal }) => api.get<UserInfo[]>('/api/users', signal),
    staleTime: 60_000,
    select: (users) => (id === null ? undefined : users.find((u) => u.id === id)),
  }).data;
}

/** The newest version the client knows for a card: the one the next PATCH must name. */
function knownVersion(qc: ReturnType<typeof useQueryClient>, tile: CardTile): number {
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
    onError: (err) => {
      const server = conflictCard(err);
      if (server) {
        applyCardDetail(qc, server);
        const winner = server.assigneeId !== null && server.assigneeId !== meId ? qc.getQueryData<UserInfo[]>(qk.users)?.find((u) => u.id === server.assigneeId) : undefined;
        if (server.assigneeId === meId) toast(`“${server.title}” is already yours`, { kind: 'info' });
        else if (server.assigneeId !== null) toast(`Someone else took it${winner ? `: ${winner.displayName}` : ''}`, { kind: 'warning' });
        else toast(`“${server.title}” changed meanwhile; check it and try again`, { kind: 'warning' });
      } else {
        toast(errorMessage(err), { kind: 'error' });
      }
      void qc.invalidateQueries({ queryKey: qk.board });
    },
  });
}
