'use client';
import { DraftMessage, SummaryChoice } from './DraftMessage';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Mark } from '../Brand';
import { DATE_FORMATS, DATE_FORMAT_CHOICES, DEFAULT_DATE_FORMAT, formatDate, deviceZone, momentText } from '@/lib/dates';
import { savingLine, reviewSummary, dateExampleDay } from '@/lib/editorux';
import { api } from '../ui';
import { useMe } from '../AppShell';
import { ReminderChoice } from './ReminderChoice';
// Send now or Send later, only for a document that is going out (SendLater.tsx).
import { SendLaterChoice } from './SendLater';
import { PayLinkChoice } from './PayLinkChoice';
import { OnlyNamed } from './OnlyNamed';
import { SendFor } from './SendFor';
import { ReviewPlus } from '../impact/SenderTrees';
import { type Ed } from './shared';
import { OwnDocsChoice } from './OwnDocsChoice';
import { OWN_DOCS_LABEL } from '@/lib/owndocs';
import { useCollectSummary } from './CollectChoice';

// The parts of step 3 that came over from step 1 (research/ux-charter.md, 2.3): the subject and the message stand
// where the Send button is, and what changes from one send to the next (reminders, the deadline, how dates are
// written, a payment link) is asked once, under the step's one More options.

/** The email's subject and message. For a template the subject is its name as well. */
export function SendWords({ ed }: { ed: Ed }) {
  const { env, isTpl, wording } = ed;
  // "Sign now": the only person is the sender, so no invitation is written. The box is the document's title, and
  // there is nobody to write a message to. A message typed earlier is kept and comes back when someone is added.
  const alone = ed.signNow;
  return (
    <div className="card ed-words">
      <label className="f" style={alone ? { marginBottom: 0 } : undefined}><span>{isTpl ? 'Template name and email subject' : alone ? 'Document title' : 'Email subject'}</span><input value={env.subject} maxLength={200} onChange={(e) => ed.patchEnv({ subject: e.target.value })} /></label>
      {!alone && <label className="f" style={{ marginBottom: 0 }}><span>Message <span className="hint">{wording ? '(from the template, locked)' : '(optional)'}</span></span><textarea value={env.message} maxLength={5000} readOnly={!!wording} onChange={(e) => ed.patchEnv({ message: e.target.value })} /></label>}
      {/* 'Draft a message': only where a model answers for this account (DraftMessage.tsx). */}
      {!alone && <DraftMessage ed={ed} />}
    </div>
  );
}

