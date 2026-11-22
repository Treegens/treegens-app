'use client';
// "Add another template" in the Use dialog of the Templates page (research/ux-charter.md, 2.4): one quiet link that
// opens a list of the other templates and an Add button. The document then starts from all of them, one after the
// other, and a role with the same name in two of them is one person (src/server/tplcombine.ts). Nothing changes until
// Add is pressed (choosing in the list with the arrow keys adds nothing), and each added template is listed with a
// Remove, so a wrong one can go again without losing the names already typed.
import { useState } from 'react';
import { api } from '@/components/ui';
import { fail } from '@/components/sender/feedback';
import { MAX_COMBINED, roleKey, combinedName } from '@/lib/tplcombine';

/** The dialog's template (the envelope GET /envelopes/:id gave) with another one added. */
export function withTemplate(use: any, more: any) {
  const extra = [...(use.more || []), more];
  const seen = new Set<string>((use.recipients || []).map((r: any) => roleKey(r.role_name)).filter(Boolean));
  const add: any[] = [];
  for (const r of more.recipients || []) {
    const k = roleKey(r.role_name);
    if (k && seen.has(k)) continue;
    if (k) seen.add(k);
    add.push(r);
  }
  return {
    ...use,
    // The dialog as it was before any template was added, so one can be taken out again (withoutTemplate).
    base: use.base || use,
    more: extra,
    recipients: [...use.recipients, ...add],
    open: [...use.open, ...add.filter((r) => !r.email)],
  };
}

/** The dialog's template with one added template taken out again: the others are added to it afresh. */
export function withoutTemplate(use: any, id: string) {
  const left = (use.more || []).filter((m: any) => m.id !== id);
  const base = use.base || use;
  return left.length ? left.reduce((u: any, m: any) => withTemplate(u, m), base) : base;
}

/** The dialog's title: every template it starts from. */
export const useTitle = (use: any) => (use.more?.length ? combinedName([use.subject, ...use.more.map((m: any) => m.subject)]) : use.subject || 'template');

/** The template ids for POST /envelopes. */
export const useBody = (use: any) => (use.more?.length ? { template_ids: [use.id, ...use.more.map((m: any) => m.id)] } : { template_id: use.id });

export function AddTemplate({ use, rows, onAdd, onRemove }: { use: any; rows: any[]; onAdd: (env: any) => void; onRemove: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pickId, setPickId] = useState('');
  const [said, setSaid] = useState('');
  const chosen = new Set([use.id, ...(use.more || []).map((m: any) => m.id)]);
  const others = rows.filter((t) => !chosen.has(t.id));
  const canAdd = others.length > 0 && chosen.size < MAX_COMBINED;
  const added = (use.more || []).map((m: any) => (
    <p key={m.id} className="small row wrap" style={{ margin: '4px 0 0', gap: 8, alignItems: 'center' }}>
      <span>Also from: {m.subject || 'Untitled template'}.</span>
      <button type="button" className="btn ghost sm" style={{ minHeight: 44 }} onClick={() => onRemove(m.id)} aria-label={`Remove ${m.subject || 'Untitled template'}`}>Remove</button>
    </p>
  ));
  if (!added.length && !canAdd) return null;
  if (!open || !canAdd)
    return (
      <div data-feature="ds-tpl-combine">
        {added}
        {canAdd && (
          <p className="small" style={{ margin: '4px 0 0' }}>
            <button type="button" className="btn ghost sm" style={{ minHeight: 44 }} onClick={() => (setPickId(''), setOpen(true))}>Add another template</button>
          </p>
        )}
      </div>
    );
  async function add() {
    if (!pickId) return setSaid('Choose a template in the list first, then press Add.');
    setBusy(true);
    try {
      const { envelope } = await api(`/envelopes/${pickId}`);
      onAdd(envelope);
      setOpen(false);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div data-feature="ds-tpl-combine">
      {added}
      <label className="f" style={{ marginBottom: 4 }}>
        <span>Add another template <span className="hint">(its files come after these, and a role with the same name is one person)</span></span>
        <select value={pickId} disabled={busy} onChange={(e) => (setSaid(''), setPickId(e.target.value))} autoFocus style={{ minHeight: 44 }}>
          <option value="">Choose a template</option>
          {others.map((t) => <option key={t.id} value={t.id}>{t.subject || 'Untitled template'}</option>)}
        </select>
      </label>
      {said && <p className="small" role="alert" style={{ margin: '0 0 4px' }}>{said}</p>}
      <div className="row wrap" style={{ gap: 8 }}>
        <button type="button" className="btn sm" style={{ minHeight: 44 }} disabled={busy} onClick={add}>{busy ? 'Adding…' : 'Add'}</button>
        <button type="button" className="btn ghost sm" style={{ minHeight: 44 }} disabled={busy} onClick={() => setOpen(false)}>Cancel</button>
      </div>
    </div>
  );
}
