'use client';
// Settings, Developers: "Signing inside your site" (research/ux-notes.json, ds-dev-api). The websites that may
// show this account's signing pages and its sender screen inside their own pages (src/server/embed.ts). Admins only;
// with no website listed nothing can be shown in a frame anywhere else, which is how every account starts.
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api } from '../ui';
import { EMBED_ORIGINS_MAX, readTypedOrigin } from '@/lib/embed';
import { useST } from '@/components/senderLang';
import '@/app/styles/embed.css';

export function EmbedSites() {
  const T = useST();
  const [list, setList] = useState<string[] | null>(null);
  // Websites on this computer listed before, which do nothing on this server (embed.ts unusedOriginsOf). Usually none.
  const [unused, setUnused] = useState<string[]>([]);
  const [typed, setTyped] = useState('');
  const [error, setError] = useState('');
  // What just happened, said in place and read out by a screen reader: added, removed, already listed.
  const [told, setTold] = useState('');
  const box = useRef<HTMLInputElement>(null);
  const rows = useRef<HTMLUListElement>(null);
  useEffect(() => {
    api('/account/embed-origins').then((r) => (setList(r.origins), setUnused(r.not_used || []))).catch(() => setList(null));
  }, []);
  if (!list) return null;
  const full = list.length >= EMBED_ORIGINS_MAX;
  const add = (e: FormEvent) => {
    e.preventDefault();
    const o = readTypedOrigin(typed);
    setTold('');
    if ('why' in o) return setError(o.why);
    setError('');
    if (list.includes(o.origin)) return (setTold(T('settings.embed.already', { origin: o.origin })), setTyped(''));
    api('/account/embed-origins', { body: { origin: o.origin } })
      .then((r) => (setList(r.origins), setTyped(''), setTold(o.note || T('settings.embed.added', { origin: o.origin }))))
      .catch((x) => setError(x?.code || x?.message ? T.error(x) : T('settings.embed.not_added')));
  };
  const remove = (origin: string, at: number) => api(`/account/embed-origins?origin=${encodeURIComponent(origin)}`, { method: 'DELETE' })
    .then((r) => {
      setList(r.origins);
      setUnused(r.not_used || []);
      setError('');
      setTold(T('settings.embed.removed', { origin }));
      // The keyboard stays where the person was: on the next Remove button, or on the address box when none is left.
      requestAnimationFrame(() => {
        const buttons = rows.current?.querySelectorAll('button');
        const next = buttons?.[Math.min(at, buttons.length - 1)];
        (next || box.current)?.focus();
      });
    })
    .catch((x) => setError(x?.code || x?.message ? T.error(x) : T('settings.embed.not_removed')));
  return (
    <div className="card" data-item="card" data-feature="ds-dev-api" id="embed">
      <h2>{T('settings.embed.title')}</h2>
      <p className="muted small">{T('embed.says')} <a href="/developers#embed" target="_blank">{T('settings.embed.how')} ↗</a></p>
      {list.length > 0 && (
        <ul className="embed-sites" aria-label={T('settings.embed.list')} ref={rows}>
          {list.map((o, i) => (
            <li key={o} className="row between">
              <span className="truncate mono">{o}</span>
              <button className="btn sm ghost danger" onClick={() => remove(o, i)} aria-label={T('settings.embed.remove_one', { origin: o })}>{T('settings.embed.remove')}</button>
            </li>
          ))}
        </ul>
      )}
      {unused.length > 0 && (
        <ul className="embed-sites" aria-label={T('settings.embed.unused_list')}>
          {unused.map((o) => (
            <li key={o} className="row between">
              <span className="truncate mono muted">{T('settings.embed.unused', { origin: o })}</span>
              <button className="btn sm ghost danger" onClick={() => remove(o, list.length)} aria-label={T('settings.embed.remove_one', { origin: o })}>{T('settings.embed.remove')}</button>
            </li>
          ))}
        </ul>
      )}
      {full ? <p className="muted small">{T('settings.embed.full', { count: EMBED_ORIGINS_MAX })}</p> : (
        <form className="row" style={{ marginTop: 12 }} onSubmit={add} noValidate>
          <input ref={box} placeholder="portal.example.org" value={typed} onChange={(e) => (setTyped(e.target.value), setError(''))} aria-label={T('settings.embed.address')} aria-invalid={!!error} aria-describedby={error ? 'embed-error' : undefined} inputMode="url" autoComplete="off" autoCapitalize="off" spellCheck={false} />
          <button className="btn">{T('settings.embed.add')}</button>
        </form>
      )}
      <p className="muted small" role="status" aria-live="polite" style={{ marginTop: told ? 8 : 0 }}>{told}</p>
      {error && <div className="notice err" id="embed-error" role="alert">{error}</div>}
      <p className="muted small" style={{ marginTop: 8 }}>{T('embed.not')}</p>
    </div>
  );
}
