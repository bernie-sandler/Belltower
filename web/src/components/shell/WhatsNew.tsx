import { useState } from 'react';
import latest from 'virtual:latest-changelog';
import { Markdown } from '../common/Markdown';
import { Modal } from '../common/Modal';
import { markVersionSeen, readLastSeenVersion, setWhatsNewEnabled, shouldShowWhatsNew, useWhatsNewEnabled } from '../../lib/whatsNew';

/**
 * "What's new" after an update: the newest CHANGELOG.md section (bundled at build time), shown
 * once per device per version. Decided once per page load, so a server update while the page is
 * open waits for the reload that UpdateBanner offers.
 */
export function WhatsNew({ appVersion, upgradedFrom }: { appVersion: string; upgradedFrom: string | null }) {
  const enabled = useWhatsNewEnabled();
  const [open, setOpen] = useState(() => {
    const show = shouldShowWhatsNew({
      appVersion,
      lastSeen: readLastSeenVersion(),
      upgradedFrom,
      enabled,
      notesVersion: latest?.body ? latest.version : null,
    });
    if (!show && appVersion !== 'dev') markVersionSeen(appVersion);
    return show;
  });
  if (!open || !latest) return null;

  const close = () => {
    markVersionSeen(appVersion);
    setOpen(false);
  };
  return (
    <Modal
      onClose={close}
      size="lg"
      className="whats-new"
      title={
        <>
          What’s new in Belltower {latest.version}
          {latest.title && <span className="whats-new-subtitle">{latest.title}</span>}
        </>
      }
    >
      <div className="modal-body">
        <Markdown text={latest.body} className="whats-new-notes" />
      </div>
      <footer className="modal-footer whats-new-footer">
        <label className="checkbox whats-new-toggle">
          <input type="checkbox" checked={enabled} onChange={(e) => setWhatsNewEnabled(e.target.checked)} />
          <span>Show this after updates</span>
        </label>
        <button type="button" className="btn btn-primary" onClick={close} data-autofocus>
          Got it
        </button>
      </footer>
    </Modal>
  );
}
