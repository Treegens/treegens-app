'use client';
// The editor's part of the newer kinds of field (src/lib/fieldkinds.ts):
// - NameChoice: in a name field's panel, which name it holds (full, first or last), with the rule said.
// - DateFrom: in the panel of a "Date from another date", which date it counts from and how far.
// - FieldLookMore: under the field's More options, "Same answer as" and "Text style", and "Save for the team" for admins.
// - SavedPalette: the team's saved fields at the end of More fields.
import { useEffect, useState } from 'react';
import { api, toast } from '../ui';
import { useMe } from '../AppShell';
import {
  NAME_RULE, LINKABLE, linkOf, dateFromOf, dateFromWords, DATE_FROM_NOTE, DATE_UNITS, DATE_ADD_MAX, FONTS, colorsFor, SIZES, STYLED,
  lookOf, lookWords, SAVABLE, SAVED_NAME_MAX, buttonWords, isButton, type Look,
} from '@/lib/fieldkinds';
import { TLABEL } from './shared';

const TALL = { minHeight: 44 } as const;
const nameOf = (f: any) => (f?.label ? String(f.label) : `${TLABEL[f?.type] || 'Field'} on page ${Number(f?.page || 0) + 1}`);

/** Full name, first name or last name: one choice in a name field's own panel. */
export function NameChoice({ field, patch }: { field: any; patch: (p: any) => void }) {
  if (!['full_name', 'first_name', 'last_name'].includes(field.type)) return null;
  return (
    <label className="f"><span>Which name</span>
      <select style={TALL} value={field.type} onChange={(e) => patch({ type: e.target.value })}>
        <option value="full_name">Full name</option>
        <option value="first_name">First name</option>
        <option value="last_name">Last name</option>
      </select>
      <span className="hint">{field.type === 'full_name' ? 'Filled in with their name as you typed it.' : NAME_RULE[field.type]}</span>
    </label>
  );
}

/** The dates a "Date from another date" of this person can count from. */
export const dateSources = (fields: any[], recipientId: any, selfId?: string) =>
  fields.filter((g) => g.id !== selfId && g.recipient_id === recipientId && (g.type === 'date_signed' || (g.type === 'date' && !dateFromOf(g))));
/** Placed when only one date can be counted from: that one is chosen already. */
export const onlyDateSource = (fields: any[], recipientId: any): string => {
  const s = dateSources(fields, recipientId);
  return s.length === 1 ? s[0].id : '';
};
const srcName = (g: any) => (g.type === 'date_signed' && !g.label ? 'the date they sign' : nameOf(g));
/** What a field is called in its panel and on the page: a date from another date says so, and says its rule. */
export function kindTitle(f: any, fields: any[], short = false): string {
  const rule = dateFromOf(f);
  if (!rule) return TLABEL[f?.type] || 'Field';
  if (short) return 'Date from another date';
  const src = fields.find((g) => g.id === rule.from);
  return src ? dateFromWords(rule, srcName(src)) : 'Date from another date';
}

/** On an Approve or Decline button's panel: the words its person sees on it. */
export function ButtonWordsNote({ field, people }: { field: any; people: any[] }) {
  if (!isButton(field.type)) return null;
  const r = people.find((p) => p.id === field.recipient_id);
  if (!r) return null;
  const who = r.name || r.role_name || 'this person';
  const approver = people.some((p) => p.role === 'approver');
  return (
    <p className="muted small" style={{ margin: '0 0 12px' }}>
      For {who} this button reads {buttonWords(field.type, r.role)}.{r.role !== 'approver' && approver ? ' To give it to someone who approves, choose them under Assigned to.' : ''}
    </p>
  );
}

