'use client';
import { useState } from 'react';
import { api, useLoad, oops, toast } from '@/components/ui';

export default function Contacts() {
  const [data, reload] = useLoad(() => api('/contacts'));
  const [f, setF] = useState({ name: '', email: '', company: '' });
  return (
    <div className="stack">
      <div className="pagehead" style={{ marginBottom: 0 }}><div><h1 className="serif">Contacts</h1><div className="muted">People you send to are saved here automatically and suggested as you type.</div></div></div>
      <form className="card row wrap" style={{ alignItems: 'flex-end' }} onSubmit={(e) => { e.preventDefault(); api('/contacts', { body: f }).then(() => (toast('Contact saved'), setF({ name: '', email: '', company: '' }), reload())).catch(oops); }}>
        <label className="f grow" style={{ margin: 0 }}><span>Name</span><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required /></label>
        <label className="f grow" style={{ margin: 0 }}><span>Email</span><input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} required /></label>
        <label className="f grow" style={{ margin: 0 }}><span>Company</span><input value={f.company} onChange={(e) => setF({ ...f, company: e.target.value })} /></label>
        <button className="btn primary">Add contact</button>
      </form>
      <div className="card pad0">
        {data && data.contacts.length === 0 ? <div className="empty"><h3>No contacts yet</h3>They appear here after your first send.</div> : (
          <div className="tablewrap"><table className="t">
            <thead><tr><th>Name</th><th>Email</th><th>Company</th><th /></tr></thead>
            <tbody>{(data?.contacts || []).map((c: any) => (
              <tr key={c.id}><td><b>{c.name}</b></td><td>{c.email}</td><td className="muted">{c.company}</td>
                <td style={{ textAlign: 'right' }}><button className="btn sm ghost danger" onClick={() => api(`/contacts/${c.id}`, { method: 'DELETE' }).then(reload).catch(oops)}>Remove</button></td></tr>
            ))}</tbody>
          </table></div>
        )}
      </div>
    </div>
  );
}
