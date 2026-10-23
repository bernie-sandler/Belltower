import { lazy, Suspense, useMemo, useState } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router';
import { useConfig } from '../../api/config';
import { errorMessage } from '../../api/errors';
import { backgroundOf } from '../../lib/navigation';
import { setAppTimeZone } from '../../lib/time';
import { Board } from '../board/Board';
import { ErrorScreen, LoadingScreen } from '../common/Status';
import { ShellContext, type ShellActions } from './ShellContext';
import { TopBar } from './TopBar';
import { UpdateBanner } from './UpdateBanner';

// Code-split: the board loads eagerly; everything opened on demand is its own chunk.
const CardRoute = lazy(() => import('../card/CardRoute'));
const LabelsManager = lazy(() => import('../labels/LabelsManager').then((m) => ({ default: m.LabelsManager })));
const SettingsDialog = lazy(() => import('../settings/SettingsDialog').then((m) => ({ default: m.SettingsDialog })));

/** Signed-in app: needs /api/config (time zone, version) before rendering any dates. */
export function AppShell() {
  const config = useConfig();
  const [labelsOpen, setLabelsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [addColumnRequest, setAddColumnRequest] = useState(0);

  const actions = useMemo<ShellActions>(
    () => ({
      openLabels: () => setLabelsOpen(true),
      openSettings: () => setSettingsOpen(true),
      requestAddColumn: () => setAddColumnRequest((n) => n + 1),
      addColumnRequest,
    }),
    [addColumnRequest],
  );

  if (config.isPending) return <LoadingScreen />;
  if (!config.data) {
    return (
      <ErrorScreen
        title="Can't load Tower Tracker"
        message={errorMessage(config.error)}
        onRetry={() => void config.refetch()}
      />
    );
  }
  setAppTimeZone(config.data.timeZone);

  return (
    <ShellContext.Provider value={actions}>
      <div className="app">
        <TopBar />
        <UpdateBanner />
        <main className="app-main">
          <AppRoutes />
        </main>
      </div>
      <Suspense fallback={null}>
        {labelsOpen && <LabelsManager onClose={() => setLabelsOpen(false)} />}
        {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
      </Suspense>
    </ShellContext.Provider>
  );
}

/**
 * Background-location routing: when a card is opened from a page, that page stays rendered
 * underneath (state.background) and the card renders on top. A deep link to /cards/:id has no
 * background, so the board renders behind it.
 */
function AppRoutes() {
  const location = useLocation();
  const background = backgroundOf(location);

  return (
    <>
      <Routes location={background ?? location}>
        <Route path="/" element={<Board />} />
        <Route path="/cards/:id" element={<Board />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <Routes>
        <Route
          path="/cards/:id"
          element={
            <Suspense fallback={<div className="modal-root modal-card is-loading" aria-hidden />}>
              <CardRoute />
            </Suspense>
          }
        />
        <Route path="*" element={null} />
      </Routes>
    </>
  );
}
