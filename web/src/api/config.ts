import { useQuery } from '@tanstack/react-query';
import type { AppConfig } from '@tt/shared';
import { api } from './client';
import { qk } from './keys';
import { useIsAdmin } from './me';

export function useConfig() {
  return useQuery({
    queryKey: qk.config,
    queryFn: ({ signal }) => api.get<AppConfig>('/api/config', signal),
    staleTime: 60_000,
    // Also poll occasionally so a desktop tab left open notices an app update.
    refetchInterval: 10 * 60_000,
  });
}

/**
 * Settings → General → Teams: assignees, Mine and Unassigned, watching, @mentions and the bell.
 * False until /api/config has loaded (the app shell waits for it), so nothing flashes on a solo install.
 */
export function useTeams(): boolean {
  return useConfig().data?.teams === true;
}

/**
 * Whether there's a bell (and a sound for it under Settings → Appearance). With Teams on, always.
 * With Teams off it only ever holds new submit-page tickets, which go to admins: so only for
 * admins, and only while the submit page is on.
 */
export function useBellShown(): boolean {
  const config = useConfig().data;
  const isAdmin = useIsAdmin();
  if (!config) return false;
  return config.teams || (isAdmin && config.submitPageEnabled);
}
