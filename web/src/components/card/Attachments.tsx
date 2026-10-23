// Attachments: upload with the file picker, by dropping files on the card, or by pasting a
// screenshot (desktop; iOS has no keyboard paste, so the picker offers Photos/Camera/Files).
// Images preview inline and open full size; text files open in a viewer that shows the first or
// last 256 KB (logs open at the end); anything else downloads.

import { LIMITS, type Attachment, type CardDetail } from '@tt/shared';
import { Download, FileText, Image as ImageIcon, Paperclip, Trash2, Upload, File as FileIcon } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { attachmentUrl, useDeleteAttachment, useTextPreview, useUploadAttachments } from '../../api/cardParts';
import { useConfig } from '../../api/config';
import { errorMessage } from '../../api/errors';
import { cls } from '../../lib/cls';
import { fileStamp, formatBytes, formatDateTime, useNow } from '../../lib/time';
import { toast } from '../../lib/toast';
import { ConfirmDialog } from '../common/ConfirmDialog';
import { Modal } from '../common/Modal';
import { Spinner } from '../common/Status';

export interface AttachmentUploader {
  upload: (files: File[]) => void;
  pick: () => void;
  progress: number | null;
}

/** Upload state shared by the section, the sidebar button, drop and paste. */
export function useAttachmentUploader(cardId: number, enabled: boolean): AttachmentUploader & { input: ReactNode } {
  const config = useConfig();
  const mutation = useUploadAttachments(cardId);
  const [progress, setProgress] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const max = config.data?.maxUploadBytes ?? 25 * 1024 * 1024;

  const upload = useCallback(
    (files: File[]) => {
      if (!enabled || !files.length) return;
      const tooBig = files.filter((f) => f.size > max);
      if (tooBig.length) {
        toast(`${tooBig.map((f) => f.name).join(', ')} ${tooBig.length > 1 ? 'are' : 'is'} over the ${formatBytes(max)} limit`, {
          kind: 'error',
        });
        return;
      }
      setProgress(0);
      mutation.mutate(
        { files, onProgress: setProgress },
        {
          onSuccess: () => toast(files.length > 1 ? `${files.length} files attached` : `Attached ${files[0]!.name}`, { kind: 'success', durationMs: 2500 }),
          onSettled: () => setProgress(null),
        },
      );
    },
    [enabled, max, mutation],
  );

  const input = (
    <input
      ref={inputRef}
      type="file"
      multiple
      hidden
      onChange={(e) => {
        upload(Array.from(e.target.files ?? []));
        e.target.value = '';
      }}
    />
  );
  return { upload, pick: () => inputRef.current?.click(), progress, input };
}

/** Pasted images (screenshots) become attachments while the card is open. */
export function usePasteToAttach(upload: (files: File[]) => void, enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    const onPaste = (e: ClipboardEvent) => {
      const files = Array.from(e.clipboardData?.files ?? []).filter((f) => f.type.startsWith('image/'));
      if (!files.length) return;
      // Pasting into a text field that also gets text: leave it alone.
      const t = e.target as HTMLElement | null;
      const inField = t?.closest('input, textarea, [contenteditable="true"]');
      if (inField && e.clipboardData?.getData('text/plain')) return;
      e.preventDefault();
      const stamp = fileStamp();
      upload(
        files.map((f, i) => {
          const ext = f.type.split('/')[1]?.replace('jpeg', 'jpg') ?? 'png';
          const generic = /^image\.\w+$/i.test(f.name) || !f.name;
          const name = generic ? `screenshot-${stamp}${files.length > 1 ? `-${i + 1}` : ''}.${ext}` : f.name;
          return new File([f], name, { type: f.type });
        }),
      );
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, [upload, enabled]);
}

