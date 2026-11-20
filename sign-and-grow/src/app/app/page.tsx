'use client';
import { useState } from 'react';
import Link from 'next/link';
import { api, useLoad, Status, fmtDate, Leaf, toast } from '@/components/ui';
import { useMe } from '@/components/AppShell';
import { fmtNum, fmtTrees } from '@/lib/impact';
import { AllowanceCard } from '@/components/sender/UsageMeter';
import { useAllowance } from '@/components/sender/allowance';
import { fail } from '@/components/sender/feedback';
import { cap, howLong, neverOpened, waitingOn } from '@/components/sender/lib';

const SHOWN = 5;

export default function Home() {
  const me = useMe();
  const [rep] = useLoad(() => api('/reports/summary'));
  const [recent] = useLoad(() => api('/envelopes?limit=6'));
  const [out] = useLoad(() => api('/envelopes?box=waiting&limit=100'));
  const [inbox] = useLoad(() => api('/inbox'));
  const [impact] = useLoad(() => api('/impact'));
  const [allowance] = useAllowance();
  const [nudging, setNudging] = useState('');

  const todo = (inbox?.items || []).filter((i: any) => i.status === 'sent' && (i.my_status === 'sent' || i.my_status === 'viewed') && i.role !== 'cc');
  const s = rep?.byStatus || {};

  // Envelopes held up by somebody else, the longest wait first.
  const others = (out?.envelopes || [])
    .map((e: any) => ({ e, w: waitingOn(e.recipients.filter((r: any) => r.role === 'inperson' || r.email.toLowerCase() !== me.user.email.toLowerCase())) }))
    .filter((x: any) => x.w)
    .sort((a: any, b: any) => String(a.w.since || '').localeCompare(String(b.w.since || '')));

  async function nudge(e: any) {
    setNudging(e.id);
    try {
      const { reminded } = await api(`/envelopes/${e.id}/remind`, { method: 'POST' });
      if (reminded) toast(`Reminder emailed to ${reminded} ${reminded === 1 ? 'person' : 'people'}.`);
      else toast('No reminder went out. They turned reminders off. Open the envelope to share the link another way.', true);
    } catch (err) {
      fail(err);
    } finally {
      setNudging('');
    }
  }

  return (
    <div className="sn stack">
      <div className="pagehead" style={{ marginBottom: 0 }}>
        <div>
          <h1 className="serif">Hello, {me.user.name.split(' ')[0]}</h1>
          <div className="muted">Every document you send here is one that never gets printed.</div>
        </div>
        <div className="row wrap">
          <Link href="/app/envelopes/new?self=1" className="btn">Sign a document yourself</Link>
          <Link href="/app/envelopes/new" className="btn primary">Send for signature</Link>
        </div>
      </div>

      {(todo.length > 0 || others.length > 0) && (
        <div className={`grid${todo.length > 0 && others.length > 0 ? ' g2' : ''} sn-waits`}>
          {todo.length > 0 && (
            <section className="card sn-wait you" aria-labelledby="sn-foryou-h">
              <h2 id="sn-foryou-h">Waiting for you</h2>
              <ul role="list">
                {todo.map((i: any) => (
                  <li key={i.id + i.token}>
                    <div className="grow"><b>{i.subject}</b><div className="muted small">from {i.sender}{i.sent_at ? ` · ${howLong(i.sent_at)} ago` : ''}</div></div>
                    <a className="btn sm primary" href={`/sign/${i.token}`} aria-label={`${i.role === 'approver' ? 'Review' : i.role === 'viewer' ? 'View' : 'Sign'} ${i.subject}`}>{i.role === 'approver' ? 'Review' : i.role === 'viewer' ? 'View' : 'Sign'}</a>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {others.length > 0 && (
            <section className="card sn-wait" aria-labelledby="sn-onothers-h">
              <div className="row between"><h2 id="sn-onothers-h">Waiting on others</h2>{others.length > SHOWN && <Link href="/app/envelopes?box=waiting" className="small">See all {others.length}</Link>}</div>
              <ul role="list">
                {others.slice(0, SHOWN).map(({ e, w }: any) => {
                  const cold = e.recipients.some((r: any) => neverOpened(r));
                  return (
                    <li key={e.id}>
                      <div className="grow">
                        <Link href={`/app/envelopes/${e.id}`} className="sn-subject">{e.subject}</Link>
                        <div className="small"><b>{cap(w.label)}</b>{w.since ? <span className="muted"> for {howLong(w.since)}</span> : null}{cold ? <span className="sn-cold"> · not opened</span> : null}</div>
                      </div>
                      <button className="btn sm" disabled={nudging === e.id} onClick={() => nudge(e)} aria-label={`Send a reminder for ${e.subject}`}>{nudging === e.id ? 'Sending…' : 'Remind'}</button>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
        </div>
      )}

      <div className="grid g4 keep2">
        <Link href="/app/envelopes?box=drafts" className="stat sn-statlink"><div className="k">Drafts</div><div className="v num">{s.draft || 0}</div></Link>
        <Link href="/app/envelopes?box=waiting" className="stat sn-statlink"><div className="k">Waiting for others</div><div className="v num">{s.sent || 0}</div></Link>
        <Link href="/app/envelopes?box=completed" className="stat sn-statlink"><div className="k">Completed</div><div className="v num">{s.completed || 0}</div></Link>
        <Link href="/app/impact" className="stat green sn-statlink">
          <div className="k">Paper saved</div><div className="v num">{impact ? fmtNum(impact.account.sheets) : '…'}</div>
          <div className="s">sheets, or {impact ? fmtTrees(impact.account.trees) : '…'} of a tree</div>
        </Link>
      </div>

      <AllowanceCard allowance={allowance} canUpgrade={me.role === 'owner' || me.role === 'admin'} />

      <section className="card pad0" aria-labelledby="sn-recent-h">
        <div className="row between sn-cardhead"><h2 id="sn-recent-h">Recent envelopes</h2><Link href="/app/envelopes?box=all">See all</Link></div>
        {recent && recent.envelopes.length === 0 ? (
          <div className="empty"><Leaf size={32} color="#6fb35f" /><h3 style={{ marginTop: 10 }}>Nothing sent yet</h3>Upload a PDF, add who needs to sign and place the fields. It takes about a minute.<div style={{ marginTop: 14 }}><Link href="/app/envelopes/new" className="btn primary">Send your first envelope</Link></div></div>
        ) : (
          <div className="tablewrap"><table className="t sn-list"><tbody>
            {(recent?.envelopes || []).map((e: any) => {
              const href = e.status === 'draft' ? `/app/envelopes/${e.id}/edit` : `/app/envelopes/${e.id}`;
              const w = e.status === 'sent' ? waitingOn(e.recipients, me.user.email) : null;
              return (
                <tr key={e.id} className="click" onClick={() => (window.location.href = href)}>
                  <td className="sn-main">
                    <Link href={href} className="sn-subject" onClick={(ev) => ev.stopPropagation()}>{e.subject || 'Untitled draft'}</Link>
                    <div className="muted small sn-to">{w ? <>Waiting on {w.label}{w.since ? ` for ${howLong(w.since)}` : ''}</> : <>To {e.recipients.map((r: any) => r.name).filter(Boolean).join(', ') || 'nobody yet'}</>}</div>
                  </td>
                  <td className="sn-fit"><Status s={e.status} /></td>
                  <td className="muted small hide-sm sn-fit">{fmtDate(e.updated_at)}</td>
                </tr>
              );
            })}
          </tbody></table></div>
        )}
      </section>
    </div>
  );
}
