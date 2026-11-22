'use client';
// Settings, Sending: the team's saved fields and the text style new fields start with (src/server/fieldkinds.ts).
// One card under More options, "Saved fields and text style": a field is saved from its More options in the editor;
// here admins see them, delete one and set the text style new fields start with (a fold, closed every time). Members
// see the card only when the team has a saved field.
import { useState } from 'react';
import { api, useLoad, toast } from '@/components/ui';
import { useMe } from '@/components/AppShell';
import { FONTS, colorsFor, SIZES, lookOf, lookWords, KIND_LABEL, type Look } from '@/lib/fieldkinds';
import { useST } from '@/components/senderLang';

const TALL = { minHeight: 44 };
// The name of a field's kind: settings.fieldkind.<type> in en.json, else the newer kinds' names from src/lib/fieldkinds.ts.
const kindName = (T: (k: string) => string, type: string) => T(`settings.fieldkind.${type}`) || (KIND_LABEL as Record<string, string>)[type] || T('settings.fieldkind.field');

export function SavedFieldSettings() {
  const me = useMe();
  const T = useST();
  const admin = me.role === 'owner' || me.role === 'admin';
  const [data, reload] = useLoad<any>(() => api('/saved-fields'), []);
  const [busy, setBusy] = useState('');
  if (!data) return null;
  const list: any[] = data.saved_fields || [];
  const look = lookOf(data.field_look);
  const setLook = async (p: Partial<Look> | null) => {
    setBusy('look');
    try {
      await api('/saved-fields/look', { method: 'PUT', body: { field_look: p === null ? null : lookOf({ ...(look || {}), ...p }) } });
      toast(T('settings.fields.look_saved'));
      reload();
    } catch (e: any) {
      toast(e?.code || e?.message ? T.error(e) : T('settings.fields.not_saved'), true);
    } finally {
      setBusy('');
    }
  };
  // A member sees the card once the team has a saved field; an admin always, under the closed More options.
  if (!list.length && !admin) return null;
  const remove = async (s: any) => {
    setBusy(s.id);
    try {
      await api(`/saved-fields/${s.id}`, { method: 'DELETE' });
      toast(T('settings.fields.deleted', { name: s.name }));
      reload();
    } catch (e: any) {
      toast(e?.code || e?.message ? T.error(e) : T('settings.fields.not_deleted'), true);
    } finally {
      setBusy('');
    }
  };
  // With zero setup it is one closed fold, not a card: nothing is there yet but the way to start.
  if (!list.length && !look)
    return (
      <details data-fold className="ed-fold" data-feature="ds-fields-kinds">
        <summary style={TALL} id="set-sf-h">{T('settings.fields.title')}</summary>
        <p className="muted small">{T('settings.fields.none_yet')} {T('settings.fields.how')}</p>
        <StyleFold look={look} brand={data.brand_color} busy={!!busy} setLook={setLook} />
      </details>
    );
  return (
    <section className="card" aria-labelledby="set-sf-h" data-item="card" data-feature="ds-fields-kinds">
      <h2 id="set-sf-h" style={{ marginBottom: 6 }}>{T('settings.fields.title')}</h2>
      {list.length === 0 ? (
        <p className="muted small" style={{ margin: 0 }}>{T('settings.fields.none')} {T('settings.fields.how')}</p>
      ) : (
        <ul className="cf-list" aria-label={T('settings.fields.list')}>
          {list.map((s) => (
            <li key={s.id} className="cf-item row between" style={{ gap: 8 }}>
              <div className="grow">
                <b>{s.name}</b>
                <div className="muted small">{kindName(T, s.field?.type)}{s.field?.label && s.field.label !== s.name ? T('settings.fields.labelled', { label: s.field.label }) : ''}{s.field?.required ? T('settings.fields.required') : ''}{s.field?.look ? `, ${lookWords(lookOf(s.field.look)).toLowerCase()}` : ''}</div>
              </div>
              {admin && <button type="button" className="btn sm danger" style={TALL} disabled={busy === s.id} onClick={() => remove(s)}>{T('settings.fields.delete', { name: s.name })}</button>}
            </li>
          ))}
        </ul>
      )}
      {admin && <StyleFold look={look} brand={data.brand_color} busy={!!busy} setLook={setLook} />}
    </section>
  );
}

/** The text style new fields start with, under its own fold. */
function StyleFold({ look, brand, busy, setLook }: { look: Look | null; brand: string | null; busy: boolean; setLook: (p: Partial<Look> | null) => void }) {
  const T = useST();
  return (
    <details data-fold className="ed-fold" style={{ marginTop: 12 }} data-feature="ds-fields-kinds">
      <summary style={TALL}>{T('settings.fields.style', { look: lookWords(look) })}</summary>
      <div className="grid g2" style={{ gap: 8, marginTop: 8 }}>
        <label className="f" style={{ margin: 0 }}><span>{T('settings.fields.font')}</span>
          <select style={TALL} disabled={busy} value={look?.font || 'sans'} onChange={(e) => setLook({ font: e.target.value as any })}>{FONTS.map((f) => <option key={f.key} value={f.key}>{f.name}</option>)}</select>
        </label>
        <label className="f" style={{ margin: 0 }}><span>{T('settings.fields.size')} <span className="hint">{T('settings.fields.size_hint')}</span></span>
          <select style={TALL} disabled={busy} value={look?.size ?? ''} onChange={(e) => setLook({ size: e.target.value === '' ? undefined : Number(e.target.value) })}>
            <option value="">{T('settings.fields.fits')}</option>
            {[...new Set([...SIZES, ...(look?.size ? [look.size] : [])])].sort((a, b) => a - b).map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
        <label className="f" style={{ margin: 0 }}><span>{T('settings.fields.colour')}</span>
          <select style={TALL} disabled={busy} value={look?.color || 'black'} onChange={(e) => setLook({ color: e.target.value as any })}>{colorsFor(brand, look?.color).map((c) => <option key={c.key} value={c.key}>{c.name}</option>)}</select>
        </label>
        <label className="check ed-tap" style={{ alignSelf: 'end' }}><input type="checkbox" disabled={busy} checked={!!look?.bold} onChange={(e) => setLook({ bold: e.target.checked || undefined })} /> {T('settings.fields.bold')}</label>
      </div>
      {look && <button type="button" className="btn sm" style={{ ...TALL, marginTop: 8 }} disabled={busy} onClick={() => setLook(null)}>{T('settings.fields.usual')}</button>}
      <p className="muted small" style={{ marginBottom: 0 }}>{T('settings.fields.style_note')}</p>
    </details>
  );
}

/** Settings, Sending, More options: the team's saved fields and the text style new fields start with. */
export const SavedFieldsCard = () => <SavedFieldSettings />;
