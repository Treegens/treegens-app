'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { listName } from '@/lib/docname';
import { useParams, useRouter } from 'next/navigation';
import { api, useLoad, Status, fmtDate, toast } from '@/components/ui';
import { Mark } from '@/components/Brand';
import { useMe } from '@/components/AppShell';
import { SenderTrees } from '@/components/impact/SenderTrees';
import { reminderText } from '@/lib/policy';
import { Recipients, lastEmailTo, openToSign, type Delivery } from '@/components/sender/Recipients';
import { MoreMenu, Fold, type MenuLine } from '@/components/sender/More';
import { History } from '@/components/sender/History';
import { mainButton, pageMore, personRemind, waitingSentence, type PagePerson } from '@/lib/envelopepage';
import { actingName } from '@/lib/groups';
import { MailStopLines, remindedText } from '@/components/sender/MailNews';
import { ConfirmDialog, CorrectDialog, ExtendDialog, VoidDialog } from '@/components/sender/dialogs';
import { fail } from '@/components/sender/feedback';
import { AfterSend } from '@/components/sender/AfterSend';
import { PrintNotice } from '@/components/sender/PrintNotice';
import { PayLinkNote } from '@/components/sender/PayLinkNote';
import { CollectNote } from '@/components/sender/CollectNote';
import { readAllowance, voidCostLine } from '@/components/sender/allowance';
import { ownLink } from '@/components/sender/OwnLink';
import { Disputed } from '@/components/sender/Disputed';
import { EnvelopeComments } from '@/components/sender/Comments';
import { RetentionCard, RetentionLine, DeleteNotes, keepInstead, keepInsteadLabel, deleteOffers, scheduleOn, askAllowed, deletedToast, copiesLine, type RetentionAsk } from '@/components/sender/Retention';
import { CustomDetails } from '@/components/sender/CustomDetails';
import { KeyDates } from '@/components/sender/KeyDates';
import { FileChecks } from '@/components/sender/FileChecks';
import { askedPaper } from '@/lib/disclosure';
import { closingSoon, deadlineLine, hasTurn, howLong, joinNames, longDate, neverOpened } from '@/components/sender/lib';
// Send later, pause and resume (src/components/sender/Timing.tsx).
import { ChangeTimeDialog, scheduledWords, pausedWords, sendNow, pauseIt, resumeIt, keepAsDraft, waitNow } from '@/components/sender/Timing';
// Working for a colleague: the line at the top, and Move to a colleague (src/components/sender/Colleagues.tsx).
import { SharedNote, MoveDialog, moveAllowed } from '@/components/sender/Colleagues';
import { shareAllows, MOVE_LABEL, commentsReadOnly } from '@/lib/shares';
import { seesLine, SEES_REST } from '@/lib/owndocs';
import { PaperReview, PaperWaitingLine, scanWaiting, scanHeadline } from '@/components/sender/PaperReview';

