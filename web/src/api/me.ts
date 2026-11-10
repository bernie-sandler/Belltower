// You and the people on this install: GET/PATCH /api/me and the directory (GET /api/users).

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { MeResponse, UpdateMeBody, UserInfo } from '@tt/shared';
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

/** Everyone on this install, active first (for pickers, mentions and names in history). */
export function useUsers() {
  return useQuery({
    queryKey: qk.users,
    queryFn: ({ signal }) => api.get<UserInfo[]>('/api/users', signal),
    staleTime: 60_000,
  });
}

export function useUpdateMe() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateMeBody) => api.patch<MeResponse>('/api/me', body),
    meta: { errorToast: false },
    onSuccess: (me) => {
      qc.setQueryData(qk.me, me);
      void qc.invalidateQueries({ queryKey: qk.users });
    },
  });
}
