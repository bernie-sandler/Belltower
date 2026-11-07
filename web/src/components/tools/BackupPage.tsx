// Backup & restore (/backup): download a full export (JSON, or ZIP with attachments), restore
// from one with a preview and a typed confirmation, and see the nightly snapshots.

import { CSRF_HEADER, CSRF_VALUE } from '@tt/shared';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, DatabaseBackup, Download, HardDrive, RotateCcw, Upload } from 'lucide-react';
import { useRef, useState } from 'react';
import { api, ApiError } from '../../api/client';
import { errorMessage } from '../../api/errors';
import { formatBytes, formatDateTime, useNow } from '../../lib/time';
import { toast } from '../../lib/toast';
import { ConfirmDialog } from '../common/ConfirmDialog';

interface Preview {
  token: string;
  exportedAt: string;
  appVersion: string | null;
  schemaVersion: number;
  counts: Record<string, number>;
  attachments: { expected: number; present: number; missing: number };
  timeZoneWarning: string | null;
  withFiles: boolean;
}

interface Snapshot {
  name: string;
  sizeBytes: number;
  modifiedAt: string;
}

function uploadBackup(file: File, onProgress: (f: number) => void): Promise<Preview> {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append('file', file, file.name);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/backup/restore');
    xhr.setRequestHeader(CSRF_HEADER, CSRF_VALUE);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      let body: unknown = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        body = xhr.responseText;
      }
      if (xhr.status === 200) resolve(body as Preview);
      else {
        const b = body as { error?: string; message?: string } | null;
        reject(new ApiError(xhr.status, b?.error ?? `http_${xhr.status}`, b?.message ?? 'Upload failed', body));
      }
    };
    xhr.onerror = () => reject(new ApiError(0, 'network', "Can't reach Belltower.", null));
    xhr.send(form);
  });
}

const COUNT_LABELS: [string, string][] = [
  ['cards', 'cards'],
  ['activity', 'history entries'],
  ['checklist_items', 'checklist items'],
  ['attachments', 'attachments'],
  ['columns', 'columns'],
  ['labels', 'labels'],
  ['recurring_templates', 'templates'],
];

