// Which work-card groups are collapsed on the board. Per browser (a viewing preference), kept in
// localStorage; falls back to memory when storage is unavailable (private mode, blocked data).

import { useCallback, useState } from 'react';

const KEY = 'tt-collapsed-groups';

function load(): Set<number> {
  try {
    const raw = window.localStorage.getItem(KEY);
    const ids = raw ? (JSON.parse(raw) as unknown) : [];
    return new Set(Array.isArray(ids) ? ids.filter((n): n is number => Number.isInteger(n)) : []);
  } catch {
    return new Set();
  }
}

function save(ids: Set<number>): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify([...ids]));
  } catch {
    /* storage unavailable: the state still lasts for this page load */
  }
}

/** The collapsed work cards (by id) and a toggle. */
export function useCollapsedGroups(): [Set<number>, (workCardId: number) => void] {
  const [collapsed, setCollapsed] = useState(load);
  const toggle = useCallback((id: number) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      save(next);
      return next;
    });
  }, []);
  return [collapsed, toggle];
}
