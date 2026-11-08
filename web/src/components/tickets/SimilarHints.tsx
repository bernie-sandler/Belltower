// Add ticket: while the title is being typed, finished tickets that look like it ("Seen this
// before?"), so you can check an old fix before filing the same problem again. Each opens in a new
// tab, so the ticket being written isn't lost.

import type { SimilarTicket } from '@tt/shared';
import { History } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useHref } from 'react-router';
import { useSimilarForText } from '../../api/phase3';
import { TicketTitle } from '../common/TicketTitle';

const DEBOUNCE_MS = 400;
const SHOWN = 3;

/** Two words or more: a single word matches too much to be useful. */
const enoughWords = (title: string) => title.trim().split(/\s+/).filter(Boolean).length >= 2;

export function SimilarHints({ title, description }: { title: string; description: string }) {
  const [typed, setTyped] = useState({ title: '', description: '' });
  useEffect(() => {
    const t = window.setTimeout(() => setTyped({ title: title.trim(), description: description.trim() }), DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [title, description]);
  const ready = enoughWords(typed.title);
  const { data } = useSimilarForText(typed.title, typed.description, ready);
  if (!ready || !enoughWords(title) || !data?.length) return null;
  return (
    <div className="similar-hints small" role="note" aria-label="Seen this before?">
      <span className="muted">
        <History size={14} aria-hidden /> Seen this before?
      </span>
      <ul>
        {data.slice(0, SHOWN).map((s) => (
          <Hint key={s.id} similar={s} />
        ))}
      </ul>
    </div>
  );
}

function Hint({ similar: s }: { similar: SimilarTicket }) {
  const href = useHref(`/cards/${s.id}`);
  const ending = [s.resolution, s.note].filter(Boolean).join(': ');
  return (
    <li>
      <a href={href} target="_blank" rel="noreferrer">
        <TicketTitle ticketNo={s.ticketNo}>{s.title}</TicketTitle>
      </a>
      {ending && <span className="muted"> · {ending}</span>}
    </li>
  );
}
