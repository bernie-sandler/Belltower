// The strip above the app in the demo: what the demo is, a switch between the owner's view and a
// submitter's (the public submit page), "Reset demo data", and where to get the real thing.

import type { AuthStatus } from '@tt/shared';
import { useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { clearPrivateData, queryClient } from '../api/queryClient';
import { qk } from '../api/keys';
import { toast } from '../lib/toast';
import { newSubmitKey } from './server/settings';
import type { DemoStore } from './store';

export const REPO_URL = 'https://github.com/bernie-sandler/Belltower';
export const INSTALL_URL = `${REPO_URL}/blob/main/docs/INSTALL.md`;
export const BANNER_TEXT = 'everything is stored in your browser only.';

function subscribeHash(fn: () => void) {
  window.addEventListener('hashchange', fn);
  return () => window.removeEventListener('hashchange', fn);
}

/** Owner = signed in, the whole app. Submitter = signed out, on the public submit page. */
function viewAs(store: DemoStore, role: 'owner' | 'submitter'): void {
  if (role === 'owner') {
    store.setSignedIn(true);
    if (window.location.hash.startsWith('#/submit/')) window.location.hash = '#/';
  } else {
    // The visitor may have turned the submit page off in Settings; a submitter needs it on.
    const key = store.transaction((ctx) => {
      const s = ctx.s.settings.submit;
      if (!s.enabled || !s.key) {
        ctx.s.settings.submit = { ...s, enabled: true, key: s.key ?? newSubmitKey() };
        toast('The submit page was turned off in Settings, so the demo turned it back on.', { kind: 'info' });
      }
      ctx.s.session = { signedIn: false, userId: null };
      return ctx.s.settings.submit.key!;
    }, true);
    window.location.hash = `#/submit/${encodeURIComponent(key)}`;
  }
  // Like useLogin/useLogout: the cached status changes at once, so the app never renders a
  // board it's no longer allowed to load (that would end in a "session has ended" toast).
  queryClient.setQueryData<AuthStatus>(qk.auth, (s) => (s ? { ...s, authenticated: role === 'owner' } : s));
  if (role === 'submitter') clearPrivateData();
  void queryClient.invalidateQueries({ queryKey: qk.auth });
  void queryClient.invalidateQueries({ queryKey: qk.settings });
}

/** Unsaved drafts and collapsed groups refer to card ids, which a fresh seed hands out again. */
function clearAppStorage(): void {
  for (const storage of [window.localStorage, window.sessionStorage]) {
    try {
      const keys: string[] = [];
      for (let i = 0; i < storage.length; i++) {
        const k = storage.key(i);
        if (k && (k.startsWith('tt-draft:') || k === 'tt-collapsed-groups')) keys.push(k);
      }
      for (const k of keys) storage.removeItem(k);
    } catch {
      // Storage unavailable.
    }
  }
}

function resetDemo(store: DemoStore): void {
  if (!window.confirm('Reset the demo? Everything you changed is replaced with the sample board again.')) return;
  store.reset();
  clearAppStorage();
  window.location.hash = '#/';
  window.location.reload();
}

export function DemoBanner({ store }: { store: DemoStore }) {
  const signedIn = useSyncExternalStore(
    (fn) => store.subscribe(fn),
    () => store.signedIn(),
  );
  const hash = useSyncExternalStore(subscribeHash, () => window.location.hash);
  const onSubmitPage = hash.startsWith('#/submit/');
  const role = signedIn ? 'owner' : 'submitter';

  return (
    <div className="demo-banner" role="region" aria-label="About this demo">
      <p className="demo-banner-text">
        <strong>Demo:</strong> {BANNER_TEXT}
        {!signedIn && !onSubmitPage && <span className="demo-banner-hint"> Signed out: any password signs you back in.</span>}
      </p>
      <div className="demo-banner-actions">
        <div className="demo-banner-view" role="group" aria-label="View the demo as">
          <span className="demo-banner-label">View as</span>
          <button
            type="button"
            aria-pressed={role === 'owner'}
            title="Signed in: the board, cards and settings"
            onClick={() => viewAs(store, 'owner')}
          >
            Owner
          </button>
          <button
            type="button"
            aria-pressed={role === 'submitter'}
            title="Signed out: the public page where other people file tickets"
            onClick={() => viewAs(store, 'submitter')}
          >
            Submitter
          </button>
        </div>
        <button type="button" className="demo-banner-reset" onClick={() => resetDemo(store)}>
          Reset demo data
        </button>
        <a className="demo-banner-link" href={INSTALL_URL} target="_blank" rel="noopener noreferrer">
          Install<span className="demo-banner-wide"> Belltower</span>
        </a>
      </div>
    </div>
  );
}

export function mountBanner(store: DemoStore): void {
  const host = document.createElement('div');
  host.id = 'demo-banner';
  document.body.insertBefore(host, document.getElementById('root'));
  createRoot(host).render(<DemoBanner store={store} />);
}
