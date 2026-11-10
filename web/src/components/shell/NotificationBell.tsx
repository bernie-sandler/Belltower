// The bell in the top bar: how many notifications you haven't read, and the list. Opening one
// opens its card and marks it read; "Mark all read" clears the count. It polls every 30 seconds,
// background tabs included, and plays the sound chosen for this device when the count goes up
// (never for what was already there when the page loaded).

import type { NotificationItem, NotificationsResponse } from '@tt/shared';
import { Bell, CheckCheck } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useMarkNotificationsRead, useNotifications } from '../../api/notifications';
import { cls } from '../../lib/cls';
import { useOpenCard } from '../../lib/navigation';
import { claimNotification, getSound, playSound } from '../../lib/sound';
import { formatDateTime, useNow } from '../../lib/time';
import { Popover } from '../common/Popover';

/** Tabs wait up to this long before claiming a new notification's sound, so two tabs polling at once rarely both play. */
export const CLAIM_JITTER_MS = 300;

/**
 * Plays the sound when the unread count rises above the last one seen (and there's a newer
 * notification), in one tab only. The first answer only sets the baseline.
 */
export function useRingOnNew(data: NotificationsResponse | undefined): void {
  const baseline = useRef<{ unread: number; latestId: number } | null>(null);
  useEffect(() => {
    if (!data) return;
    const before = baseline.current;
    baseline.current = { unread: data.unread, latestId: data.latestId };
    if (!before || data.unread <= before.unread || data.latestId <= before.latestId) return;
    const id = data.latestId;
    // Not cancelled when the data changes meanwhile (marking something read shouldn't swallow it).
    setTimeout(() => {
      if (getSound() !== 'off' && claimNotification(id)) playSound();
    }, Math.random() * CLAIM_JITTER_MS);
  }, [data]);
}

const countText = (n: number) => (n > 99 ? '99+' : String(n));

export function NotificationBell() {
  const { data } = useNotifications();
  useRingOnNew(data);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const unread = data?.unread ?? 0;

  return (
    <>
      <button
        type="button"
        className="icon-btn topbar-bell"
        aria-label={unread ? `Notifications, ${unread} unread` : 'Notifications'}
        aria-haspopup="dialog"
        aria-expanded={anchor !== null}
        onClick={(e) => setAnchor(anchor ? null : e.currentTarget)}
      >
        <Bell size={20} aria-hidden />
        {unread > 0 && (
          <span className="bell-count" aria-hidden data-testid="bell-count">
            {countText(unread)}
          </span>
        )}
      </button>
      {anchor && <NotificationPanel anchor={anchor} data={data} onClose={() => setAnchor(null)} />}
    </>
  );
}

function NotificationPanel({ anchor, data, onClose }: { anchor: HTMLElement; data: NotificationsResponse | undefined; onClose: () => void }) {
  const markRead = useMarkNotificationsRead();
  const openCard = useOpenCard();
  const now = useNow();
  const items = data?.items ?? [];
  const unread = data?.unread ?? 0;

  function open(n: NotificationItem) {
    if (!n.readAt) markRead.mutate({ ids: [n.id] });
    onClose();
    openCard(n.cardId);
  }

  return (
    <Popover anchor={anchor} onClose={onClose} placement="bottom-end" role="dialog" ariaLabel="Notifications" className="bell-panel">
      <div className="bell-head">
        <h2 className="bell-title">Notifications</h2>
        <button type="button" className="btn btn-sm" onClick={() => markRead.mutate({ all: true })} disabled={!unread}>
          <CheckCheck size={14} aria-hidden /> Mark all read
        </button>
      </div>
      {!data && <p className="popover-empty muted">Loading…</p>}
      {data && !items.length && (
        <p className="popover-empty muted">
          Nothing yet. You’ll hear here when you’re assigned a card, @mentioned in a note, or something changes on a card you watch.
        </p>
      )}
      {items.length > 0 && (
        <ul className="bell-list">
          {items.map((n) => (
            <li key={n.id}>
              <button type="button" className={cls('bell-item', !n.readAt && 'is-unread')} onClick={() => open(n)}>
                <span className="bell-item-text">
                  {!n.readAt && <span className="visually-hidden">Unread: </span>}
                  {n.text}
                </span>
                <span className="bell-item-card">
                  {n.ticketNo ? `${n.ticketNo} — ` : ''}
                  {n.cardTitle}
                </span>
                <time className="bell-item-time" dateTime={n.createdAt}>
                  {formatDateTime(n.createdAt, now)}
                </time>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Popover>
  );
}
