'use client';
// Lists for Send to many (src/server/bulklists.ts, /bulk-lists). In Send to many: "Choose a list from Contacts" puts
// a saved list, or the members of a group from Contacts, into the list box, where it is checked against the template
// like any list pasted there; and the link "Save this list for next time" keeps the list in the box under a name.
// In Contacts: the saved lists, next to the groups, with who saved each and when, shown once there is one. In
// Settings, Records and data (admins, once there is a list): after how many days an unused list is deleted.
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { api, useLoad, toast } from '@/components/ui';
import { SOURCE_LOCALE, t } from '@/lib/i18n';
import { LIST_NAME_MAX, listDeleteRule } from '@/lib/reports';
import { dayTime } from '@/components/sender/lib';
// Also used on the Settings page, which does not load this file's styles by itself.
import '../../app/styles/reports.css';

const ui = SOURCE_LOCALE;
const q = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
const people = (n: number) => `${n} ${n === 1 ? 'person' : 'people'}`;
// Told to every picker on the page when a list is saved or deleted, so it shows at once without a reload.
const CHANGED = 'growsigning:bulk-lists';
const changed = () => window.dispatchEvent(new Event(CHANGED));
// The text last put in the box from a saved list: offering to save it again would only meet "that name exists".
let loadedText = '';

