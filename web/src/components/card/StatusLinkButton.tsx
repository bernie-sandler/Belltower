// Card sidebar → Status link: copies the ticket's public status page address, so you can text it to
// whoever reported the problem. The same link the submit page shows after sending.
//
// The link is fetched when the card opens, not on click: Safari only lets a page copy during the
// click itself, and waiting for the server first would use that up.

import { useQuery } from '@tanstack/react-query';
import type { StatusLinkInfo } from '@tt/shared';
import { Share2 } from 'lucide-react';
import { useHref } from 'react-router';
import { api } from '../../api/client';
import { qk } from '../../api/keys';
import { useSettings } from '../../api/settings';
import { copyText } from '../../lib/clipboard';
import { toast } from '../../lib/toast';

export function StatusLinkButton({ cardId }: { cardId: number }) {
  const link = useQuery({
    queryKey: qk.statusLink(cardId),
    queryFn: ({ signal }) => api.get<StatusLinkInfo>(`/api/cards/${cardId}/status-link`, signal),
    staleTime: Infinity,
    meta: { errorToast: false },
  });
  const settings = useSettings();
  // Resolved through the router so the demo's hash-based addresses come out right; the path itself
  // comes from the server.
  const root = useHref('/');

  function copy() {
    if (!link.data || !settings.data) return;
    if (!link.data.active) {
      toast('Status links only work while the submit page is on. Turn it on in Settings → Submit page.', { kind: 'warning' });
      return;
    }
    const appUrl = settings.data.general.appUrl;
    const url = new URL(root.replace(/\/$/, '') + link.data.path, appUrl ? `${appUrl}/` : window.location.href).toString();
    // "localhost" only works on this computer; the person you send it to needs the real address.
    const local = !appUrl && /^(localhost|127\.|\[::1\])/.test(window.location.hostname);
    void copyText(url).then((ok) => {
      if (!ok) toast(`Couldn’t copy. The status link is ${url}`, { kind: 'warning' });
      else if (local) toast('Status link copied, but it points at localhost. Set the app’s address in Settings → General.', { kind: 'warning' });
      else toast('Status link copied', { kind: 'success' });
    });
  }

  return (
    <button type="button" className="btn btn-block card-action" disabled={!link.data || !settings.data} onClick={copy}>
      <Share2 size={16} aria-hidden /> Status link
    </button>
  );
}
