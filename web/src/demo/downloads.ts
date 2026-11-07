// Plain links to /api (the backup export buttons, attachment downloads) are navigations, which the
// fetch/XHR wrapper never sees, and on GitHub Pages they'd land on a 404 page. A capture-phase
// click listener answers them in the page instead: today every such link is for a feature that
// needs the server, so the visitor gets a "Not available in the demo" toast.

import { toast } from '../lib/toast';
import { dispatch, type DemoBackend } from './server/routes';
import { apiUrl } from './transport';

export function installDownloadLinks(backend: DemoBackend): void {
  document.addEventListener(
    'click',
    (e) => {
      const a = e.target instanceof Element ? e.target.closest('a[href]') : null;
      if (!(a instanceof HTMLAnchorElement)) return;
      const url = apiUrl(a.href);
      if (!url) return;
      e.preventDefault();
      const res = dispatch(backend, {
        method: 'GET',
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        body: undefined,
        form: null,
        headers: new Headers(),
      });
      if (res.status >= 400) {
        const message = (res.body as { message?: string } | undefined)?.message ?? 'Not available in the demo.';
        toast(message, { kind: 'warning' });
        return;
      }
      // A route that can answer in the browser: hand its JSON over as a file.
      const blob = new Blob([JSON.stringify(res.body, null, 1)], { type: 'application/json' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = a.getAttribute('download') || url.pathname.split('/').pop() || 'download.json';
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    },
    true,
  );
}
