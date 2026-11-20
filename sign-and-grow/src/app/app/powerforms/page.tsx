'use client';
import { useState } from 'react';
import Link from 'next/link';
import { api, useLoad, fmtDate, oops, toast } from '@/components/ui';
import { POWERFORM_OPEN_STARTS, POWERFORM_SHARED_OPEN_STARTS, POWERFORM_STARTS_PER_HOUR, POWERFORM_SHARED_STARTS_PER_HOUR } from '@/lib/policy';

export default function PowerForms() {
  const [tpls] = useLoad(() => api('/envelopes?kind=template'));
  const [data, reload] = useLoad(() => api('/powerforms'));
  const [tid, setTid] = useState('');
  const [name, setName] = useState('');
  const [shared, setShared] = useState(false);
  const link = (slug: string) => `${window.location.origin}/f/${slug}`;

  return (
    <div className="stack">
      <div className="pagehead" style={{ marginBottom: 0 }}><div><h1 className="serif">PowerForms</h1><div className="muted">A public link anyone can open to fill in and sign a template. Put it on your website or in an email, or print its QR code for a poster or a front desk.</div></div></div>
      <div className="card">
        <h2 style={{ marginBottom: 12 }}>Create a PowerForm</h2>
        <div className="row wrap" style={{ alignItems: 'flex-end' }}>
          <label className="f grow" style={{ margin: 0, minWidth: 200 }}><span>Template</span>
            <select value={tid} onChange={(e) => setTid(e.target.value)}>
              <option value="">Choose a template…</option>
              {/* A form sends in the name of the template's owner, so only that person and admins may publish it. */}
              {(tpls?.envelopes || []).filter((t: any) => t.may_change !== false).map((t: any) => <option key={t.id} value={t.id}>{t.subject || 'Untitled template'}</option>)}
            </select>
          </label>
          <label className="f grow" style={{ margin: 0, minWidth: 200 }}><span>Name shown to signers</span><input value={name} onChange={(e) => setName(e.target.value)} placeholder="Volunteer waiver" /></label>
          <button className="btn primary" disabled={!tid} onClick={() => api('/powerforms', { body: { template_id: tid, name, shared_device: shared } }).then(() => (toast('PowerForm created'), setName(''), setTid(''), setShared(false), reload())).catch(oops)}>Create</button>
        </div>
        {(tpls?.envelopes || []).some((t: any) => t.may_change === false) && <p className="muted small" style={{ marginTop: 8, marginBottom: 0 }}>Only templates you may change are listed here. A PowerForm sends in the name of the person its template belongs to, so a colleague&apos;s template can be published by that colleague, by an admin, or by someone they let change it. To make a form from one yourself, copy the template on the Templates page first.</p>}
        <label className="check" style={{ marginTop: 12, minHeight: 44 }}><input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} style={{ width: 20, height: 20 }} /> <span>People fill this in on a shared device or in one office (a tablet at the front desk, a classroom, an event)</span></label>
        <p className="muted small" style={{ marginTop: 6, marginBottom: 0 }}>The template needs exactly one open signer role. That is the person who fills in the form. Each person who signs uses one of your signatures. From one internet connection, an ordinary form allows {POWERFORM_OPEN_STARTS} unfinished starts at a time, ordinary forms together take {POWERFORM_STARTS_PER_HOUR} starts an hour, and an abandoned start is cleared after a day. A shared-device form allows {POWERFORM_SHARED_OPEN_STARTS} unfinished starts at a time and {POWERFORM_SHARED_STARTS_PER_HOUR} starts an hour from one connection, clears an abandoned one after an hour, and offers &quot;start a new form for the next person&quot; when someone has finished. Whoever comes back to a start that was cleared is offered a fresh form, and you are not emailed about it. While the daily limit for new accounts applies to you (see <a href="/help#cannot-send" target="_blank" rel="noreferrer">Why can I not send?</a>), each form takes that many new people a day, counted for the form alone: strangers who fill it in never use up what you can send yourself. If someone reports a document they got through a form, a person looks at it, but it does not count towards pausing your account.</p>
      </div>
      <div className="card pad0">
        {data && data.powerforms.length === 0 ? <div className="empty"><h3>No PowerForms yet</h3>Create one above to collect signatures without sending anything.</div> : (
          <div className="tablewrap"><table className="t">
            <thead><tr><th>Name</th><th>Link</th><th>Signed</th><th>Created</th></tr></thead>
            {/* Signed is who finished. Started and not finished yet is shown under it, because those count against what the form can still take. */}
            <tbody>
              {(data?.powerforms || []).map((p: any) => (
                <tr key={p.id}>
                  {/* Whose it is stands under the name, where a phone shows it without scrolling the table sideways. */}
                  {/* So do the buttons that change it, so a phone reaches them without scrolling the table sideways.
                      Pausing, changing and deleting are for the person the template belongs to and for admins. Everyone
                      else is told whose it is instead of being shown buttons that would be refused. */}
                  {/* Under the template's name: whether the envelope each visitor starts reminds them (reminderText in src/lib/policy.ts). */}
                  <td><b>{p.name}</b><div className="muted small">{p.template || 'Template deleted'}{p.shared_device ? ' · shared device' : ''}</div>{p.reminders && <div className="muted small">{p.reminders} That comes from the template.</div>}
                    {p.may_change === false ? <div className="muted small">Only {p.owner || 'the owner of its template'} or an admin can pause or delete it.</div> : (
                      <div className="row wrap" style={{ gap: 4, marginTop: 6, marginLeft: -11 }}>
                        <button className="btn sm ghost" style={{ minHeight: 44 }} aria-label={`${p.shared_device ? 'Not a shared device' : 'Shared device'}: ${p.name}`} onClick={() => api(`/powerforms/${p.id}`, { method: 'PATCH', body: { shared_device: !p.shared_device } }).then(() => (toast(p.shared_device ? 'Treated as an ordinary form again' : 'Marked as used on a shared device'), reload())).catch(oops)}>{p.shared_device ? 'Not a shared device' : 'Shared device'}</button>
                        <button className="btn sm ghost" style={{ minHeight: 44 }} aria-label={`${p.active ? 'Pause' : 'Resume'} ${p.name}`} onClick={() => api(`/powerforms/${p.id}`, { method: 'PATCH', body: { active: !p.active } }).then(reload).catch(oops)}>{p.active ? 'Pause' : 'Resume'}</button>
                        <button className="btn sm ghost danger" style={{ minHeight: 44 }} aria-label={`Delete ${p.name}`} onClick={() => window.confirm('Delete this PowerForm? The link will stop working.') && api(`/powerforms/${p.id}`, { method: 'DELETE' }).then(reload).catch(oops)}>Delete</button>
                      </div>)}
                  </td>
                  {/* The link the server gives is the public address (APP_URL), the one a printed code has to carry. */}
                  <td><button className="btn sm" onClick={() => navigator.clipboard.writeText(p.url || link(p.slug)).then(() => toast('Link copied'))}>Copy link</button> <Link className="btn sm qr-tap" href={`/app/powerforms/${p.id}/qr`} aria-label={`QR code for ${p.name}, on a sheet to print`}>QR code</Link> <a className="small" href={`/f/${p.slug}`} target="_blank" rel="noreferrer">Open</a></td>
                  <td className="num">{p.signed}{p.open > 0 && <div className="muted small">{p.open} filling it in now</div>}</td>
                  <td className="muted small">{fmtDate(p.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      </div>
    </div>
  );
}