export function BackupPage() {
  const now = useNow();
  const fileRef = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [typed, setTyped] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const snapshots = useQuery({
    queryKey: ['snapshots'],
    queryFn: ({ signal }) => api.get<Snapshot[]>('/api/backup/snapshots', signal),
  });

  async function pick(file: File) {
    setError(null);
    setPreview(null);
    setTyped('');
    setProgress(0);
    try {
      setPreview(await uploadBackup(file, setProgress));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setProgress(null);
    }
  }

  async function restore() {
    if (!preview) return;
    setRestoring(true);
    try {
      await api.post(`/api/backup/restore/${preview.token}/confirm`, { confirm: 'RESTORE' });
      toast('Backup restored. Reloading…', { kind: 'success' });
      window.setTimeout(() => window.location.assign('/'), 800);
    } catch (err) {
      setRestoring(false);
      setConfirming(false);
      setError(errorMessage(err));
    }
  }

  async function cancel() {
    if (preview) await api.del(`/api/backup/restore/${preview.token}`).catch(() => undefined);
    setPreview(null);
    setTyped('');
  }

  return (
    <div className="list-page backup-page">
      <h2 className="list-page-title">
        <DatabaseBackup size={20} aria-hidden /> Backup &amp; restore
      </h2>

      <section className="settings-block">
        <h3 className="card-section-title">
          <Download size={16} aria-hidden /> Export
        </h3>
        <p className="muted">
          A full copy of everything: cards, history, work log, checklists, links, labels, columns and templates. The ZIP
          also contains the attachment files. Your password isn't included.
        </p>
        <div className="editor-actions">
          <a className="btn btn-primary" href="/api/backup/export.zip" download>
            <Download size={16} aria-hidden /> Download ZIP (with attachments)
          </a>
          <a className="btn" href="/api/backup/export.json" download>
            <Download size={16} aria-hidden /> Download JSON (data only)
          </a>
        </div>
      </section>

      <section className="settings-block">
        <h3 className="card-section-title">
          <RotateCcw size={16} aria-hidden /> Restore
        </h3>
        <p className="muted">
          Replaces everything here with the contents of a backup. You'll see what's in it before anything changes, and
          the current data is kept in <code>/data/backups</code> as a pre-restore copy.
        </p>
        <input
          ref={fileRef}
          type="file"
          accept=".zip,.json,application/zip,application/json"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) void pick(f);
          }}
        />
        {!preview && (
          <button type="button" className="btn" onClick={() => fileRef.current?.click()} disabled={progress !== null}>
            <Upload size={16} aria-hidden /> Choose backup file…
          </button>
        )}
        {progress !== null && (
          <div className="upload-progress" role="status">
            <span>{progress < 1 ? `Uploading… ${Math.round(progress * 100)}%` : 'Checking the backup…'}</span>
            <span className="progress">
              <span className="progress-bar" style={{ width: `${Math.round(progress * 100)}%` }} />
            </span>
          </div>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}

        {preview && (
          <div className="restore-preview">
            <p>
              Backup from <strong>{formatDateTime(preview.exportedAt, now)}</strong>
              {preview.appVersion && <> (Belltower {preview.appVersion})</>}:
            </p>
            <ul className="restore-counts">
              {COUNT_LABELS.map(([k, label]) => (
                <li key={k}>
                  <strong>{preview.counts[k] ?? 0}</strong> {label}
                </li>
              ))}
            </ul>
            {preview.attachments.expected > 0 && (
              <p className={preview.attachments.missing ? 'import-warning' : 'muted'}>
                {preview.attachments.missing ? <AlertTriangle size={14} aria-hidden /> : null}{' '}
                {preview.withFiles
                  ? `${preview.attachments.present} of ${preview.attachments.expected} attachment files are in the ZIP.`
                  : `JSON-only backup: ${preview.attachments.present} of ${preview.attachments.expected} attachment files already exist on this server and will be kept.`}
                {preview.attachments.missing > 0 && ` ${preview.attachments.missing} will show as missing.`}
              </p>
            )}
            {preview.timeZoneWarning && (
              <p className="import-warning">
                <AlertTriangle size={14} aria-hidden /> {preview.timeZoneWarning}
              </p>
            )}
            <label className="field">
              <span className="field-label">
                Type <code>RESTORE</code> to replace all current data with this backup
              </span>
              <input className="input input-mono" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} />
            </label>
            <div className="editor-actions">
              <button type="button" className="btn btn-danger" disabled={typed !== 'RESTORE' || restoring} onClick={() => setConfirming(true)}>
                <RotateCcw size={16} aria-hidden /> Restore this backup
              </button>
              <button type="button" className="btn" onClick={() => void cancel()} disabled={restoring}>
                Cancel
              </button>
            </div>
          </div>
        )}
      </section>

      <section className="settings-block">
        <h3 className="card-section-title">
          <HardDrive size={16} aria-hidden /> Snapshots on the server
        </h3>
        <p className="muted">
          Every day the server saves a copy of the database to <code>/data/backups</code> (last 7 kept), plus a copy before
          each restore. Copying the whole <code>/data</code> folder (or Unraid's Appdata Backup) is a full backup too.
        </p>
        {snapshots.data && snapshots.data.length === 0 && <p className="muted small">None yet.</p>}
        {snapshots.data && snapshots.data.length > 0 && (
          <ul className="snapshot-list">
            {snapshots.data.map((s) => (
              <li key={s.name}>
                <code>{s.name}</code> <span className="muted small">{formatBytes(s.sizeBytes)} · {formatDateTime(s.modifiedAt, now)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {confirming && preview && (
        <ConfirmDialog
          title="Replace all data?"
          message={`Everything on this board is replaced by the backup from ${formatDateTime(preview.exportedAt, now)}. The current data is kept in /data/backups.`}
          danger
          confirmLabel={restoring ? 'Restoring…' : 'Replace all data'}
          busy={restoring}
          onCancel={() => setConfirming(false)}
          onConfirm={() => void restore()}
        />
      )}
    </div>
  );
}
