'use client';
import { useMemo, useState } from 'react';
import Link from 'next/link';
import { api, useLoad, Status, toast } from '@/components/ui';
import { useMe } from '@/components/AppShell';
import { readAllowance, voidCostLine } from './allowance';
import { VoidDialog } from './dialogs';
import { fail } from './feedback';
import { dayTime, exportUrl, plural } from './lib';
import { DONE } from './Recipients';

const FILTERS: [string, string][] = [['all', 'Everyone'], ['open', 'Not finished'], ['completed', 'Completed'], ['closed', 'Closed']];
const CLOSED = ['voided', 'declined', 'expired'];
// Long lists of ids make very long download addresses, so big batches come as several ZIP files.
const PER_ZIP = 250;

const group = (status: string) => (status === 'sent' ? 'open' : status === 'completed' ? 'completed' : status === 'draft' ? 'unsent' : 'closed');

function personStatus(r: any, envelopeStatus: string): { s: string; label: string } {
  if (r.status === 'completed') return { s: 'completed', label: DONE[r.role] || 'Done' };
  if (r.status === 'declined') return { s: 'declined', label: 'Declined' };
  if (envelopeStatus === 'draft') return { s: 'pending', label: 'Not sent' };
  if (CLOSED.includes(envelopeStatus)) return { s: envelopeStatus, label: envelopeStatus === 'voided' ? 'Voided' : envelopeStatus === 'expired' ? 'Expired' : 'Closed' };
  if (r.status === 'viewed') return { s: 'viewed', label: 'Opened' };
  if (r.status === 'sent') return { s: 'sent', label: 'Sent, not opened' };
  return { s: 'pending', label: 'Waiting for their turn' };
}

