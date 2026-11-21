'use client';
// The page of a document: the account's own details on it, such as a case number (src/server/customfields.ts),
// folded and closed until asked for. Absent when it has none. A draft and a template change them in the editor. A
// document that is out changes them right here, with one Save and a line in its history; once it is completed they
// can no longer be changed.
import { useState } from 'react';
import Link from 'next/link';
import { api, toast, useLoad } from '@/components/ui';
import { SOURCE_LOCALE, t } from '@/lib/i18n';
import { customKey, type CustomDef } from '@/lib/customfields';
import { DetailBoxes, pairsFrom, typedFrom, firstProblem, type Pair, type Typed } from './DetailBoxes';

const ui = SOURCE_LOCALE;
const TALL = { minHeight: 44 };

export function CustomDetails({ envelope: e, editHref, onSaved }: { envelope: any; editHref: string | null; onSaved?: () => void }) {
  const [saved, setSaved] = useState<Pair[] | null>(null);
  const [defs, setDefs] = useState<CustomDef[] | null>(null);
  const [typed, setTyped] = useState<Typed>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const rows: Pair[] = saved || e.custom_fields || [];
  const out = e.kind === 'envelope' && e.status === 'sent';
  // A document that is out without any detail can still be given one, when the account has details at all.
  const [account] = useLoad<any>(() => (out && editHref && !(e.custom_fields || []).length ? api('/custom-fields') : Promise.resolve(null)), [e.id, out]);
  if (!rows.length && !(out && account?.fields?.length)) return null;
  const draft = e.status === 'draft';
  async function open() {
    setError('');
    try {
      setDefs((await api('/custom-fields')).fields || []);
      setTyped(typedFrom(rows));
    } catch (err: any) {
      toast(err?.status ? err.message : t(ui, 'customfields.offline'), true);
    }
  }
  async function save() {
    if (!defs) return;
    setBusy(true);
    setError('');
    try {
      const r = await api(`/envelopes/${e.id}/custom-fields`, { method: 'PUT', body: { custom_fields: pairsFrom(defs, typed, rows) } });
      setSaved(r.custom_fields);
      setDefs(null);
      toast(t(ui, 'customfields.step.saved_sent'));
      onSaved?.();
    } catch (err: any) {
      setError(err?.status ? err.message : t(ui, 'customfields.offline'));
    } finally {
      setBusy(false);
    }
  }
  const kept = defs ? rows.filter((p) => !defs.some((d) => customKey(d.name) === customKey(p.name))) : [];
  const wrong = defs ? firstProblem(defs, typed) : null;
  const same = defs ? JSON.stringify(pairsFrom(defs, typed, rows)) === JSON.stringify(rows.map((p) => ({ name: p.name, value: p.value }))) : true;
  return (
    <details className="card cf-details" style={{ marginTop: 16 }} data-fold="" data-feature="ds-custom-fields">
      <summary>{t(ui, 'customfields.page.title')} ({rows.length})</summary>
      {defs ? (
        <form className="cf-step" onSubmit={(ev) => (ev.preventDefault(), void save())} noValidate>
          <p className="muted small">{t(ui, 'customfields.page.change_hint')}</p>
          <DetailBoxes defs={defs} typed={typed} onChange={(d, v) => setTyped({ ...typed, [customKey(d.name)]: v })} idPrefix="cf-page" />
          {kept.map((p) => <div key={p.name} className="cf-value small"><b>{p.name}:</b> {p.value} <span className="muted">({t(ui, 'customfields.page.kept')})</span></div>)}
          {error && <p className="notice err" role="alert">{error}</p>}
          <div className="row wrap" style={{ marginTop: 8, gap: 8 }}>
            <button type="submit" className="btn" style={TALL} disabled={busy || same || !!wrong}>{busy ? t(ui, 'customfields.saving') : t(ui, 'customfields.save')}</button>
            <button type="button" className="btn" style={TALL} disabled={busy} onClick={() => setDefs(null)}>{t(ui, 'customfields.cancel')}</button>
          </div>
        </form>
      ) : (
        <>
          <dl>
            {rows.map((r) => (
              <div key={r.name}>
                <dt>{r.name}</dt>
                <dd>{r.value} <span className="muted small">({t(ui, r.on_certificate ? 'customfields.page.printed' : 'customfields.page.not_printed')})</span></dd>
              </div>
            ))}
          </dl>
          {out && editHref && <button type="button" className="btn sm" style={{ ...TALL, marginTop: 8 }} onClick={() => void open()}>{t(ui, 'customfields.page.change_here')}</button>}
          {draft && editHref && <p className="small" style={{ marginBottom: 0 }}><Link href={`${editHref}#details`} className="cf-link">{t(ui, 'customfields.page.change')}</Link></p>}
        </>
      )}
    </details>
  );
}
