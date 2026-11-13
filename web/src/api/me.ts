// You and the people on this install: GET/PATCH /api/me and the directory (GET /api/users).

import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { MeResponse, UpdateMeBody, UserInfo } from '@tt/shared';
import { useMemo } from 'react';
import type { MentionPeople } from '../lib/markdown';
import { api } from './client';
import { qk } from './keys';

export function useMe() {
  return useQuery({
    queryKey: qk.me,
    queryFn: ({ signal }) => api.get<MeResponse>('/api/me', signal),
    staleTime: 60_000,
  });
}

/** Whether the signed-in person is an admin. False until /api/me has loaded, so admin-only parts never flash for members. */
export function useIsAdmin(): boolean {
  return useMe().data?.role === 'admin';
}

/**
 * Whether the signed-in person is restricted to some tags: they see only tickets with one of them
 * and can't change tags, columns or other board-wide things (the server refuses them anyway).
 */
export function useIsRestricted(): boolean {
  const scope = useMe().data?.tagScope;
  return scope !== undefined && scope !== null;
}

/** Whether `person` may be given a card with these tags (a restricted member needs one of theirs). */
export function canSeeTags(person: Pick<UserInfo, 'tagScope'>, labelIds: readonly number[]): boolean {
  return person.tagScope === null || person.tagScope.some((id) => labelIds.includes(id));
}

/** The people directory query, for useUsers and anything that selects from it (usePerson). */
export const usersQuery = queryOptions({
  queryKey: qk.users,
  queryFn: ({ signal }) => api.get<UserInfo[]>('/api/users', signal),
  staleTime: 60_000,
});

/** Everyone on this install, active first (for pickers, mentions and names in history). */
export function useUsers() {
  return useQuery(usersQuery);
}

/** Active people by lower-case username, for highlighting @mentions in notes (you're marked). */
export function useMentionPeople(): MentionPeople | undefined {
  const { data: users } = useUsers();
  const myId = useMe().data?.id;
  return useMemo(
    () =>
      users ? new Map(users.filter((u) => !u.disabled).map((u) => [u.username.toLowerCase(), { displayName: u.displayName, me: u.id === myId }])) : undefined,
    [users, myId],
  );
}

export function useUpdateMe() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateMeBody) => api.patch<MeResponse>('/api/me', body),
    meta: { errorToast: false },
    onSuccess: (me) => {
      qc.setQueryData(qk.me, me);
      void qc.invalidateQueries({ queryKey: qk.users });
      // Your display name shows in card histories and on tokens.
      void qc.invalidateQueries({ queryKey: qk.activities });
      void qc.invalidateQueries({ queryKey: qk.tokens });
    },
  });
}