// One bulk send as one thing: how far it has got, everyone in it, and the three things you can do to all of it at once.
export function BatchView({ id }: { id: string }) {
  const me = useMe();
  const [data, reload, error] = useLoad<any>(() => api(`/bulk/${id}`), [id]);
  const [filter, setFilter] = useState('all');
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [voiding, setVoiding] = useState(false);

  const envelopes: any[] = data?.envelopes || [];
  const count = useMemo(() => {
    const c = { open: 0, completed: 0, closed: 0, unsent: 0, opened: 0 };
    for (const e of envelopes) {
      c[group(e.status) as 'open']++;
      if (e.status === 'sent' && e.recipients.some((r: any) => r.status === 'viewed')) c.opened++;
    }
    return c;
  }, [envelopes]);
  const completedIds = envelopes.filter((e) => e.status === 'completed').map((e) => e.id as string);
  const zips = Array.from({ length: Math.ceil(completedIds.length / PER_ZIP) }, (_, i) => completedIds.slice(i * PER_ZIP, (i + 1) * PER_ZIP));

  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = envelopes
    .filter((e) => filter === 'all' || group(e.status) === filter)
    .filter((e) => !words.length || words.every((w) => e.recipients.some((r: any) => `${r.name} ${r.email}`.toLowerCase().includes(w))));

  if (error) return <div className="sn card center"><h1 className="serif" style={{ fontSize: 22 }}>We could not open this batch</h1><p className="muted" style={{ marginTop: 8 }}>It may belong to someone else on your team. Go back to see the batches you sent.</p><Link href="/app/bulk" className="btn">Back to bulk send</Link></div>;
  if (!data) return <div className="muted" role="status">Loading…</div>;
  const b = data.batch;

  async function remindAll() {
    setBusy(true);
    try {
      const { reminded } = await api(`/bulk/${id}/remind`, { method: 'POST' });
      if (reminded) toast(`Reminder emailed to ${reminded} ${reminded === 1 ? 'person' : 'people'}.`);
      else toast('No reminder went out. Everyone still waiting has turned reminders off. Open their envelope to share the link another way.', true);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="sn stack">
      <div className="pagehead" style={{ marginBottom: 0 }}>
        <div className="grow">
          <Link href="/app/bulk" className="small sn-back">← Bulk send</Link>
          <h1 className="serif sn-title">{b.name}</h1>
          <div className="muted small" style={{ marginTop: 6 }}>Sent {dayTime(b.created_at)} · {plural(envelopes.length, 'envelope')}{b.total > envelopes.length ? ` of ${b.total} rows` : ''}{data.removed > 0 ? `. ${data.removed} more ${data.removed === 1 ? 'was' : 'were'} removed from the lists by ${data.removed === 1 ? 'its' : 'their'} sender after somebody had signed, and ${data.removed === 1 ? 'is' : 'are'} not counted here${me.role !== 'member' ? ': as an admin you find them under Envelopes, in the tab Removed by its sender' : ''}` : ''}</div>
        </div>
      </div>

      <div className="grid g4 keep2" role="group" aria-label="Where this batch stands">
        <div className="stat"><div className="k">Completed</div><div className="v num">{count.completed}</div><div className="s">of {envelopes.length}</div></div>
        <div className="stat"><div className="k">Not finished</div><div className="v num">{count.open}</div><div className="s">{count.open ? `${count.opened} opened so far` : 'nobody is waiting'}</div></div>
        <div className="stat"><div className="k">Closed</div><div className="v num">{count.closed}</div><div className="s">voided, declined or expired</div></div>
        <div className="stat"><div className="k">Not sent</div><div className="v num">{count.unsent}</div><div className="s">{count.unsent ? 'saved as drafts' : 'everything went out'}</div></div>
      </div>

      <section className="card sn-batchactions" aria-label="Actions for the whole batch">
        <div className="sn-batchbtns">
          <button className="btn primary" disabled={busy || count.open === 0} onClick={remindAll}>{busy ? 'Sending reminders…' : 'Remind everyone who has not finished'}</button>
          {zips.length <= 1
            ? (completedIds.length ? <a className="btn" href={exportUrl(completedIds)}>Download completed (ZIP)</a> : <button className="btn" disabled>Download completed (ZIP)</button>)
            : zips.map((ids, i) => <a key={i} className="btn" href={exportUrl(ids)}>Download completed, part {i + 1} of {zips.length} (ZIP)</a>)}
          <button className="btn danger" disabled={count.open === 0} onClick={() => setVoiding(true)}>Void everything still open</button>
        </div>
        <p className="muted small">
          {count.open === 0 ? 'Nothing is open any more, so there is nobody to remind and nothing to void. ' : ''}
          {completedIds.length === 0 ? 'The ZIP is ready as soon as the first one is completed. ' : ''}
          To fix one person&rsquo;s name, email or document, open their row. The rest of the batch is not touched.
        </p>
      </section>

      <section className="card pad0" aria-labelledby="sn-batch-people-h">
        <div className="sn-cardhead">
          <h2 id="sn-batch-people-h">Everyone in this batch</h2>
        </div>
        <div className="sn-batchfilters">
          <div className="tabs" role="group" aria-label="Show">
            {[...FILTERS, ...(count.unsent ? [['unsent', 'Not sent']] : [])].map(([k, l]) => <button key={k} className={filter === k ? 'on' : ''} aria-pressed={filter === k} onClick={() => setFilter(k)}>{l}</button>)}
          </div>
          <div className="sn-search">
            <input type="search" placeholder="Find a name or email" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Find someone in this batch" />
            {q && <button className="btn sm ghost" onClick={() => setQ('')}>Clear</button>}
          </div>
        </div>
        {shown.length === 0 ? (
          <div className="empty"><h3>Nobody here</h3>{envelopes.length === 0 ? 'Nothing in this batch could be created.' : 'No envelope in this batch fits that filter.'}{envelopes.length > 0 && <div style={{ marginTop: 14 }}><button className="btn" onClick={() => (setFilter('all'), setQ(''))}>Show everyone</button></div>}</div>
        ) : (
          <div className="tablewrap"><table className="t sn-list sn-batch">
            <thead><tr><th>Recipient</th><th className="hide-sm">Status</th><th className="hide-sm">Opened</th><th className="hide-sm">Completed</th><th><span className="sn-vh">Envelope</span></th></tr></thead>
            <tbody>
              {shown.map((e) => e.recipients.map((r: any, i: number) => {
                const st = personStatus(r, e.status);
                const done = r.status === 'completed' && r.role !== 'cc' ? dayTime(r.completed_at) : '';
                return (
                  <tr key={`${e.id}:${i}`} className={i === e.recipients.length - 1 ? 'last' : 'cont'}>
                    <td className="sn-main">
                      <b>{r.name || 'No name'}</b>{r.role === 'cc' && <span className="muted small"> · gets a copy</span>}
                      <div className="muted small sn-break">{r.email}</div>
                      <div className="sn-only-sm sn-rowmeta">
                        <Status s={st.s} label={st.label} />
                        {r.viewed_at && <span className="muted small">Opened {dayTime(r.viewed_at)}</span>}
                        {done && <span className="muted small">Completed {done}</span>}
                      </div>
                    </td>
                    <td className="hide-sm"><Status s={st.s} label={st.label} /></td>
                    <td className="hide-sm small">{r.viewed_at ? dayTime(r.viewed_at) : <span className="muted">Not yet</span>}</td>
                    <td className="hide-sm small">{done || <span className="muted">{r.role === 'cc' ? '' : 'Not yet'}</span>}</td>
                    <td className="sn-fit">{i === 0 && <Link className="btn sm" href={e.status === 'draft' ? `/app/envelopes/${e.id}/edit` : `/app/envelopes/${e.id}`} aria-label={`${e.status === 'draft' ? 'Finish and send the envelope for' : 'Open the envelope for'} ${r.name}`}>{e.status === 'draft' ? 'Finish' : 'Open'}</Link>}</td>
                  </tr>
                );
              }))}
            </tbody>
          </table></div>
        )}
      </section>

      {voiding && (
        <VoidDialog title="Void everything still open" confirmLabel={`Void ${plural(count.open, 'envelope')}`} onClose={() => setVoiding(false)}
          onVoid={async (reason) => {
            const { voided, skipped } = await api(`/bulk/${id}/void`, { body: { reason } });
            // An envelope that someone finished or declined while the others were being voided is left alone. Say so.
            const left = skipped ? ` ${plural(skipped, 'envelope')} ${skipped === 1 ? 'was' : 'were'} finished or closed in the meantime and ${skipped === 1 ? 'stays as it is' : 'stay as they are'}.` : '';
            toast(voided ? `${plural(voided, 'envelope')} voided. Everyone who had one has been told.${left}` : `Nothing was voided.${left || ' No envelope in this batch is still out for signature.'}`);
            setVoiding(false);
            reload();
          }}>
          <p>This voids the <b>{plural(count.open, 'envelope')}</b> still waiting for signatures. Nobody will be able to sign them, and everyone who has one is told why.</p>
          <p className="muted">{count.completed ? `The ${count.completed} completed ${count.completed === 1 ? 'one stays' : 'ones stay'} exactly as ${count.completed === 1 ? 'it is' : 'they are'}. ` : ''}{voidCostLine(readAllowance(null, me))}</p>
        </VoidDialog>
      )}
    </div>
  );
}