/** Files dragged over the card show a drop zone; dropping anywhere on the card uploads them. */
export function useFileDrop(upload: (files: File[]) => void, enabled: boolean) {
  const [over, setOver] = useState(false);
  const depth = useRef(0);

  // A file dropped just outside the card would make the browser navigate to it (losing edits).
  useEffect(() => {
    if (!enabled) return;
    const stop = (e: globalThis.DragEvent) => {
      if (e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')) e.preventDefault();
    };
    window.addEventListener('dragover', stop);
    window.addEventListener('drop', stop);
    return () => {
      window.removeEventListener('dragover', stop);
      window.removeEventListener('drop', stop);
    };
  }, [enabled]);
  const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer.types).includes('Files');

  return {
    over,
    props: enabled
      ? {
          onDragEnter: (e: DragEvent) => {
            if (!hasFiles(e)) return;
            e.preventDefault();
            depth.current += 1;
            setOver(true);
          },
          onDragOver: (e: DragEvent) => {
            if (!hasFiles(e)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
          },
          onDragLeave: (e: DragEvent) => {
            if (!hasFiles(e)) return;
            depth.current = Math.max(0, depth.current - 1);
            if (depth.current === 0) setOver(false);
          },
          onDrop: (e: DragEvent) => {
            if (!hasFiles(e)) return;
            e.preventDefault();
            depth.current = 0;
            setOver(false);
            upload(Array.from(e.dataTransfer.files));
          },
        }
      : {},
  };
}

export function Attachments({
  card,
  readOnly,
  uploader,
}: {
  card: CardDetail;
  readOnly: boolean;
  uploader: AttachmentUploader;
}) {
  const now = useNow();
  const remove = useDeleteAttachment(card.id);
  const [viewing, setViewing] = useState<Attachment | null>(null);
  const [deleting, setDeleting] = useState<Attachment | null>(null);

  if (!card.attachments.length && uploader.progress === null) return null;

  return (
    <section className="card-section" aria-labelledby="card-attachments-heading">
      <div className="card-section-head">
        <h3 id="card-attachments-heading" className="card-section-title">
          <Paperclip size={16} aria-hidden /> Attachments
        </h3>
        {!readOnly && (
          <button type="button" className="btn btn-sm" onClick={uploader.pick}>
            <Upload size={14} aria-hidden /> Add
          </button>
        )}
      </div>

      {uploader.progress !== null && (
        <div className="upload-progress" role="status" aria-live="polite">
          <span>Uploading… {Math.round(uploader.progress * 100)}%</span>
          <span className="progress">
            <span className="progress-bar" style={{ width: `${Math.round(uploader.progress * 100)}%` }} />
          </span>
        </div>
      )}

      <ul className="attachment-list">
        {card.attachments.map((a) => (
          <li key={a.id} className="attachment">
            <button
              type="button"
              className="attachment-thumb"
              onClick={() => (a.kind === 'file' ? window.open(attachmentUrl(a.id, true), '_self') : setViewing(a))}
              aria-label={a.kind === 'file' ? `Download ${a.name}` : `Open ${a.name}`}
            >
              {a.kind === 'image' ? (
                <img src={attachmentUrl(a.id)} alt="" loading="lazy" decoding="async" />
              ) : a.kind === 'text' ? (
                <FileText size={28} aria-hidden />
              ) : (
                <FileIcon size={28} aria-hidden />
              )}
            </button>
            <div className="attachment-info">
              <button
                type="button"
                className="link-btn attachment-name"
                onClick={() => (a.kind === 'file' ? window.open(attachmentUrl(a.id, true), '_self') : setViewing(a))}
              >
                {a.name}
              </button>
              <span className="muted small">
                {formatBytes(a.sizeBytes)} · {formatDateTime(a.createdAt, now)}
              </span>
              <span className="attachment-actions">
                <a className="link-btn small" href={attachmentUrl(a.id, true)} download={a.name}>
                  <Download size={12} aria-hidden /> Download
                </a>
                {!readOnly && (
                  <button type="button" className="link-btn small danger" onClick={() => setDeleting(a)}>
                    <Trash2 size={12} aria-hidden /> Delete
                  </button>
                )}
              </span>
            </div>
          </li>
        ))}
      </ul>

      {viewing && <AttachmentViewer attachment={viewing} onClose={() => setViewing(null)} />}
      {deleting && (
        <ConfirmDialog
          title="Delete attachment?"
          message={`“${deleting.name}” will be deleted from the server. The card's history keeps its name.`}
          danger
          confirmLabel="Delete"
          busy={remove.isPending}
          onCancel={() => setDeleting(null)}
          onConfirm={() => remove.mutate(deleting.id, { onSettled: () => setDeleting(null) })}
        />
      )}
    </section>
  );
}

function AttachmentViewer({ attachment, onClose }: { attachment: Attachment; onClose: () => void }) {
  return (
    <Modal
      onClose={onClose}
      size="lg"
      className="attachment-viewer"
      title={
        <span className="viewer-title">
          {attachment.kind === 'image' ? <ImageIcon size={16} aria-hidden /> : <FileText size={16} aria-hidden />}
          {attachment.name}
        </span>
      }
    >
      {attachment.kind === 'image' ? (
        <div className="image-viewer">
          <img src={attachmentUrl(attachment.id)} alt={attachment.name} />
        </div>
      ) : (
        <TextViewer attachment={attachment} />
      )}
      <div className="modal-footer">
        <a className="btn" href={attachmentUrl(attachment.id, true)} download={attachment.name}>
          <Download size={16} aria-hidden /> Download
        </a>
      </div>
    </Modal>
  );
}

function TextViewer({ attachment }: { attachment: Attachment }) {
  const isLog = /\.log$/i.test(attachment.name);
  const [mode, setMode] = useState<'head' | 'tail' | 'full'>(isLog ? 'tail' : 'head');
  const [wrap, setWrap] = useState(true);
  const { data, error, isPending } = useTextPreview(attachment.id, mode);
  const preRef = useRef<HTMLPreElement>(null);

  // Logs: jump to the end, where the latest lines are.
  useEffect(() => {
    if (data && data.mode === 'tail' && preRef.current) preRef.current.scrollTop = preRef.current.scrollHeight;
  }, [data]);

  const canFull = attachment.sizeBytes <= LIMITS.textFullMaxBytes;

  return (
    <div className="text-viewer">
      <div className="text-viewer-bar">
        {data?.truncated && (
          <span className="muted small">
            Showing the {data.mode === 'tail' ? 'last' : 'first'} {formatBytes(data.text.length)} of {formatBytes(data.totalBytes)}
          </span>
        )}
        <span className="topbar-spacer" />
        {data?.truncated && (
          <>
            <button type="button" className="btn btn-sm" onClick={() => setMode(mode === 'tail' ? 'head' : 'tail')}>
              Show {mode === 'tail' ? 'start' : 'end'}
            </button>
            {canFull && (
              <button type="button" className="btn btn-sm" onClick={() => setMode('full')}>
                Load full file
              </button>
            )}
          </>
        )}
        <label className="checkbox small">
          <input type="checkbox" checked={wrap} onChange={(e) => setWrap(e.target.checked)} /> Wrap lines
        </label>
      </div>
      {isPending && <Spinner label="Loading file…" />}
      {error && <p className="form-error">{errorMessage(error)}</p>}
      {data && (
        <pre ref={preRef} className={cls('text-viewer-pre', wrap && 'is-wrapped')}>
          {data.text}
        </pre>
      )}
    </div>
  );
}
