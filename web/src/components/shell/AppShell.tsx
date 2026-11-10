import { lazy, Suspense, useMemo, useState, type ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router';
import { useShortcut } from '../../lib/keyboard';
import { useConfig } from '../../api/config';
import { useIsAdmin, useMe } from '../../api/me';
import { useAiStatus } from '../../api/tickets';
import { errorMessage } from '../../api/errors';
import { backgroundOf } from '../../lib/navigation';
import { setAppTimeZone } from '../../lib/time';
import { Board } from '../board/Board';
import { ResolveDialog } from '../card/ResolveDialog';
import { ErrorScreen, LoadingScreen } from '../common/Status';
import { ShellContext, type ShellActions } from './ShellContext';
import type { NewTicketMode, NewTicketPreset } from '../tickets/NewTicketDialog';
import { TopBar } from './TopBar';
import { UpdateBanner } from './UpdateBanner';

// Code-split: the board loads eagerly; everything opened on demand is its own chunk.
const CardRoute = lazy(() => import('../card/CardRoute'));
const CardListPage = lazy(() => import('../lists/CardListPage').then((m) => ({ default: m.CardListPage })));
const CalendarPage = lazy(() => import('../calendar/CalendarPage').then((m) => ({ default: m.CalendarPage })));
const SearchPage = lazy(() => import('../search/SearchPage').then((m) => ({ default: m.SearchPage })));
const ImportCardsPage = lazy(() => import('../tools/ImportCardsPage').then((m) => ({ default: m.ImportCardsPage })));
const BackupPage = lazy(() => import('../tools/BackupPage').then((m) => ({ default: m.BackupPage })));
const TemplatesPage = lazy(() => import('../templates/TemplatesPage').then((m) => ({ default: m.TemplatesPage })));
const LabelsManager = lazy(() => import('../labels/LabelsManager').then((m) => ({ default: m.LabelsManager })));
const BulkTicketsDialog = lazy(() => import('../tickets/BulkTicketsDialog').then((m) => ({ default: m.BulkTicketsDialog })));
const NewTicketDialog = lazy(() => import('../tickets/NewTicketDialog').then((m) => ({ default: m.NewTicketDialog })));
const SettingsPage = lazy(() => import('../settings/SettingsPage').then((m) => ({ default: m.SettingsPage })));
const AccountPage = lazy(() => import('../account/AccountPage').then((m) => ({ default: m.AccountPage })));

/**
 * Signed-in app: needs /api/config (time zone, version) before rendering any dates, and /api/me
 * (who you are, whether you're an admin) before showing any admin-only part.
 */
export function AppShell() {
  const config = useConfig();
  const me = useMe();
  const [labelsOpen, setLabelsOpen] = useState(false);
  const [newTicket, setNewTicket] = useState<{ mode: NewTicketMode; preset?: NewTicketPreset } | null>(null);
  const ai = useAiStatus();
  const [addColumnRequest, setAddColumnRequest] = useState(0);
  const [resolving, setResolving] = useState<number | null>(null);

  const actions = useMemo<ShellActions>(
    () => ({
      openLabels: () => setLabelsOpen(true),
      openNewTicket: (mode, preset) => setNewTicket({ mode, preset }),
      openResolution: (cardId) => setResolving(cardId),
      requestAddColumn: () => setAddColumnRequest((n) => n + 1),
      addColumnRequest,
    }),
    [addColumnRequest],
  );

  if (config.isPending || me.isPending) return <LoadingScreen />;
  if (!config.data || !me.data) {
    return (
      <ErrorScreen
        title="Can't load Belltower"
        message={errorMessage(config.error ?? me.error)}
        onRetry={() => {
          void config.refetch();
          void me.refetch();
        }}
      />
    );
  }
  setAppTimeZone(config.data.timeZone);
  const aiEnabled = ai.data?.enabled === true;

  return (
    <ShellContext.Provider value={actions}>
      <div className="app">
        <TopBar />
        <UpdateBanner />
        <main className="app-main">
          <AppRoutes
            aiEnabled={aiEnabled}
            onNewTicket={() => setNewTicket({ mode: aiEnabled ? 'describe' : 'blank' })}
          />
        </main>
      </div>
      <Suspense fallback={null}>
        {labelsOpen && <LabelsManager onClose={() => setLabelsOpen(false)} />}
        {resolving !== null && <ResolveDialog cardId={resolving} mode="edit" onClose={() => setResolving(null)} />}
        {newTicket &&
          (newTicket.mode === 'many' ? (
            <BulkTicketsDialog onClose={() => setNewTicket(null)} />
          ) : (
            <NewTicketDialog mode={newTicket.mode} preset={newTicket.preset} onClose={() => setNewTicket(null)} />
          ))}
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

function AppRoutes({ aiEnabled, onNewTicket }: { aiEnabled: boolean; onNewTicket: () => void }) {
  const location = useLocation();
  const navigate = useNavigate();
  // '/' anywhere (not while typing) → search; Shift+N → Add ticket.
  useShortcut('/', () => void navigate('/search'));
  useShortcut('N', onNewTicket);
  const background = backgroundOf(location);
  const isAdmin = useIsAdmin();

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
        {/* With Claude drafting on, Add ticket replaces the paste-JSON import. */}
        <Route path="/import" element={aiEnabled ? <Navigate to="/" replace /> : <Lazy><ImportCardsPage /></Lazy>} />
        <Route path="/backup" element={isAdmin ? <Lazy><BackupPage /></Lazy> : <Navigate to="/" replace />} />
        <Route path="/settings" element={<Lazy><SettingsPage /></Lazy>} />
        <Route path="/account" element={<Lazy><AccountPage /></Lazy>} />
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
