'use client';
// Settings, Account: the account's custom fields (src/server/customfields.ts). Admins add, change and delete them;
// members read them, because they fill them in on the last step of the editor. The limits and the checks of a value
// are the server's own (src/lib/customfields.ts), so the form refuses here what the server would refuse.
import { useState } from 'react';
import { api, useLoad, toast } from '@/components/ui';
import { useMe } from '@/components/AppShell';
import { Dialog } from '@/components/sender/Dialog';
import { SOURCE_LOCALE, t } from '@/lib/i18n';
import { MAX_CUSTOM_FIELDS, CUSTOM_NAME_MAX, CUSTOM_VALUE_MAX, CUSTOM_CHOICES_MAX, nameProblem, lineProblem, customKey, type CustomDef } from '@/lib/customfields';

// The sender's own screens are in English until they are translated, so their words are asked for in English.
const ui = SOURCE_LOCALE;
const TALL = { minHeight: 44 };

/** One short line about a field: its kind, whether it is required, and whether it is printed on the certificate. */
export const fieldLine = (d: Pick<CustomDef, 'kind' | 'choices' | 'required' | 'on_certificate'>) =>
  [d.kind === 'list' ? t(ui, 'customfields.kind_list_n', { count: d.choices.length }) : t(ui, 'customfields.kind_text'),
    t(ui, d.required ? 'customfields.required' : 'customfields.optional'), t(ui, d.on_certificate ? 'customfields.on_cert' : 'customfields.off_cert')].join(', ');

type Form = { id?: string; name: string; kind: 'text' | 'list'; choices: string; required: boolean; on_certificate: boolean };
const EMPTY: Form = { name: '', kind: 'text', choices: '', required: false, on_certificate: true };

// What the form would be refused for, said before it is sent.
function formProblem(f: Form, others: CustomDef[]): string | null {
  const name = f.name.trim();
  const no = nameProblem(name);
  if (no) return no;
  if (others.some((d) => d.id !== f.id && customKey(d.name) === customKey(name))) return t(ui, 'customfields.taken', { name });
  if (f.kind === 'list') {
    const lines = f.choices.split('\n').map((x) => x.trim()).filter(Boolean);
    if (!lines.length) return t(ui, 'customfields.need_choice');
    if (lines.length > CUSTOM_CHOICES_MAX) return t(ui, 'customfields.too_many_choices', { max: CUSTOM_CHOICES_MAX, count: lines.length });
    for (const [i, c] of lines.entries()) {
      const bad = lineProblem(c, CUSTOM_VALUE_MAX, t(ui, 'customfields.choice_n', { n: i + 1 }));
      if (bad) return bad;
      if (lines.slice(0, i).some((x) => customKey(x) === customKey(c))) return t(ui, 'customfields.choice_twice', { choice: c });
    }
  }
  return null;
}

