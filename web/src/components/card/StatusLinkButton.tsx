// Card sidebar → Status link: copies the ticket's public status page address, so you can text it to
// whoever reported the problem. The same link the submit page shows after sending.

import { useQueryClient } from '@tanstack/react-query';
import type { SettingsResponse, StatusLinkInfo } from '@tt/shared';
import { Share2 } from 'lucide-react';
import { useState } from 'react';
import { useHref } from 'react-router';
import { api } from '../../api/client';
import { errorMessage } from '../../api/errors';
import { qk } from '../../api/keys';
import { copyText } from '../../lib/clipboard';
import { toast } from '../../lib/toast';

export function StatusLinkButton({ cardId }: { cardId: number }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  // Resolved through the router so the demo's hash-based addresses come out right; the path itself
  // comes from the server.
  const root = useHref('/');

  async function copy() {
    setBusy(true);
    try {
      const [link, settings] = await Promise.all([
        api.get<StatusLinkInfo>(`/api/cards/${cardId}/status-link`),
        qc.fetchQuery({ queryKey: qk.settings, queryFn: ({ signal }) => api.get<SettingsResponse>('/api/settings', signal), staleTime: 60_000 }),
      ]);
      if (!link.active) {
        toast('Status links only work while the submit page is on. Turn it on in Settings → Submit page.', { kind: 'warning' });
        return;
      }
      const appUrl = settings.general.appUrl;
      const url = new URL(root.replace(/\/$/, '') + link.path, appUrl ? `${appUrl}/` : window.location.href).toString();
      const ok = await copyText(url);
      // "localhost" only works on this computer; the person you send it to needs the real address.
      const local = !appUrl && /^(localhost|127\.|\[::1\])/.test(window.location.hostname);
      if (!ok) toast('Couldn’t copy the status link', { kind: 'warning' });
      else if (local) toast('Status link copied, but it points at localhost. Set the app’s address in Settings → General.', { kind: 'warning' });
      else toast('Status link copied', { kind: 'success' });
    } catch (err) {
      toast(errorMessage(err), { kind: 'error' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <button type="button" className="btn btn-block card-action" disabled={busy} onClick={() => void copy()}>
      <Share2 size={16} aria-hidden /> Status link
    </button>
  );
}
