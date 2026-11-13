// Managing people (admins): POST /api/users and PATCH /api/users/:id. The directory and your own
// profile are in me.ts.

import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { CreateUserBody, UpdateUserBody, UserInfo } from '@tt/shared';
import { ApiError, api } from './client';
import { errorMessage } from './errors';
import { qk } from './keys';

/** What the people API's refusals mean, in words for the admin who hit them. */
export function peopleErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    switch (err.code) {
      case 'owner_protected':
        return 'The owner always stays an active admin, and only the owner changes their password (under Account).';
      case 'last_admin':
        return 'At least one active admin has to remain. Make someone else an admin first.';
      case 'cannot_disable_self':
        return 'You can’t deactivate your own account. Another admin can.';
      case 'use_account_password':
        return 'Change your own password under Account → Password; it asks for your current one.';
      case 'managed_by_env':
        return 'The owner’s password is set by APP_PASSWORD in the container’s environment. Change it there and restart.';
      case 'user_changed':
        return 'This person changed meanwhile (was a backup restored?). The list has been refreshed; try again.';
      case 'forbidden':
        return 'Only an admin can manage people.';
      case 'cannot_restrict_admin':
        return 'Admins and the owner always see every ticket. Make them a member first.';
      case 'invalid_label':
        return 'One of those tags no longer exists. Reload and pick again.';
      default:
        break;
    }
  }
  return errorMessage(err);
}

function useRefreshPeople() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: qk.users });
    // Token lists show each owner's name and whether they're deactivated; your own entry may have changed.
    void qc.invalidateQueries({ queryKey: qk.tokens });
    void qc.invalidateQueries({ queryKey: qk.me });
    // Card histories show people by display name.
    void qc.invalidateQueries({ queryKey: qk.activities });
  };
}

export function useCreateUser() {
  const refresh = useRefreshPeople();
  return useMutation({
    mutationFn: (body: CreateUserBody) => api.post<UserInfo>('/api/users', body),
    meta: { errorToast: false },
    onSuccess: refresh,
  });
}

export function useUpdateUser() {
  const refresh = useRefreshPeople();
  return useMutation({
    mutationFn: ({ id, ...patch }: UpdateUserBody & { id: number }) => api.patch<UserInfo>(`/api/users/${id}`, patch),
    meta: { errorToast: false },
    onSuccess: refresh,
    // A refusal may mean the list is out of date (someone else changed it, or a restore renumbered people).
    onError: refresh,
  });
}
