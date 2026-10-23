import { History } from 'lucide-react';
import { useCardActivity } from '../../api/cards';
import { errorMessage } from '../../api/errors';
import { cls } from '../../lib/cls';
import { formatDateTime, useNow } from '../../lib/time';
import { Spinner } from '../common/Status';
import { activityText } from './activityText';

/** Read-only card history, newest first (the server already orders it). */
export function ActivityList({ cardId }: { cardId: number }) {
  const { data, error, isPending, refetch } = useCardActivity(cardId);
  const now = useNow();

  return (
    <section className="card-section" aria-labelledby="card-activity-heading">
      <h3 id="card-activity-heading" className="card-section-title">
        <History size={16} aria-hidden /> Activity
      </h3>
      {isPending && <Spinner label="Loading activity…" />}
      {!isPending && !data && (
        <p className="muted">
          {errorMessage(error)}{' '}
          <button type="button" className="link-btn" onClick={() => void refetch()}>
            Retry
          </button>
        </p>
      )}
      {data && data.length === 0 && <p className="muted">No activity yet.</p>}
      {data && data.length > 0 && (
        <ol className="activity-list">
          {data.map((entry) => (
            <li
              key={entry.id}
              className={cls('activity-item', entry.kind === 'worklog' && 'is-worklog', entry.retractedAt && 'is-retracted')}
            >
              <div className="activity-line">
                <span className="activity-text">{activityText(entry)}</span>
                <time className="activity-time" dateTime={entry.occurredAt}>
                  {formatDateTime(entry.occurredAt, now)}
                </time>
              </div>
              {entry.kind === 'worklog' && entry.bodyMd && !entry.retractedAt && (
                <p className="activity-body">{entry.bodyMd}</p>
              )}
              {entry.retractedAt && <p className="activity-note">Retracted</p>}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
