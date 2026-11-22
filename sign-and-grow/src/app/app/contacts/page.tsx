'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, useLoad, toast } from '@/components/ui';
import { ConfirmDialog } from '@/components/sender/dialogs';
import { fail } from '@/components/sender/feedback';
import { explain, looksLikeEmail } from '@/components/sender/lib';
import { SigningGroups } from '@/components/sender/SigningGroups';
import { SavedListsSection } from '@/components/reports/SavedLists';
import '../../styles/reports.css';
import { useST } from '@/components/senderLang';

type Contact = { id: string; name: string; email: string; company: string | null };
const EMPTY = { name: '', email: '', company: '' };

export default function Contacts() {
  const T = useST();
  const [data, reload, error] = useLoad<{ contacts: Contact[] }>(() => api('/contacts'));
  const [add, setAdd] = useState(EMPTY);
  const [q, setQ] = useState('');
  const [edit, setEdit] = useState<(typeof EMPTY & { id: string }) | null>(null);
  const [editError, setEditError] = useState('');
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState<Contact | null>(null);
  const backTo = useRef('');

  const all = data?.contacts || [];
  const shown = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    return words.length ? all.filter((c) => words.every((w) => `${c.name} ${c.email} ${c.company || ''}`.toLowerCase().includes(w))) : all;
  }, [all, q]);

  // When editing ends, put the keyboard back on the Edit button it started from.
  useEffect(() => {
    if (edit || !backTo.current) return;
    document.getElementById(`sn-edit-${backTo.current}`)?.focus();
    backTo.current = '';
  }, [edit]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    const known = all.some((c) => c.email.toLowerCase() === add.email.trim().toLowerCase());
    try {
      await api('/contacts', { body: add });
      toast(known ? T('contacts.updated_known') : T('contacts.saved'));
      setAdd(EMPTY);
      reload();
    } catch (err) {
      fail(err);
    }
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!edit) return;
    if (!edit.name.trim()) return setEditError(T('contacts.need_name'));
    if (!looksLikeEmail(edit.email.trim())) return setEditError(T('contacts.bad_email'));
    setSaving(true);
    setEditError('');
    try {
      await api(`/contacts/${edit.id}`, { method: 'PATCH', body: { name: edit.name.trim(), email: edit.email.trim(), company: edit.company.trim() } });
      toast(T('contacts.updated'));
      backTo.current = edit.id;
      setEdit(null);
      reload();
    } catch (err) {
      setEditError(explain(err, T('contacts.nothing_changed')));
    } finally {
      setSaving(false);
    }
  }
  const cancel = () => {
    backTo.current = edit?.id || '';
    setEdit(null);
    setEditError('');
  };

  return (
    <div className="sn stack">
      <div className="pagehead" style={{ marginBottom: 0 }}>
        <div><h1 className="serif">{T('contacts.title')}</h1><div className="muted">{T('contacts.lede')}</div></div>
      </div>

      <form className="card sn-addcontact" onSubmit={create} aria-label={T('contacts.add_label')}>
        <label className="f"><span>{T('contacts.name')}</span><input value={add.name} onChange={(e) => setAdd({ ...add, name: e.target.value })} required autoComplete="off" /></label>
        <label className="f"><span>{T('contacts.email')}</span><input type="email" value={add.email} onChange={(e) => setAdd({ ...add, email: e.target.value })} required autoComplete="off" /></label>
        <label className="f"><span>{T('contacts.company')} <span className="hint">{T('contacts.optional')}</span></span><input value={add.company} onChange={(e) => setAdd({ ...add, company: e.target.value })} autoComplete="off" /></label>
        <button className="btn primary">{T('contacts.add')}</button>
      </form>

      <section className="card pad0" aria-labelledby="sn-contacts-h">
        <div className="sn-cardhead sn-contacts-head">
          <h2 id="sn-contacts-h">{T('contacts.yours')} <span className="muted sn-count" aria-live="polite">{data ? (q.trim() ? T('contacts.of', { shown: shown.length, all: all.length }) : all.length) : ''}</span></h2>
          {all.length > 0 && (
            <div className="sn-search">
              <input type="search" placeholder={T('contacts.search_placeholder')} value={q} onChange={(e) => setQ(e.target.value)} aria-label={T('contacts.search_label')} />
              {q && <button className="btn sm ghost" onClick={() => setQ('')}>{T('contacts.clear')}</button>}
            </div>
          )}
        </div>
        {error ? (
          <div className="empty" role="alert"><h3>{T('contacts.load_failed')}</h3>{T('contacts.load_failed_body')}<div style={{ marginTop: 14 }}><button className="btn" onClick={reload}>{T('contacts.try_again')}</button></div></div>
        ) : !data ? (
          <div className="empty" role="status">{T('contacts.loading')}</div>
        ) : all.length === 0 ? (
          <div className="empty"><h3>{T('contacts.none')}</h3>{T('contacts.none_body')}</div>
        ) : shown.length === 0 ? (
          <div className="empty"><h3>{T('contacts.nobody', { q: q.trim() })}</h3>{T('contacts.nobody_body')}<div style={{ marginTop: 14 }}><button className="btn" onClick={() => setQ('')}>{T('contacts.show_all')}</button></div></div>
        ) : (
          <ul className="sn-contacts" role="list">
            {shown.map((c) => edit?.id === c.id ? (
              <li key={c.id} className="editing">
                <form onSubmit={save} onKeyDown={(e) => e.key === 'Escape' && (e.stopPropagation(), cancel())} aria-label={T('contacts.edit_label', { name: c.name })}>
                  <label className="f"><span>{T('contacts.name')}</span><input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} autoFocus autoComplete="off" /></label>
                  <label className="f"><span>{T('contacts.email')}</span><input type="email" value={edit.email} onChange={(e) => setEdit({ ...edit, email: e.target.value })} autoComplete="off" /></label>
                  <label className="f"><span>{T('contacts.company')} <span className="hint">{T('contacts.optional')}</span></span><input value={edit.company} onChange={(e) => setEdit({ ...edit, company: e.target.value })} autoComplete="off" /></label>
                  <div className="sn-contact-actions">
                    <button type="submit" className="btn sm primary" disabled={saving}>{saving ? T('contacts.saving') : T('contacts.save')}</button>
                    <button type="button" className="btn sm" onClick={cancel}>{T('contacts.cancel')}</button>
                  </div>
                  {editError && <div className="notice err sn-wide" role="alert">{editError}</div>}
                  <p className="muted small sn-wide">{T('contacts.edit_note')}</p>
                </form>
              </li>
            ) : (
              <li key={c.id}>
                <div className="sn-contact-who">
                  <b>{c.name}</b>
                  <span className="sn-contact-email">{c.email}</span>
                  {c.company && <span className="muted small sn-contact-co">{c.company}</span>}
                </div>
                <div className="sn-contact-actions">
                  <button id={`sn-edit-${c.id}`} className="btn sm" onClick={() => (setEdit({ id: c.id, name: c.name, email: c.email, company: c.company || '' }), setEditError(''))} aria-label={T('contacts.edit_label', { name: c.name })}>{T('contacts.edit')}</button>
                  <button className="btn sm ghost danger" onClick={() => setRemoving(c)} aria-label={T('contacts.remove_label', { name: c.name })}>{T('contacts.remove')}</button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Named groups of people, any one of whom can sign for the group: see SigningGroups.tsx. */}
      <SigningGroups />
      {/* Lists saved in Send to many, for the whole team: see src/components/reports/SavedLists.tsx. */}
      <SavedListsSection />

      {removing && (
        <ConfirmDialog title={T('contacts.remove_title', { name: removing.name })} confirmLabel={T('contacts.remove_confirm')} keepLabel={T('contacts.keep')} onClose={() => setRemoving(null)}
          onConfirm={async () => {
            await api(`/contacts/${removing.id}`, { method: 'DELETE' });
            toast(T('contacts.removed', { name: removing.name }));
            setRemoving(null);
            reload();
          }}>
          <p>{T('contacts.remove_body', { name: removing.name, email: removing.email })}</p>
        </ConfirmDialog>
      )}
    </div>
  );
}
