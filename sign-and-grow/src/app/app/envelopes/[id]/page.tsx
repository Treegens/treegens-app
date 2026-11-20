'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { api, useLoad, Status, fmtDate, toast, Leaf } from '@/components/ui';
import { useMe } from '@/components/AppShell';
import { fmtNum, fmtTrees, impactOf } from '@/lib/impact';
import { reminderText } from '@/lib/policy';
import { Recipients, lastEmailTo, type Delivery } from '@/components/sender/Recipients';
import { BackNews, MailStopLines, deliveredLine, remindedText } from '@/components/sender/MailNews';
import { ConfirmDialog, CorrectDialog, ExtendDialog, VoidDialog } from '@/components/sender/dialogs';
import { fail } from '@/components/sender/feedback';
import { AfterSend } from '@/components/sender/AfterSend';
import { PrintNotice } from '@/components/sender/PrintNotice';
import { PayLinkNote } from '@/components/sender/PayLinkNote';
import { readAllowance, voidCostLine } from '@/components/sender/allowance';
import { ownLink } from '@/components/sender/OwnLink';
import { Disputed } from '@/components/sender/Disputed';
import { EnvelopeComments } from '@/components/sender/Comments';
import { closingSoon, dayTime, deadlineLine, hasTurn, howLong, joinNames, longDate, neverOpened, waitingOn } from '@/components/sender/lib';

const MAIL_STATUS: Record<string, string> = { sent: 'Handed to the mail server', outbox: 'Not delivered, no mail server set up', failed: 'Could not be sent', queued: 'Waiting to go out' };