/** "Date from another date": which date of the same person it counts from, and how many days, weeks or months. */
export function DateFrom({ field, fields, patch }: { field: any; fields: any[]; patch: (p: any) => void }) {
  const rule = dateFromOf(field);
  if (field.type !== 'date' || !rule) return null;
  const sources = dateSources(fields, field.recipient_id, field.id);
  const src = sources.find((g) => g.id === rule.from);
  const set = (p: any) => patch({ date_from: { ...rule, ...p } });
  const n = Math.abs(rule.add);
  return (
    <div className="ed-datefrom" style={{ display: 'grid', gap: 8, margin: '4px 0 12px' }}>
      <label className="f" style={{ margin: 0 }}><span>Counted from</span>
        <select style={TALL} value={src ? src.id : ''} onChange={(e) => set({ from: e.target.value })}>
          <option value="">Choose a date</option>
          {sources.map((g) => <option key={g.id} value={g.id}>{g.type === 'date_signed' && !g.label ? 'The date they sign' : nameOf(g)}</option>)}
        </select>
      </label>
      {!sources.length && <p className="notice small" style={{ margin: 0 }}>Place a Date or Date signed field for the same person first. This date counts from it.</p>}
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <label className="f" style={{ margin: 0, flex: '1 1 80px' }}><span>How many</span>
          <input type="number" inputMode="numeric" min={0} max={DATE_ADD_MAX} style={TALL} value={n} onChange={(e) => set({ add: Math.min(DATE_ADD_MAX, Math.max(0, Math.round(Number(e.target.value) || 0))) * (rule.add < 0 ? -1 : 1) })} />
        </label>
        <label className="f" style={{ margin: 0, flex: '1 1 100px' }}><span>Of</span>
          <select style={TALL} value={rule.unit} onChange={(e) => set({ unit: e.target.value })}>{DATE_UNITS.map((u) => <option key={u} value={u}>{u}</option>)}</select>
        </label>
        <label className="f" style={{ margin: 0, flex: '1 1 100px' }}><span>Before or after</span>
          <select style={TALL} value={rule.add < 0 ? 'before' : 'after'} onChange={(e) => set({ add: n * (e.target.value === 'before' ? -1 : 1) })}>
            <option value="after">After</option><option value="before">Before</option>
          </select>
        </label>
      </div>
      <p className="muted small" style={{ margin: 0 }}>{src ? `${dateFromWords(rule, srcName(src))}. ${DATE_FROM_NOTE}` : 'Choose the date it counts from. Until then it cannot be sent.'}</p>
    </div>
  );
}

