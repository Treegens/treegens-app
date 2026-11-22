'use client';
// Settings, API and webhooks: "Signing inside your site" (research/ux-notes.json, ds-dev-api). The websites that may
// show this account's signing pages and its sender screen inside their own pages (src/server/embed.ts). Admins only;
// with no website listed nothing can be shown in a frame anywhere else, which is how every account starts.
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api } from '../ui';
import { EMBED_NOT, EMBED_ORIGINS_MAX, EMBED_SAYS, readTypedOrigin } from '@/lib/embed';
import '@/app/styles/embed.css';

export function EmbedSites() {
  const [list, setList] = useState<string[] | null>(null);
  const [typed, setTyped] = useState('');
  const [error, setError] = useState('');
  // What just happened, said in place and read out by a screen reader: added, removed, already listed.
  const [told, setTold] = useState('');
  const box = useRef<HTMLInputElement>(null);
  const rows = useRef<HTMLUListElement>(null);
  useEffect(() => {
    api('/account/embed-origins').then((r) => setList(r.origins)).catch(() => setList(null));
  }, []);
  if (!list) return null;
  const full = list.length >= EMBED_ORIGINS_MAX;
  const add = (e: FormEvent) => {
    e.preventDefault();
    const o = readTypedOrigin(typed);
    setTold('');
    if ('why' in o) return setError(o.why);
    setError('');
    if (list.includes(o.origin)) return (setTold(`${o.origin} is already listed. Nothing changed.`), setTyped(''));
    api('/account/embed-origins', { body: { origin: o.origin } })
      .then((r) => (setList(r.origins), setTyped(''), setTold(o.note || `Added ${o.origin}.`)))
      .catch((x) => setError(x?.message || 'That website was not added. Try again in a moment.'));
  };
  const remove = (origin: string, at: number) => api(`/account/embed-origins?origin=${encodeURIComponent(origin)}`, { method: 'DELETE' })
    .then((r) => {
      setList(r.origins);
      setError('');
      setTold(`Removed ${origin}.`);
      // The keyboard stays where the person was: on the next Remove button, or on the address box when none is left.
      requestAnimationFrame(() => {
        const buttons = rows.current?.querySelectorAll('button');
        const next = buttons?.[Math.min(at, buttons.length - 1)];
        (next || box.current)?.focus();
      });
    })
    .catch((x) => setError(x?.message || 'That website was not removed. Try again in a moment.'));
  return (
    <div className="card" data-item="card" data-feature="ds-dev-api" id="embed">
      <h2>Signing inside your site</h2>
      <p className="muted small">{EMBED_SAYS} <a href="/developers#embed" target="_blank">How to use it ↗</a></p>
      {list.length > 0 && (
        <ul className="embed-sites" aria-label="Websites that can show your pages" ref={rows}>
          {list.map((o, i) => (
            <li key={o} className="row between">
              <span className="truncate mono">{o}</span>
              <button className="btn sm ghost danger" onClick={() => remove(o, i)} aria-label={`Remove ${o}`}>Remove</button>
            </li>
          ))}
        </ul>
      )}
      {full ? <p className="muted small">{EMBED_ORIGINS_MAX} websites are listed, which is the most. Remove one to add another.</p> : (
        <form className="row" style={{ marginTop: 12 }} onSubmit={add} noValidate>
          <input ref={box} placeholder="portal.example.org" value={typed} onChange={(e) => (setTyped(e.target.value), setError(''))} aria-label="Website address" aria-invalid={!!error} aria-describedby={error ? 'embed-error' : undefined} inputMode="url" autoComplete="off" autoCapitalize="off" spellCheck={false} />
          <button className="btn">Add website</button>
        </form>
      )}
      <p className="muted small" role="status" aria-live="polite" style={{ marginTop: told ? 8 : 0 }}>{told}</p>
      {error && <div className="notice err" id="embed-error" role="alert">{error}</div>}
      <p className="muted small" style={{ marginTop: 8 }}>{EMBED_NOT}</p>
    </div>
  );
}
