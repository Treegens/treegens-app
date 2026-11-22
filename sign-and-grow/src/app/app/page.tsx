'use client';
import { useState } from 'react';
import Link from 'next/link';
import { api, useLoad, fmtDate, toast } from '@/components/ui';
import { Mark } from '@/components/Brand';
import { useMe } from '@/components/AppShell';
import { mayDo } from '@/lib/perm';
import { listName } from '@/lib/docname';
import { AllowanceCard } from '@/components/sender/UsageMeter';
import { useAllowance } from '@/components/sender/allowance';
import { fail } from '@/components/sender/feedback';
import { neverOpened, waitingOn } from '@/components/sender/lib';
import { scheduledHome } from '@/components/sender/Timing';
import { InstallHint } from '@/components/InstallHint';
import { OnePersonLine } from '@/components/sender/OnePersonLine';
// Every word in the sender's language (lang-sender, src/components/senderLang.tsx).
import { useST, senderRich } from '@/components/senderLang';
import { howLongIn, joinIn } from '@/lib/senderlang';

const SHOWN = 5;
// How many waiting documents Home asks for. With that many or more, "See all" gives no number: it would be too low.
const WAITING_ASKED = 100;

export default function Home() {
  const me = useMe();
  const T = useST();
  // Who a document waits on, in the reader's language: "Ada", "Ada and Ben" (waitingOn in sender/lib.ts).
  const waitLabel = (w: any) => joinIn(T.lang, w.people.map((r: any) => r.name || r.role_name || r.email)) || T('sender.someone');
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
      if (reminded) toast(T('home.reminded', { count: reminded }));
      else toast(T('home.not_reminded'), true);
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
          <h1 className="serif">{senderRich(T.lang, 'home.hello', { name: <bdi>{me.user.name}</bdi> })}</h1>
          <div className="muted">{T('home.tagline')}</div>
        </div>
      </div>

      {/* A team of two or more should never hang on one admin: one line that can be closed; the full words are in Settings, Team. */}
      <OnePersonLine me={me} />

      {(todo.length > 0 || others.length > 0) && (
        <div className={`grid${todo.length > 0 && others.length > 0 ? ' g2' : ''} sn-waits`}>
          {todo.length > 0 && (
            <section className="card sn-wait you" aria-labelledby="sn-foryou-h">
              <h2 id="sn-foryou-h">{T('home.for_you')}</h2>
              <ul role="list">
                {todo.map((i: any, n: number) => (
                  <li key={i.id + i.token} data-item="row">
                    <div className="grow"><b>{listName(i.subject)}</b><div className="muted small">{T('home.from', { sender: i.sender })}{i.sent_at ? ` · ${T('home.ago', { time: howLongIn(T.lang, i.sent_at) })}` : ''}</div></div>
                    <a className={`btn sm${n === 0 ? ' primary' : ''}`} href={`/sign/${i.token}`} aria-label={T('home.act.label', { action: T(i.role === 'approver' ? 'home.act.review' : i.role === 'viewer' ? 'home.act.view' : 'home.act.sign'), document: listName(i.subject) })}>{T(i.role === 'approver' ? 'home.act.review' : i.role === 'viewer' ? 'home.act.view' : 'home.act.sign')}</a>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {others.length > 0 && (
            <section className="card sn-wait" aria-labelledby="sn-onothers-h">
              <div className="row between"><h2 id="sn-onothers-h">{T('home.on_others')}</h2>{others.length > SHOWN && <Link href="/app/envelopes?box=waiting" className="small">{(out?.envelopes || []).length >= WAITING_ASKED ? T('home.see_all') : T('home.see_all_n', { count: String(others.length) })}</Link>}</div>
              <ul role="list">
                {others.slice(0, SHOWN).map(({ e, w }: any) => {
                  const cold = e.recipients.some((r: any) => neverOpened(r));
                  return (
                    <li key={e.id} data-item="row">
                      <div className="grow">
                        <Link href={`/app/envelopes/${e.id}`} className="sn-subject">{listName(e.subject) || T('sender.untitled')}</Link>
                        <div className="small"><b>{waitLabel(w)}</b>{w.since ? <span className="muted">{' '}{T('home.for_time', { time: howLongIn(T.lang, w.since) })}</span> : null}{cold ? <span className="sn-cold">{' · '}{T('home.not_opened')}</span> : null}</div>
                      </div>
                      <button className="btn sm" disabled={nudging === e.id} onClick={() => nudge(e)} aria-label={T('home.remind_label', { document: listName(e.subject) })}>{nudging === e.id ? T('home.reminding') : T('home.remind')}</button>
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
      {loose > 0 && <p className="sn-drafts">{T('home.drafts', { count: loose })}{' '}<Link href="/app/envelopes?box=drafts">{T('home.drafts_open', { count: loose })}</Link></p>}
      {timed.count > 0 && <p className="sn-drafts">{scheduledHome(timed.count, timed.next)}{' '}<Link href="/app/envelopes?box=drafts">{T('home.scheduled_see', { count: timed.count })}</Link></p>}

      {/* On a phone only, on the first visits: one line to add GrowSigning to the home screen (InstallHint.tsx). */}
      <InstallHint />

      <AllowanceCard allowance={allowance} canUpgrade={me.role === 'owner' || me.role === 'admin'} />

      {completed.length > 0 && (
        <section className="card sn-wait sn-done" aria-labelledby="sn-done-h">
          <div className="row between"><h2 id="sn-done-h">{T('home.done')}</h2><Link href="/app/envelopes?box=completed" className="small">{T('home.done_all')}</Link></div>
          <ul role="list">
            {completed.map((e: any) => (
              <li key={e.id} data-item="row">
                <div className="grow">
                  <Link href={`/app/envelopes/${e.id}`} className="sn-subject">{listName(e.subject) || T('sender.untitled')}</Link>
                  <div className="muted small">{T('home.completed_on', { date: fmtDate(e.completed_at || e.updated_at) })}{e.recipients?.length ? ` · ${e.recipients.map((r: any) => r.name).filter(Boolean).join(', ')}` : ''}</div>
                </div>
                <a className="btn sm" href={`/api/envelopes/${e.id}/download`} aria-label={T('home.download_label', { document: listName(e.subject) || T('home.the_signed') })}>{T('home.download')}</a>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* A role the team made without sending: Home says what this person can do here, instead of nothing. */}
      {noSending && (
        <div className="card empty">
          <h2 style={{ fontSize: 18 }}>{T('home.role.title', { role: me.my_role?.name || '' })}</h2>
          <p>{T('home.role.body')} {T(todo.length ? 'home.role.above' : 'home.role.here')}{mayDo(me, 'use_templates') || mayDo(me, 'make_templates') ? ` ${T('home.role.templates')}` : ''} {T('home.role.ask')}</p>
          {(mayDo(me, 'use_templates') || mayDo(me, 'make_templates')) && <Link href="/app/templates" className="btn" style={{ minHeight: 44, display: 'inline-flex', alignItems: 'center' }}>{T('home.role.open_templates')}</Link>}
        </div>
      )}

      {/* Nothing anywhere yet: one sentence that says where the one start button is. No second button here. */}
      {nothingYet && !noSending && (
        <div className="card empty">
          <Mark size={32} label="" />
          <h2 style={{ marginTop: 10, fontSize: 18 }}>{T('home.empty.title')}</h2>
          <p><span className="sn-where-wide">{senderRich(T.lang, 'home.empty.wide', { button: <b>{T('nav.start')}</b> })}</span><span className="sn-where-phone">{senderRich(T.lang, 'home.empty.phone', { button: <b>{T('nav.start')}</b> })}</span></p>
        </div>
      )}
    </div>
  );
}