/** Step 3's More options: closed every time the step opens, and the only place reminders are asked. */
export function ReviewMore({ ed, closed }: { ed: Ed; closed: boolean }) {
  const { env, isTpl, correcting, anyLocked, lockedNames, rcps } = ed;
  const me = useMe();
  const [open, setOpen] = useState(false);
  const zone = deviceZone();
  // The day the formats are shown with: one whose day cannot be taken for a month (src/lib/editorux.ts).
  const today = dateExampleDay(new Date());
  const format = env.date_format || DATE_FORMATS[0];
  // A payment link that is already on the document (it can come with a template): said next to the closed More
  // options, and when it is not shown to anyone right now, said outside it, so nobody has to open More to find out.
  const [pay, setPay] = useState<{ pay_link: any; may: boolean; why: string | null; host_why?: string | null } | null>(null);
  useEffect(() => {
    let live = true;
    api(`/envelopes/${env.id}/pay-link`).then((r: any) => live && setPay(r)).catch(() => {});
    return () => {
      live = false;
    };
  }, [env.id]);
  // A payment asked for by card (CollectChoice.tsx): said next to the closed More options too, read again on closing.
  const asked = useCollectSummary(env.id, open);
  if (closed) return null;
  const payShown = !!pay?.pay_link && pay.may && !pay.host_why;
  const payHidden = !!pay?.pay_link && !payShown;
  const said = reviewSummary({
    reminderDays: env.reminder_days, expireDays: correcting ? null : env.expire_days, closesOn: correcting && env.expires_at ? momentText(env.expires_at, zone) : '',
    dateFormat: format, defaults: { expireDays: me.account?.default_expire_days ?? null, dateFormat: me.account?.default_date_format || DEFAULT_DATE_FORMAT },
    dateExample: formatDate(today, env.date_format, zone), signNow: ed.signNow, payLink: payShown, collect: asked,
  });
  return (
    <div className="ed-review-more">
      {payHidden && !open && <div className="notice warn" role="status" style={{ marginBottom: 10 }}><b>The payment link on this document is not shown to anyone right now.</b> {pay!.may ? pay!.host_why : pay!.why}{ed.wording ? '' : ' You can take it off under More options.'}</div>}
      <div className="row wrap" style={{ gap: '4px 12px' }}>
        <button type="button" className="btn ghost" data-more="screen" aria-expanded={open} aria-controls="ed-step3-more" onClick={() => setOpen(!open)}>More options</button>
        {/* What is set now, so nobody has to open it to find out. */}
        {!open && said && <span className="muted small">{said}</span>}
        {/* Said while closed too, so nobody has to open More options to know some files are not shown to everyone. */}
        {!open && !!env.own_docs && ed.docs.length > 1 && <span className="muted small" data-feature="ds-visibility">{OWN_DOCS_LABEL}.</span>}
      </div>
      {open && (
        <div id="ed-step3-more" className="stack" role="group" aria-label="More options for this document">
          <SendLaterChoice ed={ed} />
          <ReminderChoice days={env.reminder_days} isTpl={isTpl} bySender={!isTpl && rcps.some((r) => r.link_by_sender)} onChange={(n) => ed.patchEnv({ reminder_days: n })} />
          <div className="card">
            {correcting
              ? <div className="f ed-static" style={{ marginBottom: 12 }}><span>Deadline</span><div className="muted">{env.expires_at ? `Closes on ${momentText(env.expires_at, zone)}. ` : ''}To give people more time, use the document&rsquo;s page after you save.</div></div>
              : <label className="f"><span>Deadline <span className="hint">(days from sending, then it closes)</span></span><input type="number" inputMode="numeric" min={1} max={365} value={env.expire_days} style={{ maxWidth: 140 }} onChange={(e) => ed.patchEnv({ expire_days: Number(e.target.value) })} /></label>}
            <label className="f" style={{ marginBottom: 6 }}><span>Dates on the document are written like</span>
              <select value={format} disabled={anyLocked} aria-describedby="ed-date-example" onChange={(e) => ed.patchEnv({ date_format: e.target.value })}>
                {DATE_FORMAT_CHOICES.map((f) => <option key={f} value={f}>{formatDate(today, f, zone)}</option>)}
              </select>
            </label>
            <div id="ed-date-example" className="muted small" aria-live="polite">
              {anyLocked ? `That is fixed, because ${lockedNames} already finished.` : 'The date of signing is the day where each person is. The signing record has the exact time as well.'}
            </div>
          </div>
          {/* "Each person sees only their files": only with two or more files (OwnDocsChoice.tsx). */}
          <OwnDocsChoice ed={ed} />
          {/* A link to the sender's own payment page, shown to signers after Finish. Absent for an account that may not show one. */}
          {/* The payment link comes with a template's wording, so it is not offered where that wording is locked (tplroles.ts). */}
          {!ed.wording && <PayLinkChoice envelopeId={env.id} isTpl={isTpl} onChange={(p) => setPay((was) => (was ? { ...was, ...p } : was))} />}
          {/* 'Plain summary for signers': only where the account lets the AI read document text (DraftMessage.tsx). */}
          <SummaryChoice ed={ed} />
          {/* 'Only the person named may sign': only when someone on it is away and named a person to sign for them (OnlyNamed.tsx). */}
          <OnlyNamed ed={ed} />
          {/* 'Send for <name>': only when a colleague shared sending with this person (SendFor.tsx). */}
          <SendFor ed={ed} />
        </div>
      )}
    </div>
  );
}

/**
 * What sending this one document on screen saves, in the owner's words. No fraction of a tree; water is an
 * estimate and stands behind "How we work this out", with the link to where the numbers come from.
 */
export function SavingBox({ pages, people, envelopeId }: { pages: number; people: number; envelopeId?: string }) {
  const s = savingLine(pages, people);
  // The account switched 'Trees on screens and emails' off (Settings, Account): no saving line at all.
  const off = useMe()?.policy?.impact_display === 'off';
  if (off) return null;
  if (s.sheets < 1) return null;
  return (
    <div className="card row ed-saving" style={{ background: 'var(--green-soft)', borderColor: '#cfe3d2', alignItems: 'flex-start' }}>
      <Mark size={26} label="" />
      <div>
        <b>{s.line}</b>{envelopeId && <ReviewPlus envelopeId={envelopeId} people={people} />}
        <details data-fold className="ed-fold small">
          <summary>How we work this out</summary>
          <p style={{ margin: '4px 0 0' }}>{s.how} <Link href="/impact" target="_blank" rel="noopener" className="ed-tap-link">Where these numbers come from</Link></p>
        </details>
      </div>
    </div>
  );
}