/** Under More options: "Same answer as", "Text style", and for an admin "Save for the team". */
export function FieldLookMore({ field, fields, patch, patchMany }: { field: any; fields: any[]; patch: (p: any) => void; patchMany: (ids: string[], p: any) => void }) {
  const me = useMe();
  const admin = me?.role === 'owner' || me?.role === 'admin';
  const look = lookOf(field.look);
  const brand = useTeamFields(STYLED.includes(field.type))?.brand_color;
  const setLook = (p: Partial<Look> | null) => {
    const next = p === null ? null : lookOf({ ...(look || {}), ...p });
    patch({ look: next });
  };
  const same = LINKABLE.includes(field.type) && !dateFromOf(field) ? fields.filter((g) => g.id !== field.id && g.recipient_id === field.recipient_id && g.type === field.type && !g.readonly && !dateFromOf(g)) : [];
  const link = linkOf(field);
  const partner = link ? fields.find((g) => g.id !== field.id && g.recipient_id === field.recipient_id && g.type === field.type && linkOf(g) === link) : null;
  const pick = (id: string) => {
    if (!id) return patch({ link: null });
    const g = fields.find((x) => x.id === id);
    const key = linkOf(g) || g?.label || `Answer ${id.slice(-4)}`;
    // Both get the same link, in one step of the editor's history.
    patchMany([field.id, id], { link: key });
  };
  return (
    <>
      {same.length > 0 && (
        <label className="f"><span>Same answer as</span>
          <select style={TALL} value={partner?.id || ''} onChange={(e) => pick(e.target.value)}>
            <option value="">No other field</option>
            {same.map((g) => <option key={g.id} value={g.id}>{nameOf(g)}</option>)}
          </select>
        </label>
      )}
      {STYLED.includes(field.type) && (
        <details data-fold className="ed-fold">
          <summary style={TALL}>Text style: {lookWords(look)}</summary>
          <div style={{ display: 'grid', gap: 8, marginTop: 8 }}>
            <label className="f" style={{ margin: 0 }}><span>Font</span>
              <select style={TALL} value={look?.font || 'sans'} onChange={(e) => setLook({ font: e.target.value as any })}>{FONTS.map((f) => <option key={f.key} value={f.key}>{f.name}</option>)}</select>
            </label>
            <label className="f" style={{ margin: 0 }}><span>Size <span className="hint">(points; smaller when it does not fit)</span></span>
              <select style={TALL} value={look?.size ?? ''} onChange={(e) => setLook({ size: e.target.value === '' ? undefined : Number(e.target.value) })}>
                <option value="">Fits the box</option>
                {[...new Set([...SIZES, ...(look?.size ? [look.size] : [])])].sort((a, b) => a - b).map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>
            <label className="f" style={{ margin: 0 }}><span>Colour</span>
              <select style={TALL} value={look?.color || 'black'} onChange={(e) => setLook({ color: e.target.value as any })}>{colorsFor(brand, look?.color).map((c) => <option key={c.key} value={c.key}>{c.name}</option>)}</select>
            </label>
            <label className="check ed-tap"><input type="checkbox" checked={!!look?.bold} onChange={(e) => setLook({ bold: e.target.checked || undefined })} /> Bold</label>
            {look && <button type="button" className="btn sm" style={TALL} onClick={() => setLook(null)}>Back to the usual style</button>}
            <p className="muted small" style={{ margin: 0 }}>Serif and Typewriter have Latin letters only. Other writing is printed in the usual font.</p>
          </div>
        </details>
      )}
      {admin && SAVABLE.includes(field.type) && <SaveForTeam field={field} />}
    </>
  );
}

function SaveForTeam({ field }: { field: any }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(field.label || '');
  const [busy, setBusy] = useState(false);
  if (!open) return <button type="button" className="btn sm" style={{ ...TALL, width: '100%', marginBottom: 8 }} onClick={() => (setName(field.label || ''), setOpen(true))}>Save for the team</button>;
  const save = async () => {
    setBusy(true);
    try {
      await api('/saved-fields', { body: { name, field } });
      toast(`Saved. Everyone on your team finds ${name.trim()} under More fields.`);
      setOpen(false);
      teamCache = null;
    } catch (e: any) {
      toast(e?.message || 'That could not be saved. Try again.', true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div style={{ display: 'grid', gap: 8, marginBottom: 8 }}>
      <label className="f" style={{ margin: 0 }}><span>Name for the team <span className="hint">(the same name replaces the one saved before)</span></span>
        <input style={TALL} value={name} maxLength={SAVED_NAME_MAX} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && save()} />
      </label>
      <p className="muted small" style={{ margin: 0 }}>Its kind, label, format, size and text style are saved. Never what is filled in, nor who it is for.</p>
      <div className="row" style={{ gap: 8 }}>
        <button type="button" className="btn sm" style={TALL} onClick={() => setOpen(false)}>Cancel</button>
        <button type="button" className="btn sm" style={TALL} disabled={busy || !name.trim()} onClick={save}>Save</button>
      </div>
    </div>
  );
}

let teamCache: Promise<any> | null = null;
/** The team's saved fields and brand colour (GET /saved-fields), read once per page. */
function useTeamFields(on: boolean): any | null {
  const [data, setData] = useState<any>(null);
  useEffect(() => {
    if (!on) return;
    teamCache ??= api('/saved-fields').catch(() => ((teamCache = null), null));
    let live = true;
    teamCache.then((d) => live && setData(d));
    return () => {
      live = false;
    };
  }, [on]);
  return data;
}
/** The team's saved fields, read once per page. */
export const useSavedFields = (on: boolean): any[] => useTeamFields(on)?.saved_fields || [];

/** The team's saved fields at the end of More fields. Each drops onto the page in view, like a kind from the keyboard. */
export function SavedPalette({ open, onAdd, disabled }: { open: boolean; onAdd: (type: string, over: any) => void; disabled?: boolean }) {
  const saved = useSavedFields(open);
  if (!open || !saved.length) return null;
  return (
    <>
      {saved.map((s) => {
        const { type, w, h, ...rest } = s.field || {};
        return (
          <button key={s.id} type="button" disabled={disabled} title={`Saved by your team: ${TLABEL[type] || type}`} onClick={() => onAdd(type, { ...rest, ...(w ? { w } : {}), ...(h ? { h } : {}) })}>
            {s.name}
          </button>
        );
      })}
    </>
  );
}