export default function EnvelopeDetail() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const me = useMe();
  const [data, reload, error] = useLoad(() => api(`/envelopes/${id}`), [id]);
  const [dialog, setDialog] = useState<'' | 'void' | 'extend' | 'delete' | 'time' | 'move'>('');
  const [fix, setFix] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  // The details that are checked key dates: shown in the Key dates fold only, not a second time under Details.
  const [keyDetails, setKeyDetails] = useState<string[]>([]);
  // Which of the keeping dialogs is open (Keep it, Hold, Lift the hold, remove the files): they live in Retention.tsx.
  const [keeping, setKeeping] = useState<RetentionAsk>('');
  // The email about the deletion schedule links here with ?ask=keep, and Settings with ?ask=hold or ?ask=purge: the
  // dialog opens once, when it applies to this document and this person, and the address is cleaned.
  const asked = useRef(false);
  useEffect(() => {
    if (asked.current || !data?.retention) return;
    asked.current = true;
    const want = new URLSearchParams(window.location.search).get('ask');
    if (!want) return;
    window.history.replaceState(null, '', window.location.pathname);
    setKeeping(askAllowed(want, data.retention, id));
  }, [data, id]);
  // Sent from Templates (the Use dialog sends people here with ?from=templates): the way back is Templates.
  const [fromTemplates, setFromTemplates] = useState(false);
  useEffect(() => setFromTemplates(new URLSearchParams(window.location.search).get('from') === 'templates'), []);
  const askedForTime = useRef(false);
  // The main button "Copy the link for <name>": the people list copies it, so there is one way of copying a link.
  const [copyAsk, setCopyAsk] = useState<{ id: string; n: number } | null>(null);

  // Emails about deadlines link here with ?extend=1, so the dialog is already open when the page loads.
  useEffect(() => {
    if (!data || askedForTime.current) return;
    askedForTime.current = true;
    const q = new URLSearchParams(window.location.search);
    if (q.get('extend') !== '1') return;
    const s = data.envelope.status;
    if (s === 'sent' || s === 'expired') setDialog('extend');
    else toast(s === 'completed' ? 'Everyone has already finished, so this one does not need more time.' : 'This document is stopped, so it cannot be given more time. Copy it to send it again.');
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

  if (error) return <div className="sn card center"><h1 className="serif" style={{ fontSize: 22 }}>We could not open this document</h1><p className="muted" style={{ marginTop: 8 }}>It may have been deleted, or it belongs to someone else on your team. Ask them to share it, or go back to your list.</p><Link href="/app/envelopes" className="btn">Back to documents</Link></div>;
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
  // Kept for nothing but an open dispute: a declined or voided one nobody had finished.
  const keptForDispute = kept && !!e.disputed_at && !done && !e.recipients.some((r: any) => r.role !== 'cc' && (r.status === 'completed' || r.signed_before));
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
  const paperAsk = askedPaper(decliner);
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

  // One main button by state, and everything else in the page's one More (src/lib/envelopepage.ts).
  // The last email to them was saved, not delivered, because this server has no mail server: a reminder would end
  // the same way, so none is offered and none is claimed. Their link is offered instead.
  const noMail = (r: any) => out && hasTurn(r) && r.role !== 'inperson' && !ownLink(r) && lastEmailTo(deliveries, r.email, r.id)?.status === 'outbox';
  const mine = (r: any) => r.role !== 'inperson' && (r.email || '').toLowerCase() === me.user.email.toLowerCase();
  const people: PagePerson[] = e.recipients.map((r: any) => ({
    id: r.id, name: actingName(r) || r.name || r.role_name || 'them', role: r.role, status: r.status, turn: out && hasTurn(r), me: mine(r),
    remindable: out && !e.paused_at && hasTurn(r) && !r.muted && !stopped.includes(r) && !ownLink(r) && r.role !== 'inperson' && !mine(r) && !noMail(r),
    noMail: noMail(r),
  }));
  const later = scheduledWords(e);
  const main = mainButton({ status: e.status, isTemplate: isTpl, removed: !!removed, purged: !!e.purged_at, people, scheduled: !!later, paused: out && !!e.paused_at });
  // Asked for paper: Copy and fix would send it on screen again, which is what they asked not to do, so there is no
  // main button and Copy stays in More.
  const noMain = paperAsk && main?.kind === 'copy_fix';
  const mainPerson = main?.personId ? e.recipients.find((r: any) => r.id === main.personId) : null;
  // Someone sent back a scan signed on paper, and it waits for a look (sender/PaperReview.tsx).
  const paperScan = scanWaiting(e);
  // Someone printed it to sign on paper: the page does not say that paper was saved.
  // Anyone on the paper path (asked to, chose to, or was asked again): no "paper saved" line (sender/PaperReview.tsx).
  const onPaper = e.recipients.some((r: any) => !!r.paper_state || !!r.require_paper);
  const whyNot = paused ? 'Sending is paused on this account, so this has to wait.' : undefined;
  // Opened through a colleague's share: only what the share lets this person do is offered (src/lib/shares.ts).
  const shareOk = (k: string) => !data.shared || shareAllows(data.shared.level, k);
  const mainEl = !main || noMain ? null
    : !shareOk(main.kind) ? null
    : main.kind === 'restore' ? <button className="btn primary" disabled={busy} onClick={() => act(() => api(`/envelopes/${e.id}/restore`, { method: 'POST' }), 'Put back. It is in the lists, the search, the export and the reports again.')}>{main.label}</button>
    : main.kind === 'continue' ? <Link href={editHref} className="btn primary">{main.label}</Link>
    : main.kind === 'send_now' ? <button className="btn primary" disabled={busy || paused} title={whyNot} onClick={() => act(() => sendNow(e.id))}>{main.label}</button>
    : main.kind === 'resume' ? <button className="btn primary" disabled={busy} onClick={() => act(() => resumeIt(e.id))}>{main.label}</button>
    : main.kind === 'sign' || main.kind === 'host' ? <button className="btn primary" disabled={busy} onClick={() => (setBusy(true), openToSign(e.id, mainPerson).catch((err) => (fail(err), setBusy(false))))}>{main.label}</button>
    : main.kind === 'remind' ? <button className="btn primary" disabled={busy || paused} title={paused ? 'Sending is paused on this account, so no reminders go out.' : undefined} onClick={remindAll}>{main.label}</button>
    : main.kind === 'download' ? <a className="btn primary" href={`/api/envelopes/${e.id}/download`}>{main.label}</a>
    : main.kind === 'copy_link' ? <button className="btn primary" disabled={busy} onClick={() => setCopyAsk({ id: main.personId!, n: (copyAsk?.n || 0) + 1 })}>{main.label}</button>
    : main.kind === 'reopen' ? <button className="btn primary" disabled={paused} title={whyNot} onClick={() => setDialog('extend')}>{main.label}</button>
    : <button className="btn primary" disabled={busy} onClick={() => clone('envelope')}>{main.label}</button>;
  // A deletion schedule applies to it: only then are Keep it and Hold listed (src/components/sender/Retention.tsx).
  const ret = isTpl ? null : data.retention;
  const schedule = scheduleOn(ret);
  const more: MenuLine[] = pageMore({
    status: e.status, isTemplate: isTpl, removed: !!removed, purged: !!e.purged_at, hasFiles: e.documents.length > 0, mayChange, mayDelete: !isTpl || e.access?.may_delete !== false,
    main: isTpl && (tplLocked || tplHeld) ? 'copy' : noMain ? null : main?.kind || null, schedule, mayKeep: deleteOffers(ret).keep,
    mayHold: !!ret?.may_hold, held: !!ret?.held, heldHere: !!ret?.holds?.some((h: any) => h.envelope_id === e.id), mayPurge: deleteOffers(ret).purge,
    scheduled: !!later, pausable: out && !e.paused_at,
  }).map((l): MenuLine => ({
    ...l,
    ...(l.key === 'open_pdf' ? { href: `/api/envelopes/${e.id}/download?inline=1`, newTab: true }
      : l.key === 'full_record' ? { href: `/api/envelopes/${e.id}/evidence` }
      : l.key === 'edit' ? { href: editHref, route: true }
      : l.key === 'more_time' ? { onPick: () => setDialog('extend') }
      : l.key === 'pause' ? { onPick: () => act(() => pauseIt(e.id)), disabled: busy }
      : l.key === 'change_time' ? { onPick: () => setDialog('time') }
      : l.key === 'keep_draft' ? { onPick: () => act(() => keepAsDraft(e.id)), disabled: busy }
      : l.key === 'copy' ? { onPick: () => clone('envelope'), disabled: busy }
      : l.key === 'save_template' ? { onPick: () => clone('template'), disabled: busy }
      : l.key === 'cancel' ? { onPick: () => setDialog('void') }
      : l.key === 'keep' ? { onPick: () => setKeeping('keep') }
      : l.key === 'hold' ? { onPick: () => setKeeping('hold') }
      : l.key === 'lift_hold' ? { onPick: () => setKeeping('lift') }
      : l.key === 'remove_files' ? { onPick: () => setKeeping('purge') }
      : { onPick: () => setDialog('delete') }),
  })).filter((l) => shareOk(l.key));
  // Move to a colleague, before Cancel the request (charter 2.5), on a team only.
  const moveAt = more.findIndex((l) => l.key === 'cancel' || l.key === 'delete');
  if (moveAllowed(me, e, data)) more.splice(moveAt < 0 ? more.length : moveAt, 0, { key: 'move', label: MOVE_LABEL, onPick: () => setDialog('move') });
  // The same name the document has on Home and in Documents (listName): "Planting partnership", not "Please sign: ...".
  const title = listName(e.subject) || (isTpl ? 'Untitled template' : 'Untitled');
  const nFiles = e.documents.length;

  return (
    <div className="sn stack">
      <div className="pagehead sn-head" style={{ marginBottom: 0 }}>
        <div className="grow">
          <Link href={isTpl || fromTemplates ? '/app/templates' : '/app/envelopes'} className="small sn-back">← {isTpl || fromTemplates ? 'Templates' : 'Documents'}</Link>
          <h1 className="serif sn-title">{title}</h1>
        </div>
        <div className="sn-headactions"><MoreMenu kind="screen" label={`More for ${title}`} lines={more} /></div>
      </div>

      {removed && (
        <section className="card sn-now closed" aria-label="Removed by its sender">
          <div className="sn-now-main">
            <div>
              <p className="sn-now-line">Removed from its sender&apos;s lists on {longDate(removed)}.</p>
              <p className="sn-now-sub">It is only under Documents, in the tab Removed by its sender: in no other list, search, export or report of your team. Everyone who was on it still has their link and their copy. You can open it because you are an admin of this account: its PDF and its full record are in More.</p>
              <p className="sn-now-sub">Put it back and it is an ordinary document again, for its sender and for the admins. Its history records who removed it and who put it back.</p>
            </div>
            <div className="sn-now-actions">{mainEl}</div>
          </div>
        </section>
      )}

      <SharedNote data={data} />

      {/* Someone named on it said they did not sign it, or that it was not them (src/server/evidence.ts). */}
      <Disputed envelope={e} audit={data.audit} />

      {/* A name or wording in a script the signed PDF has no font for: said here, before anyone signs. */}
      {(data.print_problems || []).length > 0 && <PrintNotice problems={data.print_problems} />}

      {e.status === 'draft' && (
        <section className="card sn-now" aria-label="Where this stands">
          <div className="sn-now-main">
            <div><p className={`sn-now-line${later?.warn ? ' warn' : ''}`}>{isTpl ? 'A template, ready to use.' : later ? later.line : 'Not sent yet.'}</p><p className="muted">{later ? later.sub : !isTpl ? 'Nobody has received anything. Pick up where you left off.' : mayChange ? 'Use it to start a new document, or edit it to change the files, roles and fields.' : tplLocked ? `Use it to start a new document. Its wording is locked: you fill in names, email addresses and the fields left empty for you. To change it, ask ${e.access.owner} or an admin of your team.` : tplHeld ? `Use it to start a new document. It belongs to ${e.access.owner} and is not for everyone on the team, so only they or an admin can change it, and a copy would be theirs too. To change something, ask ${e.access.owner} or an admin of your team.` : 'Use it to start a new document. It belongs to a colleague, so only they or an admin of your team can change or delete it. To change something, make your own copy: the copy is yours and the original stays as it is.'}</p></div>
            {!isTpl ? !removed && <div className="sn-now-actions">{mainEl}</div>
              : mayChange ? <div className="sn-now-actions"><Link href={editHref} className="btn primary">Edit template</Link></div>
              : tplLocked || tplHeld ? <div className="sn-now-actions"><button className="btn primary" disabled={busy} onClick={() => clone('envelope')}>Use</button></div>
              : <div className="sn-now-actions"><button className="btn primary" disabled={busy} onClick={() => clone('template')}>Make my own copy</button></div>}
          </div>
        </section>
      )}

      {/* Right after sending: what we email the sender, and the one switch for an email at each signature. */}
      {out && <AfterSend envelope={e} sentFor={e.sender_id !== me.user.id && data.sent_by_name ? data.sent_for_name : undefined} />}

      {out && (
        <section className="card sn-now" aria-label="Where this stands">
          <div className="sn-now-main">
            <div>
              <p className="sn-now-line">{paperScan ? scanHeadline(paperScan) : waitingSentence(people, { paused: !!e.paused_at, wait: waitNow(e) })}{e.sent_at ? ` Sent ${howLong(e.sent_at)} ago.` : ''}</p>
              {e.paused_at && <p className="sn-now-sub warn" data-feature="ds-timing">{pausedWords(e)}</p>}
              {paperScan && <PaperWaitingLine r={paperScan} after={!!e.ordered && e.recipients.some((x: any) => x.status === 'pending' && x.routing_order > paperScan.routing_order)} />}
              {bounced.length > 0 && <p className="sn-now-sub warn">The email to {joinNames(bounced.map((r: any) => r.name))} {bounced.some((r: any) => lastEmailTo(deliveries, r.email, r.id)?.next_try_at) ? 'has not gone out yet, and we keep trying' : 'did not go out'}. Open their More below to change the address or share the link yourself.</p>}
              <MailStopLines people={stopped} />
              {almost.length > 0 && <p className="sn-now-sub warn" id="sn-almost"><b>{joinNames(almost.map((r: any) => r.name))}</b> {almost.length === 1 ? 'has' : 'have'} filled in everything but {almost.length === 1 ? 'has' : 'have'} not pressed Finish, so {almost.length === 1 ? 'their part is' : 'their parts are'} not signed yet. A reminder tells them that one button is left.</p>}
              {unopened.length > 0 && <p className="sn-now-sub warn">{joinNames(unopened.map((r: any) => r.name))} {unopened.length === 1 ? 'has' : 'have'} not opened it yet. Their More below has other ways to reach them.</p>}
              {allMuted && <p className="sn-now-sub">They turned reminder emails off, so reach them with their link instead. It is in their More below.</p>}
              {e.expires_at && <p className={`sn-now-sub${closingSoon(e.expires_at) ? ' warn' : ''}`}>{deadlineLine(e.expires_at)}.{closingSoon(e.expires_at) ? ' Give more time, in More, if they need it.' : ''}</p>}
              {paused && <p className="sn-now-sub warn">Sending is paused on this account, so reminders are off, nobody is emailed about a change you make, and people further down the signing order are asked only once the pause is lifted. You can still give more time, change the document and cancel the request.</p>}
              {!paused && e.held_at && <p className="sn-now-sub warn">We are holding back emails about this document. We emailed you why, and its history below says it too.</p>}
              {/* The paper this one saves, and what its signatures plant when that is true (impact/SenderTrees.tsx). */}
              {!onPaper && <SenderTrees envelopeId={e.id} status={e.status} line />}
            </div>
            {/* A scan signed on paper waits: its review is the main button (sender/PaperReview.tsx). */}
            {!removed && (paperScan && shareOk('remind') ? <div className="sn-now-actions"><PaperReview e={e} r={paperScan} onDone={reload} /></div> : mainEl && <div className="sn-now-actions">{mainEl}</div>)}
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
            {!removed && <div className="sn-now-actions">{mainEl}</div>}
          </div>
        </section>
      )}

      {e.status === 'declined' && (
        <section className="card sn-now closed" aria-label="Where this stands">
          <div className="sn-now-main">
            <div>
              {/* "Sign on paper instead": the software wrote the reason, so it is not quoted as theirs (src/lib/disclosure.ts). */}
              {paperAsk ? <>
                <p className="sn-now-line"><b>{decliner.name}</b> asked for this document on paper on {longDate(decliner.paper_at)}.</p>
                <p className="sn-now-sub">Send it to them on paper, the way your consent text says. GrowSigning does not print or post anything. Nobody can sign this one on screen any more.</p>
              </> : <>
                <p className="sn-now-line">{decliner ? <><b>{decliner.name}</b> declined{decliner.completed_at ? ` on ${longDate(decliner.completed_at)}` : ''}.</> : 'This was declined.'}</p>
                {decliner?.decline_reason && <p className="sn-now-sub">They wrote: &ldquo;{decliner.decline_reason}&rdquo;</p>}
                <p className="sn-now-sub">Nobody can sign this one any more. Copy it, change what needs changing and send it again.</p>
              </>}
            </div>
            {!removed && mainEl && <div className="sn-now-actions">{mainEl}</div>}
          </div>
        </section>
      )}

      {e.status === 'voided' && (
        <section className="card sn-now closed" aria-label="Where this stands">
          <div className="sn-now-main">
            <div>
              <p className="sn-now-line">Cancelled. Nobody can sign it any more.</p>
              <p className="sn-now-sub">Reason given: &ldquo;{e.void_reason}&rdquo;</p>
              <p className="sn-now-sub">{costLine ? `${costLine} ` : ''}Copy it to send a corrected one.</p>
            </div>
            {!removed && mainEl && <div className="sn-now-actions">{mainEl}</div>}
          </div>
        </section>
      )}

      {e.status === 'completed' && (
        <div className="card sn-done">
          <Mark size={26} label="" />
          <div className="grow"><b>Everyone finished{e.completed_at ? ` on ${longDate(e.completed_at)}` : ''}.{onPaper ? '' : ' Completed without paper.'}</b>{!onPaper && <SenderTrees envelopeId={e.id} status={e.status} />}</div>
          {/* The signed PDF with its signing record pages: the one file most people want. */}
          {!removed && mainEl && <div className="sn-now-actions">{mainEl}</div>}
        </div>
      )}

      {/* The day its files are deleted, or that it is on hold: one sentence, only when there is one (Retention.tsx). */}
      {!isTpl && <RetentionLine envelopeId={e.id} r={ret} onChanged={reload} onAsk={setKeeping} />}

      <section className="card pad0" aria-labelledby="sn-rcpt-h">
        <div className="sn-cardhead">
          <h2 id="sn-rcpt-h">{isTpl ? 'Roles' : 'People'}</h2>
          {!isTpl && e.status !== 'draft' && !!e.ordered && <p className="muted small">They sign in the order shown.</p>}
        </div>
        {noMailServer && (
          <div className="notice warn sn-inset" role="note">
            This server has no mail server set up, so emails are saved but not delivered, and no reminder can go out.{data.shared ? ` ${data.shared.owner} or an admin shares each link.` : <> Share each link yourself: it is in each person&apos;s More.</>}
            {me.outbox && <> You can read the saved emails in the <a href="/dev/outbox" target="_blank" rel="noreferrer">dev outbox</a>.</>}
          </div>
        )}
        {e.recipients.length === 0 ? <div className="empty">Nobody has been added yet.</div> : (
          <Recipients envelope={e} deliveries={deliveries} texts={data.texts || []} myEmail={me.user.email} onChanged={reload} onCorrect={setFix} paused={paused} allows={data.shared ? shareOk : undefined}
            mainPersonId={main?.personId || ''} copyAsk={copyAsk} mainCopies={main?.kind === 'copy_link' ? main.personId : ''} remindOne={(r: any) => { const p = people.find((x) => x.id === r.id); return !!p && personRemind(people, main, p); }} />
        )}
      </section>

      {/* The dialogs that More opens (Keep it, Hold), and what a deletion left, folded (src/components/sender/Retention.tsx). */}
      {!isTpl && <RetentionCard envelopeId={e.id} r={data.retention} onChanged={reload} ask={keeping} onAsk={setKeeping} />}

      {/* The link to the sender's own payment page, when there is one: who was shown it and who pressed it. */}
      <PayLinkNote envelopeId={e.id} closed={!isTpl && e.status !== 'draft' && e.status !== 'sent'} />
      {/* A payment by card: each person's state as Stripe reported it (components/sender/CollectNote.tsx). */}
      {!isTpl && <CollectNote envelopeId={e.id} />}

      {/* Folded, and closed every time the page opens: comments, history, files, details, checks. */}
      {/* Questions and comments: the threads, who waits for an answer, answer and settle (components/sender/Comments.tsx). */}
      {!isTpl && <EnvelopeComments envelope={e} readOnly={data.shared && !shareOk('comment') ? commentsReadOnly(data.shared.owner) : undefined} />}
      {!isTpl && e.status !== 'draft' && <History audit={data.audit} deliveries={deliveries} chain={data.chain} fullRecordHref={e.purged_at ? null : `/api/envelopes/${e.id}/evidence`} record={data.record_stamp} />}
      <Fold title="Files" count={nFiles}>
        {nFiles === 0 && <p className="muted small">{e.purged_at ? `Its files were deleted on ${longDate(e.purged_at)}.` : 'No file has been added yet.'}</p>}
        {e.documents.map((d: any) => <div key={d.id} className="row between" style={{ padding: '5px 0' }}><span className="truncate">{d.name}{d.supplemental ? <span className="muted small" data-feature="ds-supplements">, to read, not sign</span> : null}</span><span className="muted small" style={{ whiteSpace: 'nowrap' }}>{d.pages} page{d.pages === 1 ? '' : 's'}</span></div>)}
        {/* "Each person sees only their files": who was shown which (limited_people, visibility.ts). Only when it is on. */}
        {(e.limited_people || []).map((p: any) => <p key={p.id} className="muted small" data-feature="ds-visibility" style={{ margin: '4px 0' }}>{seesLine(p)}</p>)}
        {(e.limited_people || []).length > 0 && (e.recipients || []).some((r: any) => !e.limited_people.some((p: any) => p.id === r.id)) && <p className="muted small" data-feature="ds-visibility" style={{ margin: '4px 0' }}>{SEES_REST}</p>}
        <p className="muted small">
          {pages} page{pages === 1 ? '' : 's'} · {e.fields.length} field{e.fields.length === 1 ? '' : 's'} · {e.ordered ? 'signed in order' : 'everyone at once'}{out && !e.expires_at ? ' · no closing date' : ''}
        </p>
        {/* Whether anyone is reminded without the sender doing anything, in a full sentence (reminderText in src/lib/policy.ts). */}
        {out && !paused && <p className="muted small" id="sn-reminders">{reminderText(e.reminder_days)}{e.reminder_days > 0 && e.recipients.some(ownLink) ? ' For someone whose link you send yourself, the reminder comes to you instead.' : ''}{shareOk('edit') ? ' To change it, choose Edit in More.' : ''}</p>}
        {e.message && <p className="muted" style={{ whiteSpace: 'pre-wrap' }}>&ldquo;{e.message}&rdquo;</p>}
        {e.status !== 'draft' && <p className="muted small" style={{ marginBottom: 0 }}>{e.sent_at ? `Sent ${fmtDate(e.sent_at, true)}. ` : ''}If you write to us about it, its number is <span className="sn-id">{e.id}</span>.</p>}
      </Fold>
      {/* The account's own details on this envelope, such as a case number, folded (src/components/sender/CustomDetails.tsx). */}
      <CustomDetails envelope={keyDetails.length ? { ...e, custom_fields: (e.custom_fields || []).filter((r: any) => !keyDetails.includes(r.name)) } : e} editHref={mayChange ? editHref : null} onSaved={reload} />
      {/* Key dates of a completed document, folded, only when Key dates is on (src/components/sender/KeyDates.tsx). */}
      <KeyDates envelope={e} on={!!me?.key_dates} onChanged={reload} onDetails={setKeyDetails} />
      {/* What can be checked about the signed PDF, folded: today its digital seal, when it carries one (FileChecks.tsx). */}
      <FileChecks seal={data.seal} archive={data.archive_format} />

      {dialog === 'move' && <MoveDialog envelope={e} onClose={() => setDialog('')} onDone={() => (setDialog(''), toast('Moved. It belongs to them now, and its history says so.'), router.push(isTpl ? '/app/templates' : '/app/envelopes'))} />}
      {dialog === 'time' && <ChangeTimeDialog envelope={e} onClose={() => setDialog('')} onDone={() => (setDialog(''), reload())} />}
      {dialog === 'extend' && <ExtendDialog envelope={e} onClose={() => setDialog('')} onDone={() => (setDialog(''), reload())} />}
      {dialog === 'void' && (
        <VoidDialog title="Cancel the request" confirmLabel="Cancel the request" onClose={() => setDialog('')}
          onVoid={async (reason) => {
            await api(`/envelopes/${e.id}/void`, { body: { reason } });
            toast('Cancelled. Everyone who had it has been told.');
            setDialog('');
            reload();
          }}>
          <p>Nobody will be able to sign it any more, and everyone who already has it is told why.{finished.length > 0 ? ` The ${finished.length === 1 ? 'signature' : 'signatures'} already collected will be lost.` : ''}</p>
          <p className="muted">Only need to fix something? <Link href={editHref}>Edit the document</Link> instead. That keeps it open and keeps what has been signed.{costLine ? ` ${costLine}` : ''}</p>
        </VoidDialog>
      )}
      {dialog === 'delete' && (
        <ConfirmDialog title={isTpl ? 'Delete this template' : 'Delete this document'} confirmLabel={kept ? 'Delete from my account' : 'Delete for good'}
          // "Keep it" only ever means stopping a scheduled deletion, so the button that closes this dialog says Cancel.
          keepLabel="Cancel" onClose={() => setDialog('')}
          // A deletion schedule reaches it: the third way out stops that schedule instead (Retention.tsx, keepInstead).
          other={!isTpl && keepInstead(ret) ? { label: keepInsteadLabel(ret!), onClick: () => (setDialog(''), setKeeping('keep')) } : null}
          onConfirm={async () => {
            await api(`/envelopes/${e.id}`, { method: 'DELETE' });
            toast(kept ? (keptForDispute ? 'Deleted from your account. It is kept while the dispute about it is open.' : deletedToast(ret)) : 'Deleted.');
            router.push(isTpl ? '/app/templates' : '/app/envelopes');
          }}>
          {kept ? (
            <>
              {/* It is hidden, not destroyed: the account is a party to the document too, so its admins can still find it
                  and put it back. A member cannot do that themselves, and is told who can. */}
              {isAdmin
                ? <p>&ldquo;{e.subject || 'Untitled'}&rdquo; leaves the lists, the search, the export and the reports. It is not destroyed: you and the other admins find it under Documents, in the tab <b>Removed by its sender</b>, and can put it back.</p>
                : <p>&ldquo;{e.subject || 'Untitled'}&rdquo; leaves your lists, your search, your export and your reports. You cannot bring it back yourself. An admin of your team still finds it under Documents, in the tab <b>Removed by its sender</b>, and can put it back, so ask one of them if you need it again. Download the PDF first if you want to keep a copy of your own.</p>}
              {/* Kept only because a dispute is open (keptOnDelete in src/server/deleting.ts): said as that, not as a copy someone keeps. */}
              {keptForDispute ? <p className="muted">A person named on it disputes it, and GrowSigning has not closed that dispute yet, so it cannot be deleted for good until then.</p> : <p className="muted">{copiesLine(ret)}</p>}
            </>
          ) : <p>&ldquo;{e.subject || 'Untitled'}&rdquo; and its history will be removed for good. This cannot be undone.</p>}
          {/* One Delete: what the deletion schedule will do by itself, and the way to remove the files for good, are said here. */}
          {!isTpl && <DeleteNotes r={ret} onPurge={() => (setDialog(''), setKeeping('purge'))} />}
        </ConfirmDialog>
      )}
      {fix && <CorrectDialog envelopeId={e.id} recipient={fix} onClose={() => setFix(null)} onDone={() => (setFix(null), reload())} />}
    </div>
  );
}
