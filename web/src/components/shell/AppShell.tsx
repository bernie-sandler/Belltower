import { lazy, Suspense, useMemo, useState, type ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router';
import { useShortcut } from '../../lib/keyboard';
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
const CardListPage = lazy(() => import('../lists/CardListPage').then((m) => ({ default: m.CardListPage })));
const CalendarPage = lazy(() => import('../calendar/CalendarPage').then((m) => ({ default: m.CalendarPage })));
const SearchPage = lazy(() => import('../search/SearchPage').then((m) => ({ default: m.SearchPage })));
const TemplatesPage = lazy(() => import('../templates/TemplatesPage').then((m) => ({ default: m.TemplatesPage })));
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
function Lazy({ children }: { children: ReactNode }) {
  return <Suspense fallback={<LoadingScreen />}>{children}</Suspense>;
}

function AppRoutes() {
  const location = useLocation();
  const navigate = useNavigate();
  // '/' anywhere (not while typing) → search.
  useShortcut('/', () => void navigate('/search'));
  const background = backgroundOf(location);

  return (
    <>
      <Routes location={background ?? location}>
        <Route path="/" element={<Board />} />
        <Route path="/cards/:id" element={<Board />} />
        <Route
          path="/archive"
          element={
            <Suspense fallback={<LoadingScreen />}>
              <CardListPage kind="archived" />
            </Suspense>
          }
        />
        <Route path="/calendar" element={<Lazy><CalendarPage /></Lazy>} />
        <Route path="/search" element={<Lazy><SearchPage /></Lazy>} />
        <Route path="/templates" element={<Lazy><TemplatesPage /></Lazy>} />
        <Route
          path="/trash"
          element={
            <Suspense fallback={<LoadingScreen />}>
              <CardListPage kind="trashed" />
            </Suspense>
          }
        />
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