/** Send to many, step 2: pick a saved list, or a group when the template has one role to fill. */
export function UseSavedList({ roles, header, onLoad }: { roles: { key: string; phone?: boolean }[]; header: string; onLoad: (csv: string, note: string) => void }) {
  const [lists, reloadLists] = useLoad<any>(() => api('/bulk-lists'), []);
  const [groups] = useLoad<any>(() => api('/groups'), []);
  const [busy, setBusy] = useState(false);
  const asked = useRef(false);
  useEffect(() => {
    window.addEventListener(CHANGED, reloadLists);
    return () => window.removeEventListener(CHANGED, reloadLists);
  }, [reloadLists]);
  const saved: any[] = lists?.lists || [];
  const grps: any[] = groups?.groups || [];
  // "Send to this list" in Contacts opens /app/bulk?list=<id>: once a template is chosen, that list is put in the box.
  useEffect(() => {
    if (asked.current || !lists) return;
    const want = new URLSearchParams(window.location.search).get('list');
    asked.current = true;
    if (want && saved.some((l) => l.id === want)) void pick(`list:${want}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lists]);
  if (!saved.length && !grps.length) return null;
  // A group is a list of names and addresses: it fills one role, and none that needs a mobile number.
  const phone = roles.some((r) => r.phone);
  const groupsFit = roles.length === 1 && !phone;
  async function pick(v: string) {
    if (!v) return;
    const [kind, id] = v.split(':');
    setBusy(true);
    try {
      if (kind === 'list') {
        const l = (await api(`/bulk-lists/${id}`)).list;
        loadedText = l.csv;
        onLoad(l.csv, t(ui, 'reports.lists.loaded', { name: l.name }));
      } else {
        const g = grps.find((x) => x.id === id);
        if (g) onLoad(`${header}\n${g.members.map((m: any) => `${q(m.name)},${q(m.email)}`).join('\n')}\n`, t(ui, 'reports.lists.loaded', { name: g.name }));
      }
    } catch (e: any) {
      toast(e?.message || 'We could not open that list. Reload the page and try again.', true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="sl-use">
      <label className="f"><span>{t(ui, 'reports.lists.use')}</span>
        <select value="" disabled={busy} onChange={(e) => pick(e.target.value)} aria-describedby={grps.length && !groupsFit ? 'sl-group-note' : undefined}>
          <option value="">{t(ui, 'reports.lists.none')}</option>
          {saved.length > 0 && <optgroup label={t(ui, 'reports.lists.saved')}>{saved.map((l) => <option key={l.id} value={`list:${l.id}`}>{l.name} ({people(l.rows)})</option>)}</optgroup>}
          {grps.length > 0 && <optgroup label={t(ui, 'reports.lists.groups')}>{grps.map((g) => <option key={g.id} value={`group:${g.id}`} disabled={!groupsFit}>{g.name} ({people(g.members.length)})</option>)}</optgroup>}
        </select>
      </label>
      {grps.length > 0 && !groupsFit && <p className="muted small" id="sl-group-note" style={{ margin: 0, flexBasis: '100%' }}>{t(ui, phone ? 'reports.lists.group_phone' : 'reports.lists.group_one_role')}</p>}
    </div>
  );
}

/** Send to many, under the list: one link, which opens a name field to keep the list for the team. */
export function SaveList({ csv, rows }: { csv: string; rows: number }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState('');
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (open) field.current?.focus();
  }, [open]);
  if (done && done === csv) return <p className="muted small" role="status">{t(ui, 'reports.lists.saved_toast')}</p>;
  // The list in the box came from a saved list just now: it is saved already.
  if (csv === loadedText) return null;
  async function save() {
    setBusy(true);
    try {
      await api('/bulk-lists', { body: { name: name.trim(), csv, rows } });
      toast(t(ui, 'reports.lists.saved_toast'));
      setDone(csv);
      setName('');
      setOpen(false);
      changed();
    } catch (e: any) {
      toast(e?.message || 'The list was not saved. Try again.', true);
    } finally {
      setBusy(false);
    }
  }
  if (!open) return <p style={{ margin: '8px 0 0' }}><button type="button" className="btn sm ghost" onClick={() => setOpen(true)}>{t(ui, 'reports.lists.open_save')}</button></p>;
  return (
    <form className="sl-save" onSubmit={(e) => (e.preventDefault(), name.trim() && !busy && save())}>
      <label className="f"><span>{t(ui, 'reports.lists.save_name')}</span>
        <input ref={field} value={name} maxLength={LIST_NAME_MAX} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setOpen(false)} placeholder={t(ui, 'reports.lists.save_placeholder')} aria-describedby="sl-save-note" />
      </label>
      <button type="submit" className="btn sm" disabled={busy || !name.trim()}>{t(ui, 'reports.lists.save')}</button>
      <button type="button" className="btn sm ghost" onClick={() => setOpen(false)}>Cancel</button>
      <p className="muted small" id="sl-save-note" style={{ margin: '0 0 8px', flexBasis: '100%' }}>{t(ui, 'reports.lists.save_note')}</p>
    </form>
  );
}

/** Contacts, next to the groups: the team's lists for Send to many. Nothing shows until there is one. */
export function SavedListsSection() {
  const [d, reload] = useLoad<any>(() => api('/bulk-lists'), []);
  const lists: any[] = d?.lists || [];
  if (!lists.length) return null;
  async function remove(l: any) {
    if (!window.confirm(`Delete the list "${l.name}"? Nobody on your team can use it after this. Documents already sent to it are not affected.`)) return;
    try {
      await api(`/bulk-lists/${l.id}`, { method: 'DELETE' });
      toast(t(ui, 'reports.lists.deleted'));
      reload();
      changed();
    } catch (e: any) {
      toast(e?.message || 'The list was not deleted. Try again.', true);
    }
  }
  return (
    <section className="card" aria-labelledby="sl-h">
      <h2 id="sl-h" style={{ marginBottom: 4 }}>{t(ui, 'reports.lists.title')}</h2>
      <p className="muted small" style={{ margin: 0 }}>{t(ui, 'reports.lists.intro')} {t(ui, 'reports.lists.save_note')} {listDeleteRule(d.days)}</p>
      <ul className="sl-list">
        {lists.map((l) => (
          <li key={l.id} className="sl-item">
            <div><b>{l.name}</b><div className="muted small">{t(ui, 'reports.lists.who', { rows: people(l.rows), name: l.created_by, day: dayTime(l.created_at) })}</div></div>
            <span className="row">
              <Link className="btn sm" href={`/app/bulk?list=${encodeURIComponent(l.id)}`} aria-label={t(ui, 'reports.lists.send_label', { name: l.name })}>{t(ui, 'reports.lists.send')}</Link>
              {l.may_delete && <button type="button" className="btn sm ghost danger" aria-label={t(ui, 'reports.lists.delete_label', { name: l.name })} onClick={() => remove(l)}>{t(ui, 'reports.lists.delete')}</button>}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Settings, Records and data (owners and admins, once the account has a saved list): after how many days a list
 * nobody used is deleted. A smaller number that would delete lists says how many first, and asks.
 */
export function ListDaysSetting() {
  const [d, reload] = useLoad<any>(() => api('/bulk-lists'), []);
  const [days, setDays] = useState('');
  const [busy, setBusy] = useState(false);
  if (!d?.may_change_days || !(d.lists || []).length) return null;
  async function save(confirm = false) {
    setBusy(true);
    try {
      await api('/bulk-lists/settings', { method: 'PUT', body: { days: Number(days), ...(confirm ? { confirm: true } : {}) } });
      toast(t(ui, 'reports.lists.days_saved'));
      setDays('');
      reload();
    } catch (e: any) {
      if (e?.code === 'lists_would_be_deleted' && !confirm && window.confirm(`${e.message.replace(/ Nothing was changed\.$/, '')}\n\nDelete ${e.data?.deleting === 1 ? 'it' : 'them'} and save ${days} days?`)) {
        setBusy(false);
        return save(true);
      }
      if (e?.code !== 'lists_would_be_deleted') toast(e?.message || 'That did not save. Try again.', true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="card">
      <form className="sl-days" onSubmit={(e) => (e.preventDefault(), days && Number(days) !== d.days && !busy && save())}>
        <label className="f" style={{ margin: 0 }}><span>{t(ui, 'reports.lists.days_label')}</span>
          <input type="number" inputMode="numeric" min={d.min_days} max={d.max_days} value={days} placeholder={String(d.days)} onChange={(e) => setDays(e.target.value)} aria-describedby="sl-days-hint" />
        </label>
        <button type="submit" className="btn sm" disabled={busy || !days || Number(days) === d.days}>{t(ui, 'reports.lists.days_save')}</button>
        <span className="muted small" id="sl-days-hint">Now {d.days} days. From {d.min_days} to {d.max_days}.</span>
      </form>
    </div>
  );
}
