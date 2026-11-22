'use client';
import { useState } from 'react';
import Link from 'next/link';
import { api, useLoad, fmtDate, toast } from '@/components/ui';
import { Mark } from '@/components/Brand';
import { useMe } from '@/components/AppShell';
import { NAV_START } from '@/lib/nav';
import { mayDo } from '@/lib/perm';
import { listName } from '@/lib/docname';
import { AllowanceCard } from '@/components/sender/UsageMeter';
import { useAllowance } from '@/components/sender/allowance';
import { fail } from '@/components/sender/feedback';
import { cap, howLong, neverOpened, waitingOn } from '@/components/sender/lib';
import { scheduledHome } from '@/components/sender/Timing';

const SHOWN = 5;
// How many waiting documents Home asks for. With that many or more, "See all" gives no number: it would be too low.
const WAITING_ASKED = 100;

export default function Home() {
  const me = useMe();
  const [rep] = useLoad(() => api('/reports/summary'));
  // What was completed lately, newest first: the thing people come back for is the signed copy.
  const [done] = useLoad(() => api('/envelopes?box=completed&limit=5'));
  const [out] = useLoad(() => api(`/envelopes?box=waiting&limit=${WAITING_ASKED}`));
  const [inbox] = useLoad(() => api('/inbox'));
  const [allowance] = useAllowance();
  const [nudging, setNudging] = useState('');

  const todo = (inbox?.items || []).filter((i: any) => i.status === 'sent' && (i.my_status === 'sent' || i.my_status === 'viewed') && i.role !== 'cc');
  const s = rep?.byStatus || {};
  const timed = { count: Number(rep?.scheduled?.count) || 0, next: rep?.scheduled?.next || null };
  const loose = Math.max(0, (s.draft || 0) - timed.count);

  // Envelopes held up by somebody else, the longest wait first.
  const others = (out?.envelopes || [])
    .map((e: any) => ({ e, w: waitingOn(e.recipients.filter((r: any) => r.role === 'inperson' || r.email.toLowerCase() !== me.user.email.toLowerCase())) }))
    .filter((x: any) => x.w)
    .sort((a: any, b: any) => String(a.w.since || '').localeCompare(String(b.w.since || '')));

  const completed: any[] = done?.envelopes || [];
  // Every list has answered and all of them are empty: a new account.
  const nothingYet = !!rep && !!done && !!out && !!inbox && !completed.length && !todo.length && !others.length && !(s.draft > 0) && !(s.sent > 0);
  // Only a role an admin made can leave sending out; with the built-in roles this is never true.
  const noSending = !!me.my_role?.custom && !mayDo(me, 'send') && !mayDo(me, 'see_all');

  async function nudge(e: any) {
    setNudging(e.id);
    try {
      const { reminded } = await api(`/envelopes/${e.id}/remind`, { method: 'POST' });
      if (reminded) toast(`Reminder emailed to ${reminded} ${reminded === 1 ? 'person' : 'people'}.`);
      else toast('No reminder went out. They turned reminders off. Open the document to share the link another way.', true);
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
          <h1 className="serif">Hello, <bdi>{me.user.name}</bdi></h1>
          <div className="muted">Every document you send here is one that never gets printed.</div>
        </div>
      </div>

      {/* A workspace that is paid for, or that more than one person works in, should never hang on one mailbox. */}
      {me.role !== 'member' && me.admins < 2 && (me.members > 1 || me.account.plan !== 'seedling') && (
        <div className="notice warn row between wrap" role="note">
          <span><b>This workspace depends on one person.</b> If you lose access to {me.user.email}, nobody else can manage the team, the plan or the documents. Add a second admin, who can do all three. Only you, as the owner, can hand the whole account to someone else, so do that on the Team tab before you move on.</span>
          <Link href="/app/settings?tab=team" className="btn sm">Add a second admin</Link>
        </div>
      )}

      {(todo.length > 0 || others.length > 0) && (
        <div className={`grid${todo.length > 0 && others.length > 0 ? ' g2' : ''} sn-waits`}>
          {todo.length > 0 && (
            <section className="card sn-wait you" aria-labelledby="sn-foryou-h">
              <h2 id="sn-foryou-h">Waiting for you</h2>
              <ul role="list">
                {todo.map((i: any, n: number) => (
                  <li key={i.id + i.token} data-item="row">
                    <div className="grow"><b>{listName(i.subject)}</b><div className="muted small">from {i.sender}{i.sent_at ? ` · ${howLong(i.sent_at)} ago` : ''}</div></div>
                    <a className={`btn sm${n === 0 ? ' primary' : ''}`} href={`/sign/${i.token}`} aria-label={`${i.role === 'approver' ? 'Review' : i.role === 'viewer' ? 'View' : 'Sign'} ${listName(i.subject)}`}>{i.role === 'approver' ? 'Review' : i.role === 'viewer' ? 'View' : 'Sign'}</a>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {others.length > 0 && (
            <section className="card sn-wait" aria-labelledby="sn-onothers-h">
              <div className="row between"><h2 id="sn-onothers-h">Waiting on others</h2>{others.length > SHOWN && <Link href="/app/envelopes?box=waiting" className="small">{(out?.envelopes || []).length >= WAITING_ASKED ? 'See all' : `See all ${others.length}`}</Link>}</div>
              <ul role="list">
                {others.slice(0, SHOWN).map(({ e, w }: any) => {
                  const cold = e.recipients.some((r: any) => neverOpened(r));
                  return (
                    <li key={e.id} data-item="row">
                      <div className="grow">
                        <Link href={`/app/envelopes/${e.id}`} className="sn-subject">{listName(e.subject) || 'Untitled'}</Link>
                        <div className="small"><b>{cap(w.label)}</b>{w.since ? <span className="muted"> for {howLong(w.since)}</span> : null}{cold ? <span className="sn-cold"> · not opened</span> : null}</div>
                      </div>
                      <button className="btn sm" disabled={nudging === e.id} onClick={() => nudge(e)} aria-label={`Send a reminder for ${listName(e.subject)}`}>{nudging === e.id ? 'Sending…' : 'Remind'}</button>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
        </div>
      )}

      {/* A draft somebody started and left is theirs to finish: one line, only when there is one. */}
      {/* A draft with a time to go out by itself (Send later) is not a forgotten one: said apart (sender/Timing.tsx). */}
      {loose > 0 && <p className="sn-drafts">You have {loose} {loose === 1 ? 'draft' : 'drafts'} that {loose === 1 ? 'was' : 'were'} not sent. <Link href="/app/envelopes?box=drafts">Open {loose === 1 ? 'it' : 'them'}</Link></p>}
      {timed.count > 0 && <p className="sn-drafts">{scheduledHome(timed.count, timed.next)} <Link href="/app/envelopes?box=drafts">See {timed.count === 1 ? 'it' : 'them'}</Link></p>}

      <AllowanceCard allowance={allowance} canUpgrade={me.role === 'owner' || me.role === 'admin'} />

      {completed.length > 0 && (
        <section className="card sn-wait sn-done" aria-labelledby="sn-done-h">
          <div className="row between"><h2 id="sn-done-h">Recently completed</h2><Link href="/app/envelopes?box=completed" className="small">See all completed</Link></div>
          <ul role="list">
            {completed.map((e: any) => (
              <li key={e.id} data-item="row">
                <div className="grow">
                  <Link href={`/app/envelopes/${e.id}`} className="sn-subject">{listName(e.subject) || 'Untitled'}</Link>
                  <div className="muted small">Completed {fmtDate(e.completed_at || e.updated_at)}{e.recipients?.length ? ` · ${e.recipients.map((r: any) => r.name).filter(Boolean).join(', ')}` : ''}</div>
                </div>
                <a className="btn sm" href={`/api/envelopes/${e.id}/download`} aria-label={`Download ${listName(e.subject) || 'the signed document'}`}>Download</a>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* A role the team made without sending: Home says what this person can do here, instead of nothing. */}
      {noSending && (
        <div className="card empty">
          <h2 style={{ fontSize: 18 }}>Your role on this team: {me.my_role?.name}</h2>
          <p>It does not include sending documents. {todo.length ? 'What others sent you to sign is above.' : 'What others send you to sign shows up here and under To sign.'}{mayDo(me, 'use_templates') || mayDo(me, 'make_templates') ? ' You can work on templates under Templates.' : ''} If you need to send, ask an admin of your team.</p>
          {(mayDo(me, 'use_templates') || mayDo(me, 'make_templates')) && <Link href="/app/templates" className="btn" style={{ minHeight: 44, display: 'inline-flex', alignItems: 'center' }}>Open Templates</Link>}
        </div>
      )}

      {/* Nothing anywhere yet: one sentence that says where the one start button is. No second button here. */}
      {nothingYet && !noSending && (
        <div className="card empty">
          <Mark size={32} label="" />
          <h2 style={{ marginTop: 10, fontSize: 18 }}>Nothing sent yet</h2>
          <p>Press <b>{NAV_START.label}</b><span className="sn-where-wide"> on the left</span><span className="sn-where-phone"> (Send, in the bar at the bottom)</span>. Upload a PDF, add who needs to sign and place the fields. It takes about a minute.</p>
        </div>
      )}
    </div>
  );
}
