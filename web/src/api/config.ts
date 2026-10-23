import { useQuery } from '@tanstack/react-query';
import type { AppConfig } from '@tt/shared';
import { api } from './client';
import { qk } from './keys';

export function useConfig() {
  return useQuery({
    queryKey: qk.config,
    queryFn: ({ signal }) => api.get<AppConfig>('/api/config', signal),
    staleTime: 60_000,
    // Also poll occasionally so a desktop tab left open notices an app update.
    refetchInterval: 10 * 60_000,
  });
}
