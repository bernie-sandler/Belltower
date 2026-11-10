// About Belltower: the version and how this install is set up. Your password moved to Account (1.5).

import { useId } from 'react';
import { useConfig } from '../../api/config';
import { Modal } from '../common/Modal';

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const { data: config } = useConfig();
  const ids = useId();
  const uploadMb = config ? Math.round(config.maxUploadBytes / (1024 * 1024)) : null;

  return (
    <Modal title="About Belltower" onClose={onClose} size="md">
      <div className="modal-body settings">
        <section className="settings-section" aria-labelledby={`${ids}-about`}>
          <h3 id={`${ids}-about`} className="section-title">
            About
          </h3>
          <dl className="about-list">
            <dt>Version</dt>
            <dd>{config?.appVersion ?? '…'}</dd>
            <dt>Time zone</dt>
            <dd>{config?.timeZone ?? '…'}</dd>
            <dt>Largest upload</dt>
            <dd>{uploadMb === null ? '…' : `${uploadMb} MB`}</dd>
          </dl>
          <p className="muted small">Your password, profile and tokens are under Account.</p>
        </section>
      </div>
    </Modal>
  );
}
