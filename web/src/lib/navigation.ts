import { useCallback } from 'react';
import { useLocation, useNavigate, type Location } from 'react-router';
import { whenHistoryIdle } from './layers';

/** History state for the background-location pattern: the page the card was opened over. */
export interface RouteState {
  background?: Location;
}

export function backgroundOf(location: Location): Location | undefined {
  const state = location.state as RouteState | null;
  return state?.background;
}

/**
 * Opens /cards/:id over the current page (keeps the existing background when already on a card).
 * Waits for any layer that is closing (a menu, a popover dismissed by this very tap) to drop its
 * history entry first, so the card's entry isn't stacked on top of it.
 */
export function useOpenCard(): (id: number) => void {
  const navigate = useNavigate();
  const location = useLocation();
  return useCallback(
    (id: number) => {
      const background = backgroundOf(location) ?? location;
      whenHistoryIdle(() => {
        void navigate(`/cards/${id}`, { state: { background } satisfies RouteState });
      });
    },
    [navigate, location],
  );
}
