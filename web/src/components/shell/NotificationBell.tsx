// The bell in the top bar: how many notifications you haven't read, and the list. Opening one
// opens its card and marks it read; "Mark all read" clears the count. It polls every 30 seconds,
// background tabs included, and when the count goes up (never for what was already there when the
// page loaded) it plays the sound chosen for this device and tells screen readers what's new.

import type { NotificationItem, NotificationsResponse } from '@tt/shared';
import { useQueryClient } from '@tanstack/react-query';
import { Bell, CheckCheck } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useConfig, useTeams } from '../../api/config';
import { qk } from '../../api/keys';
import { useMarkNotificationsRead, useNotifications } from '../../api/notifications';
import { cls } from '../../lib/cls';
import { useOpenCard } from '../../lib/navigation';
import { canPlay, claimNotification, playSound } from '../../lib/sound';
import { formatDateTime, useNow } from '../../lib/time';
import { Popover } from '../common/Popover';

/** Tabs wait up to this long before claiming a new notification's sound, so two tabs polling at once rarely both play. */
export const CLAIM_JITTER_MS = 300;

/**
 * When the unread count rises above the last one seen (and there's a newer notification): plays
 * the sound in one tab only, and calls `onNew` with the new unread items. The first answer only
 * sets the baseline, and so does the first after the list was reset or Teams was turned on or off,
 * here or anywhere else (that changes what the list holds, which isn't news).
 */
export function useRingOnNew(data: NotificationsResponse | undefined, onNew?: (fresh: NotificationItem[]) => void): void {
  const baseline = useRef<{ unread: number; latestId: number; teams: boolean } | null>(null);
  const onNewRef = useRef(onNew);
  onNewRef.current = onNew;
  useEffect(() => {
    if (!data) {
      baseline.current = null;
      return;
    }
    const before = baseline.current;
    baseline.current = { unread: data.unread, latestId: data.latestId, teams: data.teams };
    if (!before || before.teams !== data.teams || data.unread <= before.unread || data.latestId <= before.latestId) return;
    onNewRef.current?.(data.items.filter((n) => n.id > before.latestId && !n.readAt));
    const id = data.latestId;
    // Not cancelled when the data changes meanwhile (marking something read shouldn't swallow it).
    setTimeout(() => {
      // A tab that can't make a sound (audio not unlocked yet) leaves the claim to one that can.
      if (canPlay() && claimNotification(id)) playSound();
    }, Math.random() * CLAIM_JITTER_MS);
  }, [data]);
}

/** What a screen reader hears when something new arrives. */
function announce(fresh: NotificationItem[], unread: number): string {
  if (fresh.length === 1) return `New notification: ${fresh[0]!.text}, on ${fresh[0]!.cardTitle}`;
  return `${fresh.length || 'Some'} new notifications; ${unread} unread`;
}

const countText = (n: number) => (n > 99 ? '99+' : String(n));

/**
 * The bell's poll also says whether Teams is on. When that differs from /api/config (an admin
 * switched it in another tab or browser), the app shell reloads it, so the nav and the bell follow
 * within one poll.
 */
function useFollowTeams(data: NotificationsResponse | undefined): void {
  const qc = useQueryClient();
  const listTeams = data?.teams;
  const configTeams = useConfig().data?.teams;
  useEffect(() => {
    if (listTeams !== undefined && configTeams !== undefined && listTeams !== configTeams) void qc.invalidateQueries({ queryKey: qk.config });
  }, [listTeams, configTeams, qc]);
}

export function NotificationBell() {
  const { data } = useNotifications();
  useFollowTeams(data);
  const [announcement, setAnnouncement] = useState('');
  useRingOnNew(data, (fresh) => setAnnouncement(announce(fresh, data?.unread ?? fresh.length)));
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
      <span className="visually-hidden" aria-live="polite" data-testid="bell-announcement">
        {announcement}
      </span>
      {anchor && <NotificationPanel anchor={anchor} data={data} onClose={() => setAnchor(null)} />}
    </>
  );
}

function NotificationPanel({ anchor, data, onClose }: { anchor: HTMLElement; data: NotificationsResponse | undefined; onClose: () => void }) {
  const markRead = useMarkNotificationsRead();
  const openCard = useOpenCard();
  const now = useNow();
  const teams = useTeams();
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
          {teams
            ? 'Nothing yet. You’ll hear here when you’re assigned a card, @mentioned in a note, or something changes on a card you watch.'
            : 'Nothing yet. You’ll hear here when a new ticket comes in through the submit page.'}
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
