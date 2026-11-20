'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, useLoad, toast } from '@/components/ui';
import { ConfirmDialog } from '@/components/sender/dialogs';
import { fail } from '@/components/sender/feedback';
import { explain, looksLikeEmail } from '@/components/sender/lib';

type Contact = { id: string; name: string; email: string; company: string | null };
const EMPTY = { name: '', email: '', company: '' };

export default function Contacts() {
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
      toast(known ? 'That email was already in your contacts, so we updated its name and company.' : 'Contact saved.');
      setAdd(EMPTY);
      reload();
    } catch (err) {
      fail(err);
    }
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!edit) return;
    if (!edit.name.trim()) return setEditError('Add a name.');
    if (!looksLikeEmail(edit.email.trim())) return setEditError('That email address is not complete. It should look like name@example.org.');
    setSaving(true);
    setEditError('');
    try {
      await api(`/contacts/${edit.id}`, { method: 'PATCH', body: { name: edit.name.trim(), email: edit.email.trim(), company: edit.company.trim() } });
      toast('Contact updated.');
      backTo.current = edit.id;
      setEdit(null);
      reload();
    } catch (err) {
      setEditError(explain(err, 'Nothing was changed.'));
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
        <div><h1 className="serif">Contacts</h1><div className="muted">People you send to are saved here automatically and suggested as you type. Fix a name or address here any time.</div></div>
      </div>

      <form className="card sn-addcontact" onSubmit={create} aria-label="Add a contact">
        <label className="f"><span>Name</span><input value={add.name} onChange={(e) => setAdd({ ...add, name: e.target.value })} required autoComplete="off" /></label>
        <label className="f"><span>Email</span><input type="email" value={add.email} onChange={(e) => setAdd({ ...add, email: e.target.value })} required autoComplete="off" /></label>
        <label className="f"><span>Company <span className="hint">(optional)</span></span><input value={add.company} onChange={(e) => setAdd({ ...add, company: e.target.value })} autoComplete="off" /></label>
        <button className="btn primary">Add contact</button>
      </form>

      <section className="card pad0" aria-labelledby="sn-contacts-h">
        <div className="sn-cardhead sn-contacts-head">
          <h2 id="sn-contacts-h">Your contacts <span className="muted sn-count" aria-live="polite">{data ? (q.trim() ? `${shown.length} of ${all.length}` : all.length) : ''}</span></h2>
          {all.length > 0 && (
            <div className="sn-search">
              <input type="search" placeholder="Search by name, email or company" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search contacts" />
              {q && <button className="btn sm ghost" onClick={() => setQ('')}>Clear</button>}
            </div>
          )}
        </div>
        {error ? (
          <div className="empty" role="alert"><h3>We could not load your contacts</h3>Check your connection, then try again.<div style={{ marginTop: 14 }}><button className="btn" onClick={reload}>Try again</button></div></div>
        ) : !data ? (
          <div className="empty" role="status">Loading…</div>
        ) : all.length === 0 ? (
          <div className="empty"><h3>No contacts yet</h3>They appear here after your first send, or you can add one above.</div>
        ) : shown.length === 0 ? (
          <div className="empty"><h3>Nobody matches &ldquo;{q.trim()}&rdquo;</h3>Try part of their name, email or company.<div style={{ marginTop: 14 }}><button className="btn" onClick={() => setQ('')}>Show everyone</button></div></div>
        ) : (
          <ul className="sn-contacts">
            {shown.map((c) => edit?.id === c.id ? (
              <li key={c.id} className="editing">
                <form onSubmit={save} onKeyDown={(e) => e.key === 'Escape' && (e.stopPropagation(), cancel())} aria-label={`Edit ${c.name}`}>
                  <label className="f"><span>Name</span><input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} autoFocus autoComplete="off" /></label>
                  <label className="f"><span>Email</span><input type="email" value={edit.email} onChange={(e) => setEdit({ ...edit, email: e.target.value })} autoComplete="off" /></label>
                  <label className="f"><span>Company <span className="hint">(optional)</span></span><input value={edit.company} onChange={(e) => setEdit({ ...edit, company: e.target.value })} autoComplete="off" /></label>
                  <div className="sn-contact-actions">
                    <button type="submit" className="btn sm primary" disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
                    <button type="button" className="btn sm" onClick={cancel}>Cancel</button>
                  </div>
                  {editError && <div className="notice err sn-wide" role="alert">{editError}</div>}
                  <p className="muted small sn-wide">This changes the saved contact for next time. Envelopes already sent keep the details they were sent with.</p>
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
                  <button id={`sn-edit-${c.id}`} className="btn sm" onClick={() => (setEdit({ id: c.id, name: c.name, email: c.email, company: c.company || '' }), setEditError(''))} aria-label={`Edit ${c.name}`}>Edit</button>
                  <button className="btn sm ghost danger" onClick={() => setRemoving(c)} aria-label={`Remove ${c.name}`}>Remove</button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {removing && (
        <ConfirmDialog title={`Remove ${removing.name}`} confirmLabel="Remove contact" keepLabel="Keep" onClose={() => setRemoving(null)}
          onConfirm={async () => {
            await api(`/contacts/${removing.id}`, { method: 'DELETE' });
            toast(`${removing.name} removed from your contacts.`);
            setRemoving(null);
            reload();
          }}>
          <p>{removing.name} ({removing.email}) will no longer be suggested when you add recipients. Envelopes you already sent them are not affected.</p>
        </ConfirmDialog>
      )}
    </div>
  );
}
