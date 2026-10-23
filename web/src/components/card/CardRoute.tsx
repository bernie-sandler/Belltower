// /cards/:id route element (lazy-loaded). Closing goes back in history when the card was opened
// from inside the app (the board sits in `state.background`); for a deep link it replaces the
// entry with the board instead, so Back doesn't reopen the card.

import { useCallback } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router';
import { routeBack, unwindThen } from '../../lib/layers';
import { backgroundOf } from '../../lib/navigation';
import { CardDetailModal } from './CardDetail';

export default function CardRoute() {
  const { id } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const fromApp = backgroundOf(location) !== undefined;
  const cardId = Number(id);

  const close = useCallback(() => {
    if (fromApp) routeBack(1);
    else unwindThen(() => navigate('/', { replace: true }));
  }, [fromApp, navigate]);

  return <CardDetailModal key={cardId} cardId={Number.isInteger(cardId) && cardId > 0 ? cardId : 0} onClose={close} />;
}
