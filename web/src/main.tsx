import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { installGlobalKeyboard } from './lib/keyboard';
import { installStaleBundleReload } from './lib/staleBundle';
import './styles/tokens.css';
import './styles/base.css';
import './styles/components.css';
import './styles/auth.css';
import './styles/board.css';
import './styles/card.css';
import './styles/parts.css';
import './styles/phase3.css';

installStaleBundleReload();
installGlobalKeyboard();

const root = document.getElementById('root');
if (!root) throw new Error('#root element missing from index.html');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
