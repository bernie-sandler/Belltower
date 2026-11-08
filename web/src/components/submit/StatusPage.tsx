// A ticket's status page (/submit/status/<id>/<sig>): what the person who reported it sees when they
// open the link from the submit page's thank-you screen. No sign-in, and deliberately little: the
// title, a simple state and the resolution reason. Nothing else from the card.

import { useQuery } from '@tanstack/react-query';
import type { PublicTicketStatus, TicketState } from '@tt/shared';
import { Check } from 'lucide-react';
import { useParams } from 'react-router';
import { api, ApiError } from '../../api/client';
import { errorMessage } from '../../api/errors';
import { cls } from '../../lib/cls';
import { formatDateTime } from '../../lib/time';
import { AuthLayout } from '../auth/AuthLayout';
import { Spinner } from '../common/Status';

/** The viewer isn't signed in, so there's no app time zone to use: show times in theirs. */
const viewerTz = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

const HEADLINE: Record<TicketState, string> = {
  received: 'We’ve got it',
  in_progress: 'Being worked on',
  waiting: 'Waiting on something',
  done: 'Done',
};

const STEPS = ['received', 'in_progress', 'done'] as const;

export function StatusPage() {
  const { id = '', sig = '' } = useParams();
  const status = useQuery({
    queryKey: ['publicStatus', id, sig],
    queryFn: ({ signal }) => api.get<PublicTicketStatus>(`/api/public/status/${encodeURIComponent(id)}/${encodeURIComponent(sig)}`, signal),
    retry: false,
    meta: { errorToast: false },
  });

  if (status.isPending) {
    return (
      <AuthLayout title="Loading…">
        <Spinner />
      </AuthLayout>
    );
  }
  if (!status.data) {
    const missing = status.error instanceof ApiError && status.error.status === 404;
    return (
      <AuthLayout title={missing ? 'This page doesn’t exist' : 'Something went wrong'}>
        <p className="auth-intro">
          {missing ? 'Check the link you were given. If it used to work, ask for a new one.' : errorMessage(status.error)}
        </p>
      </AuthLayout>
    );
  }

  const s = status.data;
  const tz = viewerTz();
  const now = Date.now();
  // Waiting sits where "being worked on" would: it has started, but it's stuck for now.
  const current = s.state === 'waiting' ? 'in_progress' : s.state;
  const reached = STEPS.indexOf(current);
  return (
    <AuthLayout title={HEADLINE[s.state]}>
      <div className="status-ticket">
        <strong className="status-ticket-title">{s.title}</strong>
        {s.ticketNo && <span className="muted small">Ticket <span className="ticket-no">{s.ticketNo}</span></span>}
      </div>
      {/* role="list": Safari drops list semantics from lists styled with list-style: none. */}
      <ol className="status-steps" role="list" aria-label="Progress">
        {STEPS.map((step, i) => (
          <li
            key={step}
            className={cls('status-step', i < reached && 'is-done', i === reached && 'is-current', i === reached && s.state === 'waiting' && 'is-waiting')}
            aria-current={i === reached ? 'step' : undefined}
          >
            <span className="status-step-dot" aria-hidden>
              {(i < reached || (i === reached && step === 'done')) && <Check size={12} />}
            </span>
            {step === 'received' ? 'Received' : step === 'done' ? 'Done' : s.state === 'waiting' ? 'Waiting' : 'Being worked on'}
            {i < reached && <span className="visually-hidden"> (finished)</span>}
          </li>
        ))}
      </ol>
      <p className="auth-intro">{explain(s)}</p>
      <dl className="status-facts small">
        <dt>Sent</dt>
        <dd>{formatDateTime(s.submittedAt, now, tz)}</dd>
        <dt>Last update</dt>
        <dd>{formatDateTime(s.changedAt, now, tz)}</dd>
      </dl>
      <p className="muted small">Keep this link to check again later.</p>
    </AuthLayout>
  );
}

function explain(s: PublicTicketStatus): string {
  switch (s.state) {
    case 'received':
      return 'Your request is in the queue and will be looked at soon.';
    case 'in_progress':
      return 'Your request is being worked on.';
    case 'waiting':
      return 'Work on this is paused until something else is sorted out.';
    case 'done':
      return s.resolution ? `It was closed as “${s.resolution}”.` : 'This has been taken care of.';
  }
}