export function CustomFieldSettings() {
  const me = useMe();
  const [data, reload, failed] = useLoad<any>(() => api('/custom-fields'), []);
  const [form, setForm] = useState<Form | null>(null);
  const [gone, setGone] = useState<CustomDef | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notes, setNotes] = useState<string[]>([]);
  const admin = me.role !== 'member';
  if (failed) return <section className="card" style={{ marginTop: 16 }}><h2>{t(ui, 'customfields.title')}</h2><p className="notice err" role="alert">{t(ui, 'customfields.load_failed')}</p></section>;
  if (!data) return null;
  const fields: CustomDef[] = data.fields;
  const full = fields.length >= MAX_CUSTOM_FIELDS;

  const open = (f: Form) => (setForm(f), setError(''));
  async function save() {
    if (!form) return;
    const wrong = formProblem(form, fields);
    if (wrong) return setError(wrong);
    setBusy(true);
    try {
      const body = { name: form.name.trim(), kind: form.kind, choices: form.kind === 'list' ? form.choices.split('\n').map((x) => x.trim()).filter(Boolean) : [], required: form.required, on_certificate: form.on_certificate };
      const r = await api(form.id ? `/custom-fields/${form.id}` : '/custom-fields', { method: form.id ? 'PATCH' : 'POST', body });
      toast(t(ui, form.id ? 'customfields.changed' : 'customfields.added', { name: r.field.name }));
      setNotes(r.notes || []);
      setForm(null);
      reload();
    } catch (e: any) {
      setError(e?.status ? e.message : t(ui, 'customfields.offline'));
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    if (!gone) return;
    setBusy(true);
    try {
      const r = await api(`/custom-fields/${gone.id}`, { method: 'DELETE' });
      toast(t(ui, 'customfields.deleted', { name: r.name, drafts: r.drafts_cleared, sent: r.sent_kept }));
      setNotes([]);
      setGone(null);
      reload();
    } catch (e: any) {
      toast(e?.status ? e.message : t(ui, 'customfields.offline'), true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card" style={{ marginTop: 16 }} aria-labelledby="set-cf-h">
      <h2 id="set-cf-h" style={{ marginBottom: 6 }}>{t(ui, 'customfields.title')}</h2>
      <p className="muted small" style={{ marginTop: 0 }}>{t(ui, 'customfields.intro')}</p>
      {!admin && <p className="muted small">{t(ui, 'customfields.admins_only')}</p>}
      {notes.length > 0 && <div className="notice warn" role="status">{notes.map((x) => <div key={x}>{x}</div>)}</div>}
      {fields.length === 0 ? <p className="muted">{t(ui, 'customfields.none')}</p> : (
        <ul className="cf-list" aria-label={t(ui, 'customfields.title')}>
          {fields.map((d) => (
            <li key={d.id} className="cf-item">
              <div className="grow">
                <b className="cf-name">{d.name}</b>
                <div className="muted small">{fieldLine(d)}</div>
                {d.kind === 'list' && <div className="muted small cf-choices">{t(ui, 'customfields.choices_are', { choices: d.choices.join(', ') })}</div>}
              </div>
              {admin && (
                <div className="row wrap cf-actions">
                  <button type="button" className="btn sm" style={TALL} onClick={() => open({ id: d.id, name: d.name, kind: d.kind, choices: d.choices.join('\n'), required: d.required, on_certificate: d.on_certificate })} aria-label={t(ui, 'customfields.change_named', { name: d.name })}>{t(ui, 'customfields.change')}</button>
                  <button type="button" className="btn sm ghost" style={TALL} onClick={() => setGone(d)} aria-label={t(ui, 'customfields.delete_named', { name: d.name })}>{t(ui, 'customfields.delete')}</button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {admin && (full ? <p className="muted small">{t(ui, 'customfields.full', { max: MAX_CUSTOM_FIELDS })}</p> : (
        <div className="row wrap" style={{ marginTop: 10, alignItems: 'center' }}>
          <button type="button" className="btn" style={TALL} onClick={() => open(EMPTY)}>{t(ui, 'customfields.add')}</button>
          <span className="muted small">{t(ui, 'customfields.count', { count: fields.length, max: MAX_CUSTOM_FIELDS })}</span>
        </div>
      ))}
      {data.past_names?.length > 0 && <p className="muted small">{t(ui, 'customfields.past', { names: data.past_names.join(', ') })}</p>}

      {form && (
        <Dialog title={form.id ? t(ui, 'customfields.change_title', { name: fields.find((d) => d.id === form.id)?.name || form.name }) : t(ui, 'customfields.add_title')} onClose={() => setForm(null)}>
          <form onSubmit={(e) => (e.preventDefault(), void save())} noValidate>
            <label className="f"><span>{t(ui, 'customfields.name')}</span>
              <input value={form.name} maxLength={CUSTOM_NAME_MAX} data-autofocus="" autoComplete="off" style={TALL} placeholder={t(ui, 'customfields.name_example')} onChange={(e) => (setForm({ ...form, name: e.target.value }), setError(''))} aria-invalid={!!error && !!nameProblem(form.name.trim())} />
            </label>
            <fieldset className="f cf-kind">
              <legend>{t(ui, 'customfields.kind')}</legend>
              <label className="cf-radio"><input type="radio" name="cf-kind" checked={form.kind === 'text'} onChange={() => setForm({ ...form, kind: 'text' })} /> {t(ui, 'customfields.kind_text_choice')}</label>
              <label className="cf-radio"><input type="radio" name="cf-kind" checked={form.kind === 'list'} onChange={() => setForm({ ...form, kind: 'list' })} /> {t(ui, 'customfields.kind_list_choice')}</label>
            </fieldset>
            {form.kind === 'list' && (
              <label className="f"><span>{t(ui, 'customfields.choices')}</span>
                <textarea className="cf-textarea" rows={5} value={form.choices} aria-describedby="cf-choices-hint" onChange={(e) => (setForm({ ...form, choices: e.target.value }), setError(''))} />
                <span id="cf-choices-hint" className="hint">{t(ui, 'customfields.choices_hint', { max: CUSTOM_CHOICES_MAX })}</span>
              </label>
            )}
            <label className="cf-check"><input type="checkbox" checked={form.required} onChange={(e) => setForm({ ...form, required: e.target.checked })} aria-describedby="cf-required-hint" /> {t(ui, 'customfields.required_choice')}</label>
            <p id="cf-required-hint" className="muted small cf-hint">{t(ui, 'customfields.required_hint')}</p>
            <label className="cf-check"><input type="checkbox" checked={form.on_certificate} onChange={(e) => setForm({ ...form, on_certificate: e.target.checked })} aria-describedby="cf-cert-hint" /> {t(ui, 'customfields.cert_choice')}</label>
            <p id="cf-cert-hint" className="muted small cf-hint">{t(ui, 'customfields.cert_hint')}</p>
            {form.id && <p className="muted small">{t(ui, 'customfields.change_hint')}</p>}
            {error && <p className="notice err" role="alert">{error}</p>}
            <div className="actions">
              <button type="button" className="btn" style={TALL} onClick={() => setForm(null)}>{t(ui, 'customfields.cancel')}</button>
              <button type="submit" className="btn primary" style={TALL} disabled={busy}>{busy ? t(ui, 'customfields.saving') : t(ui, 'customfields.save')}</button>
            </div>
          </form>
        </Dialog>
      )}
      {gone && (
        <Dialog title={t(ui, 'customfields.delete_title', { name: gone.name })} onClose={() => setGone(null)}>
          <p>{t(ui, 'customfields.delete_body')}</p>
          <div className="actions">
            <button type="button" className="btn" style={TALL} data-autofocus="" onClick={() => setGone(null)}>{t(ui, 'customfields.keep')}</button>
            <button type="button" className="btn danger" style={TALL} disabled={busy} onClick={() => void remove()}>{busy ? t(ui, 'customfields.deleting') : t(ui, 'customfields.delete_yes')}</button>
          </div>
        </Dialog>
      )}
    </section>
  );
}
