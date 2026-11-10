// Mine (/mine) and Unassigned (/triage): open cards from the board query, most urgent first, then
// oldest. Each card shows its column and the board's badges and opens over the page; Unassigned
// has "Take it" on every card.

import type { CardTile, Column, Label } from '@tt/shared';
import { Hand, Inbox, UserRoundCheck } from 'lucide-react';
import { useMemo } from 'react';
import { Link } from 'react-router';
import { useTakeCard } from '../../api/assignees';
import { useBoard } from '../../api/board';
import { errorMessage } from '../../api/errors';
import { useMe } from '../../api/me';
import { mineCards, unassignedCards } from '../../lib/assignees';
import { useOpenCard } from '../../lib/navigation';
import { useNow } from '../../lib/time';
import { ErrorScreen, LoadingScreen } from '../common/Status';
import { TileView } from '../board/Tile';

type Kind = 'mine' | 'unassigned';

const COPY: Record<Kind, { title: string; intro: string; icon: typeof Inbox }> = {
  mine: { title: 'Mine', intro: 'Open cards assigned to you, most urgent first.', icon: UserRoundCheck },
  unassigned: {
    title: 'Unassigned',
    intro: 'Open cards nobody has taken yet, from every column: most urgent first, then oldest.',
    icon: Inbox,
  },
};

export function QueuePage({ kind }: { kind: Kind }) {
  const { data: board, error, isPending, refetch } = useBoard();
  const me = useMe();
  const meId = me.data?.id ?? null;
  const now = useNow();
  const openCard = useOpenCard();
  const cards = useMemo(() => {
    if (!board) return [];
    if (kind === 'unassigned') return unassignedCards(board);
    return meId === null ? [] : mineCards(board, meId);
  }, [board, kind, meId]);
  const columnsById = useMemo(() => new Map((board?.columns ?? []).map((c) => [c.id, c] as const)), [board?.columns]);
  const labelsById = useMemo(() => new Map((board?.labels ?? []).map((l) => [l.id, l] as const)), [board?.labels]);

  // Until we know who "me" is, there's no list to show (not "nothing is assigned to you").
  if (isPending || me.isPending) return <LoadingScreen label="Loading cards…" />;
  if (!board || meId === null) {
    return (
      <ErrorScreen
        title="Couldn't load the cards"
        message={errorMessage(error ?? me.error)}
        onRetry={() => {
          void refetch();
          void me.refetch();
        }}
      />
    );
  }
  const { title, intro, icon: Icon } = COPY[kind];

  return (
    <div className="list-page queue-page">
      <header className="list-page-header">
        <h2 className="list-page-title">
          <Icon size={20} aria-hidden /> {title}
          <span className="muted small">({cards.length})</span>
        </h2>
      </header>
      <p className="muted queue-intro">{intro}</p>
      {cards.length === 0 ? (
        <p className="muted">
          {kind === 'mine' ? (
            <>
              Nothing is assigned to you. Pick something from <Link to="/triage">Unassigned</Link>.
            </>
          ) : (
            'Every open card has someone.'
          )}
        </p>
      ) : (
        <ul className="queue-list" aria-label={`${title} cards`}>
          {cards.map((tile) => (
            <QueueRow
              key={tile.id}
              tile={tile}
              column={columnsById.get(tile.columnId)}
              labelsById={labelsById}
              now={now}
              meId={kind === 'unassigned' ? meId : null}
              onOpen={openCard}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function QueueRow({
  tile,
  column,
  labelsById,
  now,
  meId,
  onOpen,
}: {
  tile: CardTile;
  column: Column | undefined;
  labelsById: Map<number, Label>;
  now: number;
  /** Set on Unassigned: shows "Take it" for this person. */
  meId: number | null;
  onOpen: (id: number) => void;
}) {
  return (
    <li className="queue-row" data-card-id={tile.id}>
      <button type="button" className="queue-open" onClick={() => onOpen(tile.id)}>
        <span className="queue-column">{column?.name ?? 'Unknown column'}</span>
        <TileView tile={tile} labelsById={labelsById} now={now} />
      </button>
      {meId !== null && <TakeButton tile={tile} meId={meId} />}
    </li>
  );
}

function TakeButton({ tile, meId }: { tile: CardTile; meId: number }) {
  const take = useTakeCard(tile, meId);
  return (
    <button
      type="button"
      className="btn btn-sm btn-primary queue-take"
      aria-label={`Take it: “${tile.title}”`}
      disabled={take.isPending}
      onClick={() => take.mutate()}
    >
      <Hand size={14} aria-hidden /> {take.isPending ? 'Taking…' : 'Take it'}
    </button>
  );
}