export default function EnvelopeDetail() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const me = useMe();
  const [data, reload, error] = useLoad(() => api(`/envelopes/${id}`), [id]);
  const [dialog, setDialog] = useState<'' | 'void' | 'extend' | 'delete'>('');
  const [fix, setFix] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const askedForTime = useRef(false);

  // Emails about deadlines link here with ?extend=1, so the dialog is already open when the page loads.
  useEffect(() => {
    if (!data || askedForTime.current) return;
    askedForTime.current = true;
    const q = new URLSearchParams(window.location.search);
    if (q.get('extend') !== '1') return;
    const s = data.envelope.status;
    if (s === 'sent' || s === 'expired') setDialog('extend');
    else toast(s === 'completed' ? 'Everyone has already finished, so this one does not need more time.' : 'This envelope is closed, so it cannot be given more time. Clone it to send it again.');
    q.delete('extend');
    window.history.replaceState(null, '', `${window.location.pathname}${q.toString() ? `?${q}` : ''}`);
  }, [data]);

  const act = async (fn: () => Promise<any>, ok?: string) => {
    setBusy(true);
    try {
      await fn();
      if (ok) toast(ok);
      reload();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  if (error) return <div className="sn card center"><h1 className="serif" style={{ fontSize: 22 }}>We could not open this envelope</h1><p className="muted" style={{ marginTop: 8 }}>It may have been deleted, or it belongs to someone else on your team. Ask them to share it, or go back to your list.</p><Link href="/app/envelopes" className="btn">Back to envelopes</Link></div>;
  if (!data) return <div className="muted" role="status">Loading…</div>;

  const e = data.envelope;
  const deliveries: Delivery[] = data.deliveries || [];
  const isTpl = e.kind === 'template';
  // A template says who may change it (access, src/server/tplroles.ts): the person it belongs to and admins, and
  // whoever its rule adds. A locked one is not copied as a way to change it: the copy would be locked too.
  const mayChange = !isTpl || (e.access ? e.access.may_change !== false : me.role !== 'member' || e.sender_id === me.user.id);
  const tplLocked = isTpl && !!e.access?.locked && !mayChange;
  // A copy of a template that is not for everyone stays with its owner, so "make your own copy" is not offered.
  const tplHeld = isTpl && !mayChange && e.access?.copy_is_yours === false;
  const done = e.status === 'completed';
  // Set when its sender removed this envelope from their lists. Only an admin gets to see it then: they can read
  // it, download it and put it back, and nothing else until it is back.
  const removed: string | null = data.removed_at || null;
  const isAdmin = me.role !== 'member';
  const impact = impactOf(e.sheets);
  const pages = e.documents.reduce((n: number, d: any) => n + d.pages, 0);
  const out = e.status === 'sent';
  const acting = e.recipients.filter((r: any) => r.role !== 'cc');
  const finished = acting.filter((r: any) => r.status === 'completed');
  const unfinished = acting.filter((r: any) => r.status !== 'completed');
  // An envelope somebody has signed is not only the sender's: deleting it takes it out of the sender's account and
  // leaves every recipient their link and their copy. That is every completed one, and a voided, declined or
  // expired one on which someone had already finished.
  // The server's own rule decides (kept_on_delete, src/server/deleting.ts), so this dialog never says "for good" about
  // one that is kept. The line after ?? is only for an answer from a server older than that flag.
  const kept = data.kept_on_delete ?? (!isTpl && e.status !== 'draft' && (done || e.recipients.some((r: any) => r.status === 'completed' && r.role !== 'cc')));
  const waiting = out ? waitingOn(e.recipients, me.user.email) : null;
  const unopened = out ? e.recipients.filter((r: any) => neverOpened(r)) : [];
  // People who filled in everything required and have not pressed Finish, by the server's count (progress.ready).
  const almost = out ? e.recipients.filter((r: any) => r.progress?.ready) : [];
  const bounced = out ? e.recipients.filter((r: any) => r.status === 'sent' && r.role !== 'inperson' && lastEmailTo(deliveries, r.email, r.id)?.status === 'failed') : [];
  // Reminders never go to people who turned them off, so do not offer a button that would do nothing. Nor to an
  // address the last email came back from, or someone who marked one as spam (MailNews.tsx).
  const stopped = out ? e.recipients.filter((r: any) => hasTurn(r) && r.role !== 'inperson' && (r.bounced_at || r.complained_at)) : [];
  // Nor to someone with no address, whose link the sender passes on (OwnLink.tsx): their card offers the link instead.
  const canRemind = out && e.recipients.some((r: any) => hasTurn(r) && !r.muted && !stopped.includes(r) && !ownLink(r));
  const allMuted = out && !canRemind && e.recipients.some((r: any) => hasTurn(r) && r.muted);
  const decliner = e.recipients.find((r: any) => r.status === 'declined');
  // Only worth a banner while people can still act on it. Each recipient's own line says it in every state.
  const noMailServer = out && deliveries.some((d) => d.status === 'outbox');
  const editHref = `/app/${isTpl ? 'templates' : 'envelopes'}/${e.id}/edit`;
  const costLine = voidCostLine(readAllowance(null, me));
  // While sending is paused the server refuses reminders and reopening. The buttons say so before they are pressed.
  const paused = !!me.account?.paused;

  async function remindAll() {
    await act(async () => {
      const { reminded, not_reminded } = await api(`/envelopes/${e.id}/remind`, { method: 'POST' });
      // Someone whose link you send yourself is named apart: nothing was wrong with an email, there was none to send.
      const own = (not_reminded || []).filter((x: any) => x.why === 'link_by_sender');
      const said = remindedText(reminded, (not_reminded || []).filter((x: any) => x.why !== 'link_by_sender'));
      toast(own.length ? `${said.text} You send the link to ${own.map((x: any) => x.name).join(' and ')} yourself, so we did not write to ${own.length === 1 ? 'them' : 'them either'}.` : said.text, said.bad);
    });
  }
  const clone = (kind: 'envelope' | 'template') => act(async () => {
    const r = await api(`/envelopes/${e.id}/clone`, { body: { kind } });
    // A template made from a locked one, or from one not for everyone, stays with the person that one belongs to and
    // keeps its rules (cloneOwner in src/server/tplroles.ts).
    if (r.belongs_to) return (toast(`Saved as a template. It keeps the rules of the template it came from${r.locked ? ', and its wording stays locked' : ''}, so it belongs to ${r.belongs_to}. Only they or an admin can change who can use it.`), router.push('/app/templates'));
    router.push(`/app/${kind === 'template' ? 'templates' : 'envelopes'}/${r.id}/edit`);
  });

  return (
    <div className="sn stack">
      <div className="pagehead" style={{ marginBottom: 0 }}>
        <div className="grow">
          <Link href={isTpl ? '/app/templates' : '/app/envelopes'} className="small sn-back">← {isTpl ? 'Templates' : 'Envelopes'}</Link>
          <h1 className="serif sn-title">{e.subject || (isTpl ? 'Untitled template' : 'Untitled')}</h1>
          <div className="row wrap" style={{ marginTop: 6, rowGap: 4 }}>
            <Status s={e.status} label={isTpl ? 'Template' : undefined} />
            <span className="muted small">{e.sent_at ? `Sent ${fmtDate(e.sent_at, true)} · ` : ''}<span className="sn-id">ID {e.id}</span></span>
          </div>
        </div>
        <div className="row wrap sn-headactions">
          {e.documents.length > 0 && <a className="btn" href={`/api/envelopes/${e.id}/download?inline=1`} target="_blank" rel="noreferrer">{e.status === 'completed' ? 'View signed PDF' : 'Preview PDF'}</a>}
          {e.status === 'completed' && <a className="btn primary" href={`/api/envelopes/${e.id}/download`}>Download with certificate</a>}
          {/* The signed PDF, the certificate, the record, our emails and the consent wording in one ZIP (evidence.ts). */}
          {!isTpl && e.status !== 'draft' && <a className="btn" href={`/api/envelopes/${e.id}/evidence`} title="A ZIP with the signed PDF, its certificate, the audit trail as text and data, our emails about it and what each person agreed to">Download evidence pack</a>}
          {!removed && <button className="btn" disabled={busy} onClick={() => clone('envelope')}>{isTpl ? 'Use' : 'Clone'}</button>}
          {!removed && !isTpl && <button className="btn" disabled={busy} onClick={() => clone('template')}>Save as template</button>}
          {out && <button className="btn danger" onClick={() => setDialog('void')}>Void</button>}
          {!removed && !out && mayChange && (!isTpl || e.access?.may_delete !== false) && <button className="btn ghost danger" disabled={busy} onClick={() => setDialog('delete')}>Delete</button>}
        </div>
      </div>

      {removed && (
        <section className="card sn-now closed" aria-label="Removed by its sender">
          <div className="sn-now-main">
            <div>
              <p className="sn-now-line">Removed from its sender&apos;s lists on {longDate(removed)}.</p>
              <p className="sn-now-sub">It is only under Envelopes, in the tab Removed by its sender: in no other list, search, export or report of your team. Everyone who was on it still has their link and their copy. You can open it because you are an admin of this account.</p>
              <p className="sn-now-sub">Put it back and it is an ordinary envelope again, for its sender and for the admins. The audit trail records who removed it and who put it back.</p>
            </div>
            <div className="sn-now-actions"><button className="btn primary" disabled={busy} onClick={() => act(() => api(`/envelopes/${e.id}/restore`, { method: 'POST' }), 'Put back. It is in the lists, the search, the export and the reports again.')}>Put it back</button></div>
          </div>
        </section>
      )}

      {/* Someone named on it said they did not sign it, or that it was not them (src/server/evidence.ts). */}
      <Disputed envelope={e} audit={data.audit} />

      {/* A name or wording in a script the signed PDF has no font for: said here, before anyone signs. */}
      {(data.print_problems || []).length > 0 && <PrintNotice problems={data.print_problems} />}

      {e.status === 'draft' && (
        <section className="card sn-now" aria-label="Where this stands">
          <div className="sn-now-main">
            <div><p className="sn-now-line">{isTpl ? 'A template, ready to use.' : 'Not sent yet.'}</p><p className="muted">{!isTpl ? 'Nobody has received anything. Pick up where you left off.' : mayChange ? 'Use it to start a new envelope, or edit it to change the document, roles and fields.' : tplLocked ? `Use it to start a new envelope. Its wording is locked: you fill in names, email addresses and the fields left empty for you. To change it, ask ${e.access.owner} or an admin of your team.` : tplHeld ? `Use it to start a new envelope. It belongs to ${e.access.owner} and is not for everyone on the team, so only they or an admin can change it, and a copy would be theirs too. To change something, ask ${e.access.owner} or an admin of your team.` : 'Use it to start a new envelope. It belongs to a colleague, so only they or an admin of your team can change or delete it. To change something, make your own copy: the copy is yours and the original stays as it is.'}</p></div>
            {mayChange ? <div className="sn-now-actions"><Link href={editHref} className="btn primary">{isTpl ? 'Edit template' : 'Continue editing'}</Link></div>
              : tplLocked || tplHeld ? <div className="sn-now-actions"><button className="btn primary" disabled={busy} onClick={() => clone('envelope')}>Use</button></div>
              : <div className="sn-now-actions"><button className="btn primary" disabled={busy} onClick={() => clone('template')}>Make my own copy</button></div>}
          </div>
        </section>
      )}

      {/* Right after sending: what we email the sender, and the one switch for an email at each signature. */}
      {out && <AfterSend envelope={e} />}

      {out && (
        <section className="card sn-now" aria-label="Where this stands">
          <div className="sn-now-main">
            <div>
              <p className="sn-now-line">{waiting ? <>Waiting on <b>{waiting.label}</b>{waiting.since ? ` for ${howLong(waiting.since)}` : ''}.</> : 'Sent. Nobody is holding it up right now.'}</p>
              {bounced.length > 0 && <p className="sn-now-sub warn">The email to {joinNames(bounced.map((r: any) => r.name))} {bounced.some((r: any) => lastEmailTo(deliveries, r.email, r.id)?.next_try_at) ? 'has not gone out yet, and we keep trying' : 'did not go out'}. See below to fix the address or share the link yourself.</p>}
              <MailStopLines people={stopped} />
              {almost.length > 0 && <p className="sn-now-sub warn" id="sn-almost"><b>{joinNames(almost.map((r: any) => r.name))}</b> {almost.length === 1 ? 'has' : 'have'} filled in everything but {almost.length === 1 ? 'has' : 'have'} not pressed Finish, so {almost.length === 1 ? 'their part is' : 'their parts are'} not signed yet. A reminder tells them that one button is left.</p>}
              {unopened.length > 0 && <p className="sn-now-sub warn">{joinNames(unopened.map((r: any) => r.name))} {unopened.length === 1 ? 'has' : 'have'} not opened it yet. See below for ways to reach them.</p>}
              {allMuted && <p className="sn-now-sub">They turned reminder emails off, so reach them with their link instead. It is below.</p>}
              <p className={`sn-now-sub${closingSoon(e.expires_at) ? ' warn' : ''}`}>{e.expires_at ? `${deadlineLine(e.expires_at)}.` : 'No closing date.'}{closingSoon(e.expires_at) ? ' Give more time if they need it.' : ''}</p>
              {/* Whether anyone is reminded without the sender doing anything, in a full sentence (reminderText in src/lib/policy.ts). */}
              {!paused && <p className="sn-now-sub" id="sn-reminders">{reminderText(e.reminder_days)}{e.reminder_days > 0 && e.recipients.some(ownLink) ? ' For someone whose link you send yourself, the reminder comes to you instead.' : ''} To change it, use Edit envelope.</p>}
              {paused && <p className="sn-now-sub warn">Sending is paused on this account, so reminders are off, nobody is emailed about a change you make, and people further down the signing order are asked only once the pause is lifted. You can still give more time, change the envelope and void it.</p>}
              {!paused && e.held_at && <p className="sn-now-sub warn">We are holding back emails about this envelope. We emailed you why, and the history below says it too.</p>}
            </div>
            <div className="sn-now-actions">
              {canRemind && <button className="btn" disabled={busy || paused} title={paused ? 'Sending is paused on this account, so no reminders go out.' : undefined} onClick={remindAll}>Send reminder</button>}
              <button className={`btn${closingSoon(e.expires_at) ? ' sn-amber' : ''}`} onClick={() => setDialog('extend')}>Give more time</button>
            </div>
          </div>
          <div className="sn-edit">
            <div>
              <b>Need to change something?</b> Fix a typo, swap a document or change who signs, without voiding.
              {finished.length > 0 && <div className="small sn-edit-lock">{joinNames(finished.map((r: any) => r.name))} already finished. Names, addresses and the order of the others can still change. A change to the pages means asking {finished.length === 1 ? 'them' : 'those who finished'} to sign again, and you are asked first.</div>}
            </div>
            <Link href={editHref} className="btn primary">Edit envelope</Link>
          </div>
        </section>
      )}

      {e.status === 'expired' && (
        <section className="card sn-now expired" aria-label="Where this stands">
          <div className="sn-now-main">
            <div>
              <p className="sn-now-line">{e.expires_at ? `${deadlineLine(e.expires_at)}` : 'This closed'} before everyone had finished.</p>
              {unfinished.length > 0 && <p className="sn-now-sub">Still needed: <b>{joinNames(unfinished.map((r: any) => r.name))}</b>.</p>}
              <p className="sn-now-sub">{paused ? 'Sending is paused on this account. Reopening emails everyone who still has to sign, so it has to wait until the pause is lifted.' : 'Reopen it with a new closing date. Nobody who already signed has to sign again.'}</p>
            </div>
            {!removed && <div className="sn-now-actions"><button className="btn primary" disabled={paused} title={paused ? 'Sending is paused on this account, so this has to wait.' : undefined} onClick={() => setDialog('extend')}>Reopen</button></div>}
          </div>
        </section>
      )}

      {e.status === 'declined' && (
        <section className="card sn-now closed" aria-label="Where this stands">
          <div className="sn-now-main">
            <div>
              <p className="sn-now-line">{decliner ? <><b>{decliner.name}</b> declined{decliner.completed_at ? ` on ${longDate(decliner.completed_at)}` : ''}.</> : 'This was declined.'}</p>
              {decliner?.decline_reason && <p className="sn-now-sub">They wrote: &ldquo;{decliner.decline_reason}&rdquo;</p>}
              <p className="sn-now-sub">This envelope is closed. Clone it, change what needs changing and send it again.</p>
            </div>
            {!removed && <div className="sn-now-actions"><button className="btn primary" disabled={busy} onClick={() => clone('envelope')}>Clone and fix</button></div>}
          </div>
        </section>
      )}

      {e.status === 'voided' && (
        <section className="card sn-now closed" aria-label="Where this stands">
          <div className="sn-now-main">
            <div>
              <p className="sn-now-line">Voided. Nobody can sign it any more.</p>
              <p className="sn-now-sub">Reason given: &ldquo;{e.void_reason}&rdquo;</p>
              <p className="sn-now-sub">{costLine ? `${costLine} ` : ''}Clone it to send a corrected one.</p>
            </div>
            {!removed && <div className="sn-now-actions"><button className="btn" disabled={busy} onClick={() => clone('envelope')}>Clone</button></div>}
          </div>
        </section>
      )}

      {e.status === 'completed' && (
        <div className="card row" style={{ background: 'var(--green-soft)', borderColor: '#cfe3d2', alignItems: 'flex-start' }}>
          <Leaf size={26} color="#1f6f43" />
          <div><b>Everyone finished{e.completed_at ? ` on ${longDate(e.completed_at)}` : ''}. Completed without paper.</b> About {fmtNum(impact.sheets)} sheets, {fmtNum(impact.litresWater)} litres of water and {fmtNum(impact.kgCo2, 2)} kg of CO2e not used ({fmtTrees(impact.trees)} of a tree).</div>
        </div>
      )}

      <section className="card pad0" aria-labelledby="sn-rcpt-h">
        <div className="sn-cardhead">
          <h2 id="sn-rcpt-h">{isTpl ? 'Roles' : 'Recipients'}</h2>
          {!isTpl && e.status !== 'draft' && <p className="muted small">What happened to each email, when they opened the document, and when they finished.{e.ordered ? ' They sign in the order shown.' : ''}</p>}
        </div>
        {noMailServer && (
          <div className="notice warn sn-inset" role="note">
            This server has no mail server set up, so emails are saved but not delivered. Share each link yourself with the buttons below.
            {me.outbox && <> You can read the saved emails in the <a href="/dev/outbox" target="_blank" rel="noreferrer">dev outbox</a>.</>}
          </div>
        )}
        {e.recipients.length === 0 ? <div className="empty">Nobody has been added yet.</div> : (
          <Recipients envelope={e} deliveries={deliveries} texts={data.texts || []} myEmail={me.user.email} onChanged={reload} onCorrect={setFix} paused={paused} />
        )}
      </section>

      {/* Questions and comments: the threads, who waits for an answer, answer and settle (components/sender/Comments.tsx). */}
      {!isTpl && <EnvelopeComments envelope={e} />}

      {/* The link to the sender's own payment page, when there is one: who was shown it and who pressed it. */}
      <PayLinkNote envelopeId={e.id} closed={!isTpl && e.status !== 'draft' && e.status !== 'sent'} />

      <div className="grid g2">
        <section className="card" aria-labelledby="sn-docs-h">
          <h2 id="sn-docs-h" style={{ marginBottom: 10 }}>Documents</h2>
          {e.documents.length === 0 && <div className="muted small">No document has been added yet.</div>}
          {e.documents.map((d: any) => <div key={d.id} className="row between" style={{ padding: '5px 0' }}><span className="truncate">{d.name}</span><span className="muted small" style={{ whiteSpace: 'nowrap' }}>{d.pages} page{d.pages === 1 ? '' : 's'}</span></div>)}
          <div className="muted small" style={{ marginTop: 8 }}>
            {pages} page{pages === 1 ? '' : 's'} · {e.fields.length} field{e.fields.length === 1 ? '' : 's'} · {e.ordered ? 'signed in order' : 'everyone at once'}
            {!isTpl && <> · {e.reminder_days > 0 ? `automatic reminder every ${e.reminder_days} day${e.reminder_days === 1 ? '' : 's'}` : 'no automatic reminders'}</>}
          </div>
          {e.message && <p className="muted" style={{ marginTop: 12, whiteSpace: 'pre-wrap' }}>&ldquo;{e.message}&rdquo;</p>}
          {!isTpl && deliveries.length > 0 && (
            <details className="sn-mails">
              <summary>Every email about this envelope ({deliveries.length})</summary>
              <ul>
                {deliveries.map((d, i) => (
                  <li key={i}>
                    <div><b className="small">{d.subject}</b></div>
                    <div className="muted small">To {d.to_email} · {dayTime(d.at)}</div>
                    {/* A refused email is tried again by the timer: say whether a next try is coming or nobody tries any more. */}
                    <div className={`small${d.status === 'failed' || d.status === 'outbox' ? ' sn-bad' : ''}`}>{d.status === 'sent' && deliveredLine(d) ? <>{deliveredLine(d)}.</> : <>{d.status === 'failed' && d.next_try_at ? 'Not sent yet' : MAIL_STATUS[d.status] || d.status}{d.status === 'failed' && d.error ? `: ${d.error}` : ''}{d.status === 'failed' ? (d.next_try_at ? `. We try again around ${dayTime(d.next_try_at)}.` : '. We have stopped trying.') : ''}</>}<BackNews d={d} /></div>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </section>
        <section className="card" aria-labelledby="sn-audit-h">
          <div className="row between wrap"><h2 id="sn-audit-h">Audit trail</h2><span className={`badge ${data.chain.ok ? 'completed' : 'declined'}`}>{data.chain.ok ? 'Record intact' : 'Record was altered'}</span></div>
          <div className="sn-audit" tabIndex={0} role="group" aria-label="Audit trail entries">
            {data.audit.length === 0 && <div className="muted small">Nothing has happened yet.</div>}
            {data.audit.map((a: any) => (
              <div key={a.seq} className="sn-audit-item">
                <div className="row between wrap" style={{ rowGap: 0 }}><b className="small">{a.action}</b><span className="muted small">{fmtDate(a.at, true)}</span></div>
                <div className="muted small">{a.detail}</div>
                <div className="muted mono" style={{ fontSize: 11 }}>{a.actor}{a.ip ? ` · ${a.ip}` : ''} · {a.hash.slice(0, 12)}</div>
              </div>
            ))}
          </div>
        </section>
      </div>

      {dialog === 'extend' && <ExtendDialog envelope={e} onClose={() => setDialog('')} onDone={() => (setDialog(''), reload())} />}
      {dialog === 'void' && (
        <VoidDialog title="Void this envelope" confirmLabel="Void envelope" onClose={() => setDialog('')}
          onVoid={async (reason) => {
            await api(`/envelopes/${e.id}/void`, { body: { reason } });
            toast('Envelope voided. Everyone who had it has been told.');
            setDialog('');
            reload();
          }}>
          <p>Nobody will be able to sign it any more, and everyone who already has it is told why.{finished.length > 0 ? ` The ${finished.length === 1 ? 'signature' : 'signatures'} already collected will be lost.` : ''}</p>
          <p className="muted">Only need to fix something? <Link href={editHref}>Edit the envelope</Link> instead. That keeps it open and keeps what has been signed.{costLine ? ` ${costLine}` : ''}</p>
        </VoidDialog>
      )}
      {dialog === 'delete' && (
        <ConfirmDialog title={isTpl ? 'Delete this template' : 'Delete this envelope'} confirmLabel={kept ? 'Delete from my account' : 'Delete for good'} onClose={() => setDialog('')}
          onConfirm={async () => {
            await api(`/envelopes/${e.id}`, { method: 'DELETE' });
            toast(kept ? 'Deleted from your account. Everyone who was on it keeps their copy.' : 'Deleted.');
            router.push(isTpl ? '/app/templates' : '/app/envelopes');
          }}>
          {kept ? (
            <>
              {/* It is hidden, not destroyed: the account is a party to the document too, so its admins can still find it
                  and put it back. A member cannot do that themselves, and is told who can. */}
              {isAdmin
                ? <p>&ldquo;{e.subject || 'Untitled'}&rdquo; leaves the lists, the search, the export and the reports. It is not destroyed: you and the other admins of this account still find it under Envelopes, in the tab <b>Removed by its sender</b>, and can put it back from there.</p>
                : <p>&ldquo;{e.subject || 'Untitled'}&rdquo; leaves your lists, your search, your export and your reports. You cannot bring it back yourself. An admin of your team still finds it under Envelopes, in the tab <b>Removed by its sender</b>, and can put it back, so ask one of them if you need it again. Download the PDF first if you want to keep a copy of your own.</p>}
              <p className="muted">{done ? 'It is a completed document, so it is not only yours.' : 'Someone on it has already done their part (signed, approved, witnessed or confirmed they viewed it), so it is not only yours.'} Everyone who was on it keeps their copy: the link in their email and their download keep working, and it stays in their list of documents sent to them. It is removed for everyone when this account is closed.</p>
            </>
          ) : <p>&ldquo;{e.subject || 'Untitled'}&rdquo; and its audit trail will be removed for good. This cannot be undone.</p>}
        </ConfirmDialog>
      )}
      {fix && <CorrectDialog envelopeId={e.id} recipient={fix} onClose={() => setFix(null)} onDone={() => (setFix(null), reload())} />}
    </div>
  );
}
