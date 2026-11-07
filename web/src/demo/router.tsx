// GitHub Pages has no SPA fallback: a refresh on /Belltower/card/12 would be a 404. In the demo
// build, vite.config.ts points the app's `react-router` imports here, where BrowserRouter is a
// HashRouter (/Belltower/#/card/12), so deep links and refreshes always load index.html.
// Everything else is react-router itself.

import { HashRouter, type BrowserRouterProps } from 'react-router';

export * from 'react-router';

export function BrowserRouter(props: BrowserRouterProps) {
  return <HashRouter {...props} />;
}
