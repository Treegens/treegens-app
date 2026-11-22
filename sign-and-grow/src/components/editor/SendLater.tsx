'use client';
import { useId } from 'react';
import { SEND_LATER_MAX_DAYS, SEND_LATER_MIN_MINUTES, atWords, fromLocalInput, sendAtLabel, sendAtProblem, toLocalInput, waitLine } from '@/lib/timing';
import { type Ed } from './shared';

// Send later, in step 3's More options (research/ux-notes.json "ds-timing"). Default: Send now. With a time chosen,
// the one Send button reads "Send at 9:00 on 3 December" and nothing else on the step changes. The time is the
// sender's own (their device's clock); the server keeps it as a moment.

/** The chosen time, whenever Send later is chosen. One that has passed is never treated as none: Send refuses it. */
export function sendLaterAt(ed: Ed): string {
  const at = ed.env?.send_at;
  if (!at || ed.isTpl || ed.correcting || ed.signNow) return '';
  return at;
}

/** The Send button's label with a time chosen, or null for the usual one. A time that can no longer be used says so. */
export const sendLaterLabel = (ed: Ed) => (!sendLaterAt(ed) ? null : sendAtProblem(sendLaterAt(ed)) ? 'Pick a later time' : sendAtLabel(sendLaterAt(ed)));

export function SendLaterChoice({ ed }: { ed: Ed }) {
  const id = useId();
  if (ed.isTpl || ed.correcting || ed.signNow) return null;
  const at = sendLaterAt(ed);
  const later = !!ed.env.send_at;
  const problem = at ? sendAtProblem(at) : null;
  const min = toLocalInput(new Date(Date.now() + (SEND_LATER_MIN_MINUTES + 1) * 60_000).toISOString());
  const max = toLocalInput(new Date(Date.now() + SEND_LATER_MAX_DAYS * 864e5).toISOString());
  // Tomorrow at 9:00 where the sender is: a time most people mean, and easy to change.
  const tomorrow = () => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    d.setHours(9, 0, 0, 0);
    return d.toISOString();
  };
  return (
    <div className="card ed-send-later" data-feature="ds-timing">
      <fieldset className="ed-plain-fieldset" style={{ border: 0, padding: 0, margin: 0 }}>
        <legend className="f" style={{ fontWeight: 600, marginBottom: 6 }}>When it goes out</legend>
        <div className="row wrap" style={{ gap: '4px 16px' }}>
          <label className="ed-radio" style={{ minHeight: 44, display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <input type="radio" name={`${id}-when`} checked={!later} onChange={() => ed.patchEnv({ send_at: null })} /> Send now
          </label>
          <label className="ed-radio" style={{ minHeight: 44, display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <input type="radio" name={`${id}-when`} checked={later} onChange={() => ed.patchEnv({ send_at: at || tomorrow() })} /> Send later
          </label>
        </div>
      </fieldset>
      {later && (
        <>
          <label className="f" style={{ margin: '6px 0' }}><span>Day and time <span className="hint">(your time, up to {SEND_LATER_MAX_DAYS} days ahead)</span></span>
            <input type="datetime-local" value={toLocalInput(ed.env.send_at)} min={min} max={max} aria-describedby={`${id}-says`} style={{ maxWidth: 260, minHeight: 44 }}
              onChange={(e) => ed.patchEnv({ send_at: fromLocalInput(e.target.value) || ed.env.send_at })} />
          </label>
          <div id={`${id}-says`} className="muted small" aria-live="polite">
            {at && !problem ? `It goes out by itself, soon after ${atWords(at)}. Until then you can change the time or send it now from its page.` : `${problem || 'Pick a day and a time.'} Nothing goes out until you do.`}
          </div>
        </>
      )}
    </div>
  );
}

/** One line under a person on the review step: "Wait 2 days before this person". */
export const waitNote = (ed: Ed, r: any) => (ed.env?.ordered && r.wait_hours > 0 && !isFirst(ed, r) ? waitLine(r.wait_hours) : '');

/** The first step of a signing order has nothing before it to wait for. */
export function isFirst(ed: Ed, r: any): boolean {
  const orders = ed.rcps.filter((x: any) => x.role !== 'witness').map((x: any) => Number(x.routing_order) || 1);
  return (Number(r.routing_order) || 1) <= Math.min(...orders);
}
