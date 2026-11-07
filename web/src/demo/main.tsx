// Entry point of the demo build (vite.config.ts swaps it in for src/main.tsx when VITE_DEMO=true).
// The in-browser backend has to be in place before the app's first request, so it's installed
// first; then the real app starts exactly as it does in production.

import './install';
import '../main';
