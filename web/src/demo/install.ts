// Sets up the browser-only demo: the data store, the /api interceptor, download links and the banner.

import './demo.css';
import { mountBanner } from './DemoBanner';
import { installDownloadLinks } from './downloads';
import { seedDemo } from './seed';
import { DemoStore, pickStorage } from './store';
import { installTransport } from './transport';

const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
// The submit page link is built as `${appUrl}/submit/<key>`; with "#" on the end it lands on the
// HashRouter route, e.g. https://bernie-sandler.github.io/Belltower/#/submit/<key>.
const appUrl = `${window.location.origin}${import.meta.env.BASE_URL.replace(/\/$/, '')}/#`;

const store = new DemoStore({
  storage: pickStorage(),
  timeZone,
  seed: (now, tz) => seedDemo(now, tz, { appUrl }),
});

installTransport(store);
installDownloadLinks(store);
document.body.classList.add('demo');
mountBanner(store);
