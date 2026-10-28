// The public submit page (/submit/<key>): pick what you need help with, answer its questions,
// file a ticket. No sign-in; shows nothing from the board except the request types and their tags.

import { useQuery } from '@tanstack/react-query';
import { CSRF_HEADER, CSRF_VALUE, LIMITS, type PublicSubmitConfig, type RequestFieldDef, type SubmitResult } from '@tt/shared';
import { CircleCheck, ImagePlus, X } from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';
import { useParams } from 'react-router';
import { api, ApiError } from '../../api/client';
import { errorMessage } from '../../api/errors';
import { cls } from '../../lib/cls';
import { formatBytes } from '../../lib/time';
import { AuthLayout } from '../auth/AuthLayout';
import { LabelChip } from '../labels/LabelChip';
import { Spinner } from '../common/Status';

type Answers = Record<string, string | string[] | boolean>;

async function send(key: string, data: unknown, files: File[]): Promise<SubmitResult> {
  const form = new FormData();
  form.append('data', JSON.stringify(data));
  for (const f of files) form.append('screenshots', f, f.name);
  let res: Response;
  try {
    res = await fetch(`/api/public/submit/${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { [CSRF_HEADER]: CSRF_VALUE },
      body: form,
      credentials: 'omit',
    });
  } catch {
    throw new ApiError(0, 'network', 'Can’t reach the server. Check your connection and try again.', null);
  }
  const body = (await res.json().catch(() => null)) as { error?: string; message?: string; retryAfterSec?: number } | SubmitResult | null;
  if (!res.ok) {
    const b = body as { error?: string; message?: string } | null;
    throw new ApiError(res.status, b?.error ?? `http_${res.status}`, b?.message ?? 'Sending failed', body);
  }
  return body as SubmitResult;
}

export function SubmitPage() {
  const { key = '' } = useParams();
  const config = useQuery({
    queryKey: ['publicSubmit', key],
    queryFn: ({ signal }) => api.get<PublicSubmitConfig>(`/api/public/submit/${encodeURIComponent(key)}`, signal),
    retry: false,
    staleTime: Infinity,
  });

  if (config.isPending) {
    return (
      <AuthLayout title="Loading…">
        <Spinner />
      </AuthLayout>
    );
  }
  if (!config.data) {
    const missing = config.error instanceof ApiError && config.error.status === 404;
    return (
      <AuthLayout title={missing ? 'This page doesn’t exist' : 'Something went wrong'}>
        <p className="auth-intro">{missing ? 'Check the link you were given, or ask for a new one.' : errorMessage(config.error)}</p>
      </AuthLayout>
    );
  }
  return <SubmitForm submitKey={key} config={config.data} />;
}

function SubmitForm({ submitKey, config }: { submitKey: string; config: PublicSubmitConfig }) {
  const ids = useId();
  const [typeId, setTypeId] = useState<number | null>(config.types.length === 1 ? config.types[0]!.id : null);
  const [summary, setSummary] = useState('');
  const [description, setDescription] = useState('');
  const [answers, setAnswers] = useState<Answers>({});
  const [tags, setTags] = useState<number[]>([]);
  const [files, setFiles] = useState<File[]>([]);
  const [name, setName] = useState('');
  const [website, setWebsite] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [done, setDone] = useState<SubmitResult | null>(null);
  const type = config.types.find((t) => t.id === typeId) ?? null;

  function reset() {
    setSummary('');
    setDescription('');
    setAnswers({});
    setTags([]);
    setFiles([]);
    setError(null);
    setDone(null);
  }

  function addFiles(list: FileList | null) {
    if (!list) return;
    const next = [...files];
    for (const f of Array.from(list)) {
      if (!f.type.startsWith('image/')) {
        setError(`“${f.name}” isn’t an image.`);
        continue;
      }
      if (f.size > config.maxUploadBytes) {
        setError(`“${f.name}” is larger than ${formatBytes(config.maxUploadBytes)}.`);
        continue;
      }
      if (next.length < config.maxFiles) next.push(f);
    }
    setFiles(next);
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!type) return;
    setError(null);
    setSending(true);
    try {
      const result = await send(
        submitKey,
        { typeId: type.id, summary: summary.trim(), description: description.trim(), answers, tagLabelIds: tags, name: name.trim(), website },
        files,
      );
      setDone(result);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSending(false);
    }
  }

  if (done) {
    return (
      <AuthLayout title="Thanks!">
        <p className="auth-intro submit-done">
          <CircleCheck size={20} aria-hidden /> Your request was sent
          {done.ticketNo && (
            <>
              {' '}
              as ticket <strong className="ticket-no">{done.ticketNo}</strong>
            </>
          )}
          .
        </p>
        <button type="button" className="btn btn-block" onClick={reset}>
          Send another
        </button>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title={config.pageTitle}>
      {config.intro && <p className="auth-intro">{config.intro}</p>}
      {config.types.length === 0 ? (
        <p className="auth-intro">Nothing can be requested here right now.</p>
      ) : (
        <form className="auth-form submit-form" onSubmit={(e) => void onSubmit(e)}>
          <fieldset className="ticket-fieldset">
            <legend className="field-label">What do you need help with?</legend>
            <div className="submit-types" role="radiogroup">
              {config.types.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  role="radio"
                  aria-checked={typeId === t.id}
                  className={cls('submit-type', typeId === t.id && 'is-selected')}
                  onClick={() => {
                    setTypeId(t.id);
                    setAnswers({});
                    setTags([]);
                  }}
                >
                  <strong>{t.name}</strong>
                  {t.description && <span className="muted small">{t.description}</span>}
                </button>
              ))}
            </div>
          </fieldset>

          {type && (
            <>
              <label className="field">
                <span className="field-label">Title *</span>
                <input className="input" required maxLength={LIMITS.cardTitle} value={summary} onChange={(e) => setSummary(e.target.value)} />
                <span className="field-help">A few words, e.g. “stutters every few minutes”.</span>
              </label>
              <label className="field">
                <span className="field-label">What’s wrong? *</span>
                <textarea className="input" required rows={4} maxLength={LIMITS.submitAnswer * 2} value={description} onChange={(e) => setDescription(e.target.value)} />
              </label>
              {type.fields.map((f) => (
                <Question key={`${type.id}-${f.key}`} field={f} value={answers[f.key]} onChange={(v) => setAnswers({ ...answers, [f.key]: v })} />
              ))}
              {type.tags.length > 0 && (
                <fieldset className="ticket-fieldset">
                  <legend className="field-label">Tags</legend>
                  <div className="ticket-labels">
                    {type.tags.map((l) => {
                      const on = tags.includes(l.id);
                      return (
                        <button
                          key={l.id}
                          type="button"
                          role="checkbox"
                          aria-checked={on}
                          aria-label={l.name}
                          className="ticket-label-toggle"
                          onClick={() => setTags(on ? tags.filter((x) => x !== l.id) : [...tags, l.id])}
                        >
                          <LabelChip label={l} />
                        </button>
                      );
                    })}
                  </div>
                </fieldset>
              )}
              <div className="field">
                <span className="field-label" id={`${ids}-shots`}>
                  Screenshots (up to {config.maxFiles})
                </span>
                {files.length > 0 && (
                  <ul className="submit-files" aria-labelledby={`${ids}-shots`}>
                    {files.map((f, i) => (
                      <li key={`${f.name}-${i}`}>
                        <span>{f.name}</span>
                        <span className="muted small">{formatBytes(f.size)}</span>
                        <button
                          type="button"
                          className="icon-btn"
                          aria-label={`Remove ${f.name}`}
                          onClick={() => setFiles(files.filter((_, j) => j !== i))}
                        >
                          <X size={16} aria-hidden />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {files.length < config.maxFiles && (
                  <label className="btn btn-sm submit-add-file">
                    <ImagePlus size={14} aria-hidden /> Add a screenshot
                    <input
                      type="file"
                      accept="image/*"
                      multiple
                      hidden
                      onChange={(e) => {
                        addFiles(e.target.files);
                        e.target.value = '';
                      }}
                    />
                  </label>
                )}
              </div>
              <label className="field">
                <span className="field-label">Your name</span>
                <input className="input" maxLength={60} autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} />
              </label>
              {/* For bots only: people never see this field. */}
              <div className="visually-hidden" aria-hidden="true">
                <label>
                  Website
                  <input tabIndex={-1} autoComplete="off" value={website} onChange={(e) => setWebsite(e.target.value)} />
                </label>
              </div>
              {error && (
                <p className="form-error" role="alert">
                  {error}
                </p>
              )}
              <button type="submit" className="btn btn-primary btn-block" disabled={sending || !summary.trim() || !description.trim()}>
                {sending ? 'Sending…' : 'Send'}
              </button>
            </>
          )}
        </form>
      )}
    </AuthLayout>
  );
}

function Question({ field: f, value, onChange }: { field: RequestFieldDef; value: Answers[string] | undefined; onChange: (v: Answers[string]) => void }) {
  const label = `${f.label}${f.required ? ' *' : ''}`;
  const help = f.help ? <span className="field-help">{f.help}</span> : null;
  switch (f.kind) {
    case 'short':
    case 'long':
    case 'datetime':
      return (
        <label className="field">
          <span className="field-label">{label}</span>
          {f.kind === 'long' ? (
            <textarea className="input" rows={3} required={f.required} maxLength={LIMITS.submitAnswer} value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value)} />
          ) : (
            <input
              className="input"
              type={f.kind === 'datetime' ? 'datetime-local' : 'text'}
              required={f.required}
              maxLength={f.kind === 'short' ? 200 : undefined}
              value={(value as string) ?? ''}
              onChange={(e) => onChange(e.target.value)}
            />
          )}
          {help}
        </label>
      );
    case 'choice':
      return (
        <label className="field">
          <span className="field-label">{label}</span>
          <select className="input" required={f.required} value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value)}>
            <option value="">Choose…</option>
            {f.options.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
          {help}
        </label>
      );
    case 'multi': {
      const picked = (value as string[]) ?? [];
      return (
        <fieldset className="ticket-fieldset">
          <legend className="field-label">{label}</legend>
          {f.options.map((o) => (
            <label key={o} className="checkbox">
              <input
                type="checkbox"
                checked={picked.includes(o)}
                onChange={(e) => onChange(e.target.checked ? [...picked, o] : picked.filter((x) => x !== o))}
              />
              <span>{o}</span>
            </label>
          ))}
          {help}
        </fieldset>
      );
    }
    case 'yesno':
      return (
        <fieldset className="ticket-fieldset">
          <legend className="field-label">{label}</legend>
          <div className="segmented" role="radiogroup">
            {([true, false] as const).map((v) => (
              <button key={String(v)} type="button" role="radio" aria-checked={value === v} className="segmented-item" onClick={() => onChange(v)}>
                {v ? 'Yes' : 'No'}
              </button>
            ))}
          </div>
          {help}
        </fieldset>
      );
  }
}
