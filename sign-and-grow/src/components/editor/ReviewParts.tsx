'use client';
import { useState } from 'react';
import Link from 'next/link';
import { Mark } from '../Brand';
import { DATE_FORMATS, DATE_FORMAT_CHOICES, formatDate, deviceZone, momentText } from '@/lib/dates';
import { savingLine } from '@/lib/editorux';
import { ReminderChoice } from './ReminderChoice';
import { PayLinkChoice } from './PayLinkChoice';
import { plural, type Ed } from './shared';

// The parts of step 3 that came over from step 1 (research/ux-charter.md, 2.3): the subject and the message stand
// where the Send button is, and what changes from one send to the next (reminders, the deadline, how dates are
// written, a payment link) is asked once, under the step's one More options.

/** The email's subject and message. For a template the subject is its name as well. */
export function SendWords({ ed }: { ed: Ed }) {
  const { env, isTpl, wording } = ed;
  return (
    <div className="card ed-words">
      <label className="f"><span>{isTpl ? 'Template name and email subject' : 'Email subject'}</span><input value={env.subject} maxLength={200} onChange={(e) => ed.patchEnv({ subject: e.target.value })} /></label>
      <label className="f" style={{ marginBottom: 0 }}><span>Message <span className="hint">{wording ? '(from the template, locked)' : '(optional)'}</span></span><textarea value={env.message} maxLength={5000} readOnly={!!wording} onChange={(e) => ed.patchEnv({ message: e.target.value })} /></label>
    </div>
  );
}

/** Step 3's More options: closed every time the step opens, and the only place reminders are asked. */
export function ReviewMore({ ed, closed }: { ed: Ed; closed: boolean }) {
  const { env, isTpl, correcting, anyLocked, lockedNames, rcps } = ed;
  const [open, setOpen] = useState(false);
  const zone = deviceZone();
  const today = new Date();
  const format = env.date_format || DATE_FORMATS[0];
  if (closed) return null;
  return (
    <div className="ed-review-more">
      <div className="row wrap" style={{ gap: '4px 12px' }}>
        <button type="button" className="btn ghost" data-more="screen" aria-expanded={open} aria-controls="ed-step3-more" onClick={() => setOpen(!open)}>More options</button>
        {/* What is set now, so nobody has to open it to find out. */}
        {!open && <span className="muted small">{env.reminder_days ? `Reminder every ${plural(env.reminder_days, 'day')}` : 'No automatic reminders'}
          {correcting ? (env.expires_at ? ` · closes on ${momentText(env.expires_at, zone)}` : '') : ` · closes after ${plural(env.expire_days, 'day')}`} · dates written like {formatDate(today, env.date_format, zone)}</span>}
      </div>
      {open && (
        <div id="ed-step3-more" className="stack" role="group" aria-label="More options for this document">
          <ReminderChoice days={env.reminder_days} isTpl={isTpl} bySender={!isTpl && rcps.some((r) => r.link_by_sender)} onChange={(n) => ed.patchEnv({ reminder_days: n })} />
          <div className="card">
            {correcting
              ? <div className="f ed-static" style={{ marginBottom: 12 }}><span>Deadline</span><div className="muted">{env.expires_at ? `Closes on ${momentText(env.expires_at, zone)}. ` : ''}To give people more time, use the document&rsquo;s page after you save.</div></div>
              : <label className="f"><span>Deadline <span className="hint">(days from sending, then it closes)</span></span><input type="number" inputMode="numeric" min={1} max={365} value={env.expire_days} style={{ maxWidth: 140 }} onChange={(e) => ed.patchEnv({ expire_days: Number(e.target.value) })} /></label>}
            <label className="f" style={{ marginBottom: 6 }}><span>Dates on the document are written like</span>
              <select value={format} disabled={anyLocked} aria-describedby="ed-date-example" onChange={(e) => ed.patchEnv({ date_format: e.target.value })}>
                {DATE_FORMAT_CHOICES.map((f) => <option key={f} value={f}>{formatDate(today, f, zone)} ({f})</option>)}
              </select>
            </label>
            <div id="ed-date-example" className="muted small" aria-live="polite">
              {anyLocked ? `That is fixed, because ${lockedNames} already finished.` : 'The date of signing is the day where each person is. The signing record has the exact time as well.'}
            </div>
          </div>
          {/* A link to the sender's own payment page, shown to signers after Finish. Absent for an account that may not show one. */}
          {/* The payment link comes with a template's wording, so it is not offered where that wording is locked (tplroles.ts). */}
          {!ed.wording && <PayLinkChoice envelopeId={env.id} isTpl={isTpl} />}
        </div>
      )}
    </div>
  );
}

/**
 * What sending this one document on screen saves, in the owner's words. No fraction of a tree; water and CO2e are
 * estimates and stand behind "How we work this out", with the link to where the numbers come from.
 */
export function SavingBox({ pages, people }: { pages: number; people: number }) {
  const s = savingLine(pages, people);
  if (s.sheets < 1) return null;
  return (
    <div className="card row ed-saving" style={{ background: 'var(--green-soft)', borderColor: '#cfe3d2', alignItems: 'flex-start' }}>
      <Mark size={26} label="" />
      <div>
        <b>{s.line}</b>
        <details data-fold className="ed-fold small">
          <summary>How we work this out</summary>
          <p style={{ margin: '4px 0 0' }}>{s.how} <Link href="/impact" target="_blank" rel="noopener">Where these numbers come from</Link></p>
        </details>
      </div>
    </div>
  );
}
