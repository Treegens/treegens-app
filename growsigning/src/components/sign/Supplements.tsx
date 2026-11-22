'use client';
// "Also for you" above the document on the signing page: the files given to read with it, not signed, such as a
// privacy notice (research/ux-notes.json, ds-supplements). Only when the sender gave some. A file opens in a dialog;
// one that must be acknowledged has the tick "I have been given <name>" next to it. What Finish still waits for is
// said here, and the server checks it again at Finish (src/server/supplements.ts). Opened means the file was opened,
// never that it was read, so the page never says read.
import { useEffect, useState } from 'react';
import { PdfDoc } from '@/components/PdfDoc';
import { api } from '@/components/ui';
import { Dialog } from './Dialog';
import { useT } from './lang';

export type Supplement = { id: string; name: string; pages: number; sha256: string; rule: 'none' | 'open' | 'acknowledge'; opened: boolean; acknowledged: boolean };

/** The id of the list, so a refusal at Finish can bring the person back to it. */
export const ALSO_ID = 'sg-also';

/** What the signing page counts as places left (its Next, its count and its guide line). */
export type AlsoLeft = { left: number; total: number; guide: string };
export const NO_ALSO: AlsoLeft = { left: 0, total: 0, guide: '' };

/** Next, when only files to read are left: to the first one still to open or tick, or else the list. */
export function focusAlso() {
  const el = (document.querySelector(`#${ALSO_ID} [data-missing]`) || document.getElementById(ALSO_ID)) as HTMLElement | null;
  el?.scrollIntoView({ block: 'center' });
  el?.focus({ preventScroll: true });
}

export function Supplements({ base, list, canTick, finish = 'Finish', onLeft }: { base: string; list?: Supplement[]; canTick: boolean; finish?: string; onLeft?: (a: AlsoLeft) => void }) {
  const T = useT();
  // What this page saw happen since the list came from the server, by file as it is now (its SHA-256). A new list
  // (after a reload, a replaced file or a correction) starts from what the server says.
  const [seen, setSeen] = useState<Record<string, { opened?: boolean; acknowledged?: boolean }>>({});
  useEffect(() => setSeen({}), [list]);
  const [open, setOpen] = useState<Supplement | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const key = (s: Supplement) => `${s.id}:${s.sha256}`;
  const items = (list || []).map((s) => ({ ...s, ...seen[key(s)] }));
  const url = (s: Supplement, download = false) => `/api${base}/supplements/${s.id}?v=${s.sha256}${download ? '&download=1' : ''}`;
  const opened = (s: Supplement) => setSeen((m) => ({ ...m, [key(s)]: { ...m[key(s)], opened: true } }));
  const missing = canTick ? items.filter((s) => (s.rule === 'open' && !s.opened) || (s.rule === 'acknowledge' && !s.acknowledged)) : [];
  const total = canTick ? items.filter((s) => s.rule !== 'none').length : 0;
  // "Open Privacy notice and tick 'I have been given House rules' above the document, then choose Finish."
  const todo = missing.map((s) => T(s.rule === 'open' ? 'sign.supplements.guide_open' : 'sign.supplements.guide_tick', { name: s.name }));
  const joined = todo.length < 2 ? todo.join('') : `${todo.slice(0, -1).join(', ')} ${T('sign.supplements.and')} ${todo.at(-1)}`;
  const guide = joined ? T('sign.supplements.guide', { todo: joined.charAt(0).toUpperCase() + joined.slice(1), finish }) : '';
  useEffect(() => onLeft?.({ left: missing.length, total, guide }), [missing.length, total, guide]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!list?.length) return null;

  async function tick(s: Supplement) {
    setBusy(s.id);
    setError('');
    try {
      await api(`${base}/supplements/${s.id}/acknowledge`, { body: {} });
      setSeen((m) => ({ ...m, [key(s)]: { ...m[key(s)], acknowledged: true } }));
    } catch (e: any) {
      setError(e?.code ? T.error(e) : T('sign.supplements.failed'));
    } finally {
      setBusy('');
    }
  }

  return (
    <section id={ALSO_ID} tabIndex={-1} className="card sg-also" aria-labelledby={`${ALSO_ID}-h`} data-feature="ds-supplements" style={{ padding: '12px 14px', margin: '0 0 12px' }}>
      <h2 id={`${ALSO_ID}-h`} style={{ fontSize: 16, margin: 0 }}>{T('sign.supplements.title')}</h2>
      <p className="muted small" style={{ margin: '2px 0 6px' }}>{T('sign.supplements.lead')}</p>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 4 }}>
        {items.map((s) => (
          <li key={s.id} style={{ display: 'grid', gap: 2 }}>
            <div className="row wrap" style={{ gap: 8, alignItems: 'center' }}>
              {/* The first file still to open or tick is where Next goes (focusAlso). */}
              <button type="button" className="btn sm" style={{ minHeight: 44, textAlign: 'left' }} onClick={() => setOpen(s)} data-missing={(s.rule === 'open' && missing[0]?.id === s.id) || undefined}
                aria-label={T(s.rule === 'open' && !s.opened && canTick ? 'sign.supplements.open_must' : 'sign.supplements.open', { name: s.name })}>
                {s.name}
              </button>
              {s.opened ? <span className="muted small">{T('sign.supplements.opened')}</span>
                : s.rule === 'open' && canTick ? <span className="muted small" aria-hidden="true">{T('sign.supplements.must_open_tag')}</span> : null}
              {/* Opening a file does not tick it: the tag stays until the box below is ticked. */}
              {s.rule === 'acknowledge' && canTick && !s.acknowledged ? <span className="muted small" aria-hidden="true">{T('sign.supplements.must_tick_tag')}</span> : null}
            </div>
            {s.rule === 'acknowledge' && canTick && (
              <label className="check" style={{ minHeight: 44, paddingLeft: 4 }}>
                {/* Once saved it stays ticked in its own colour (not greyed out as if broken), and cannot be taken back. */}
                <input type="checkbox" style={{ width: 20, height: 20 }} checked={!!s.acknowledged || busy === s.id} disabled={busy === s.id} aria-readonly={s.acknowledged || undefined}
                  data-missing={(!s.acknowledged && missing[0]?.id === s.id) || undefined} onChange={(e) => !s.acknowledged && e.target.checked && void tick(s)} />
                <span>{T('sign.supplements.given', { name: s.name })}{s.acknowledged && <span className="muted small"> · {T('sign.supplements.saved')}</span>}</span>
              </label>
            )}
          </li>
        ))}
      </ul>
      {error && <p className="notice warn small" role="alert" style={{ margin: '6px 0 0' }}>{error}</p>}
      {missing.length > 0 && <p className="small" style={{ margin: '6px 0 0' }} aria-live="polite">{T('sign.supplements.missing', { names: missing.map((s) => `${s.rule === 'open' ? T('sign.supplements.must_open') : T('sign.supplements.must_tick')} ${s.name}`).join(', ') })}</p>}
      {open && (
        <Dialog title={open.name} wide onClose={() => setOpen(null)}>
          <PdfDoc key={open.sha256} url={url(open)} maxWidth={760} onShown={() => opened(open)} />
          <div className="row wrap" style={{ gap: 8, marginTop: 12 }}>
            <a className="btn" style={{ minHeight: 44 }} href={url(open, true)} onClick={() => opened(open)}>{T('sign.supplements.download', { name: open.name })}</a>
            <button type="button" className="btn ghost" style={{ minHeight: 44 }} onClick={() => setOpen(null)}>{T('sign.supplements.close')}</button>
          </div>
        </Dialog>
      )}
    </section>
  );
}
